import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { DB_PATH, ensureDatabaseSchema } from "./sql.mjs";

const execFileAsync = promisify(execFile);
const gzipAsync = promisify(gzip);
const DEFAULT_RECIPIENT = "v.dulec@yandex.ru";
const DEFAULT_BACKUP_WEEKDAY = "sunday";
const DEFAULT_BACKUP_TIME = "03:00";
const MAX_TIMEOUT_MS = 2_147_483_647;
const WEEKDAYS = new Map([
  ["0", 0],
  ["7", 0],
  ["sun", 0],
  ["sunday", 0],
  ["вс", 0],
  ["воскресенье", 0],
  ["1", 1],
  ["mon", 1],
  ["monday", 1],
  ["пн", 1],
  ["понедельник", 1],
  ["2", 2],
  ["tue", 2],
  ["tuesday", 2],
  ["вт", 2],
  ["вторник", 2],
  ["3", 3],
  ["wed", 3],
  ["wednesday", 3],
  ["ср", 3],
  ["среда", 3],
  ["4", 4],
  ["thu", 4],
  ["thursday", 4],
  ["чт", 4],
  ["четверг", 4],
  ["5", 5],
  ["fri", 5],
  ["friday", 5],
  ["пт", 5],
  ["пятница", 5],
  ["6", 6],
  ["sat", 6],
  ["saturday", 6],
  ["сб", 6],
  ["суббота", 6]
]);

