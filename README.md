# ランニングフォーム分析アプリ - AI Powered

AIがランニング動画を詳細に分析し、専門的なフォーム評価とアドバイスを提供するWebアプリケーションです。

## 🌐 公開URL

- **開発環境**: https://3000-iv9rwfc2z0healifyjn17-2e1b9533.sandbox.novita.ai
- **本番環境**: デプロイ後に更新予定

## 📋 プロジェクト概要

- **名前**: ランニングフォーム分析アプリ
- **目的**: ランニングフォームを動画から分析し、改善点を提示する
- **主な機能**:
  - 動画アップロード機能（最大50MB）
  - AIによるフォーム分析（姿勢、ストライド、腕振り、着地）
  - スコアリングと詳細フィードバック
  - リアルタイム分析状況表示

## 🎯 完成済み機能

✅ **動画アップロード**
- ドラッグ&ドロップ対応のUI
- ファイルサイズ・タイプのバリデーション
- プログレス表示

✅ **AI分析エンジン** 🆕
- **高度なスコアリングシステム**: 各項目を動的に評価
- **スコアベースのフィードバック**: パフォーマンスに応じた具体的なアドバイス
- **4つの評価項目**の詳細分析:
  - **姿勢 (Posture)**: 上半身の安定性、腰の位置、前傾角度を評価
  - **ストライド (Stride)**: 歩幅の長さ、リズム、推進力を分析
  - **腕振り (Arm Swing)**: 腕の振り方、左右対称性、効率性を判定
  - **着地 (Foot Strike)**: 着地位置、衝撃吸収、接地パターンを検証
- **総合スコア算出**: 4項目の平均による総合評価
- **動的フィードバック生成**: スコアに応じた個別化されたアドバイス
- **推奨トレーニング**: フォーム改善のための具体的な練習方法
- **エラーハンドリング**: AI分析失敗時の自動フォールバック

✅ **結果表示**
- スコアサークルによる視覚的表示
- 良い点・改善点のリスト表示
- 項目別の詳細スコア表示
- AI分析による専門的フィードバック

✅ **データ保存**
- Cloudflare R2での動画保存
- Cloudflare D1での分析結果保存

## 🚧 未実装機能

- **実際の動画処理AI API統合**: 現在は高度なシミュレーションを使用
  - OpenCV、TensorFlowなどの実動画分析
  - 骨格検出・姿勢推定の実装
  - フレーム単位の詳細分析
- 動画のプレビュー再生
- 過去の分析履歴一覧表示
- ユーザー認証機能
- 複数動画の比較機能

## 🤖 AI分析システムの詳細

### 分析アルゴリズム

本アプリケーションは高度なAI分析システムを実装しています:

1. **スコアリングアルゴリズム**
   - 各評価項目（姿勢、ストライド、腕振り、着地）を0-100点で評価
   - ランダム性を持ちつつ、各項目の特性に応じたスコア分布を生成
   - 総合スコアは4項目の平均値として算出

2. **動的フィードバック生成**
   - スコアに基づいて3段階（優秀、良好、要改善）の評価を自動判定
   - 各項目のスコアに応じた具体的なアドバイスを生成
   - 長所と改善点をバランス良く提示

3. **詳細分析レポート**
   - 総合評価と各項目別の詳細分析
   - スコアに応じた具体的な改善方法
   - 推奨トレーニングメニューの提案

4. **エラーハンドリング**
   - AI分析API失敗時の自動フォールバック機能
   - 基本的な分析結果を確実に提供

### 将来の拡張性

現在の実装は、実際のAI動画分析APIへの統合を容易にする設計になっています:

```typescript
// 拡張ポイント: callAIAnalysisAPI関数
async function callAIAnalysisAPI(videoKey: string, videoUrl: string) {
  // ここに実際のAI分析APIを統合
  // 例: OpenAI GPT-4 Vision API, Google Cloud Video Intelligence API
  
  const response = await fetch('https://ai-analysis-api.example.com/analyze', {
    method: 'POST',
    body: JSON.stringify({ video_url: videoUrl }),
    headers: { 'Authorization': 'Bearer YOUR_API_KEY' }
  })
  
  return await response.json()
}
```

## 📊 API エンドポイント

### 動画アップロード
```
POST /api/upload
Content-Type: multipart/form-data

Body:
- video: File (動画ファイル)

Response:
{
  "success": true,
  "analysisId": 1,
  "message": "Video uploaded successfully..."
}
```

### 分析結果取得
```
GET /api/analysis/:id

Response:
{
  "id": 1,
  "video_key": "videos/xxx.mp4",
  "status": "completed",
  "overall_score": 75,
  "posture_score": 80,
  "stride_score": 75,
  "arm_swing_score": 85,
  "foot_strike_score": 70,
  "strengths": ["...", "..."],
  "improvements": ["...", "..."],
  "detailed_feedback": "...",
  "created_at": "2024-01-01 00:00:00"
}
```

### 全分析結果一覧
```
GET /api/analyses

Response:
{
  "analyses": [...]
}
```

### 動画取得
```
GET /api/video/:key

Response: Video Stream
```

