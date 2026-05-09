import { Hono } from 'hono'
import { cors } from 'hono/cors'
import OpenAI from 'openai'

type Bindings = {
  DB: D1Database
  OPENAI_API_KEY: string
  OPENAI_BASE_URL: string
}

// ランドマークインデックス定義 (MediaPipe Pose 33点)
const POSE_LANDMARKS = {
  NOSE: 0,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,    RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,    RIGHT_WRIST: 16,
  LEFT_HIP: 23,      RIGHT_HIP: 24,
  LEFT_KNEE: 25,     RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,    RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,     RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32,
}

const app = new Hono<{ Bindings: Bindings }>()
app.use('/api/*', cors())

// ==========================================
// 座標ベース分析API（WASMから呼ぶ）
// ==========================================
app.post('/api/analyze-pose', async (c) => {
  try {
    const body = await c.req.json() as {
      summary: PoseSummary
      sampleFrames: FrameData[]
    }

    if (!body.summary || !body.sampleFrames) {
      return c.json({ error: 'Invalid pose data' }, 400)
    }

    // DBに分析レコードを作成
    const result = await c.env.DB.prepare(`
      INSERT INTO analyses (video_key, status) VALUES (?, 'processing')
    `).bind(`pose-${Date.now()}`).run()
    const analysisId = result.meta.last_row_id as number

    // 非同期でGPT-5分析
    c.executionCtx.waitUntil(
      analyzeWithGPT(c.env, analysisId, body.summary, body.sampleFrames)
    )

    return c.json({ success: true, analysisId })
  } catch (error) {
    console.error('analyze-pose error:', error)
    return c.json({ error: 'Failed to start analysis' }, 500)
  }
})

// 分析結果取得
app.get('/api/analysis/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const result = await c.env.DB.prepare(
      'SELECT * FROM analyses WHERE id = ?'
    ).bind(id).first()

    if (!result) return c.json({ error: 'Not found' }, 404)

    return c.json({
      ...result,
      strengths:    result.strengths    ? JSON.parse(result.strengths as string)    : [],
      improvements: result.improvements ? JSON.parse(result.improvements as string) : [],
    })
  } catch (error) {
    return c.json({ error: 'Failed to get analysis' }, 500)
  }
})

// ==========================================
// 型定義
// ==========================================
type Landmark = { x: number; y: number; z: number; visibility: number }
type FrameData = {
  timestamp: number
  landmarks: Landmark[]
  angles: {
    leftKnee: number; rightKnee: number
    leftElbow: number; rightElbow: number
    trunkLean: number
    leftHipAngle: number; rightHipAngle: number
  }
}
type PoseSummary = {
  frameCount: number
  fps: number
  duration: number
  avgAngles: FrameData['angles']
  minAngles: FrameData['angles']
  maxAngles: FrameData['angles']
  symmetryScore: number       // 左右対称性 0-1
  cadenceEstimate: number     // ストライド周期(fps換算)
  trunkStability: number      // 体幹安定度(分散の逆数)
  footStrikePattern: string   // 'forefoot' | 'midfoot' | 'heel'
}

// ==========================================
// GPT-5分析
// ==========================================
async function analyzeWithGPT(
  env: Bindings,
  analysisId: number,
  summary: PoseSummary,
  sampleFrames: FrameData[]
) {
  try {
    const openai = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_BASE_URL,
    })

    // サンプルフレーム（最大5フレーム）を抽出して可読化
    const frameDescriptions = sampleFrames.slice(0, 5).map((f, i) => `
フレーム${i + 1} (${f.timestamp.toFixed(2)}秒):
  左膝角度: ${f.angles.leftKnee.toFixed(1)}°  右膝角度: ${f.angles.rightKnee.toFixed(1)}°
  左肘角度: ${f.angles.leftElbow.toFixed(1)}°  右肘角度: ${f.angles.rightElbow.toFixed(1)}°
  体幹前傾: ${f.angles.trunkLean.toFixed(1)}°
  左股関節: ${f.angles.leftHipAngle.toFixed(1)}°  右股関節: ${f.angles.rightHipAngle.toFixed(1)}°
`.trim()).join('\n\n')

    const prompt = `
あなたはランニングバイオメカニクスの専門家です。
MediaPipe Pose（WASM）でブラウザ側から抽出した骨格座標データを基に、
ランニングフォームを厳密に分析してください。

## 分析データ（サマリー）
- 総フレーム数: ${summary.frameCount}フレーム（${summary.duration.toFixed(1)}秒）
- 平均体幹前傾角: ${summary.avgAngles.trunkLean.toFixed(1)}°（理想: 5〜10°）
- 平均左膝角度: ${summary.avgAngles.leftKnee.toFixed(1)}°  右膝: ${summary.avgAngles.rightKnee.toFixed(1)}°
- 平均左肘角度: ${summary.avgAngles.leftElbow.toFixed(1)}°  右肘: ${summary.avgAngles.rightElbow.toFixed(1)}°
- 平均股関節角度: 左 ${summary.avgAngles.leftHipAngle.toFixed(1)}°  右 ${summary.avgAngles.rightHipAngle.toFixed(1)}°
- 膝角度の範囲: ${summary.minAngles.leftKnee.toFixed(1)}°〜${summary.maxAngles.leftKnee.toFixed(1)}°
- 左右対称スコア: ${(summary.symmetryScore * 100).toFixed(1)}%（100%が完全対称）
- 体幹安定スコア: ${summary.trunkStability.toFixed(2)}（値が大きいほど安定）
- 着地パターン: ${summary.footStrikePattern === 'heel' ? 'ヒールストライク' : summary.footStrikePattern === 'midfoot' ? 'ミッドフット' : 'フォアフット'}

## サンプルフレームデータ
${frameDescriptions}

## 評価基準（参考）
- 膝の着地角度: 理想165〜175°（伸展しすぎず屈曲しすぎず）
- 体幹前傾: 理想5〜10°（過度な前傾・後傾は非効率）
- 肘角度: 理想85〜95°
- 左右対称: 90%以上が理想
- ヒールストライクは膝・腰への衝撃が大きい

上記データを元に以下のJSON形式のみで回答してください（余計な文章不要）:

{
  "posture_score": 85,
  "stride_score": 78,
  "arm_swing_score": 82,
  "foot_strike_score": 70,
  "strengths": [
    "具体的な数値を引用した良い点",
    "...",
    "..."
  ],
  "improvements": [
    "具体的な数値と理想値を示した改善点",
    "...",
    "..."
  ],
  "detailed_feedback": "総合評価: XX点\\n\\n【姿勢・体幹】\\n実測値を引用した詳細分析...\\n\\n【ストライド・膝】\\n...\\n\\n【腕振り】\\n...\\n\\n【着地パターン】\\n...\\n\\n【推奨トレーニング】\\n..."
}
`.trim()

    const completion = await openai.chat.completions.create({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'あなたはランニングバイオメカニクスの専門家です。実測データを根拠に具体的な分析をJSON形式で返してください。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.4,
      max_tokens: 2000,
    })

    const responseText = completion.choices[0]?.message?.content || ''
    const jsonMatch = responseText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON in response')

    const data = JSON.parse(jsonMatch[0])
    const overall = Math.round(
      (data.posture_score + data.stride_score + data.arm_swing_score + data.foot_strike_score) / 4
    )

    await env.DB.prepare(`
      UPDATE analyses SET
        status='completed', overall_score=?, posture_score=?, stride_score=?,
        arm_swing_score=?, foot_strike_score=?, strengths=?, improvements=?,
        detailed_feedback=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).bind(
      overall, data.posture_score, data.stride_score,
      data.arm_swing_score, data.foot_strike_score,
      JSON.stringify(data.strengths), JSON.stringify(data.improvements),
      data.detailed_feedback, analysisId
    ).run()

  } catch (error) {
    console.error('GPT analysis error:', error)
    await env.DB.prepare(`
      UPDATE analyses SET status='error', error_message=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).bind(String(error), analysisId).run()
  }
}