export async function createSqliteBackup() {
  await ensureDatabaseSchema();

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "water-db-backup-"));
  const backupPath = path.join(tempDir, "water.sqlite");
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await rm(tempDir, { recursive: true, force: true });
  };

  try {
    await execFileAsync("sqlite3", ["-cmd", ".timeout 5000", DB_PATH, `.backup '${escapeSqlitePath(backupPath)}'`], {
      maxBuffer: 10 * 1024 * 1024
    });
    const fileStat = await stat(backupPath);
    if (!fileStat.isFile()) throw new Error("Database backup was not created");

    return {
      path: backupPath,
      size: fileStat.size,
      createdAt: new Date(),
      cleanup
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function getBackupEmailConfig(env = process.env) {
  const smtpPort = Number(env.SMTP_PORT || 465);
  if (!Number.isInteger(smtpPort) || smtpPort <= 0) throw new Error("SMTP_PORT must be a positive integer");

  const time = parseBackupTime(env.BACKUP_EMAIL_TIME || DEFAULT_BACKUP_TIME);
  const weekday = parseBackupWeekday(env.BACKUP_EMAIL_WEEKDAY || DEFAULT_BACKUP_WEEKDAY);
  const retryMinutes = Number(env.BACKUP_EMAIL_RETRY_MINUTES || 60);
  if (!Number.isFinite(retryMinutes) || retryMinutes < 1) {
    throw new Error("BACKUP_EMAIL_RETRY_MINUTES must be at least 1");
  }

  const username = String(env.SMTP_USER || "").trim();
  const provider = String(env.BACKUP_EMAIL_PROVIDER || (env.RESEND_API_KEY ? "resend" : "smtp"))
    .trim()
    .toLowerCase();
  return {
    enabled: parseBoolean(env.BACKUP_EMAIL_ENABLED, false),
    to: splitEmailList(env.BACKUP_EMAIL_TO || DEFAULT_RECIPIENT),
    from: String(env.BACKUP_EMAIL_FROM || env.RESEND_FROM || env.SMTP_FROM || username || "").trim(),
    provider,
    resend: {
      apiKey: String(env.RESEND_API_KEY || "").trim(),
      apiBase: String(env.RESEND_API_BASE || "https://api.resend.com").replace(/\/+$/, "")
    },
    smtp: {
      host: String(env.SMTP_HOST || "smtp.yandex.com").trim(),
      port: smtpPort,
      secure: parseBoolean(env.SMTP_SECURE, smtpPort === 465),
      startTls: parseBoolean(env.SMTP_STARTTLS, smtpPort !== 465),
      username,
      password: String(env.SMTP_PASSWORD || ""),
      authMethod: String(env.SMTP_AUTH_METHOD || "").trim().toUpperCase(),
      rejectUnauthorized: parseBoolean(env.SMTP_REJECT_UNAUTHORIZED, true),
      timeoutMs: Number(env.SMTP_TIMEOUT_MS || 30_000),
      ehloName: String(env.SMTP_EHLO_NAME || os.hostname() || "localhost").trim()
    },
    schedule: {
      weekday,
      hour: time.hour,
      minute: time.minute,
      label: `${weekdayLabel(weekday)} ${time.label}`,
      retryMs: Math.round(retryMinutes * 60 * 1000)
    },
    statePath: path.resolve(env.BACKUP_EMAIL_STATE_PATH || path.join(path.dirname(DB_PATH), "backup-email-state.json")),
    timeZoneLabel: String(env.BACKUP_EMAIL_TZ || env.TZ || "server local time").trim()
  };
}

export function missingBackupEmailConfig(config = getBackupEmailConfig()) {
  const missing = [];
  if (!["smtp", "resend"].includes(config.provider)) missing.push("BACKUP_EMAIL_PROVIDER=smtp|resend");
  if (!config.to.length) missing.push("BACKUP_EMAIL_TO");
  if (config.provider === "resend") {
    if (!config.from) missing.push("BACKUP_EMAIL_FROM or RESEND_FROM");
    if (!config.resend.apiKey) missing.push("RESEND_API_KEY");
    return missing;
  }
  if (!config.from) missing.push("BACKUP_EMAIL_FROM or SMTP_USER");
  if (!config.smtp.host) missing.push("SMTP_HOST");
  if (!config.smtp.username) missing.push("SMTP_USER");
  if (!config.smtp.password) missing.push("SMTP_PASSWORD");
  return missing;
}

export async function sendBackupEmail(options = {}) {
  const config = options.config || getBackupEmailConfig();
  const missing = missingBackupEmailConfig(config);
  if (missing.length) throw new Error(`Backup email is not configured: missing ${missing.join(", ")}`);

  const backup = await createSqliteBackup();
  try {
    const sqliteBuffer = await readFile(backup.path);
    const gzipBuffer = await gzipAsync(sqliteBuffer, { level: 9 });
    const stamp = formatBackupStamp(backup.createdAt);
    const filename = `water-backup-${stamp}.sqlite.gz`;
    const subject = `Water Payments backup ${stamp}`;
    const body = [
      "Автоматический бекап Water Payments во вложении.",
      "",
      `Создан: ${backup.createdAt.toISOString()}`,
      `Источник: ${DB_PATH}`,
      `Размер SQLite: ${backup.size} bytes`,
      `Размер вложения gzip: ${gzipBuffer.length} bytes`,
      options.reason ? `Причина запуска: ${options.reason}` : "",
      options.scheduledFor ? `Расписание: ${options.scheduledFor.toISOString()}` : ""
    ]
      .filter((line) => line !== "")
      .join("\n");

    const message = {
      from: config.from,
      to: config.to,
      subject,
      text: body,
      attachments: [
        {
          filename,
          contentType: "application/gzip",
          content: gzipBuffer
        }
      ]
    };

    const delivery = await sendBackupMessage(config, message);

    return {
      ok: true,
      filename,
      sentTo: config.to,
      createdAt: backup.createdAt.toISOString(),
      sqliteBytes: backup.size,
      attachmentBytes: gzipBuffer.length,
      delivery
    };
  } finally {
    await backup.cleanup();
  }
}

export function startBackupEmailScheduler() {
  let config;
  try {
    config = getBackupEmailConfig();
  } catch (error) {
    console.warn(`Email backup scheduler is disabled: ${error.message}`);
    return null;
  }

  if (!config.enabled) return null;

  const missing = missingBackupEmailConfig(config);
  if (missing.length) {
    console.warn(`Email backup scheduler is disabled: missing ${missing.join(", ")}`);
    return null;
  }

  const scheduler = new BackupEmailScheduler(config);
  scheduler.start();
  return scheduler;
}

export async function sendSmtpMail(options) {
  const candidates = smtpOptionCandidates(options);
  const errors = [];

  for (const candidate of candidates) {
    try {
      await sendSmtpMailOnce(candidate);
      return;
    } catch (error) {
      errors.push(`${candidate.host}:${candidate.port} ${smtpMode(candidate)} - ${shortSmtpError(error)}`);
      if (!isRetryableSmtpConnectionError(error)) {
        throw new Error(errors.at(-1));
      }
    }
  }

  throw new Error(`SMTP connection failed: ${errors.join("; ")}`);
}

async function sendSmtpMailOnce(options) {
  const client = new SmtpClient(options);
  try {
    await client.connect();
    await client.sendMail(options);
  } finally {
    await client.close().catch(() => {});
  }
}

async function sendBackupMessage(config, message) {
  if (config.provider === "resend") {
    return await sendResendMail(config.resend, message);
  }
  await sendSmtpMail({ ...config.smtp, ...message });
  return { provider: "smtp" };
}

async function sendResendMail(config, message) {
  if (!config.apiKey) throw new Error("RESEND_API_KEY is required");
  const response = await fetch(`${config.apiBase}/emails`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: message.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      attachments: message.attachments.map((attachment) => ({
        filename: attachment.filename,
        content: Buffer.from(attachment.content).toString("base64")
      }))
    })
  });
  const payload = await response.json().catch(async () => ({ message: await response.text().catch(() => "") }));
  if (!response.ok) {
    throw new Error(`Resend API ${response.status}: ${resendErrorMessage(payload)}`);
  }
  return { provider: "resend", id: payload.id || "" };
}

