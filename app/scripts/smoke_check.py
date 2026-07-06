from __future__ import annotations

import sqlite3
import os
from collections import defaultdict
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.environ.get("DB_PATH", APP_DIR / "db" / "water.sqlite"))
AS_OF_MONTH = os.environ.get("AS_OF_MONTH", "2026-06")


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


def can_link_multiple_accounts_to_house(conn: sqlite3.Connection, table: str, user_id_column: str) -> bool | None:
    house = conn.execute("SELECT id FROM houses WHERE status = 'active' ORDER BY number LIMIT 1").fetchone()
    if not house:
        return None

    first_user_id = f"smoke-{table}-1"
    second_user_id = f"smoke-{table}-2"
    cursor = conn.cursor()
    cursor.execute(f"SAVEPOINT smoke_{table}_links")
    try:
        cursor.execute(
            f"INSERT INTO {table} ({user_id_column}, linked_house_id) VALUES (?, ?)",
            (first_user_id, house["id"]),
        )
        cursor.execute(
            f"INSERT INTO {table} ({user_id_column}, linked_house_id) VALUES (?, ?)",
            (second_user_id, house["id"]),
        )
        linked_count = cursor.execute(
            f"""
            SELECT COUNT(*)
            FROM {table}
            WHERE linked_house_id = ?
              AND {user_id_column} IN (?, ?)
            """,
            (house["id"], first_user_id, second_user_id),
        ).fetchone()[0]
        return linked_count == 2
    except sqlite3.IntegrityError:
        return False
    finally:
        cursor.execute(f"ROLLBACK TO SAVEPOINT smoke_{table}_links")
        cursor.execute(f"RELEASE SAVEPOINT smoke_{table}_links")


def main() -> None:
    if not DB_PATH.exists():
        raise SystemExit("Database not found. Run npm run init-db first.")

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
        telegram_multi_link = can_link_multiple_accounts_to_house(conn, "telegram_users", "telegram_user_id")
        max_multi_link = can_link_multiple_accounts_to_house(conn, "max_users", "max_user_id")
        extras = defaultdict(int)
        for row in conn.execute("SELECT month, amount FROM monthly_charges WHERE kind = 'extra'"):
            extras[row["month"]] += int(row["amount"])
        overrides = {
            row["month"]: int(row["amount"])
            for row in conn.execute("SELECT month, amount FROM monthly_charges WHERE kind = 'override'")
        }

        total_debt = 0
        total_overpaid = 0
        for house in conn.execute("SELECT id, number, starts_on FROM houses ORDER BY number"):
            start_month = house["starts_on"] or AS_OF_MONTH
            due = sum(charge_amount(month, extras, overrides) for month in month_range(start_month, AS_OF_MONTH))
            paid = conn.execute("SELECT COALESCE(SUM(amount), 0) FROM payments WHERE house_id = ?", (house["id"],)).fetchone()[0]
            debt = max(due - paid, 0)
            overpaid = max(paid - due, 0)
            total_debt += debt
            total_overpaid += overpaid

    failed = []
    telegram_multi_link_status = "skipped" if telegram_multi_link is None else "ok" if telegram_multi_link else "failed"
    max_multi_link_status = "skipped" if max_multi_link is None else "ok" if max_multi_link else "failed"
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
        "multiple Telegram users per house": telegram_multi_link_status,
        "multiple MAX users per house": max_multi_link_status,
    }

    if payments_total < 0 or expenses_total < 0:
        failed.append("totals: expected non-negative payment and expense totals")
    if total_debt < 0 or total_overpaid < 0:
        failed.append("balances: expected non-negative debt and overpaid totals")
    if duplicate_access_codes:
        failed.append(f"duplicate access codes: expected 0, got {duplicate_access_codes}")
    if telegram_multi_link is False:
        failed.append("multiple Telegram users per house: expected allowed")
    if max_multi_link is False:
        failed.append("multiple MAX users per house: expected allowed")

    if failed:
        raise SystemExit("Smoke check failed:\n" + "\n".join(failed))

    print("Smoke check passed")
    for name, actual in checks.items():
        print(f"- {name}: {actual}")


if __name__ == "__main__":
    main()