// ==========================================
// フロントエンド
// ==========================================
app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RunLens - AIランニングフォーム分析</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏃</text></svg>">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    .score-ring {
      width: 140px; height: 140px; border-radius: 50%;
      background: conic-gradient(
        #3b82f6 0deg,
        #3b82f6 calc(var(--pct, 0) * 3.6deg),
        #e5e7eb calc(var(--pct, 0) * 3.6deg)
      );
      display: flex; align-items: center; justify-content: center;
    }
    .score-inner {
      width: 112px; height: 112px; border-radius: 50%;
      background: white; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
    }
    .spinner {
      border: 3px solid #e5e7eb; border-top-color: #3b82f6;
      border-radius: 50%; width: 44px; height: 44px;
      animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    #skeletonCanvas { position: absolute; top:0; left:0; pointer-events:none; }
    #reviewCanvas   { position: absolute; top:0; left:0; pointer-events:none; width:100%; height:100%; }
    #cameraCanvas   { position: absolute; top:0; left:0; pointer-events:none; width:100%; height:100%; }
    .tab-btn { transition: all .2s; }
    .tab-btn.active { background:#3b82f6; color:white; }
    .tab-btn:not(.active) { background:transparent; color:#94a3b8; }
    .rec-dot { width:10px; height:10px; border-radius:50%; background:#ef4444;
               animation: recblink 1s ease-in-out infinite; display:inline-block; }
    @keyframes recblink { 0%,100%{opacity:1} 50%{opacity:.2} }
    .step-badge {
      width:28px; height:28px; border-radius:50%;
      background:#3b82f6; color:white; display:flex;
      align-items:center; justify-content:center;
      font-size:.8rem; font-weight:700; flex-shrink:0;
    }
  </style>
</head>
<body class="bg-gradient-to-br from-slate-900 to-blue-950 min-h-screen text-white">

<div class="max-w-3xl mx-auto px-4 py-10">

  <!-- ヘッダー -->
  <header class="text-center mb-10">
    <h1 class="text-4xl font-black tracking-tight mb-2">
      <i class="fas fa-running text-blue-400 mr-2"></i>RunLens
    </h1>
    <p class="text-slate-400">MediaPipe WASM によるブラウザ内ランニングフォーム分析</p>
  </header>

  <!-- タブ切替 -->
  <div class="bg-slate-800/60 rounded-2xl p-1.5 mb-6 flex gap-1">
    <button id="tabFileBtn" onclick="switchTab('file')"
      class="tab-btn active flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2">
      <i class="fas fa-file-video"></i>動画ファイル
    </button>
    <button id="tabCamBtn" onclick="switchTab('camera')"
      class="tab-btn flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2">
      <i class="fas fa-camera"></i>カメラ録画
    </button>
  </div>

  <!-- ─── 動画ファイルタブ ─── -->
  <section id="uploadSection" class="bg-slate-800/60 rounded-2xl p-8 mb-6">
    <h2 class="text-xl font-bold mb-5"><i class="fas fa-video text-blue-400 mr-2"></i>動画を選択</h2>
    <label for="videoInput"
      class="flex flex-col items-center justify-center border-2 border-dashed border-slate-600 rounded-xl p-10 cursor-pointer hover:border-blue-500 transition-colors">
      <i class="fas fa-cloud-upload-alt text-5xl text-slate-500 mb-3"></i>
      <p class="text-slate-300 mb-1">クリックして動画を選択</p>
      <p class="text-xs text-slate-500">MP4 / MOV / AVI（最大200MB）</p>
    </label>
    <input type="file" id="videoInput" accept="video/*" class="hidden">

    <!-- 選択後 -->
    <div id="fileInfo" class="hidden mt-4 bg-blue-900/40 rounded-xl p-4 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <i class="fas fa-file-video text-blue-400 text-2xl"></i>
        <div>
          <p id="fileName" class="font-medium text-sm"></p>
          <p id="fileSize" class="text-xs text-slate-400"></p>
        </div>
      </div>
      <button id="analyzeBtn" onclick="startAnalysis()"
        class="bg-blue-600 hover:bg-blue-500 px-5 py-2 rounded-lg font-semibold text-sm transition-colors">
        <i class="fas fa-brain mr-2"></i>骨格解析スタート
      </button>
    </div>
  </section>

  <!-- ─── カメラ録画タブ ─── -->
  <section id="cameraSection" class="hidden bg-slate-800/60 rounded-2xl p-6 mb-6">
    <h2 class="text-xl font-bold mb-4">
      <i class="fas fa-camera text-red-400 mr-2"></i>カメラでリアルタイム分析・録画
    </h2>

    <!-- カメラ映像 + 骨格オーバーレイ -->
    <div class="relative rounded-xl overflow-hidden bg-black aspect-video mb-4">
      <video id="cameraVideo" class="w-full h-full object-contain" muted playsinline autoplay></video>
      <canvas id="cameraCanvas"></canvas>
      <!-- REC バッジ -->
      <div id="recBadge" class="hidden absolute top-3 left-3 bg-black/70 rounded-lg px-3 py-1.5 flex items-center gap-2 text-sm font-bold">
        <span class="rec-dot"></span>REC
        <span id="recTimer" class="tabular-nums text-red-300 ml-1">0:00</span>
      </div>
      <!-- リアルタイムスコア -->
      <div id="liveScoreOverlay" class="hidden absolute top-3 right-3 bg-black/70 rounded-lg px-3 py-2 text-xs space-y-0.5">
        <div class="flex justify-between gap-4"><span class="text-slate-400">左膝</span><span id="camLeftKnee" class="text-cyan-300 font-bold tabular-nums">—</span></div>
        <div class="flex justify-between gap-4"><span class="text-slate-400">右膝</span><span id="camRightKnee" class="text-cyan-300 font-bold tabular-nums">—</span></div>
        <div class="flex justify-between gap-4"><span class="text-slate-400">体幹</span><span id="camTrunk" class="text-orange-300 font-bold tabular-nums">—</span></div>
        <div class="flex justify-between gap-4"><span class="text-slate-400">肘</span><span id="camElbow" class="text-purple-300 font-bold tabular-nums">—</span></div>
        <div class="flex justify-between gap-4"><span class="text-slate-400">対称</span><span id="camSym" class="text-green-300 font-bold tabular-nums">—</span></div>
      </div>
    </div>

    <!-- カメラ読み込み中 -->
    <div id="cameraLoading" class="text-center text-slate-400 text-sm mb-4">
      <i class="fas fa-circle-notch fa-spin mr-2"></i>カメラを準備中...
    </div>

    <!-- コントロール -->
    <div id="cameraControls" class="hidden space-y-3">
      <!-- カメラ選択 -->
      <div class="flex items-center gap-3">
        <label class="text-sm text-slate-400 w-20 flex-shrink-0">カメラ</label>
        <select id="cameraSelect" onchange="switchCamera(this.value)"
          class="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white">
        </select>
      </div>
      <!-- ボタン -->
      <div class="flex gap-3">
        <button id="startRecBtn" onclick="startCameraRec()"
          class="flex-1 bg-red-600 hover:bg-red-500 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-center gap-2">
          <span class="rec-dot"></span>録画開始
        </button>
        <button id="stopRecBtn" onclick="stopCameraRec()" disabled
          class="flex-1 bg-slate-600 py-3 rounded-xl font-bold text-sm transition-colors opacity-50 cursor-not-allowed flex items-center justify-center gap-2">
          <i class="fas fa-stop"></i>録画停止・分析
        </button>
      </div>
      <p class="text-xs text-slate-500 text-center">録画停止後、自動的に骨格解析して結果を表示します</p>
    </div>
  </section>

  <!-- 解析プログレス -->
  <section id="progressSection" class="hidden bg-slate-800/60 rounded-2xl p-8 mb-6">
    <h2 class="text-xl font-bold mb-6"><i class="fas fa-cogs text-yellow-400 mr-2"></i>解析中...</h2>

    <!-- MediaPipe進捗 -->
    <div class="mb-5">
      <div class="flex justify-between text-sm mb-1">
        <span id="wasmStatus" class="text-slate-300">MediaPipe WASMを読み込み中...</span>
        <span id="wasmPct" class="text-blue-400">0%</span>
      </div>
      <div class="h-2 bg-slate-700 rounded-full overflow-hidden">
        <div id="wasmBar" class="h-full bg-blue-500 rounded-full transition-all duration-300" style="width:0%"></div>
      </div>
    </div>

    <!-- プレビュー＋骨格描画 -->
    <div class="relative rounded-xl overflow-hidden bg-black aspect-video mb-5">
      <video id="previewVideo" class="w-full h-full object-contain" muted playsinline></video>
      <canvas id="skeletonCanvas"></canvas>
    </div>

    <!-- フレームカウンター -->
    <div class="text-center text-sm text-slate-400">
      <span id="frameCounter">フレーム処理中: 0</span>
    </div>
  </section>

  <!-- 分析結果 -->
  <section id="resultSection" class="hidden">

    <!-- ワイヤーフレームレビュー -->
    <div class="bg-slate-800/60 rounded-2xl p-6 mb-6">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-bold">
          <i class="fas fa-film text-cyan-400 mr-2"></i>ワイヤーフレームレビュー
        </h3>
        <label class="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none">
          <input type="checkbox" id="toggleOverlay" checked
            class="w-4 h-4 accent-cyan-400" onchange="onToggleOverlay(this.checked)">
          骨格表示
        </label>
      </div>

      <!-- 動画 + 骨格 canvas -->
      <div class="relative rounded-xl overflow-hidden bg-black aspect-video mb-4">
        <video id="reviewVideo" class="w-full h-full object-contain" muted playsinline></video>
        <canvas id="reviewCanvas"></canvas>
      </div>

      <!-- シークバー -->
      <div class="flex items-center gap-3 mb-3">
        <span id="reviewCurrentTime" class="text-xs text-slate-400 w-10 text-right tabular-nums">0.0s</span>
        <input type="range" id="reviewSeek" min="0" max="100" step="0.01" value="0"
          class="flex-1 accent-cyan-400 cursor-pointer h-2"
          oninput="onSeek(this.value)">
        <span id="reviewDuration" class="text-xs text-slate-400 w-10 tabular-nums">0.0s</span>
      </div>

      <!-- 再生コントロール -->
      <div class="flex items-center justify-center gap-3 mb-4">
        <button onclick="stepFrame(-1)"
          class="bg-slate-700 hover:bg-slate-600 w-10 h-10 rounded-lg text-sm transition-colors flex items-center justify-center"
          title="コマ戻し">
          <i class="fas fa-step-backward"></i>
        </button>
        <button id="playPauseBtn" onclick="togglePlayPause()"
          class="bg-cyan-600 hover:bg-cyan-500 px-8 h-10 rounded-lg font-semibold text-sm transition-colors">
          <i class="fas fa-play mr-1"></i>再生
        </button>
        <button onclick="stepFrame(1)"
          class="bg-slate-700 hover:bg-slate-600 w-10 h-10 rounded-lg text-sm transition-colors flex items-center justify-center"
          title="コマ送り">
          <i class="fas fa-step-forward"></i>
        </button>
        <select id="reviewSpeed" onchange="onSpeedChange(this.value)"
          class="bg-slate-700 border border-slate-600 rounded-lg px-3 h-10 text-sm text-white ml-2">
          <option value="0.25">0.25×</option>
          <option value="0.5">0.5×</option>
          <option value="1" selected>1×</option>
        </select>
      </div>

      <!-- リアルタイム角度パネル -->
      <div id="liveAngles" class="grid grid-cols-3 gap-2 pt-3 border-t border-slate-700 text-xs">
        <div class="bg-slate-700/50 rounded-lg p-2">
          <p class="text-slate-400 mb-0.5">左膝</p>
          <p id="laLeftKnee" class="font-bold text-cyan-300 tabular-nums">—</p>
        </div>
        <div class="bg-slate-700/50 rounded-lg p-2">
          <p class="text-slate-400 mb-0.5">右膝</p>
          <p id="laRightKnee" class="font-bold text-cyan-300 tabular-nums">—</p>
        </div>
        <div class="bg-slate-700/50 rounded-lg p-2">
          <p class="text-slate-400 mb-0.5">体幹前傾</p>
          <p id="laTrunk" class="font-bold text-orange-300 tabular-nums">—</p>
        </div>
        <div class="bg-slate-700/50 rounded-lg p-2">
          <p class="text-slate-400 mb-0.5">左肘</p>
          <p id="laLeftElbow" class="font-bold text-purple-300 tabular-nums">—</p>
        </div>
        <div class="bg-slate-700/50 rounded-lg p-2">
          <p class="text-slate-400 mb-0.5">右肘</p>
          <p id="laRightElbow" class="font-bold text-purple-300 tabular-nums">—</p>
        </div>
        <div class="bg-slate-700/50 rounded-lg p-2">
          <p class="text-slate-400 mb-0.5">左右対称</p>
          <p id="laSymmetry" class="font-bold text-green-300 tabular-nums">—</p>
        </div>
      </div>
    </div>

    <!-- 総合スコア -->
    <div class="bg-slate-800/60 rounded-2xl p-8 mb-6 text-center">
      <div class="score-ring mx-auto mb-3" id="overallRing">
        <div class="score-inner">
          <span id="overallScore" class="text-4xl font-black text-slate-800"></span>
          <span class="text-xs text-slate-500">/ 100</span>
        </div>
      </div>
      <h3 class="text-xl font-bold">総合スコア</h3>
      <p class="text-sm text-slate-400 mt-1">GPT-5 × MediaPipe骨格データによる分析</p>
    </div>

    <!-- 4項目スコア -->
    <div class="grid grid-cols-2 gap-4 mb-6">
      <div class="bg-slate-800/60 rounded-xl p-5 text-center">
        <i class="fas fa-male text-blue-400 text-2xl mb-2"></i>
        <p class="text-xs text-slate-400 mb-1">姿勢・体幹</p>
        <p class="text-3xl font-black"><span id="postureScore"></span><span class="text-base text-slate-400">点</span></p>
      </div>
      <div class="bg-slate-800/60 rounded-xl p-5 text-center">
        <i class="fas fa-shoe-prints text-green-400 text-2xl mb-2"></i>
        <p class="text-xs text-slate-400 mb-1">ストライド</p>
        <p class="text-3xl font-black"><span id="strideScore"></span><span class="text-base text-slate-400">点</span></p>
      </div>
      <div class="bg-slate-800/60 rounded-xl p-5 text-center">
        <i class="fas fa-hands text-purple-400 text-2xl mb-2"></i>
        <p class="text-xs text-slate-400 mb-1">腕振り</p>
        <p class="text-3xl font-black"><span id="armScore"></span><span class="text-base text-slate-400">点</span></p>
      </div>
      <div class="bg-slate-800/60 rounded-xl p-5 text-center">
        <i class="fas fa-walking text-orange-400 text-2xl mb-2"></i>
        <p class="text-xs text-slate-400 mb-1">着地</p>
        <p class="text-3xl font-black"><span id="footScore"></span><span class="text-base text-slate-400">点</span></p>
      </div>
    </div>

    <!-- 計測データ -->
    <div id="metricsCard" class="bg-slate-800/60 rounded-2xl p-6 mb-6">
      <h4 class="font-bold mb-4 text-slate-200"><i class="fas fa-ruler text-cyan-400 mr-2"></i>実測値サマリー</h4>
      <div id="metricsGrid" class="grid grid-cols-2 gap-3 text-sm"></div>
    </div>

    <!-- 良い点 -->
    <div class="bg-slate-800/60 rounded-2xl p-6 mb-6">
      <h4 class="font-bold mb-4 text-green-400"><i class="fas fa-check-circle mr-2"></i>良い点</h4>
      <ul id="strengthsList" class="space-y-3"></ul>
    </div>

    <!-- 改善点 -->
    <div class="bg-slate-800/60 rounded-2xl p-6 mb-6">
      <h4 class="font-bold mb-4 text-yellow-400"><i class="fas fa-lightbulb mr-2"></i>改善点</h4>
      <ul id="improvementsList" class="space-y-3"></ul>
    </div>

    <!-- 詳細フィードバック -->
    <div class="bg-gradient-to-br from-blue-900/50 to-purple-900/50 rounded-2xl p-6 mb-6">
      <h4 class="font-bold mb-4 text-blue-300"><i class="fas fa-comment-alt mr-2"></i>AI詳細フィードバック</h4>
      <pre id="detailedFeedback" class="whitespace-pre-wrap text-slate-300 text-sm leading-relaxed"></pre>
    </div>

    <!-- ダウンロード（カメラ録画時のみ表示） -->
    <div id="downloadBtnWrap" class="hidden mb-3">
      <button onclick="downloadRecording()"
        class="w-full bg-green-700 hover:bg-green-600 py-3 rounded-xl font-semibold transition-colors">
        <i class="fas fa-download mr-2"></i>録画動画をダウンロード保存
      </button>
    </div>

    <!-- もう一度 -->
    <button onclick="resetApp()" class="w-full bg-slate-700 hover:bg-slate-600 py-3 rounded-xl font-semibold transition-colors">
      <i class="fas fa-redo mr-2"></i>別の動画を分析する
    </button>
  </section>

  <!-- エラー表示 -->
  <div id="errorBox" class="hidden bg-red-900/60 rounded-2xl p-6 text-center">
    <i class="fas fa-exclamation-circle text-3xl text-red-400 mb-3"></i>
    <p id="errorMsg" class="text-red-300"></p>
    <button onclick="resetApp()" class="mt-4 bg-red-800 hover:bg-red-700 px-6 py-2 rounded-lg text-sm">やり直す</button>
  </div>

</div>

<!-- MediaPipe Tasks Vision (CDN) -->
<script type="module">
import { PoseLandmarker, FilesetResolver, DrawingUtils }
  from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs'

// ==========================================
// グローバル状態
// ==========================================
let poseLandmarker = null
let selectedFile   = null
let analysisId     = null
let poseFrames     = []      // 全フレームの角度データ
let drawUtils      = null

// レビュー用
let reviewDrawUtils   = null
let reviewCtx         = null
let reviewOverlayOn   = true
let reviewRafId       = null
let reviewVideoUrl    = null

// カメラ・録画用
let cameraStream      = null   // MediaStream
let mediaRecorder     = null   // MediaRecorder
let recordedChunks    = []     // 録画データ
let cameraRafId       = null   // requestAnimationFrame ID
let cameraDrawUtils   = null
let recStartTime      = null   // 録画開始時刻
let recTimerInterval  = null   // タイマー更新用
let currentDeviceId   = null   // 選択中カメラID

// ==========================================
// タブ切替
// ==========================================
window.switchTab = function(tab) {
  const isFile = tab === 'file'
  document.getElementById('tabFileBtn').classList.toggle('active', isFile)
  document.getElementById('tabCamBtn').classList.toggle('active', !isFile)
  document.getElementById('uploadSection').classList.toggle('hidden', !isFile)
  document.getElementById('cameraSection').classList.toggle('hidden', isFile)
  if (!isFile) initCamera()
  else stopCamera()
}

// ==========================================
// カメラ初期化・デバイス列挙
// ==========================================
async function initCamera() {
  // MediaPipe が未ロードなら先にロード
  if (!poseLandmarker) {
    document.getElementById('cameraLoading').textContent = 'MediaPipe WASMを読み込み中...'
    try {
      await initMediaPipe((pct, msg) => {
        document.getElementById('cameraLoading').textContent = msg
      })
    } catch(e) {
      document.getElementById('cameraLoading').textContent = 'MediaPipeの読み込みに失敗: ' + e.message
      return
    }
  }

  // mediaDevices API の存在確認
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraError(
      'お使いのブラウザはカメラAPIに対応していません。',
      'Chrome / Edge / Safari の最新版でお試しください。'
    )
    return
  }

  // video のみ → video+audio の順で段階的に試みる
  const attempts = [
    { video: true, audio: false },
    { video: true, audio: true },
  ]
  let stream = null
  let lastErr = null

  for (const c of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(c)
      break
    } catch(e) {
      lastErr = e
      console.warn('getUserMedia attempt failed:', c, e.name, e.message)
    }
  }

  if (!stream) {
    const name = lastErr?.name || 'Error'
    const msg  = lastErr?.message || ''
    let hint = ''
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      hint = [
        '\u2460 このページを <strong>ブラウザで直接</strong> 開いてください（iframeプレビュー内では動作しません）',
        '\u2461 URLをコピーして新しいタブに貼り付けてください',
        '\u2462 ブラウザのアドレスバー左の \u{1F512} アイコンからカメラを「許可」してください',
      ].join('<br>')
    } else if (name === 'NotFoundError') {
      hint = 'カメラデバイスが見つかりません。カメラが接続されているか確認してください。'
    } else if (name === 'NotReadableError') {
      hint = '別のアプリがカメラを使用中です。他のアプリを閉じてから再試行してください。'
    } else if (location.protocol !== 'https:') {
      hint = 'カメラはHTTPS接続が必要です。https:// のURLでアクセスしてください。'
    }
    showCameraError(name + (msg ? ': ' + msg : ''), hint)
    return
  }

  // 成功 — デバイス一覧を取得
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const cams = devices.filter(d => d.kind === 'videoinput')
    const sel = document.getElementById('cameraSelect')
    sel.innerHTML = cams.length
      ? cams.map((d, i) =>
          '<option value="' + d.deviceId + '">' + (d.label || 'カメラ ' + (i+1)) + '</option>'
        ).join('')
      : '<option value="">デフォルトカメラ</option>'
    currentDeviceId = cams[0]?.deviceId || null
  } catch(_) {}

  await openCameraWithStream(stream)
}

