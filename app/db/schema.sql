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

CREATE TABLE IF NOT EXISTS telegram_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL UNIQUE,
  username TEXT DEFAULT '',
  first_name TEXT DEFAULT '',
  last_name TEXT DEFAULT '',
  linked_house_id INTEGER REFERENCES houses(id) ON DELETE SET NULL,
  state TEXT DEFAULT '',
  state_payload TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_payment_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  house_id INTEGER NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  telegram_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT DEFAULT '',
  submitted_by_name TEXT DEFAULT '',
  amount INTEGER NOT NULL,
  paid_at TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'other',
  comment_public TEXT DEFAULT '',
  comment_private TEXT DEFAULT '',
  screenshot_file_id TEXT DEFAULT '',
  screenshot_file_unique_id TEXT DEFAULT '',
  screenshot_message_id TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  admin_telegram_user_id TEXT DEFAULT '',
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_link_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  house_id INTEGER NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  telegram_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT DEFAULT '',
  submitted_by_name TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  admin_telegram_user_id TEXT DEFAULT '',
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id TEXT DEFAULT '',
  telegram_message_id TEXT DEFAULT '',
  telegram_user_id TEXT DEFAULT '',
  chat_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT DEFAULT '',
  callback_data TEXT DEFAULT '',
  photo_file_id TEXT DEFAULT '',
  photo_file_unique_id TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS max_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  max_user_id TEXT NOT NULL UNIQUE,
  username TEXT DEFAULT '',
  first_name TEXT DEFAULT '',
  last_name TEXT DEFAULT '',
  linked_house_id INTEGER REFERENCES houses(id) ON DELETE SET NULL,
  state TEXT DEFAULT '',
  state_payload TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS max_payment_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  house_id INTEGER NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  max_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT DEFAULT '',
  submitted_by_name TEXT DEFAULT '',
  amount INTEGER NOT NULL,
  paid_at TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'other',
  comment_public TEXT DEFAULT '',
  comment_private TEXT DEFAULT '',
  screenshot_attachment TEXT DEFAULT '',
  screenshot_message_id TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  admin_max_user_id TEXT DEFAULT '',
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS max_link_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  house_id INTEGER NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  max_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT DEFAULT '',
  submitted_by_name TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  admin_max_user_id TEXT DEFAULT '',
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS max_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id TEXT DEFAULT '',
  max_message_id TEXT DEFAULT '',
  max_user_id TEXT DEFAULT '',
  chat_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT DEFAULT '',
  callback_payload TEXT DEFAULT '',
  attachment_json TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payments_house_paid_at ON payments(house_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_allocations_payment_month ON payment_allocations(payment_id, month);
CREATE INDEX IF NOT EXISTS idx_expenses_spent_at ON expenses(spent_at);
CREATE INDEX IF NOT EXISTS idx_houses_access_code ON houses(access_code);
CREATE INDEX IF NOT EXISTS idx_telegram_users_user_id ON telegram_users(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_telegram_claims_status ON telegram_payment_claims(status, created_at);
CREATE INDEX IF NOT EXISTS idx_telegram_claims_house ON telegram_payment_claims(house_id, created_at);
CREATE INDEX IF NOT EXISTS idx_telegram_link_claims_status ON telegram_link_claims(status, created_at);
CREATE INDEX IF NOT EXISTS idx_telegram_link_claims_user ON telegram_link_claims(telegram_user_id, status);
CREATE INDEX IF NOT EXISTS idx_telegram_messages_chat ON telegram_messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_telegram_messages_user ON telegram_messages(telegram_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_max_users_user_id ON max_users(max_user_id);
CREATE INDEX IF NOT EXISTS idx_max_claims_status ON max_payment_claims(status, created_at);
CREATE INDEX IF NOT EXISTS idx_max_claims_house ON max_payment_claims(house_id, created_at);
CREATE INDEX IF NOT EXISTS idx_max_link_claims_status ON max_link_claims(status, created_at);
CREATE INDEX IF NOT EXISTS idx_max_link_claims_user ON max_link_claims(max_user_id, status);
CREATE INDEX IF NOT EXISTS idx_max_messages_chat ON max_messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_max_messages_user ON max_messages(max_user_id, created_at);

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
