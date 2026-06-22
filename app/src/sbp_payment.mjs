import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SBP_PAYMENT_RECIPIENT = "Дулец Виктор";
const DEFAULT_SBP_PAYMENT_PHONE = "+79788606861";
const DEFAULT_SBP_PAYMENT_AMOUNT = 1000;
const DEFAULT_SBP_PAYMENT_BANK = "Альфа-Банк";
const SBP_PAYMENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ALFA_BANK_ICON_PATH = path.resolve(SBP_PAYMENT_DIR, "../public/assets/alfa-bank-icon.png");

let cachedBankIconBuffer;

export function getSbpTransferDetails(houseNumber = null) {
  const amount = normalizePositiveAmount(process.env.SBP_PAYMENT_AMOUNT, DEFAULT_SBP_PAYMENT_AMOUNT);
  const number = houseNumber ? Number(houseNumber) : null;
  const houseLabel = Number.isFinite(number) && number > 0 ? `Дом ${number}` : "Дом <номер>";

  return {
    amount,
    currency: "RUB",
    recipient: String(process.env.SBP_PAYMENT_RECIPIENT || DEFAULT_SBP_PAYMENT_RECIPIENT).trim(),
    bank: DEFAULT_SBP_PAYMENT_BANK,
    phone: String(process.env.SBP_PAYMENT_PHONE || DEFAULT_SBP_PAYMENT_PHONE).trim(),
    comment: `${houseLabel}, взнос за воду`
  };
}

export async function readSbpBankIcon() {
  if (cachedBankIconBuffer !== undefined) return cachedBankIconBuffer;
  try {
    cachedBankIconBuffer = await readFile(ALFA_BANK_ICON_PATH);
  } catch {
    cachedBankIconBuffer = null;
  }
  return cachedBankIconBuffer;
}

function normalizePositiveAmount(value, fallback) {
  const amount = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(amount) && amount > 0 ? amount : fallback;
}