function showCameraError(errorText, hint) {
  const el = document.getElementById('cameraLoading')
  el.classList.remove('hidden')
  el.innerHTML = [
    '<div class="py-2">',
    '  <i class="fas fa-exclamation-triangle text-yellow-400 text-3xl mb-3"></i>',
    '  <p class="text-red-300 font-bold mb-2">カメラを起動できませんでした</p>',
    '  <p class="text-slate-400 text-xs font-mono mb-3">' + errorText + '</p>',
    hint
      ? '  <div class="text-left text-xs text-slate-300 bg-slate-700/70 rounded-xl p-4 mb-4 leading-relaxed">' + hint + '</div>'
      : '',
    '  <div class="text-xs text-slate-400 bg-slate-700/40 rounded-xl p-3 mb-4 text-left">',
    '    <p class="font-bold text-slate-300 mb-1"><i class="fas fa-link mr-1"></i>直接URLで開く</p>',
    '    <p class="font-mono text-blue-300 break-all select-all">' + location.href + '</p>',
    '  </div>',
    '  <button onclick="initCamera()" class="bg-blue-600 hover:bg-blue-500 px-6 py-2 rounded-lg text-sm font-semibold">',
    '    <i class="fas fa-redo mr-1"></i>再試行',
    '  </button>',
    '</div>',
  ].join('')
}