function resendErrorMessage(payload) {
  if (!payload || typeof payload !== "object") return String(payload || "request failed");
  return payload.message || payload.error || payload.name || JSON.stringify(payload);
}

function smtpOptionCandidates(options) {
  const candidates = [normalizeSmtpCandidate(options)];
  if (/^smtp\.yandex\./i.test(String(options.host || ""))) {
    candidates.push(
      normalizeSmtpCandidate({ ...options, host: "smtp.yandex.ru", port: 465, secure: true, startTls: false }),
      normalizeSmtpCandidate({ ...options, host: "smtp.yandex.com", port: 587, secure: false, startTls: true }),
      normalizeSmtpCandidate({ ...options, host: "smtp.yandex.ru", port: 587, secure: false, startTls: true })
    );
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.host}:${candidate.port}:${candidate.secure}:${candidate.startTls}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSmtpCandidate(candidate) {
  const port = Number(candidate.port || 465);
  return {
    ...candidate,
    port,
    secure: Boolean(candidate.secure),
    startTls: Boolean(candidate.startTls)
  };
}

function smtpMode(options) {
  if (options.secure) return "SSL";
  if (options.startTls) return "STARTTLS";
  return "plain";
}

function isRetryableSmtpConnectionError(error) {
  const text = shortSmtpError(error).toUpperCase();
  return [
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "SMTP CONNECTION TIMED OUT",
    "SMTP CONNECTION CLOSED"
  ].some((marker) => text.includes(marker));
}

function shortSmtpError(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const details = {};
    for (const key of ["name", "message", "code", "errno", "syscall", "hostname", "host", "address", "port"]) {
      if (error[key]) details[key] = String(error[key]);
    }
    if (Object.keys(details).length) {
      return Object.entries(details)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
    }
  }
  return String(error || "unknown SMTP error");
}

class BackupEmailScheduler {
  constructor(config) {
    this.config = config;
    this.timer = null;
    this.stopped = false;
    this.running = false;
  }

