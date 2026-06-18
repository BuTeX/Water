import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createExpense,
  createPayment,
  exportCsv,
  getAdminData,
  getDashboard,
  getHouseByCode,
  upsertHouse
} from "./repository.mjs";
import { DB_PATH } from "./sql.mjs";

const execFileAsync = promisify(execFile);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(appDir, "public");
const sessions = new Map();
const isProduction = process.env.NODE_ENV === "production";
const adminPassword = process.env.ADMIN_PASSWORD || (isProduction ? "" : "admin");
const isAdminEnabled = Boolean(adminPassword);

if (isProduction && !isAdminEnabled) {
  console.warn("ADMIN_PASSWORD is not set; admin login is disabled.");
}

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function cookieAttrs(req, extra = "") {
  const secure =
    process.env.COOKIE_SECURE === "true" ||
    (process.env.COOKIE_SECURE !== "false" && req.headers["x-forwarded-proto"] === "https");
  return `HttpOnly; SameSite=Lax; Path=/${secure ? "; Secure" : ""}${extra ? `; ${extra}` : ""}`;
}

function isAuthed(req) {
  const session = parseCookies(req).water_session;
  return Boolean(session && sessions.has(session));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf-8");
  return text ? JSON.parse(text) : {};
}

async function readBuffer(req, maxBytes = 30 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("Database file is too large");
    chunks.push(chunk);
  }
  if (!total) throw new Error("Database file is required");
  return Buffer.concat(chunks);
}

async function serveFile(res, filePath) {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    };
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
    createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, 404, "Not found");
  }
}

function requireAdmin(req, res) {
  if (isAuthed(req)) return true;
  sendJson(res, 401, { error: "Unauthorized" });
  return false;
}

async function inspectDatabase(filePath) {
  const quickCheck = await execFileAsync("sqlite3", [filePath, "PRAGMA quick_check;"]);
  if (quickCheck.stdout.trim() !== "ok") {
    throw new Error("Uploaded file is not a valid SQLite database");
  }

  const requiredTables = [
    "houses",
    "contribution_rates",
    "monthly_charges",
    "payments",
    "payment_allocations",
    "expense_categories",
    "expenses"
  ];
  const quotedTables = requiredTables.map((name) => `'${name}'`).join(",");
  const tablesResult = await execFileAsync("sqlite3", [
    "-json",
    filePath,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${quotedTables});`
  ]);
  const foundTables = new Set(JSON.parse(tablesResult.stdout.trim() || "[]").map((row) => row.name));
  const missing = requiredTables.filter((table) => !foundTables.has(table));
  if (missing.length) {
    throw new Error(`Uploaded database is missing tables: ${missing.join(", ")}`);
  }

  const countsResult = await execFileAsync("sqlite3", [
    "-json",
    filePath,
    `
      SELECT
        (SELECT COUNT(*) FROM houses) AS houses,
        (SELECT COUNT(*) FROM payments) AS payments,
        (SELECT COUNT(*) FROM expenses) AS expenses;
    `
  ]);
  return JSON.parse(countsResult.stdout.trim() || "[{}]")[0] || {};
}

async function replaceDatabase(buffer) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "water-db-"));
  const uploadedPath = path.join(tempDir, "upload.sqlite");

  try {
    await writeFile(uploadedPath, buffer);
    const summary = await inspectDatabase(uploadedPath);
    await mkdir(path.dirname(DB_PATH), { recursive: true });
    await copyFile(uploadedPath, DB_PATH);
    await Promise.all([
      unlink(`${DB_PATH}-wal`).catch(() => {}),
      unlink(`${DB_PATH}-shm`).catch(() => {})
    ]);
    return summary;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readJson(req);
      if (!isAdminEnabled) {
        sendJson(res, 503, { error: "Admin login is disabled. Set ADMIN_PASSWORD." });
        return;
      }
      if (String(body.password || "") !== adminPassword) {
        sendJson(res, 401, { error: "Wrong password" });
        return;
      }
      const token = crypto.randomBytes(24).toString("hex");
      sessions.set(token, { createdAt: Date.now() });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": `water_session=${encodeURIComponent(token)}; ${cookieAttrs(req)}`
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const token = parseCookies(req).water_session;
      if (token) sessions.delete(token);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": `water_session=; ${cookieAttrs(req, "Max-Age=0")}`
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard") {
      sendJson(res, 200, await getDashboard());
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/house/")) {
      const code = decodeURIComponent(url.pathname.replace("/api/house/", ""));
      const house = await getHouseByCode(code);
      if (!house) sendJson(res, 404, { error: "House not found" });
      else sendJson(res, 200, house);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/summary") {
      if (!requireAdmin(req, res)) return;
      sendJson(res, 200, await getAdminData());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/database") {
      if (!requireAdmin(req, res)) return;
      const summary = await replaceDatabase(await readBuffer(req));
      sendJson(res, 200, { ok: true, summary });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/payments") {
      if (!requireAdmin(req, res)) return;
      sendJson(res, 201, await createPayment(await readJson(req)));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/expenses") {
      if (!requireAdmin(req, res)) return;
      sendJson(res, 201, await createExpense(await readJson(req)));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/houses") {
      if (!requireAdmin(req, res)) return;
      sendJson(res, 201, await upsertHouse(await readJson(req)));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/export/")) {
      if (!requireAdmin(req, res)) return;
      const type = url.pathname.replace("/api/export/", "").replace(".csv", "");
      const csv = await exportCsv(type);
      sendText(res, 200, csv, "text/csv; charset=utf-8");
      return;
    }

    sendJson(res, 404, { error: "Unknown API route" });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Request failed" });
  }
}

async function handleRequest(req, res) {
  if (req.url === "/healthz" || req.url === "/healthz/") {
    sendText(res, 200, "ok");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url);
    return;
  }

  if (url.pathname === "/") {
    await serveFile(res, path.join(publicDir, "index.html"));
    return;
  }
  if (url.pathname === "/admin") {
    await serveFile(res, path.join(publicDir, "admin.html"));
    return;
  }
  if (url.pathname.startsWith("/h/")) {
    await serveFile(res, path.join(publicDir, "house.html"));
    return;
  }

  const requested = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
  await serveFile(res, path.join(publicDir, requested));
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => sendJson(res, 500, { error: error.message || "Server error" }));
});

function listen(port) {
  const bindHost = process.env.BIND_HOST || (isProduction ? undefined : "127.0.0.1");
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE") listen(port + 1);
    else throw error;
  });
  const listenArgs = bindHost ? [port, bindHost] : [port];
  server.listen(...listenArgs, () => {
    const address = server.address();
    console.log(
      `Water Payments MVP listening on ${address.address}:${address.port} (PORT=${process.env.PORT || "not set"})`
    );
    console.log(`Admin path: /admin`);
  });
}

listen(Number(process.env.PORT || 4173));