// カメラ切替用（デバイスID指定で再取得）
async function openCamera(deviceId) {
  if (cameraStream) cameraStream.getTracks().forEach(t => t.stop())
  if (cameraRafId)  { cancelAnimationFrame(cameraRafId); cameraRafId = null }

  let stream = null
  const attempts = [
    { video: deviceId ? { deviceId: { exact: deviceId } } : true, audio: false },
    { video: deviceId ? { deviceId: { exact: deviceId } } : true, audio: true  },
  ]
  for (const c of attempts) {
    try { stream = await navigator.mediaDevices.getUserMedia(c); break }
    catch(e) { console.warn('openCamera retry:', e.name) }
  }
  if (!stream) { showCameraError('カメラの切り替えに失敗しました', ''); return }
  await openCameraWithStream(stream)
}

// 取得済みストリームをセット＆ループ開始
async function openCameraWithStream(stream) {
  if (cameraStream) cameraStream.getTracks().forEach(t => t.stop())
  if (cameraRafId)  { cancelAnimationFrame(cameraRafId); cameraRafId = null }

  cameraStream = stream

  const cv = document.getElementById('cameraVideo')
  cv.srcObject = cameraStream
  await new Promise(res => cv.addEventListener('loadedmetadata', res, { once: true }))
  cv.play()

  // canvasサイズ合わせ
  const cc = document.getElementById('cameraCanvas')
  cc.width  = cv.videoWidth  || 640
  cc.height = cv.videoHeight || 480

  cameraDrawUtils = new DrawingUtils(cc.getContext('2d'))

  document.getElementById('cameraLoading').classList.add('hidden')
  document.getElementById('cameraControls').classList.remove('hidden')
  document.getElementById('liveScoreOverlay').classList.remove('hidden')

  startCameraLoop()
}

