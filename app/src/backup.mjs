import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DB_PATH, ensureDatabaseSchema } from "./sql.mjs";

const execFileAsync = promisify(execFile);

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
    await mkdir(path.dirname(backupPath), { recursive: true });
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

function escapeSqlitePath(value) {
  return String(value).replaceAll("'", "''");
}
