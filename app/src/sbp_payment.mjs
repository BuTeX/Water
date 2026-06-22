const DEFAULT_SBP_PAYMENT_RECIPIENT = "Дулец Виктор";
const DEFAULT_SBP_PAYMENT_PHONE = "+79788606861";
const DEFAULT_SBP_PAYMENT_AMOUNT = 1000;

export function getSbpTransferDetails(houseNumber = null) {
  const amount = normalizePositiveAmount(process.env.SBP_PAYMENT_AMOUNT, DEFAULT_SBP_PAYMENT_AMOUNT);
  const number = houseNumber ? Number(houseNumber) : null;
  const houseLabel = Number.isFinite(number) && number > 0 ? `Дом ${number}` : "Дом <номер>";

  return {
    amount,
    currency: "RUB",
    recipient: String(process.env.SBP_PAYMENT_RECIPIENT || DEFAULT_SBP_PAYMENT_RECIPIENT).trim(),
    phone: String(process.env.SBP_PAYMENT_PHONE || DEFAULT_SBP_PAYMENT_PHONE).trim(),
    comment: `${houseLabel}, взнос за воду`
  };
}

function normalizePositiveAmount(value, fallback) {
  const amount = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(amount) && amount > 0 ? amount : fallback;
}