function startCameraLoop() {
  const cv  = document.getElementById('cameraVideo')
  const cc  = document.getElementById('cameraCanvas')
  const ctx = cc.getContext('2d')

  function loop() {
    cameraRafId = requestAnimationFrame(loop)
    if (cv.readyState < 2) return

    ctx.clearRect(0, 0, cc.width, cc.height)
    const result = poseLandmarker.detectForVideo(cv, performance.now())
    if (result.landmarks?.length > 0) {
      const lm = result.landmarks[0]
      cameraDrawUtils.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS,
        { color: '#00FF88', lineWidth: 2 })
      cameraDrawUtils.drawLandmarks(lm, { color: '#FF3366', radius: 3 })

      // 角度計算してオーバーレイ更新
      const ang = extractAngles(lm)
      const sym = Math.max(0, 1 - (
        Math.abs(ang.leftKnee  - ang.rightKnee)  +
        Math.abs(ang.leftElbow - ang.rightElbow)
      ) / 90) * 100
      document.getElementById('camLeftKnee').textContent  = ang.leftKnee.toFixed(1)  + '°'
      document.getElementById('camRightKnee').textContent = ang.rightKnee.toFixed(1) + '°'
      document.getElementById('camTrunk').textContent     = ang.trunkLean.toFixed(1) + '°'
      document.getElementById('camElbow').textContent     =
        ((ang.leftElbow + ang.rightElbow) / 2).toFixed(1) + '°'
      document.getElementById('camSym').textContent       = sym.toFixed(1) + '%'

      // キャンバスに角度テキストも描く
      drawAngleLabels(ctx, lm, ang, cc.width, cc.height)
    }
  }
  loop()
}

// カメラ切替
window.switchCamera = async function(deviceId) {
  currentDeviceId = deviceId
  await openCamera(deviceId)
}

// カメラ停止（タブ離脱時）
function stopCamera() {
  if (cameraRafId)  { cancelAnimationFrame(cameraRafId); cameraRafId = null }
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null }
  if (recTimerInterval) { clearInterval(recTimerInterval); recTimerInterval = null }
  document.getElementById('cameraLoading').classList.remove('hidden')
  document.getElementById('cameraLoading').textContent = 'カメラを準備中...'
  document.getElementById('cameraControls').classList.add('hidden')
  document.getElementById('liveScoreOverlay').classList.add('hidden')
}

// ==========================================
// 録画開始
// ==========================================
window.startCameraRec = function() {
  if (!cameraStream) return
  recordedChunks = []

  // サポートするMIMEタイプを選択
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    .find(m => MediaRecorder.isTypeSupported(m)) || ''

  mediaRecorder = new MediaRecorder(cameraStream, mime ? { mimeType: mime } : {})
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data) }
  mediaRecorder.start(100)   // 100ms ごとにチャンク

  recStartTime = Date.now()
  document.getElementById('recBadge').classList.remove('hidden')
  document.getElementById('startRecBtn').disabled = true
  document.getElementById('startRecBtn').classList.add('opacity-50', 'cursor-not-allowed')
  document.getElementById('stopRecBtn').disabled  = false
  document.getElementById('stopRecBtn').classList.remove('opacity-50', 'cursor-not-allowed')

  // タイマー表示
  recTimerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - recStartTime) / 1000)
    const mm = String(Math.floor(s / 60)).padStart(1, '0')
    const ss = String(s % 60).padStart(2, '0')
    document.getElementById('recTimer').textContent = mm + ':' + ss
  }, 500)
}