  start() {
    this.initialize().catch((error) => {
      console.warn(`Email backup scheduler failed to start: ${error.message}`);
      this.scheduleNextRun(new Date());
    });
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async initialize() {
    const now = new Date();
    const state = await readBackupState(this.config);
    const previousScheduledFor = previousScheduleOccurrence(now, this.config.schedule);
    const lastSuccess = state.lastSuccessScheduledFor ? new Date(state.lastSuccessScheduledFor) : null;

    if (!lastSuccess || Number.isNaN(lastSuccess.getTime()) || lastSuccess < previousScheduledFor) {
      console.log(
        `Email backup scheduler will run catch-up backup for ${previousScheduledFor.toISOString()} in ${this.config.timeZoneLabel}.`
      );
      this.scheduleTimer(30_000, () => this.run(previousScheduledFor, "catch-up"));
      return;
    }

    this.scheduleNextRun(now);
  }

  scheduleNextRun(now) {
    const scheduledFor = nextScheduleOccurrence(now, this.config.schedule);
    const delay = Math.min(Math.max(1_000, scheduledFor.getTime() - Date.now()), MAX_TIMEOUT_MS);
    console.log(
      `Next email backup is scheduled for ${scheduledFor.toISOString()} (${this.config.schedule.label}, ${this.config.timeZoneLabel}).`
    );
    this.scheduleTimer(delay, () => this.run(scheduledFor, "scheduled"));
  }

  scheduleRetry(scheduledFor) {
    const delay = Math.min(this.config.schedule.retryMs, MAX_TIMEOUT_MS);
    console.warn(`Email backup will retry in ${Math.round(delay / 60_000)} minutes.`);
    this.scheduleTimer(delay, () => this.run(scheduledFor, "retry"));
  }

  scheduleTimer(delay, callback) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(callback, delay);
    this.timer.unref?.();
  }

  async run(scheduledFor, reason) {
    if (this.stopped) return;
    if (this.running) {
      this.scheduleRetry(scheduledFor);
      return;
    }

    this.running = true;
    const startedAt = new Date();
    try {
      await writeBackupState(this.config, {
        ...(await readBackupState(this.config)),
        lastAttemptAt: startedAt.toISOString(),
        lastAttemptScheduledFor: scheduledFor.toISOString(),
        lastError: ""
      });

      const result = await sendBackupEmail({ config: this.config, scheduledFor, reason });
      await writeBackupState(this.config, {
        lastAttemptAt: startedAt.toISOString(),
        lastSuccessAt: new Date().toISOString(),
        lastSuccessScheduledFor: scheduledFor.toISOString(),
        lastResult: result,
        lastError: ""
      });
      console.log(`Email backup sent to ${result.sentTo.join(", ")}: ${result.filename}`);
      this.scheduleNextRun(new Date(Date.now() + 1_000));
    } catch (error) {
      await writeBackupState(this.config, {
        ...(await readBackupState(this.config)),
        lastErrorAt: new Date().toISOString(),
        lastErrorScheduledFor: scheduledFor.toISOString(),
        lastError: error.message || "Email backup failed"
      }).catch(() => {});
      console.warn(`Email backup failed: ${error.message}`);
      this.scheduleRetry(scheduledFor);
    } finally {
      this.running = false;
    }
  }
}

class SmtpClient {
  constructor(options) {
    this.options = options;
    this.socket = null;
    this.buffer = "";
    this.lines = [];
    this.waiting = [];
    this.capabilities = new Set();
  }

  async connect() {
    this.socket = await openSocket(this.options);
    this.attachSocketListeners();
    await this.expect([220]);
    await this.ehlo();

    if (!this.options.secure && this.options.startTls) {
      await this.command("STARTTLS", [220]);
      await this.upgradeToTls();
      await this.ehlo();
    }

    if (this.options.username || this.options.password) {
      await this.authenticate();
    }
  }

  async ehlo() {
    const response = await this.command(`EHLO ${sanitizeEhloName(this.options.ehloName)}`, [250]);
    this.capabilities = parseCapabilities(response.lines);
  }

  async authenticate() {
    const method = chooseAuthMethod(this.options.authMethod, this.capabilities);
    if (method === "PLAIN") {
      const token = Buffer.from(`\0${this.options.username}\0${this.options.password}`, "utf-8").toString("base64");
      await this.command(`AUTH PLAIN ${token}`, [235]);
      return;
    }

    await this.command("AUTH LOGIN", [334]);
    await this.command(Buffer.from(this.options.username, "utf-8").toString("base64"), [334]);
    await this.command(Buffer.from(this.options.password, "utf-8").toString("base64"), [235]);
  }

