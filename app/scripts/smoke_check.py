from __future__ import annotations

import sqlite3
import os
from collections import defaultdict
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.environ.get("DB_PATH", APP_DIR / "db" / "water.sqlite"))
AS_OF_MONTH = os.environ.get("AS_OF_MONTH", "2026-06")
STRICT_IMPORT_CHECK = os.environ.get("STRICT_IMPORT_CHECK") == "1"


def add_month(month: str) -> str:
    year, month_number = (int(part) for part in month.split("-"))
    month_number += 1
    if month_number > 12:
        year += 1
        month_number = 1
    return f"{year:04d}-{month_number:02d}"


def month_range(start: str, end: str) -> list[str]:
    result = []
    current = start
    while current <= end:
        result.append(current)
        current = add_month(current)
    return result


def base_amount(month: str) -> int:
    return 1000 if month >= "2026-07" else 500


def charge_amount(month: str, extra_by_month: dict[str, int], override_by_month: dict[str, int]) -> int:
    if month in override_by_month:
        return override_by_month[month]
    return base_amount(month) + extra_by_month.get(month, 0)


def main() -> None:
    if not DB_PATH.exists():
        raise SystemExit("Database not found. Run npm run init-db && npm run import:excel first.")

    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        payments_count, payments_total = conn.execute("SELECT COUNT(*), COALESCE(SUM(amount), 0) FROM payments").fetchone()
        expenses_count, expenses_total = conn.execute("SELECT COUNT(*), COALESCE(SUM(amount), 0) FROM expenses").fetchone()
        houses_count = conn.execute("SELECT COUNT(*) FROM houses WHERE status = 'active'").fetchone()[0]
        duplicate_access_codes = conn.execute(
            """
            SELECT COUNT(*)
            FROM (
                SELECT access_code
                FROM houses
                GROUP BY access_code
                HAVING COUNT(*) > 1
            )
            """
        ).fetchone()[0]
        extras = defaultdict(int)
        for row in conn.execute("SELECT month, amount FROM monthly_charges WHERE kind = 'extra'"):
            extras[row["month"]] += int(row["amount"])
        overrides = {
            row["month"]: int(row["amount"])
            for row in conn.execute("SELECT month, amount FROM monthly_charges WHERE kind = 'override'")
        }

        total_debt = 0
        total_overpaid = 0
        by_house: dict[int, dict[str, int]] = {}
        for house in conn.execute("SELECT id, number, starts_on FROM houses ORDER BY number"):
            due = sum(charge_amount(month, extras, overrides) for month in month_range(house["starts_on"], AS_OF_MONTH))
            paid = conn.execute("SELECT COALESCE(SUM(amount), 0) FROM payments WHERE house_id = ?", (house["id"],)).fetchone()[0]
            debt = max(due - paid, 0)
            overpaid = max(paid - due, 0)
            total_debt += debt
            total_overpaid += overpaid
            by_house[int(house["number"])] = {"due": due, "paid": paid, "debt": debt, "overpaid": overpaid}

    failed = []
    checks = {
        "active houses": houses_count,
        "payments count": payments_count,
        "payments total": payments_total,
        "expenses count": expenses_count,
        "expenses total": expenses_total,
        "balance": payments_total - expenses_total,
        "total debt": total_debt,
        "total overpaid": total_overpaid,
        "duplicate access codes": duplicate_access_codes,
    }

    if houses_count <= 0:
        failed.append("active houses: expected at least 1")
    if payments_count <= 0:
        failed.append("payments count: expected at least 1")
    if expenses_count <= 0:
        failed.append("expenses count: expected at least 1")
    if payments_total < 0 or expenses_total < 0:
        failed.append("totals: expected non-negative payment and expense totals")
    if total_debt < 0 or total_overpaid < 0:
        failed.append("balances: expected non-negative debt and overpaid totals")
    if duplicate_access_codes:
        failed.append(f"duplicate access codes: expected 0, got {duplicate_access_codes}")

    if STRICT_IMPORT_CHECK:
        strict_checks = {
            "active houses": (houses_count, 19),
            "payments count": (payments_count, 222),
            "payments total": (payments_total, 233150),
            "expenses count": (expenses_count, 15),
            "expenses total": (expenses_total, 169874),
            "balance": (payments_total - expenses_total, 63276),
            "total debt": (total_debt, 17650),
            "total overpaid": (total_overpaid, 4800),
            "house 36 debt": (by_house[36]["debt"], 500),
            "house 26 debt": (by_house[26]["debt"], 0),
        }
        for name, (actual, expected) in strict_checks.items():
            if actual != expected:
                failed.append(f"{name}: expected {expected}, got {actual}")

    if failed:
        raise SystemExit("Smoke check failed:\n" + "\n".join(failed))

    print("Smoke check passed")
    for name, actual in checks.items():
        print(f"- {name}: {actual}")


if __name__ == "__main__":
    main()