// ==========================================
// 録画停止 → 分析へ
// ==========================================
window.stopCameraRec = function() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return

  mediaRecorder.stop()
  clearInterval(recTimerInterval)
  document.getElementById('recBadge').classList.add('hidden')
  document.getElementById('startRecBtn').disabled = false
  document.getElementById('startRecBtn').classList.remove('opacity-50', 'cursor-not-allowed')
  document.getElementById('stopRecBtn').disabled  = true
  document.getElementById('stopRecBtn').classList.add('opacity-50', 'cursor-not-allowed')

  // カメラループを止めてストリームも解放
  if (cameraRafId) { cancelAnimationFrame(cameraRafId); cameraRafId = null }
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null }

  mediaRecorder.onstop = async () => {
    const mime = recordedChunks[0]?.type || 'video/webm'
    const blob = new Blob(recordedChunks, { type: mime })
    const ext  = mime.includes('mp4') ? 'mp4' : 'webm'

    // File オブジェクトに変換して既存の分析フローへ
    selectedFile = new File([blob], \`camera-rec-\${Date.now()}.\${ext}\`, { type: mime })

    // カメラUIを隠してファイルタブに切替（内部的に）
    hide('cameraSection')
    document.getElementById('tabFileBtn').classList.add('active')
    document.getElementById('tabCamBtn').classList.remove('active')

    // 分析開始
    await startAnalysis()
  }
}

// ==========================================
// ファイル選択
// ==========================================
document.getElementById('videoInput').addEventListener('change', e => {
  const file = e.target.files[0]
  if (!file) return
  selectedFile = file
  document.getElementById('fileName').textContent = file.name
  document.getElementById('fileSize').textContent = (file.size / 1024 / 1024).toFixed(2) + ' MB'
  document.getElementById('fileInfo').classList.remove('hidden')
})

// ==========================================
// MediaPipe 初期化
// ==========================================
async function initMediaPipe(onProgress) {
  onProgress(10, 'WASMファイルを読み込み中...')
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
  )
  onProgress(50, 'Poseモデルをロード中...')
  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
      delegate: 'GPU',
    },
    runningMode:            'VIDEO',
    numPoses:               1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence:  0.5,
    minTrackingConfidence:      0.5,
  })
  onProgress(100, 'MediaPipe 準備完了')
}

// ==========================================
// 角度計算ユーティリティ
// ==========================================
function angle3(a, b, c) {
  // b が頂点
  const v1 = { x: a.x - b.x, y: a.y - b.y }
  const v2 = { x: c.x - b.x, y: c.y - b.y }
  const dot  = v1.x * v2.x + v1.y * v2.y
  const mag  = Math.sqrt((v1.x**2 + v1.y**2) * (v2.x**2 + v2.y**2))
  if (mag === 0) return 0
  return (Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180) / Math.PI
}

function extractAngles(lm) {
  // 33点ランドマーク配列からインデックスで取得
  const L = i => lm[i]
  return {
    leftKnee:      angle3(L(23), L(25), L(27)),
    rightKnee:     angle3(L(24), L(26), L(28)),
    leftElbow:     angle3(L(11), L(13), L(15)),
    rightElbow:    angle3(L(12), L(14), L(16)),
    trunkLean:     angle3(L(23), L(11), { x: L(11).x, y: 0 }),  // 肩から垂直への角度
    leftHipAngle:  angle3(L(11), L(23), L(25)),
    rightHipAngle: angle3(L(12), L(24), L(26)),
  }
}

function detectFootStrike(frames) {
  if (frames.length === 0) return 'unknown'
  const avgKnee = frames.reduce((s, f) =>
    s + (f.angles.leftKnee + f.angles.rightKnee) / 2, 0) / frames.length
  if (avgKnee > 165) return 'heel'
  if (avgKnee > 150) return 'midfoot'
  return 'forefoot'
}

function avgAngles(frames) {
  if (frames.length === 0) return null
  const keys = Object.keys(frames[0].angles)
  const result = {}
  for (const k of keys) {
    result[k] = frames.reduce((s, f) => s + f.angles[k], 0) / frames.length
  }
  return result
}

function minMaxAngles(frames) {
  const keys = Object.keys(frames[0].angles)
  const mn = {}, mx = {}
  for (const k of keys) {
    const vals = frames.map(f => f.angles[k])
    mn[k] = Math.min(...vals)
    mx[k] = Math.max(...vals)
  }
  return { min: mn, max: mx }
}

function symmetryScore(frames) {
  if (frames.length === 0) return 0
  const diffs = frames.map(f =>
    Math.abs(f.angles.leftKnee  - f.angles.rightKnee) +
    Math.abs(f.angles.leftElbow - f.angles.rightElbow)
  )
  const avgDiff = diffs.reduce((s, d) => s + d, 0) / diffs.length
  return Math.max(0, 1 - avgDiff / 90)
}

function trunkStability(frames) {
  if (frames.length < 2) return 1
  const leans = frames.map(f => f.angles.trunkLean)
  const mean  = leans.reduce((s, v) => s + v, 0) / leans.length
  const variance = leans.reduce((s, v) => s + (v - mean) ** 2, 0) / leans.length
  return variance < 1 ? 10 : 1 / Math.sqrt(variance)
}

// ==========================================
// サンプルフレーム均等抽出
// ==========================================
function sampleFrames(frames, n = 10) {
  if (frames.length <= n) return frames
  const step = Math.floor(frames.length / n)
  return Array.from({ length: n }, (_, i) => frames[i * step])
}

// ==========================================
// メイン解析フロー
// ==========================================
window.startAnalysis = async function() {
  if (!selectedFile) return
  poseFrames = []

  show('progressSection')
  hide('uploadSection')
  hide('errorBox')

  const wasmBar    = document.getElementById('wasmBar')
  const wasmStatus = document.getElementById('wasmStatus')
  const wasmPct    = document.getElementById('wasmPct')

  // プログレスコールバック
  const onProgress = (pct, msg) => {
    wasmBar.style.width    = pct + '%'
    wasmPct.textContent    = pct + '%'
    wasmStatus.textContent = msg
  }

  try {
    await initMediaPipe(onProgress)
  } catch (e) {
    showError('MediaPipeの読み込みに失敗しました: ' + e.message)
    return
  }

  // 動画をcanvasに描画しながらフレーム処理
  const video  = document.getElementById('previewVideo')
  const canvas = document.getElementById('skeletonCanvas')
  const ctx    = canvas.getContext('2d')
  drawUtils = new DrawingUtils(ctx)

  const url = URL.createObjectURL(selectedFile)
  video.src = url

  await new Promise(res => video.addEventListener('loadedmetadata', res, { once: true }))

  canvas.width  = video.videoWidth
  canvas.height = video.videoHeight

  const frameCounter = document.getElementById('frameCounter')
  const FPS_SAMPLE   = 10   // 解析する疑似FPS
  const duration     = video.duration
  let   t            = 0
  let   frameCount   = 0

  // フレームごとに seek → detect
  onProgress(100, '骨格を検出中...')

  while (t < duration) {
    video.currentTime = t
    await new Promise(res => video.addEventListener('seeked', res, { once: true }))

    // Canvas に描画
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    const result = poseLandmarker.detectForVideo(video, t * 1000)

    if (result.landmarks && result.landmarks.length > 0) {
      const lm = result.landmarks[0]
      const wlm = result.worldLandmarks[0]

      // 骨格を描画
      drawUtils.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: '#00FF88', lineWidth: 2 })
      drawUtils.drawLandmarks(lm, { color: '#FF3366', radius: 4 })

      const angles = extractAngles(lm)
      poseFrames.push({ timestamp: t, landmarks: lm, angles })
      frameCount++
      frameCounter.textContent = 'フレーム処理中: ' + frameCount
    }

    t += 1 / FPS_SAMPLE
  }

  if (poseFrames.length === 0) {
    showError('骨格を検出できませんでした。人物が映っている動画をご使用ください。')
    return
  }

  // サマリー生成
  const avg  = avgAngles(poseFrames)
  const { min, max } = minMaxAngles(poseFrames)
  const summary = {
    frameCount:       poseFrames.length,
    fps:              FPS_SAMPLE,
    duration:         duration,
    avgAngles:        avg,
    minAngles:        min,
    maxAngles:        max,
    symmetryScore:    symmetryScore(poseFrames),
    cadenceEstimate:  0,
    trunkStability:   trunkStability(poseFrames),
    footStrikePattern: detectFootStrike(poseFrames),
  }

  onProgress(100, '解析完了！結果を計算中...')
  wasmStatus.textContent = '骨格データから評価を生成中...'

  // ブラウザ内でスコアを算出して表示（バックエンド不要）
  await new Promise(res => setTimeout(res, 500))
  const localResult = calcLocalScores(summary)
  showResult(localResult, summary)
}

// ==========================================
// ブラウザ内スコア算出（MediaPipe結果のみで計算）
// ==========================================
function calcLocalScores(summary) {
  // --- 姿勢スコア（体幹前傾角と安定度）---
  const trunkLean = summary.avgAngles.trunkLean
  const trunkIdeal = trunkLean >= 5 && trunkLean <= 10
  const trunkOk    = trunkLean >= 3 && trunkLean <= 15
  const postureScore = trunkIdeal ? 90 + Math.round(summary.trunkStability * 5)
                     : trunkOk    ? 70 + Math.round(summary.trunkStability * 5)
                                  : 50 + Math.round(summary.trunkStability * 5)
  const postureScoreClamped = Math.min(100, Math.max(30, postureScore))

  // --- ストライドスコア（膝角度の範囲と対称性）---
  const kneeRange   = summary.maxAngles.leftKnee - summary.minAngles.leftKnee
  const kneeRangeOk = kneeRange >= 20 && kneeRange <= 60
  const symPct      = summary.symmetryScore * 100
  const strideScore = Math.round(
    (kneeRangeOk ? 80 : 60) * 0.5 + symPct * 0.5
  )
  const strideScoreClamped = Math.min(100, Math.max(30, strideScore))

  // --- 腕振りスコア（肘角度）---
  const avgElbow = (summary.avgAngles.leftElbow + summary.avgAngles.rightElbow) / 2
  const elbowIdeal = avgElbow >= 80 && avgElbow <= 100
  const elbowOk    = avgElbow >= 70 && avgElbow <= 115
  const elbowSym   = Math.abs(summary.avgAngles.leftElbow - summary.avgAngles.rightElbow)
  const armScore   = (elbowIdeal ? 88 : elbowOk ? 72 : 55) - Math.round(elbowSym * 0.3)
  const armScoreClamped = Math.min(100, Math.max(30, armScore))

  // --- 着地スコア（着地パターン）---
  const footScoreMap = { forefoot: 90, midfoot: 82, heel: 62, unknown: 60 }
  const footScore = footScoreMap[summary.footStrikePattern] ?? 60

  const overall = Math.round(
    (postureScoreClamped + strideScoreClamped + armScoreClamped + footScore) / 4
  )

  // --- 良い点 ---
  const strengths = []
  if (trunkIdeal) strengths.push(\`体幹前傾角 \${trunkLean.toFixed(1)}° は理想範囲（5〜10°）です\`)
  if (symPct >= 90) strengths.push(\`左右対称性 \${symPct.toFixed(1)}% — バランスの良いフォームです\`)
  if (elbowIdeal) strengths.push(\`肘角度 \${avgElbow.toFixed(1)}° — 腕振りが適切です\`)
  if (summary.footStrikePattern === 'midfoot') strengths.push('ミッドフット着地でひざへの衝撃が少ないフォームです')
  if (summary.footStrikePattern === 'forefoot') strengths.push('フォアフット着地でランニングエコノミーに優れています')
  if (summary.trunkStability > 0.7) strengths.push(\`体幹安定スコア \${summary.trunkStability.toFixed(2)} — 上半身がぶれずに安定しています\`)
  if (strengths.length === 0) strengths.push('骨格データを取得できました。継続して計測すると傾向が把握できます')

  // --- 改善点 ---
  const improvements = []
  if (!trunkOk) {
    improvements.push(\`体幹前傾角 \${trunkLean.toFixed(1)}° — 理想は 5〜10°。\${trunkLean < 5 ? '少し前傾を増やすと推進力が上がります' : '前傾しすぎると腰への負担が増えます'}\`)
  }
  if (symPct < 85) {
    improvements.push(\`左右対称性 \${symPct.toFixed(1)}% — 90%以上が理想。左右のフォームのばらつきを減らしましょう\`)
  }
  if (!elbowOk) {
    improvements.push(\`肘角度 \${avgElbow.toFixed(1)}° — 理想は 85〜95°。肘を直角に近づけると腕振りが効率的になります\`)
  }
  if (summary.footStrikePattern === 'heel') {
    improvements.push('ヒールストライク着地は膝・腰への衝撃大。着地位置を体の真下に近づけることで改善できます')
  }
  if (kneeRange < 15) {
    improvements.push('膝の屈伸範囲が小さいです。ストライドを意識して膝をしっかり曲げると推進力が上がります')
  }
  if (improvements.length === 0) improvements.push('全体的にバランスの取れたフォームです。引き続き継続してください')

  // --- 詳細フィードバック ---
  const detailed = [
    \`総合評価: \${overall}点\`,
    '',
    '【姿勢・体幹】',
    \`体幹前傾角: \${trunkLean.toFixed(1)}°（理想 5〜10°）\`,
    \`体幹安定スコア: \${summary.trunkStability.toFixed(2)}\`,
    trunkIdeal ? '→ 理想的な前傾角度で推進力を最大化できています。' : \`→ 前傾角度を調整することでさらに効率が向上します。\`,
    '',
    '【ストライド・膝】',
    \`左膝平均: \${summary.avgAngles.leftKnee.toFixed(1)}°  右膝平均: \${summary.avgAngles.rightKnee.toFixed(1)}°\`,
    \`膝角度範囲: \${summary.minAngles.leftKnee.toFixed(1)}°〜\${summary.maxAngles.leftKnee.toFixed(1)}°\`,
    \`左右対称性: \${symPct.toFixed(1)}%\`,
    '',
    '【腕振り】',
    \`左肘: \${summary.avgAngles.leftElbow.toFixed(1)}°  右肘: \${summary.avgAngles.rightElbow.toFixed(1)}°（理想: 85〜95°）\`,
    elbowIdeal ? '→ 腕振りは理想的な角度です。' : '→ 肘をさらに直角に近づけましょう。',
    '',
    '【着地パターン】',
    \`着地タイプ: \${summary.footStrikePattern === 'heel' ? 'ヒールストライク' : summary.footStrikePattern === 'midfoot' ? 'ミッドフット' : 'フォアフット'}\`,
    summary.footStrikePattern === 'heel'
      ? '→ ヒールストライクは衝撃吸収には優れますが、ブレーキ力が生じます。重心の真下で着地する練習をしましょう。'
      : summary.footStrikePattern === 'midfoot'
      ? '→ ミッドフット着地でバランスの良いフォームです。'
      : '→ フォアフット着地でランニングエコノミーに優れています。',
    '',
    '【解析データ】',
    \`解析フレーム: \${summary.frameCount}フレーム / \${summary.duration.toFixed(1)}秒\`,
    '※ MediaPipe WASM によるブラウザ内骨格検出結果に基づく評価です',
  ].join('\\n')

  return {
    overall_score:    overall,
    posture_score:    postureScoreClamped,
    stride_score:     strideScoreClamped,
    arm_swing_score:  armScoreClamped,
    foot_strike_score: footScore,
    strengths,
    improvements,
    detailed_feedback: detailed,
  }
}

// ==========================================
// 結果表示
// ==========================================
function showResult(data, summary) {
  hide('progressSection')
  show('resultSection')

  // カメラ録画由来なら「ダウンロード」ボタンを表示
  const isRecorded = selectedFile?.name?.startsWith('camera-rec-')
  document.getElementById('downloadBtnWrap').classList.toggle('hidden', !isRecorded)

  // スコア
  document.getElementById('overallRing').style.setProperty('--pct', data.overall_score)
  document.getElementById('overallScore').textContent  = data.overall_score
  document.getElementById('postureScore').textContent  = data.posture_score
  document.getElementById('strideScore').textContent   = data.stride_score
  document.getElementById('armScore').textContent      = data.arm_swing_score
  document.getElementById('footScore').textContent     = data.foot_strike_score

  // 実測値サマリー
  const metrics = [
    ['体幹前傾角', summary.avgAngles.trunkLean.toFixed(1) + '°（理想: 5〜10°）'],
    ['左膝平均角', summary.avgAngles.leftKnee.toFixed(1) + '°'],
    ['右膝平均角', summary.avgAngles.rightKnee.toFixed(1) + '°'],
    ['左右対称性', (summary.symmetryScore * 100).toFixed(1) + '%'],
    ['体幹安定度', summary.trunkStability.toFixed(2)],
    ['着地パターン', summary.footStrikePattern === 'heel' ? 'ヒールストライク' : summary.footStrikePattern === 'midfoot' ? 'ミッドフット' : 'フォアフット'],
    ['解析フレーム数', summary.frameCount + ' フレーム'],
    ['動画時間', summary.duration.toFixed(1) + ' 秒'],
  ]
  document.getElementById('metricsGrid').innerHTML = metrics.map(([k, v]) => \`
    <div class="bg-slate-700/50 rounded-lg p-3">
      <p class="text-slate-400 text-xs mb-1">\${k}</p>
      <p class="font-semibold text-white text-sm">\${v}</p>
    </div>
  \`).join('')

  // 良い点
  document.getElementById('strengthsList').innerHTML =
    data.strengths.map(s => \`
      <li class="flex items-start gap-2">
        <i class="fas fa-check text-green-400 mt-1 flex-shrink-0"></i>
        <span class="text-slate-300 text-sm">\${s}</span>
      </li>
    \`).join('')

  // 改善点
  document.getElementById('improvementsList').innerHTML =
    data.improvements.map(s => \`
      <li class="flex items-start gap-2">
        <i class="fas fa-arrow-right text-yellow-400 mt-1 flex-shrink-0"></i>
        <span class="text-slate-300 text-sm">\${s}</span>
      </li>
    \`).join('')

  // 詳細フィードバック
  document.getElementById('detailedFeedback').textContent = data.detailed_feedback

  // ── ワイヤーフレームレビューをセットアップ ──
  setupReview()
}

// ==========================================
// ワイヤーフレームレビュー
// ==========================================
function setupReview() {
  const rv  = document.getElementById('reviewVideo')
  const rc  = document.getElementById('reviewCanvas')
  reviewCtx = rc.getContext('2d')
  reviewDrawUtils = new DrawingUtils(reviewCtx)

  // 動画ソースをセット（解析時と同じファイル）
  if (reviewVideoUrl) URL.revokeObjectURL(reviewVideoUrl)
  reviewVideoUrl = URL.createObjectURL(selectedFile)
  rv.src = reviewVideoUrl

  rv.addEventListener('loadedmetadata', () => {
    // canvas サイズを動画に合わせる
    rc.width  = rv.videoWidth
    rc.height = rv.videoHeight

    // シークバー最大値を動画時間に設定
    const seekEl = document.getElementById('reviewSeek')
    seekEl.max   = rv.duration
    document.getElementById('reviewDuration').textContent = rv.duration.toFixed(1) + 's'

    // 最初のフレームを描画
    renderReviewFrame()
  }, { once: true })

  // 再生中のループ描画
  rv.addEventListener('timeupdate', () => {
    document.getElementById('reviewSeek').value        = rv.currentTime
    document.getElementById('reviewCurrentTime').textContent = rv.currentTime.toFixed(1) + 's'
    renderReviewFrame()
  })

  rv.addEventListener('ended', () => {
    document.getElementById('playPauseBtn').innerHTML =
      '<i class="fas fa-play mr-1"></i>再生'
  })
}

// 現在フレームの骨格を描画し角度パネルを更新
function renderReviewFrame() {
  const rv  = document.getElementById('reviewVideo')
  const rc  = document.getElementById('reviewCanvas')

  reviewCtx.clearRect(0, 0, rc.width, rc.height)

  if (!reviewOverlayOn || !poseLandmarker) return

  // poseFrames から最近傍フレームを探す
  const t = rv.currentTime
  if (poseFrames.length === 0) return

  let nearest = poseFrames[0]
  let minDiff = Math.abs(poseFrames[0].timestamp - t)
  for (const f of poseFrames) {
    const d = Math.abs(f.timestamp - t)
    if (d < minDiff) { minDiff = d; nearest = f }
  }

  const lm = nearest.landmarks

  // 接続線（緑）
  reviewDrawUtils.drawConnectors(
    lm, PoseLandmarker.POSE_CONNECTIONS,
    { color: '#00FF88', lineWidth: 2 }
  )
  // ランドマーク点（赤ピンク）
  reviewDrawUtils.drawLandmarks(lm, { color: '#FF3366', radius: 3 })

  // 主要角度をキャンバス上にテキスト描画
  if (reviewOverlayOn) drawAngleLabels(reviewCtx, lm, nearest.angles, rc.width, rc.height)

  // 角度パネルを更新
  const a = nearest.angles
  const sym = Math.max(0, 1 - (Math.abs(a.leftKnee - a.rightKnee) + Math.abs(a.leftElbow - a.rightElbow)) / 90)
  document.getElementById('laLeftKnee').textContent   = a.leftKnee.toFixed(1)   + '°'
  document.getElementById('laRightKnee').textContent  = a.rightKnee.toFixed(1)  + '°'
  document.getElementById('laTrunk').textContent      = a.trunkLean.toFixed(1)  + '°'
  document.getElementById('laLeftElbow').textContent  = a.leftElbow.toFixed(1)  + '°'
  document.getElementById('laRightElbow').textContent = a.rightElbow.toFixed(1) + '°'
  document.getElementById('laSymmetry').textContent   = (sym * 100).toFixed(1)  + '%'
}

// キャンバス上に角度ラベルを描画
function drawAngleLabels(ctx, lm, angles, W, H) {
  const px = (lm, idx) => ({ x: lm[idx].x * W, y: lm[idx].y * H })

  const labels = [
    // [テキスト, ランドマーク番号, 色]
    [angles.leftKnee.toFixed(0)  + '°', 25, '#67e8f9'],   // 左膝
    [angles.rightKnee.toFixed(0) + '°', 26, '#67e8f9'],   // 右膝
    [angles.leftElbow.toFixed(0) + '°', 13, '#d8b4fe'],   // 左肘
    [angles.rightElbow.toFixed(0)+ '°', 14, '#d8b4fe'],   // 右肘
  ]

  ctx.save()
  ctx.font = 'bold 13px monospace'
  ctx.textBaseline = 'middle'

  for (const [text, idx, color] of labels) {
    const p = px(lm, idx)
    // 背景
    const w = ctx.measureText(text).width + 8
    ctx.fillStyle = 'rgba(0,0,0,0.65)'
    ctx.beginPath()
    ctx.roundRect(p.x + 6, p.y - 10, w, 20, 4)
    ctx.fill()
    // テキスト
    ctx.fillStyle = color
    ctx.fillText(text, p.x + 10, p.y)
  }
  ctx.restore()
}

// 再生 / 一時停止
window.togglePlayPause = function() {
  const rv  = document.getElementById('reviewVideo')
  const btn = document.getElementById('playPauseBtn')
  if (rv.paused) {
    rv.play()
    btn.innerHTML = '<i class="fas fa-pause mr-1"></i>一時停止'
  } else {
    rv.pause()
    btn.innerHTML = '<i class="fas fa-play mr-1"></i>再生'
  }
}

// シークバー操作
window.onSeek = function(val) {
  const rv = document.getElementById('reviewVideo')
  rv.currentTime = parseFloat(val)
  document.getElementById('reviewCurrentTime').textContent = parseFloat(val).toFixed(1) + 's'
  renderReviewFrame()
}

// コマ送り / コマ戻し（0.1秒単位）
window.stepFrame = function(dir) {
  const rv = document.getElementById('reviewVideo')
  rv.currentTime = Math.max(0, Math.min(rv.duration, rv.currentTime + dir * 0.1))
  document.getElementById('reviewSeek').value = rv.currentTime
  document.getElementById('reviewCurrentTime').textContent = rv.currentTime.toFixed(1) + 's'
  renderReviewFrame()
}

// 再生速度変更
window.onSpeedChange = function(val) {
  document.getElementById('reviewVideo').playbackRate = parseFloat(val)
}

// 骨格オーバーレイ ON/OFF
window.onToggleOverlay = function(checked) {
  reviewOverlayOn = checked
  renderReviewFrame()
}

// ==========================================
// ユーティリティ
// ==========================================
function show(id) { document.getElementById(id).classList.remove('hidden') }
function hide(id) { document.getElementById(id).classList.add('hidden') }

function showError(msg) {
  hide('progressSection')
  document.getElementById('errorMsg').textContent = msg
  show('errorBox')
}

window.resetApp = function() {
  // レビュー動画を停止・解放
  const rv = document.getElementById('reviewVideo')
  if (rv) { rv.pause(); rv.src = '' }
  if (reviewVideoUrl) { URL.revokeObjectURL(reviewVideoUrl); reviewVideoUrl = null }
  if (reviewRafId)    { cancelAnimationFrame(reviewRafId); reviewRafId = null }

  // カメラ停止
  stopCamera()

  poseFrames = []; selectedFile = null; analysisId = null; recordedChunks = []
  hide('progressSection'); hide('resultSection'); hide('errorBox')
  hide('cameraSection')
  show('uploadSection')
  document.getElementById('fileInfo').classList.add('hidden')
  document.getElementById('videoInput').value = ''
  document.getElementById('playPauseBtn').innerHTML = '<i class="fas fa-play mr-1"></i>再生'
  // タブをファイルに戻す
  document.getElementById('tabFileBtn').classList.add('active')
  document.getElementById('tabCamBtn').classList.remove('active')
}

// 録画済み動画をダウンロード
window.downloadRecording = function() {
  if (!selectedFile) return
  const url = URL.createObjectURL(selectedFile)
  const a   = document.createElement('a')
  a.href     = url
  a.download = selectedFile.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
</script>

</body>
</html>`)
})

export default app
