-- ユーザーテーブル
CREATE TABLE IF NOT EXISTS users (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  email     TEXT    UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,       -- PBKDF2-SHA256 (hex)
  password_salt TEXT NOT NULL,       -- ランダムsalt (hex)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- セッションテーブル
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    PRIMARY KEY,    -- UUID v4
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
