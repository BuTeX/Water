import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DB_PATH = process.env.DB_PATH || path.join(appDir, "db", "water.sqlite");
const bundledDbPath = path.join(appDir, "db", "water.sqlite");
const schemaPath = path.join(appDir, "db", "schema.sql");
let isDbPrepared = false;
let prepareDbPromise = null;

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function prepareDb() {
  if (isDbPrepared) return;
  if (!prepareDbPromise) {
    prepareDbPromise = prepareDbOnce().finally(() => {
      prepareDbPromise = null;
    });
  }
  await prepareDbPromise;
}

async function prepareDbOnce() {
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  if (!(await exists(DB_PATH))) {
    if (DB_PATH !== bundledDbPath && (await exists(bundledDbPath))) {
      await copyFile(bundledDbPath, DB_PATH);
    }
  }

  await applySchema();
  isDbPrepared = true;
}

async function applySchema() {
  const schema = await readFile(schemaPath, "utf-8");
  await execFileAsync("sqlite3", ["-cmd", ".timeout 5000", DB_PATH, schema], {
    maxBuffer: 10 * 1024 * 1024
  });
  await applyMigrations();
}

async function tableColumns(tableName) {
  const { stdout } = await execFileAsync("sqlite3", ["-cmd", ".timeout 5000", "-json", DB_PATH, `PRAGMA table_info(${tableName});`], {
    maxBuffer: 10 * 1024 * 1024
  });
  return new Set(JSON.parse(stdout.trim() || "[]").map((row) => row.name));
}

async function ensureColumn(tableName, columnName, definition) {
  const columns = await tableColumns(tableName);
  if (columns.has(columnName)) return;
  await execFileAsync("sqlite3", ["-cmd", ".timeout 5000", DB_PATH, `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`], {
    maxBuffer: 10 * 1024 * 1024
  });
}

async function applyMigrations() {
  await ensureColumn("telegram_users", "state", "TEXT DEFAULT ''");
  await ensureColumn("telegram_users", "state_payload", "TEXT DEFAULT ''");
  await ensureColumn("telegram_payment_claims", "screenshot_file_id", "TEXT DEFAULT ''");
  await ensureColumn("telegram_payment_claims", "screenshot_file_unique_id", "TEXT DEFAULT ''");
  await ensureColumn("telegram_payment_claims", "screenshot_message_id", "TEXT DEFAULT ''");
}

export async function ensureDatabaseSchema() {
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  await applySchema();
  isDbPrepared = true;
}

export async function query(sql) {
  await prepareDb();
  const { stdout } = await execFileAsync("sqlite3", ["-cmd", ".timeout 5000", "-json", DB_PATH, sql], {
    maxBuffer: 10 * 1024 * 1024
  });
  const text = stdout.trim();
  return text ? JSON.parse(text) : [];
}

export async function run(sql) {
  await prepareDb();
  await execFileAsync("sqlite3", ["-cmd", ".timeout 5000", DB_PATH, sql], {
    maxBuffer: 10 * 1024 * 1024
  });
}

export function sqlText(value) {
  if (value === undefined || value === null || value === "") return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function sqlRequiredText(value, label = "value") {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`${label} is required`);
  }
  return sqlText(String(value).trim());
}

export function sqlInt(value, label = "value") {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a number`);
  return String(Math.round(number));
}

export function normalizeInt(value, label = "value") {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a number`);
  return Math.round(number);
}

export function sqlMonth(value, label = "month") {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}$/.test(text)) throw new Error(`${label} must use YYYY-MM`);
  return sqlText(text);
}

export function sqlDate(value, label = "date") {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label} must use YYYY-MM-DD`);
  return sqlText(text);
}

export function sqlEnum(value, allowed, fallback) {
  const text = String(value || fallback || "");
  return sqlText(allowed.includes(text) ? text : fallback);
}
