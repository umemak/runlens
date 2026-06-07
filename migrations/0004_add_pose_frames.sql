-- analyses に骨格フレームデータカラムを追加
ALTER TABLE analyses ADD COLUMN pose_frames TEXT;  -- 圧縮済み poseFrames JSON
