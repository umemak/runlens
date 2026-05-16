-- analysesテーブルにuser_id・name・summaryカラムを追加
ALTER TABLE analyses ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE analyses ADD COLUMN name TEXT NOT NULL DEFAULT '無題のセッション';
ALTER TABLE analyses ADD COLUMN summary TEXT;   -- PoseSummary JSON
ALTER TABLE analyses ADD COLUMN vector TEXT;    -- 類似検索ベクトル JSON

CREATE INDEX IF NOT EXISTS idx_analyses_user_id ON analyses(user_id);
