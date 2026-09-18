import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temporary = await mkdtemp(path.join(os.tmpdir(), "water-disconnection-"));
process.env.DB_PATH = path.join(temporary, "test.sqlite");
process.env.AS_OF_MONTH = "2026-09";
try {
  // Exercise an existing database as well as idempotent startup migrations.
  const schema = (await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"))
    .replace("  disconnected_from TEXT,\n", "");
  execFileSync("sqlite3", [process.env.DB_PATH, schema]);
  const { ensureDatabaseSchema, query, run } = await import("../src/sql.mjs");
  const { upsertHouse, createPayment, getDashboard, getHouseDetailsByNumber, getAdminData, exportCsv } = await import("../src/repository.mjs");
  await ensureDatabaseSchema();
  await ensureDatabaseSchema();
  assert.equal((await query("PRAGMA table_info(houses)")).filter((column) => column.name === "disconnected_from").length, 1);
  for (const number of [18, 19, 20]) await upsertHouse({ number, startsOn: "2025-05" });
  const payment = await createPayment({ houseNumber: 18, amount: 15300, paidAt: "2026-08-01" });
  await createPayment({ houseNumber: 20, amount: 18000, paidAt: "2026-08-01" });
  const before = await getDashboard();
  const allocationsBefore = await query("SELECT * FROM payment_allocations ORDER BY id");
  await assert.rejects(upsertHouse({ number: 18, status: "disconnected" }), /месяц отключения/);
  await assert.rejects(upsertHouse({ number: 18, status: "disconnected", disconnectedFrom: "2026-13" }), /месяц отключения/);
  await assert.rejects(upsertHouse({ number: 18, status: "wrong" }), /статус/);
  assert.equal((await getHouseDetailsByNumber(18)).house.status, "active");
  for (const number of [18, 20]) await upsertHouse({ number, status: "disconnected", disconnectedFrom: "2026-09" });
  const after = await getDashboard();
  assert.equal(after.totals.balance, before.totals.balance);
  assert.equal(after.totals.payments, before.totals.payments);
  assert.equal(after.totals.activeHouses, 1);
  assert.equal(after.houses.length, 3);
  assert.deepEqual(await query("SELECT * FROM payment_allocations ORDER BY id"), allocationsBefore);
  const disconnected = await getHouseDetailsByNumber(18);
  assert.equal(disconnected.house.due, 16300);
  assert.equal(disconnected.house.debt, 1000);
  assert.deepEqual(disconnected.months.find((month) => month.month === "2026-09"), { month: "2026-09", charge: 0, paid: 0, status: "not_applicable" });
  assert.equal((await getHouseDetailsByNumber(20)).house.overpaid, 1700);
  assert.equal((await getHouseDetailsByNumber(19)).house.due, 17300);
  assert.equal((await getAdminData()).houses.find((house) => house.number === 18).disconnectedFrom, "2026-09");
  assert.match(await exportCsv("houses"), /disconnected_from/);
  assert.ok(after.houses.every((house) => !("accessCode" in house)));
  process.env.AS_OF_MONTH = "2027-02";
  assert.equal((await getHouseDetailsByNumber(18)).house.due, 16300);
  await upsertHouse({ number: 18, privateNotes: "Updated note" });
  assert.equal((await getHouseDetailsByNumber(18)).house.disconnectedFrom, "2026-09");
  const repayment = await createPayment({ houseNumber: 18, amount: 1500, paidAt: "2027-02-01" });
  assert.deepEqual(repayment.allocations, [{ month: "2026-08", amount: 1000 }]);
  assert.equal((await getHouseDetailsByNumber(18)).house.debt, 0);
  assert.equal((await getHouseDetailsByNumber(18)).house.overpaid, 500);
  assert.equal((await query(`SELECT amount FROM payments WHERE id = ${payment.id}`))[0].amount, 15300);
  await upsertHouse({ number: 21, status: "disconnected", startsOn: "2026-09", disconnectedFrom: "2026-09" });
  assert.equal((await getHouseDetailsByNumber(21)).house.due, 0);
  await upsertHouse({ number: 21, status: "active" });
  assert.equal((await getHouseDetailsByNumber(21)).house.disconnectedFrom, null);
  process.env.AS_OF_MONTH = "2026-08";
  assert.equal((await getHouseDetailsByNumber(18)).house.due, 16300);
  // Stop future allocation exactly at the cutoff, including planned disconnection.
  await upsertHouse({ number: 22, startsOn: "2026-08", status: "disconnected", disconnectedFrom: "2026-10" });
  const advance = await createPayment({ houseNumber: 22, amount: 4000, paidAt: "2026-08-01" });
  assert.deepEqual(advance.allocations, [{ month: "2026-08", amount: 1000 }, { month: "2026-09", amount: 1000 }]);
  // Later general monthly charges must never accrue to a disconnected house.
  await run("INSERT INTO monthly_charges (month, amount, kind, title) VALUES ('2026-10', 9000, 'extra', 'test')");
  process.env.AS_OF_MONTH = "2026-12";
  assert.equal((await getHouseDetailsByNumber(18)).house.due, 16300);
  console.log("Disconnection checks passed: migration, validation, cutoff, balances, history, repayment, future months, API projections.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