  async sendMail(options) {
    const recipients = splitEmailList(options.to);
    if (!recipients.length) throw new Error("Email recipient is required");

    await this.command(`MAIL FROM:${smtpPath(options.from)}`, [250]);
    for (const recipient of recipients) {
      await this.command(`RCPT TO:${smtpPath(recipient)}`, [250, 251]);
    }
    await this.command("DATA", [354]);
    this.write(`${dotStuff(buildMimeMessage(options))}\r\n.\r\n`);
    await this.expect([250]);
    await this.command("QUIT", [221]).catch(() => {});
  }

  async upgradeToTls() {
    this.detachSocketListeners();
    const secureSocket = tls.connect({
      socket: this.socket,
      servername: this.options.host,
      rejectUnauthorized: this.options.rejectUnauthorized !== false
    });
    this.socket = secureSocket;
    await new Promise((resolve, reject) => {
      secureSocket.once("secureConnect", resolve);
      secureSocket.once("error", reject);
    });
    this.buffer = "";
    this.lines = [];
    this.attachSocketListeners();
  }

  command(text, expectedCodes) {
    this.write(`${text}\r\n`);
    return this.expect(expectedCodes);
  }

  write(text) {
    this.socket.write(text, "utf-8");
  }

  async expect(expectedCodes) {
    const response = await this.readResponse();
    if (!expectedCodes.includes(response.code)) {
      throw new Error(`SMTP expected ${expectedCodes.join("/")} but got ${response.code}: ${response.text}`);
    }
    return response;
  }

  async readResponse() {
    const lines = [];
    while (true) {
      const line = await this.readLine();
      lines.push(line);
      if (/^\d{3} /.test(line)) {
        const code = Number(line.slice(0, 3));
        return {
          code,
          lines,
          text: lines.map((item) => item.slice(4)).join("\n")
        };
      }
    }
  }

  readLine() {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
    });
  }

  attachSocketListeners() {
    this.socket.setTimeout(Number(this.options.timeoutMs || 30_000));
    this.socket.on("data", (chunk) => this.handleData(chunk));
    this.socket.on("error", (error) => this.rejectWaiting(error));
    this.socket.on("timeout", () => {
      this.socket.destroy(new Error("SMTP connection timed out"));
    });
    this.socket.on("close", () => {
      this.rejectWaiting(new Error("SMTP connection closed"));
    });
  }

  detachSocketListeners() {
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("error");
    this.socket.removeAllListeners("timeout");
    this.socket.removeAllListeners("close");
  }

  handleData(chunk) {
    this.buffer += chunk.toString("utf-8");
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) break;
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      const waiter = this.waiting.shift();
      if (waiter) waiter.resolve(line);
      else this.lines.push(line);
    }
  }

  rejectWaiting(error) {
    while (this.waiting.length) this.waiting.shift().reject(error);
  }

  async close() {
    if (!this.socket) return;
    this.detachSocketListeners();
    this.socket.end();
  }
}

async function openSocket(options) {
  return await new Promise((resolve, reject) => {
    const socketOptions = {
      host: options.host,
      port: options.port,
      servername: options.host,
      rejectUnauthorized: options.rejectUnauthorized !== false
    };
    const socket = options.secure ? tls.connect(socketOptions) : net.connect(socketOptions);
    const eventName = options.secure ? "secureConnect" : "connect";
    socket.setTimeout(Number(options.timeoutMs || 30_000), () => {
      socket.destroy(new Error("SMTP connection timed out"));
    });
    socket.once(eventName, () => resolve(socket));
    socket.once("error", reject);
  });
}

async function readBackupState(config) {
  try {
    return JSON.parse(await readFile(config.statePath, "utf-8"));
  } catch {
    return {};
  }
}

