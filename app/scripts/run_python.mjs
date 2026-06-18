import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: node scripts/run_python.mjs <script.py> [...args]");
  process.exit(1);
}

const candidates = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
const python = candidates.find((candidate) => {
  const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
  return result.status === 0;
});

if (!python) {
  console.error("Python 3 was not found.");
  process.exit(1);
}

const result = spawnSync(python, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
