-- Analyses table - ランニングフォーム分析結果を保存
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_key TEXT NOT NULL,           -- R2に保存された動画のキー
  video_url TEXT,                     -- R2動画のURL（オプション）
  status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, completed, error
  
  -- 分析結果
  overall_score INTEGER,              -- 総合スコア（0-100）
  posture_score INTEGER,              -- 姿勢スコア
  stride_score INTEGER,               -- ストライドスコア
  arm_swing_score INTEGER,            -- 腕振りスコア
  foot_strike_score INTEGER,          -- 着地スコア
  
  -- AIからのアドバイス
  strengths TEXT,                     -- 良い点（JSON配列）
  improvements TEXT,                  -- 改善点（JSON配列）
  detailed_feedback TEXT,             -- 詳細フィードバック
  
  -- メタデータ
  analysis_data TEXT,                 -- 完全な分析データ（JSON）
  error_message TEXT,                 -- エラーメッセージ
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_analyses_status ON analyses(status);
CREATE INDEX IF NOT EXISTS idx_analyses_created_at ON analyses(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analyses_video_key ON analyses(video_key);