async function writeBackupState(config, state) {
  await mkdir(path.dirname(config.statePath), { recursive: true });
  await writeFile(config.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function previousScheduleOccurrence(now, schedule) {
  const occurrence = new Date(now);
  occurrence.setHours(schedule.hour, schedule.minute, 0, 0);
  occurrence.setDate(occurrence.getDate() - ((occurrence.getDay() - schedule.weekday + 7) % 7));
  if (occurrence > now) occurrence.setDate(occurrence.getDate() - 7);
  return occurrence;
}

function nextScheduleOccurrence(now, schedule) {
  const occurrence = new Date(now);
  occurrence.setHours(schedule.hour, schedule.minute, 0, 0);
  occurrence.setDate(occurrence.getDate() + ((schedule.weekday - occurrence.getDay() + 7) % 7));
  if (occurrence <= now) occurrence.setDate(occurrence.getDate() + 7);
  return occurrence;
}

function parseBackupWeekday(value) {
  const key = String(value || "").trim().toLowerCase();
  if (WEEKDAYS.has(key)) return WEEKDAYS.get(key);
  throw new Error("BACKUP_EMAIL_WEEKDAY must be a weekday name or 0-6");
}

function parseBackupTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) throw new Error("BACKUP_EMAIL_TIME must use HH:MM");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error("BACKUP_EMAIL_TIME is out of range");
  return {
    hour,
    minute,
    label: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
  };
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function splitEmailList(value) {
  if (Array.isArray(value)) return value.flatMap(splitEmailList);
  return String(value || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildMimeMessage(options) {
  const boundary = `water-backup-${crypto.randomBytes(12).toString("hex")}`;
  const from = sanitizeHeader(options.from);
  const recipients = splitEmailList(options.to).map(sanitizeHeader);
  const headers = [
    `From: ${from}`,
    `To: ${recipients.join(", ")}`,
    `Subject: ${encodeHeader(options.subject || "Water Payments backup")}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@water-payments.local>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ];

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(options.text || "", "utf-8")),
    ...buildAttachmentParts(boundary, options.attachments || []),
    `--${boundary}--`,
    ""
  ];

  return [...headers, "", ...parts].join("\r\n");
}

function buildAttachmentParts(boundary, attachments) {
  return attachments.flatMap((attachment) => [
    `--${boundary}`,
    `Content-Type: ${attachment.contentType || "application/octet-stream"}; name="${sanitizeQuoted(attachment.filename)}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${sanitizeQuoted(attachment.filename)}"`,
    "",
    base64Lines(Buffer.from(attachment.content)),
    ""
  ]);
}

function base64Lines(buffer) {
  return buffer
    .toString("base64")
    .replace(/.{1,76}/g, "$&\r\n")
    .trimEnd();
}

function encodeHeader(value) {
  const text = sanitizeHeader(value);
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf-8").toString("base64")}?=`;
}

function sanitizeHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function sanitizeQuoted(value) {
  return sanitizeHeader(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function dotStuff(message) {
  return message
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

function smtpPath(value) {
  const address = extractEmailAddress(value);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) throw new Error(`Invalid email address: ${value}`);
  return `<${address}>`;
}

function extractEmailAddress(value) {
  const text = sanitizeHeader(value);
  const match = /<([^<>]+)>/.exec(text);
  return (match ? match[1] : text).trim();
}

function parseCapabilities(lines) {
  return new Set(
    lines
      .map((line) => line.slice(4).trim().toUpperCase())
      .filter(Boolean)
  );
}

function chooseAuthMethod(preferred, capabilities) {
  const authLine = [...capabilities].find((capability) => capability.startsWith("AUTH"));
  const methods = new Set(String(authLine || "").split(/\s+/).slice(1));
  if (preferred) {
    if (!["PLAIN", "LOGIN"].includes(preferred)) {
      throw new Error("SMTP_AUTH_METHOD must be PLAIN or LOGIN");
    }
    return preferred;
  }
  if (methods.has("PLAIN")) return "PLAIN";
  return "LOGIN";
}

function sanitizeEhloName(value) {
  return String(value || "localhost")
    .replace(/[^a-zA-Z0-9.-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "localhost";
}

function escapeSqlitePath(value) {
  return String(value).replaceAll("'", "''");
}

function formatBackupStamp(date) {
  return date.toISOString().replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");
}

function weekdayLabel(weekday) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday] || "Sunday";
}

async function main() {
  try {
    const result = await sendBackupEmail({ reason: "manual" });
    console.log(`Backup email sent to ${result.sentTo.join(", ")}: ${result.filename}`);
  } catch (error) {
    console.error(`Backup email failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