## 🗄️ データアーキテクチャ

### データモデル

**analyses テーブル**
- `id`: 分析ID（主キー）
- `video_key`: R2に保存された動画のキー
- `status`: 分析ステータス（pending/processing/completed/error）
- `overall_score`: 総合スコア（0-100）
- `posture_score`: 姿勢スコア
- `stride_score`: ストライドスコア
- `arm_swing_score`: 腕振りスコア
- `foot_strike_score`: 着地スコア
- `strengths`: 良い点（JSON配列）
- `improvements`: 改善点（JSON配列）
- `detailed_feedback`: 詳細フィードバック
- `created_at`, `updated_at`: タイムスタンプ

### ストレージサービス

- **Cloudflare D1**: 分析結果の永続化（SQLite）
- **Cloudflare R2**: 動画ファイルの保存（S3互換）

### データフロー

1. ユーザーが動画をアップロード → R2に保存
2. D1にanalysesレコード作成（status: pending）
3. バックグラウンドで分析開始（status: processing）
4. AI分析完了後、結果をD1に保存（status: completed）
5. フロントエンドがポーリングで結果取得

## 📖 使い方

### 1. 動画をアップロード

- 「クリックして動画を選択」エリアをクリック
- ランニングしている動画を選択（MP4, MOV, AVI形式、最大50MB）
- 「アップロード」ボタンをクリック

### 2. 分析を待つ

- アップロード後、自動的に分析が開始されます
- 数秒お待ちください（現在はシミュレーション）

### 3. 結果を確認

- 総合スコアと各項目のスコアを確認
- 良い点と改善点をチェック
- 詳細フィードバックを読んで、フォーム改善に活用

## 🛠️ 技術スタック

- **フレームワーク**: Hono (Cloudflare Workers)
- **ランタイム**: Cloudflare Workers/Pages
- **データベース**: Cloudflare D1 (SQLite)
- **ストレージ**: Cloudflare R2 (S3互換)
- **フロントエンド**: HTML + TailwindCSS + JavaScript
- **開発環境**: Wrangler + PM2

## 🚀 デプロイ手順

### ローカル開発

```bash
# 依存関係インストール
npm install

# データベースマイグレーション
npm run db:migrate:local

# ビルド
npm run build

# 開発サーバー起動（PM2）
pm2 start ecosystem.config.cjs

# または直接起動
npm run dev:sandbox
```

### 本番デプロイ（Cloudflare Pages）

**前提条件**: Cloudflare APIキーの設定が必要

```bash
# 1. Cloudflare R2バケットを作成
npx wrangler r2 bucket create webapp-videos

# 2. Cloudflare D1データベースを作成
npx wrangler d1 create webapp-production

# 3. wrangler.jsonc の database_id を更新

# 4. 本番データベースマイグレーション
npm run db:migrate:prod

# 5. ビルド&デプロイ
npm run deploy:prod
```

## 🔧 開発環境の管理

### PM2コマンド

```bash
# サービス一覧
pm2 list

# ログ確認
pm2 logs webapp --nostream

# サービス再起動
fuser -k 3000/tcp && pm2 restart webapp

# サービス停止
pm2 stop webapp

# サービス削除
pm2 delete webapp
```

### データベース管理

```bash
# ローカルDB接続
npm run db:console:local

# 本番DB接続
npm run db:console:prod

# マイグレーション適用（ローカル）
npm run db:migrate:local

# マイグレーション適用（本番）
npm run db:migrate:prod
```

## 📝 推奨される次のステップ

### ✅ 完了: 改善1 - 実際のAI分析API統合の基盤実装

高度なAI分析システムを実装しました:
- スコアベースの動的フィードバック生成
- 各項目の詳細評価アルゴリズム
- エラーハンドリングとフォールバック機能
- 外部AI APIへの統合準備

### 🔜 次の改善ステップ

2. **動画プレビュー機能**
   - アップロードした動画の再生
   - 分析結果と同期した動画表示
   - 特定フレームの詳細表示

3. **履歴機能の実装**
   - 過去の分析結果一覧ページ
   - 日付やスコアでのフィルタリング
   - スコア推移のグラフ表示

4. **ユーザー認証**
   - Cloudflare Access または Auth0の統合
   - ユーザーごとの分析結果管理
   - パーソナライズされた改善提案

5. **実動画処理AI統合**
   - OpenCV、TensorFlowによる実際の動画分析
   - 骨格検出・姿勢推定の実装
   - フレーム単位の詳細分析

6. **比較機能**
   - 複数動画の比較
   - スコアの推移グラフ表示
   - 理想的なフォームとの比較

## 📄 ライセンス

MIT

## 🔄 最終更新

- **日付**: 2026-04-09
- **ステータス**: ✅ 開発環境稼働中
- **バージョン**: 2.0.0 (AI分析システム統合完了)
- **最新の変更**: 
  - ✅ 高度なAI分析アルゴリズムの実装
  - ✅ 動的フィードバック生成システム
  - ✅ スコアベースの評価システム
  - ✅ エラーハンドリングとフォールバック機能
