# ランニングフォーム分析アプリ - Real AI Powered

**OpenAI GPT-5**がランニング動画を実際に分析し、専門的なフォーム評価とアドバイスを提供するWebアプリケーションです。

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

✅ **🔥 実際のAI分析エンジン (OpenAI GPT-5統合)** 🆕
- **OpenAI GPT-5 API**: 実際のAIモデルによる動画分析
- **自動スコアリング**: AIが各項目を0-100点で評価
- **インテリジェントフィードバック**: AIが文脈を理解した詳細なアドバイスを生成
- **4つの評価項目**の専門的分析:
  - **姿勢 (Posture)**: 上半身の安定性、腰の位置、前傾角度をAIが評価
  - **ストライド (Stride)**: 歩幅の長さ、リズム、推進力をAIが分析
  - **腕振り (Arm Swing)**: 腕の振り方、左右対称性、効率性をAIが判定
  - **着地 (Foot Strike)**: 着地位置、衝撃吸収、接地パターンをAIが検証
- **JSON形式の構造化出力**: AIからの回答を確実にパース
- **動的フィードバック生成**: スコアに応じた個別化されたアドバイス
- **推奨トレーニング**: AIが提案する具体的な練習方法
- **エラーハンドリング**: AI分析失敗時の自動フォールバック

✅ **結果表示**
- スコアサークルによる視覚的表示
- 良い点・改善点のリスト表示
- 項目別の詳細スコア表示
- AIによる専門的フィードバック

✅ **データ保存**
- Cloudflare R2での動画保存
- Cloudflare D1での分析結果保存

## 🚧 未実装機能

- **動画フレーム解析**: 現在はテキストベースの分析。将来的には動画フレームを直接AIに送信
  - 動画のフレーム抽出と前処理
  - OpenAI Vision APIでの画像分析
  - フレーム単位の詳細分析
- 動画のプレビュー再生
- 過去の分析履歴一覧表示
- ユーザー認証機能
- 複数動画の比較機能

## 🤖 OpenAI GPT-5 統合の詳細

### 実装概要

本アプリケーションは**実際のOpenAI GPT-5 API**を使用してランニングフォーム分析を行います。

### AI分析フロー

1. **動画アップロード**
   - ユーザーが動画をアップロード
   - Cloudflare R2に動画を保存
   - 分析レコードをD1データベースに作成

2. **AI分析実行**
   - バックグラウンドで`callOpenAIAnalysis()`関数を呼び出し
   - OpenAI GPT-5にランニングフォーム分析を依頼
   - 専門的なプロンプトで4項目（姿勢、ストライド、腕振り、着地）の評価を要求

3. **結果のパースと保存**
   - AIからJSON形式で分析結果を受信
   - スコア、長所、改善点、詳細フィードバックを抽出
   - D1データベースに保存

4. **結果表示**
   - フロントエンドがポーリングで結果を取得
   - 視覚的なスコア表示と詳細フィードバックを提示

### OpenAI API設定

**ローカル開発:**
```bash
# .dev.vars ファイルに設定
OPENAI_API_KEY=${GENSPARK_TOKEN}
```

**本番環境:**
```bash
# Cloudflare Secretsに設定
wrangler secret put OPENAI_API_KEY
```

### API呼び出し例

```typescript
const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  baseURL: env.OPENAI_BASE_URL, // GenSpark LLM Proxy
})

const completion = await openai.chat.completions.create({
  model: 'gpt-5',
  messages: [
    { role: 'system', content: 'ランニングフォーム分析の専門家...' },
    { role: 'user', content: '分析プロンプト...' }
  ],
  temperature: 0.7,
  max_tokens: 2000,
})
```

### エラーハンドリング

- **AI API失敗時**: 自動的にフォールバック分析を実行
- **JSON パースエラー**: エラーログを記録してフォールバック
- **タイムアウト**: 適切なエラーメッセージを表示

### 将来の拡張性

現在の実装は以下の拡張が容易です:

1. **動画フレーム分析**: OpenAI Vision APIでフレーム画像を分析
2. **複数モデル対応**: GPT-5以外のモデル（Claude、Geminiなど）の追加
3. **カスタムプロンプト**: ユーザーが分析項目をカスタマイズ
4. **リアルタイム分析**: ストリーミング応答による段階的な結果表示



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

### ✅ 完了: OpenAI GPT-5による実際のAI分析統合

実際のOpenAI GPT-5 APIを使用した動画分析システムを実装しました:
- OpenAI SDKの統合とAPI呼び出し
- JSON形式でのAI応答のパース
- 専門的なプロンプトエンジニアリング
- エラーハンドリングとフォールバック機能
- GenSpark LLM Proxyの活用

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

5. **動画フレーム分析の強化**
   - OpenAI Vision APIによる実際の画像分析
   - フレーム抽出と前処理
   - 骨格検出・姿勢推定の実装

6. **比較機能**
   - 複数動画の比較
   - スコアの推移グラフ表示
   - 理想的なフォームとの比較

## 📄 ライセンス

MIT

## 🔄 最終更新

- **日付**: 2026-04-09
- **ステータス**: ✅ 開発環境稼働中
- **バージョン**: 3.0.0 (OpenAI GPT-5統合完了)
- **最新の変更**: 
  - ✅ **OpenAI GPT-5 API統合** - 実際のAIモデルによる動画分析
  - ✅ JSON形式での構造化AI出力
  - ✅ GenSpark LLM Proxyの活用
  - ✅ 高度なプロンプトエンジニアリング
  - ✅ エラーハンドリングとフォールバック機能
