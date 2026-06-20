export function currentMonth() {
  if (process.env.AS_OF_MONTH && /^\d{4}-\d{2}$/.test(process.env.AS_OF_MONTH)) {
    return process.env.AS_OF_MONTH;
  }
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function addMonth(month, delta = 1) {
  let [year, monthNumber] = month.split("-").map(Number);
  monthNumber += delta;
  while (monthNumber > 12) {
    year += 1;
    monthNumber -= 12;
  }
  while (monthNumber < 1) {
    year -= 1;
    monthNumber += 12;
  }
  return `${year}-${String(monthNumber).padStart(2, "0")}`;
}

export function monthRange(start, end) {
  if (!start || !end || start > end) return [];
  const months = [];
  let current = start;
  while (current <= end) {
    months.push(current);
    current = addMonth(current);
  }
  return months;
}

export function baseAmountForMonth(month, rates) {
  const match = rates
    .filter((rate) => rate.effective_from_month <= month && (!rate.effective_to_month || rate.effective_to_month >= month))
    .sort((a, b) => b.effective_from_month.localeCompare(a.effective_from_month))[0];
  return match ? Number(match.amount) : 0;
}

export function extraAmountForMonth(month, monthlyCharges) {
  return monthlyCharges
    .filter((charge) => charge.month === month && charge.kind === "extra")
    .reduce((sum, charge) => sum + Number(charge.amount), 0);
}

export function overrideAmountForMonth(month, monthlyCharges) {
  const match = monthlyCharges
    .filter((charge) => charge.month === month && charge.kind === "override")
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
  return match ? Number(match.amount) : null;
}

export function chargeForMonth(month, rates, monthlyCharges) {
  const overrideAmount = overrideAmountForMonth(month, monthlyCharges);
  return overrideAmount ?? baseAmountForMonth(month, rates) + extraAmountForMonth(month, monthlyCharges);
}

export function buildHouseSummary({ house, payments, allocations, rates, monthlyCharges, asOfMonth }) {
  const dueMonths = monthRange(house.starts_on, asOfMonth);
  const due = dueMonths.reduce((sum, month) => sum + chargeForMonth(month, rates, monthlyCharges), 0);
  const paid = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const debt = Math.max(due - paid, 0);
  const overpaid = Math.max(paid - due, 0);
  const lastPaymentAt = payments.map((payment) => payment.paid_at).sort().at(-1) || null;
  const maxAllocatedMonth = allocations.map((item) => item.month).sort().at(-1);
  const lastMonth = maxAllocatedMonth && maxAllocatedMonth > asOfMonth ? maxAllocatedMonth : asOfMonth;

  const allocationByMonth = new Map();
  for (const allocation of allocations) {
    allocationByMonth.set(allocation.month, (allocationByMonth.get(allocation.month) || 0) + Number(allocation.amount));
  }

  const months = monthRange("2025-05", lastMonth).map((month) => {
    if (!house.starts_on || month < house.starts_on) {
      return { month, charge: 0, paid: 0, status: "not_applicable" };
    }

    const charge = chargeForMonth(month, rates, monthlyCharges);
    const paidForMonth = allocationByMonth.get(month) || 0;
    let status = "unpaid";
    if (month > asOfMonth && paidForMonth > 0) status = "overpaid";
    else if (paidForMonth >= charge && charge > 0) status = "paid";
    else if (paidForMonth > 0) status = "partial";

    return { month, charge, paid: paidForMonth, status };
  });

  return {
    id: house.id,
    number: house.number,
    displayName: house.display_name,
    status: house.status,
    startsOn: house.starts_on,
    due,
    paid,
    debt,
    overpaid,
    lastPaymentAt,
    months
  };
}
