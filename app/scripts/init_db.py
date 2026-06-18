from __future__ import annotations

import sqlite3
import os
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.environ.get("DB_PATH", APP_DIR / "db" / "water.sqlite"))
DB_DIR = DB_PATH.parent
SCHEMA_PATH = APP_DIR / "db" / "schema.sql"


def init_db() -> Path:
    DB_DIR.mkdir(parents=True, exist_ok=True)
    schema = SCHEMA_PATH.read_text(encoding="utf-8")
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.executescript(schema)
    return DB_PATH


def main() -> None:
    db_path = init_db()
    print(f"Initialized SQLite database: {db_path}")


if __name__ == "__main__":
    main()
