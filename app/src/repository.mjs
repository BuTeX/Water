import crypto from "node:crypto";
import { addMonth, buildHouseSummary, chargeForMonth, currentMonth, monthRange } from "./calculations.mjs";
import {
  normalizeInt,
  query,
  run,
  sqlDate,
  sqlEnum,
  sqlInt,
  sqlMonth,
  sqlRequiredText,
  sqlText
} from "./sql.mjs";

const PAYMENT_METHODS = ["cash", "bank_transfer", "sbp", "card", "other"];
const HOUSE_STATUSES = ["active", "paused", "disconnected", "archived"];

function normalizeStartMonth(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.slice(0, 7);
  throw new Error("startsOn must use YYYY-MM or YYYY-MM-DD");
}

async function loadCoreData() {
  const [houses, rates, monthlyCharges, payments, allocations, expenses, categories] = await Promise.all([
    query("SELECT * FROM houses ORDER BY number"),
    query("SELECT * FROM contribution_rates ORDER BY effective_from_month"),
    query("SELECT * FROM monthly_charges ORDER BY month"),
    query("SELECT p.*, h.number AS house_number FROM payments p JOIN houses h ON h.id = p.house_id ORDER BY p.paid_at, p.id"),
    query(
      "SELECT pa.*, p.house_id FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id ORDER BY pa.month, pa.id"
    ),
    query(
      "SELECT e.*, c.name AS category FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id ORDER BY e.spent_at DESC, e.id DESC"
    ),
    query("SELECT * FROM expense_categories ORDER BY name")
  ]);
  return { houses, rates, monthlyCharges, payments, allocations, expenses, categories };
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function toPublicHouse(summary) {
  return {
    number: summary.number,
    displayName: summary.displayName,
    status: summary.status,
    startsOn: summary.startsOn,
    due: summary.due,
    paid: summary.paid,
    debt: summary.debt,
    overpaid: summary.overpaid,
    lastPaymentAt: summary.lastPaymentAt
  };
}

export async function getDashboard() {
  const data = await loadCoreData();
  const asOfMonth = currentMonth();
  const paymentsByHouse = groupBy(data.payments, (payment) => payment.house_id);
  const allocationsByHouse = groupBy(data.allocations, (allocation) => allocation.house_id);
  const summaries = data.houses
    .filter((house) => house.status !== "archived")
    .map((house) =>
      buildHouseSummary({
        house,
        payments: paymentsByHouse.get(house.id) || [],
        allocations: allocationsByHouse.get(house.id) || [],
        rates: data.rates,
        monthlyCharges: data.monthlyCharges,
        asOfMonth
      })
    );

  const totalPayments = data.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const totalExpenses = data.expenses.reduce((sum, expense) => sum + Number(expense.amount), 0);
  const totalDebt = summaries.reduce((sum, house) => sum + house.debt, 0);
  const totalOverpaid = summaries.reduce((sum, house) => sum + house.overpaid, 0);

  return {
    asOfMonth,
    updatedAt: new Date().toISOString(),
    totals: {
      payments: totalPayments,
      expenses: totalExpenses,
      balance: totalPayments - totalExpenses,
      debt: totalDebt,
      overpaid: totalOverpaid,
      houses: summaries.length
    },
    houses: summaries.map(toPublicHouse),
    recentExpenses: data.expenses.slice(0, 8).map((expense) => ({
      spentAt: expense.spent_at,
      amount: expense.amount,
      category: expense.category || "прочее",
      title: expense.description_public || expense.title
    }))
  };
}

export async function getHouseByCode(code) {
  const safeCode = sqlRequiredText(code, "access code");
  const houses = await query(`SELECT * FROM houses WHERE access_code = ${safeCode} LIMIT 1`);
  const house = houses[0];
  if (!house) return null;

  const data = await loadCoreData();
  const asOfMonth = currentMonth();
  const payments = data.payments.filter((payment) => payment.house_id === house.id);
  const allocations = data.allocations.filter((allocation) => allocation.house_id === house.id);
  const summary = buildHouseSummary({
    house,
    payments,
    allocations,
    rates: data.rates,
    monthlyCharges: data.monthlyCharges,
    asOfMonth
  });

  return {
    asOfMonth,
    house: toPublicHouse(summary),
    months: summary.months,
    payments: payments
      .slice()
      .reverse()
      .map((payment) => ({
        paidAt: payment.paid_at,
        amount: payment.amount,
        method: payment.method,
        comment: payment.comment_public || ""
      })),
    paymentInstruction: "Оплатите взнос по согласованным реквизитам и сообщите администратору номер дома, дату и сумму платежа."
  };
}

export async function getAdminData() {
  const dashboard = await getDashboard();
  const data = await loadCoreData();
  return {
    dashboard,
    houses: data.houses.map((house) => ({
      id: house.id,
      number: house.number,
      displayName: house.display_name,
      status: house.status,
      startsOn: house.starts_on,
      accessCode: house.access_code,
      url: `/h/${house.access_code}`,
      publicNotes: house.public_notes || "",
      privateNotes: house.private_notes || ""
    })),
    categories: data.categories,
    rates: data.rates,
    monthlyCharges: data.monthlyCharges,
    recentPayments: data.payments
      .slice()
      .reverse()
      .slice(0, 20)
      .map((payment) => ({
        id: payment.id,
        houseNumber: payment.house_number,
        paidAt: payment.paid_at,
        amount: payment.amount,
        method: payment.method,
        source: payment.source
      })),
    recentExpenses: data.expenses.slice(0, 20)
  };
}

async function existingAllocatedByMonth(houseId) {
  const rows = await query(`
    SELECT pa.month, COALESCE(SUM(pa.amount), 0) AS amount
    FROM payment_allocations pa
    JOIN payments p ON p.id = pa.payment_id
    WHERE p.house_id = ${sqlInt(houseId, "house id")}
    GROUP BY pa.month
  `);
  return new Map(rows.map((row) => [row.month, Number(row.amount)]));
}

async function buildAutoAllocations({ house, amount, startMonth }) {
  const [rates, monthlyCharges] = await Promise.all([
    query("SELECT * FROM contribution_rates ORDER BY effective_from_month"),
    query("SELECT * FROM monthly_charges ORDER BY month")
  ]);
  const allocatedByMonth = await existingAllocatedByMonth(house.id);
  const asOfMonth = currentMonth();
  const allocations = [];
  let remaining = amount;
  const firstMonth = startMonth || house.starts_on || asOfMonth;

  for (const month of monthRange(firstMonth, asOfMonth)) {
    if (remaining <= 0) break;
    const charge = chargeForMonth(month, rates, monthlyCharges);
    const outstanding = charge - (allocatedByMonth.get(month) || 0);
    if (outstanding <= 0) continue;
    const value = Math.min(remaining, outstanding);
    allocations.push({ month, amount: value });
    allocatedByMonth.set(month, (allocatedByMonth.get(month) || 0) + value);
    remaining -= value;
  }

  let futureMonth = addMonth(asOfMonth);
  let guard = 0;
  while (remaining > 0 && guard < 36) {
    const charge = chargeForMonth(futureMonth, rates, monthlyCharges);
    if (charge <= 0) break;
    const value = Math.min(remaining, charge);
    allocations.push({ month: futureMonth, amount: value });
    remaining -= value;
    futureMonth = addMonth(futureMonth);
    guard += 1;
  }

  if (remaining > 0) allocations.push({ month: futureMonth, amount: remaining });
  return allocations;
}

export async function createPayment(body) {
  const number = normalizeInt(body.houseNumber, "house number");
  const houses = await query(`SELECT * FROM houses WHERE number = ${sqlInt(number, "house number")} LIMIT 1`);
  const house = houses[0];
  if (!house) throw new Error(`House ${number} not found`);

  const amount = normalizeInt(body.amount, "amount");
  const insertRows = await query(`
    INSERT INTO payments (house_id, paid_at, amount, method, comment_public, comment_private, source)
    VALUES (
      ${sqlInt(house.id, "house id")},
      ${sqlDate(body.paidAt, "paid at")},
      ${sqlInt(amount, "amount")},
      ${sqlEnum(body.method, PAYMENT_METHODS, "other")},
      ${sqlText(body.commentPublic || "")},
      ${sqlText(body.commentPrivate || "")},
      'manual'
    )
    RETURNING id
  `);
  const paymentId = insertRows[0].id;

  const allocations = Array.isArray(body.allocations) && body.allocations.length
    ? body.allocations.map((item) => ({ month: String(item.month), amount: normalizeInt(item.amount, "allocation amount") }))
    : await buildAutoAllocations({ house, amount, startMonth: body.startMonth || null });

  if (allocations.length) {
    const values = allocations
      .map((item) => `(${sqlInt(paymentId, "payment id")}, ${sqlMonth(item.month)}, ${sqlInt(item.amount, "allocation amount")})`)
      .join(", ");
    await run(`INSERT INTO payment_allocations (payment_id, month, amount) VALUES ${values};`);
  }

  return { id: paymentId, allocations };
}

export async function createExpense(body) {
  const categoryName = String(body.category || "прочее");
  const category = await query(`SELECT id FROM expense_categories WHERE name = ${sqlText(categoryName)} LIMIT 1`);
  const categoryId = category[0]?.id || (await query("SELECT id FROM expense_categories WHERE name = 'прочее' LIMIT 1"))[0].id;
  const rows = await query(`
    INSERT INTO expenses (
      spent_at, amount, category_id, title, description_public, description_private, vendor, source
    )
    VALUES (
      ${sqlDate(body.spentAt, "spent at")},
      ${sqlInt(body.amount, "amount")},
      ${sqlInt(categoryId, "category id")},
      ${sqlRequiredText(body.title, "title")},
      ${sqlText(body.descriptionPublic || body.title || "")},
      ${sqlText(body.descriptionPrivate || "")},
      ${sqlText(body.vendor || "")},
      'manual'
    )
    RETURNING id
  `);
  return { id: rows[0].id };
}

export async function upsertHouse(body) {
  const number = normalizeInt(body.number, "house number");
  const existing = await query(`SELECT * FROM houses WHERE number = ${sqlInt(number, "house number")} LIMIT 1`);
  const hasStartField = body.startsOn !== undefined || body.billingStartsOn !== undefined;

  if (existing[0]) {
    const current = existing[0];
    const displayName = String(body.displayName ?? current.display_name ?? `ул. Уютная ${number}`).trim();
    const status = HOUSE_STATUSES.includes(body.status) ? body.status : current.status;
    const startsOn = hasStartField ? normalizeStartMonth(body.startsOn ?? body.billingStartsOn) : current.starts_on;
    const publicNotes = body.publicNotes ?? current.public_notes ?? "";
    const privateNotes = body.privateNotes ?? current.private_notes ?? "";
    await run(`
      UPDATE houses
      SET display_name = ${sqlRequiredText(displayName, "display name")},
          status = ${sqlText(status)},
          starts_on = ${startsOn ? sqlMonth(startsOn) : "NULL"},
          public_notes = ${sqlText(publicNotes)},
          private_notes = ${sqlText(privateNotes)},
          updated_at = CURRENT_TIMESTAMP
      WHERE number = ${sqlInt(number, "house number")};
    `);
    return { id: existing[0].id, updated: true };
  }

  const displayName = String(body.displayName || `ул. Уютная ${number}`).trim();
  const status = HOUSE_STATUSES.includes(body.status) ? body.status : "active";
  const startsOn = hasStartField ? normalizeStartMonth(body.startsOn ?? body.billingStartsOn) : null;
  const accessCode = `h${number}-${crypto.randomBytes(6).toString("hex")}`;
  const rows = await query(`
    INSERT INTO houses (number, display_name, status, starts_on, access_code, public_notes, private_notes)
    VALUES (
      ${sqlInt(number, "house number")},
      ${sqlRequiredText(displayName, "display name")},
      ${sqlText(status)},
      ${startsOn ? sqlMonth(startsOn) : "NULL"},
      ${sqlText(accessCode)},
      ${sqlText(body.publicNotes || "")},
      ${sqlText(body.privateNotes || "")}
    )
    RETURNING id
  `);
  return { id: rows[0].id, created: true };
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export async function exportCsv(type) {
  const allowed = {
    houses: "SELECT number, display_name, status, starts_on, access_code FROM houses ORDER BY number",
    payments:
      "SELECT h.number AS house, p.paid_at, p.amount, p.method, p.source FROM payments p JOIN houses h ON h.id = p.house_id ORDER BY p.paid_at, p.id",
    expenses:
      "SELECT e.spent_at, e.amount, c.name AS category, e.title, e.description_public, e.source FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id ORDER BY e.spent_at, e.id"
  };
  const sql = allowed[type];
  if (!sql) throw new Error("Unknown export type");
  const rows = await query(sql);
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n");
}
