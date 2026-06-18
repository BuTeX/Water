PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS houses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  starts_on TEXT,
  access_code TEXT NOT NULL UNIQUE,
  public_notes TEXT DEFAULT '',
  private_notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contribution_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  effective_from_month TEXT NOT NULL,
  effective_to_month TEXT,
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(effective_from_month, amount)
);

CREATE TABLE IF NOT EXISTS monthly_charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  kind TEXT NOT NULL DEFAULT 'extra',
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  applies_to TEXT NOT NULL DEFAULT 'all_active_houses',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(month, kind, title)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  house_id INTEGER NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  paid_at TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  method TEXT NOT NULL DEFAULT 'other',
  comment_public TEXT DEFAULT '',
  comment_private TEXT DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS expense_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spent_at TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  category_id INTEGER REFERENCES expense_categories(id),
  title TEXT NOT NULL,
  description_public TEXT DEFAULT '',
  description_private TEXT DEFAULT '',
  vendor TEXT DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payments_house_paid_at ON payments(house_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_allocations_payment_month ON payment_allocations(payment_id, month);
CREATE INDEX IF NOT EXISTS idx_expenses_spent_at ON expenses(spent_at);
CREATE INDEX IF NOT EXISTS idx_houses_access_code ON houses(access_code);

INSERT OR IGNORE INTO contribution_rates (amount, effective_from_month, effective_to_month, description)
VALUES
  (500, '2025-05', '2026-06', 'Базовый взнос до июня 2026 включительно'),
  (1000, '2026-07', NULL, 'Базовый взнос с июля 2026');

INSERT OR IGNORE INTO monthly_charges (month, amount, kind, title, description, applies_to)
VALUES
  ('2025-05', 2300, 'extra', 'Дополнительный сбор за май 2025', 'Непредвиденные расходы сверх базового взноса', 'all_active_houses'),
  ('2025-07', 3000, 'extra', 'Дополнительный сбор за июль 2025', 'Непредвиденные расходы сверх базового взноса', 'all_active_houses'),
  ('2025-12', 2000, 'extra', 'Дополнительный сбор за декабрь 2025', 'Непредвиденные расходы сверх базового взноса', 'all_active_houses');

INSERT OR IGNORE INTO expense_categories (name)
VALUES
  ('ремонт'),
  ('насос'),
  ('скважина'),
  ('электрика'),
  ('материалы'),
  ('обслуживание'),
  ('прочее');
