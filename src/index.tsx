import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

type Bindings = {
  DB: D1Database
  R2: R2Bucket
  AI: Ai
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
}

// ==========================================
// パスワードユーティリティ（Web Crypto API）
// ==========================================
async function hashPassword(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  )
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function generateId(len = 32): string {
  const arr = new Uint8Array(len)
  crypto.getRandomValues(arr)
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

// セッション有効期限（30日）
const SESSION_DAYS = 30

// ==========================================
// 認証ミドルウェア
// ==========================================
async function requireAuth(c: any, next: any) {
  const sessionId = getCookie(c, 'session_id')
  if (!sessionId) return c.json({ error: 'Unauthorized' }, 401)

  const session = await c.env.DB.prepare(
    `SELECT s.*, u.email FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.id = ? AND s.expires_at > datetime('now')`
  ).bind(sessionId).first()

  if (!session) {
    deleteCookie(c, 'session_id')
    return c.json({ error: 'Unauthorized' }, 401)
  }

  c.set('userId', session.user_id)
  c.set('userEmail', session.email)
  await next()
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
app.use('/api/*', cors({ origin: '*', credentials: true }))

// ==========================================
// 認証API
// ==========================================

// 新規登録
app.post('/api/auth/register', async (c) => {
  try {
    const { email, password } = await c.req.json()
    if (!email || !password) return c.json({ error: 'メールアドレスとパスワードを入力してください' }, 400)
    if (password.length < 8) return c.json({ error: 'パスワードは8文字以上にしてください' }, 400)

    // 既存ユーザー確認
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
    if (existing) return c.json({ error: 'このメールアドレスはすでに登録されています' }, 409)

    // パスワードハッシュ
    const salt = generateId(16)
    const hash = await hashPassword(password, salt)

    // ユーザー作成
    const result = await c.env.DB.prepare(
      'INSERT INTO users (email, password_hash, password_salt) VALUES (?, ?, ?)'
    ).bind(email, hash, salt).run()
    const userId = result.meta.last_row_id as number

    // セッション作成
    const sessionId = generateId()
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000)
      .toISOString().replace('T', ' ').substring(0, 19)
    await c.env.DB.prepare(
      'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
    ).bind(sessionId, userId, expiresAt).run()

    setCookie(c, 'session_id', sessionId, {
      httpOnly: true, secure: true, sameSite: 'Lax',
      maxAge: SESSION_DAYS * 86400, path: '/'
    })
    return c.json({ success: true, email })
  } catch (e) {
    console.error(e)
    return c.json({ error: '登録に失敗しました' }, 500)
  }
})

// ログイン
app.post('/api/auth/login', async (c) => {
  try {
    const { email, password } = await c.req.json()
    if (!email || !password) return c.json({ error: 'メールアドレスとパスワードを入力してください' }, 400)

    const user = await c.env.DB.prepare(
      'SELECT * FROM users WHERE email = ?'
    ).bind(email).first()
    if (!user) return c.json({ error: 'メールアドレスまたはパスワードが正しくありません' }, 401)

    const hash = await hashPassword(password, user.password_salt as string)
    if (hash !== user.password_hash) return c.json({ error: 'メールアドレスまたはパスワードが正しくありません' }, 401)

    // セッション作成
    const sessionId = generateId()
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000)
      .toISOString().replace('T', ' ').substring(0, 19)
    await c.env.DB.prepare(
      'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
    ).bind(sessionId, user.id, expiresAt).run()

    setCookie(c, 'session_id', sessionId, {
      httpOnly: true, secure: true, sameSite: 'Lax',
      maxAge: SESSION_DAYS * 86400, path: '/'
    })
    return c.json({ success: true, email })
  } catch (e) {
    console.error(e)
    return c.json({ error: 'ログインに失敗しました' }, 500)
  }
})

// ログアウト
app.post('/api/auth/logout', async (c) => {
  const sessionId = getCookie(c, 'session_id')
  if (sessionId) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run()
  }
  deleteCookie(c, 'session_id', { path: '/' })
  return c.json({ success: true })
})

// 認証状態確認
app.get('/api/auth/me', async (c) => {
  const sessionId = getCookie(c, 'session_id')
  if (!sessionId) return c.json({ authenticated: false })

  const session = await c.env.DB.prepare(
    `SELECT u.email FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.id = ? AND s.expires_at > datetime('now')`
  ).bind(sessionId).first()

  if (!session) {
    deleteCookie(c, 'session_id', { path: '/' })
    return c.json({ authenticated: false })
  }
  return c.json({ authenticated: true, email: session.email })
})

// ==========================================
// セッション保存API（分析結果をD1に保存）
// ==========================================

// 動画をR2にアップロード → video_keyを返す
app.post('/api/sessions/upload-video', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number
    const formData = await c.req.formData()
    const file = formData.get('video') as File | null
    if (!file) return c.json({ error: '動画ファイルがありません' }, 400)

    const ext      = file.name.split('.').pop() || 'webm'
    const videoKey = `users/${userId}/${Date.now()}.${ext}`
    await c.env.R2.put(videoKey, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type || 'video/webm' }
    })
    return c.json({ success: true, videoKey })
  } catch (e) {
    console.error('upload-video error:', e)
    return c.json({ error: '動画のアップロードに失敗しました' }, 500)
  }
})

// 分析結果をD1に保存
app.post('/api/sessions', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number
    const body = await c.req.json() as {
      name: string
      videoKey: string
      result: any
      summary: any
      vector: number[]
    }
    if (!body.result || !body.summary) return c.json({ error: 'Invalid data' }, 400)

    const name    = (body.name || '無題のセッション').slice(0, 40)
    const videoKey = body.videoKey || `pose-${Date.now()}`

    const res = await c.env.DB.prepare(`
      INSERT INTO analyses
        (user_id, name, video_key, status,
         overall_score, posture_score, stride_score, arm_swing_score, foot_strike_score,
         strengths, improvements, detailed_feedback, summary, vector, updated_at)
      VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(
      userId, name, videoKey,
      body.result.overall_score,
      body.result.posture_score,
      body.result.stride_score,
      body.result.arm_swing_score,
      body.result.foot_strike_score,
      JSON.stringify(body.result.strengths),
      JSON.stringify(body.result.improvements),
      body.result.detailed_feedback,
      JSON.stringify(body.summary),
      JSON.stringify(body.vector || []),
    ).run()

    return c.json({ success: true, id: res.meta.last_row_id })
  } catch (e) {
    console.error('save session error:', e)
    return c.json({ error: '保存に失敗しました' }, 500)
  }
})

// セッション一覧取得（ログインユーザーのみ）
app.get('/api/sessions', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number
    const rows = await c.env.DB.prepare(`
      SELECT id, name, video_key, overall_score, posture_score, stride_score,
             arm_swing_score, foot_strike_score, summary, vector, created_at
      FROM analyses
      WHERE user_id = ? AND status = 'completed'
      ORDER BY created_at DESC
    `).bind(userId).all()

    const sessions = rows.results.map((r: any) => ({
      ...r,
      summary: r.summary ? JSON.parse(r.summary) : null,
      vector:  r.vector  ? JSON.parse(r.vector)  : [],
    }))
    return c.json({ sessions })
  } catch (e) {
    return c.json({ error: 'Failed to fetch sessions' }, 500)
  }
})

// セッション削除
app.delete('/api/sessions/:id', requireAuth, async (c) => {
  try {
    const userId    = c.get('userId') as number
    const sessionId = c.req.param('id')

    // 所有確認してからR2の動画も削除
    const row = await c.env.DB.prepare(
      'SELECT video_key FROM analyses WHERE id = ? AND user_id = ?'
    ).bind(sessionId, userId).first()
    if (!row) return c.json({ error: 'Not found' }, 404)

    // R2から動画削除（存在すれば）
    if (row.video_key && (row.video_key as string).startsWith('users/')) {
      await c.env.R2.delete(row.video_key as string)
    }

    await c.env.DB.prepare('DELETE FROM analyses WHERE id = ? AND user_id = ?')
      .bind(sessionId, userId).run()

    return c.json({ success: true })
  } catch (e) {
    return c.json({ error: 'Failed to delete session' }, 500)
  }
})

// 動画をR2から取得（署名付きURLの代わりにプロキシ）
app.get('/api/sessions/:id/video', requireAuth, async (c) => {
  try {
    const userId    = c.get('userId') as number
    const sessionId = c.req.param('id')

    const row = await c.env.DB.prepare(
      'SELECT video_key FROM analyses WHERE id = ? AND user_id = ?'
    ).bind(sessionId, userId).first()
    if (!row || !row.video_key) return c.json({ error: 'Not found' }, 404)

    const obj = await c.env.R2.get(row.video_key as string)
    if (!obj) return c.json({ error: 'Video not found in storage' }, 404)

    return new Response(obj.body, {
      headers: {
        'Content-Type': obj.httpMetadata?.contentType || 'video/webm',
        'Cache-Control': 'private, max-age=3600',
      }
    })
  } catch (e) {
    return c.json({ error: 'Failed to get video' }, 500)
  }
})

// ==========================================
// Workers AI フィードバック生成
// ==========================================
app.post('/api/analyze-ai', async (c) => {
  try {
    const body = await c.req.json()
    const { summary } = body as { summary: PoseSummary }
    if (!summary) return c.json({ error: 'summary required' }, 400)

    const footLabel =
      summary.footStrikePattern === 'heel'     ? 'ヒールストライク' :
      summary.footStrikePattern === 'midfoot'  ? 'ミッドフット' :
      summary.footStrikePattern === 'forefoot' ? 'フォアフット' : '不明'

    const prompt = `あなたはランニングバイオメカニクスの専門家です。
以下はMediaPipe Poseで計測したランニングフォームの実測データです。
このデータを根拠に、具体的な数値を引用しながら日本語でフィードバックしてください。

## 計測データ
- 体幹前傾角（平均）: ${summary.avgAngles.trunkLean.toFixed(1)}°（理想: 5〜10°）
- 左膝角度（平均/最小/最大）: ${summary.avgAngles.leftKnee.toFixed(1)}° / ${summary.minAngles.leftKnee.toFixed(1)}° / ${summary.maxAngles.leftKnee.toFixed(1)}°
- 右膝角度（平均/最小/最大）: ${summary.avgAngles.rightKnee.toFixed(1)}° / ${summary.minAngles.rightKnee.toFixed(1)}° / ${summary.maxAngles.rightKnee.toFixed(1)}°
- 左肘角度（平均）: ${summary.avgAngles.leftElbow.toFixed(1)}°  右肘: ${summary.avgAngles.rightElbow.toFixed(1)}°（理想: 85〜95°）
- 左右対称スコア: ${(summary.symmetryScore * 100).toFixed(1)}%（100%が完全対称）
- 体幹安定スコア: ${summary.trunkStability.toFixed(2)}（1.0が最高）
- 着地パターン: ${footLabel}
- 解析フレーム数: ${summary.frameCount}フレーム / ${summary.duration.toFixed(1)}秒

## 出力形式（JSON、必ずこの形式で返すこと）
{
  "strengths": ["良い点1（数値引用）", "良い点2", "良い点3"],
  "improvements": ["改善点1（数値と理想値を示す）", "改善点2", "改善点3"],
  "advice": "200字以内の総合アドバイス。体幹・膝・腕振り・着地の順で簡潔に。"
}

JSON以外の文字は一切出力しないこと。`

    const response = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
      messages: [
        {
          role: 'system',
          content: 'ランニングバイオメカニクスの専門家として、実測データを根拠に具体的なフィードバックをJSON形式で返す。JSON以外は出力しない。',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1024,
      temperature: 0.3,
    }) as { response: string }

    const raw = response.response ?? ''
    // JSONブロックを抽出
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return c.json({ error: 'AI response parse failed', raw }, 500)

    const parsed = JSON.parse(match[0])
    return c.json({
      strengths:    Array.isArray(parsed.strengths)    ? parsed.strengths    : [],
      improvements: Array.isArray(parsed.improvements) ? parsed.improvements : [],
      advice:       typeof parsed.advice === 'string'  ? parsed.advice       : '',
    })
  } catch (e) {
    console.error('Workers AI error:', e)
    return c.json({ error: String(e) }, 500)
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
// GPT分析（現在未使用 / OPENAI_API_KEY未設定時は呼ばれない）
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
  <title>RunLens - ランニングフォーム分析</title>
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
    .session-card {
      transition: all .2s;
    }
    .session-card:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 20px rgba(59,130,246,.25);
    }
    .sim-bar {
      height: 6px; border-radius: 3px;
      background: linear-gradient(90deg, #3b82f6, #06b6d4);
      transition: width .6s ease;
    }
    .save-badge {
      display:inline-flex; align-items:center; gap:4px;
      background:#16a34a; color:white; font-size:.7rem;
      padding:2px 8px; border-radius:999px; font-weight:700;
    }
  </style>
</head>
<body class="bg-gradient-to-br from-slate-900 to-blue-950 min-h-screen text-white">

<!-- ==================== ログイン・登録画面 ==================== -->
<div id="authScreen" class="hidden min-h-screen flex items-center justify-center px-4">
  <div class="w-full max-w-sm">
    <!-- ロゴ -->
    <div class="text-center mb-8">
      <h1 class="text-4xl font-black tracking-tight mb-2">
        <i class="fas fa-running text-blue-400 mr-2"></i>RunLens
      </h1>
      <p class="text-slate-400 text-sm">ランニングフォーム分析</p>
    </div>

    <!-- タブ -->
    <div class="bg-slate-800/60 rounded-2xl p-1.5 mb-6 flex gap-1">
      <button id="authTabLogin" onclick="switchAuthTab('login')"
        class="tab-btn active flex-1 py-2.5 rounded-xl font-semibold text-sm">
        ログイン
      </button>
      <button id="authTabRegister" onclick="switchAuthTab('register')"
        class="tab-btn flex-1 py-2.5 rounded-xl font-semibold text-sm">
        新規登録
      </button>
    </div>

    <!-- ログインフォーム -->
    <div id="loginForm" class="bg-slate-800/60 rounded-2xl p-6">
      <div class="space-y-4">
        <div>
          <label class="text-sm text-slate-400 mb-1.5 block">メールアドレス</label>
          <input id="loginEmail" type="email" placeholder="example@email.com"
            class="w-full bg-slate-700 border border-slate-600 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors">
        </div>
        <div>
          <label class="text-sm text-slate-400 mb-1.5 block">パスワード</label>
          <input id="loginPassword" type="password" placeholder="パスワード"
            onkeydown="if(event.key==='Enter') doLogin()"
            class="w-full bg-slate-700 border border-slate-600 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors">
        </div>
        <p id="loginError" class="hidden text-red-400 text-xs"></p>
        <button onclick="doLogin()"
          class="w-full bg-blue-600 hover:bg-blue-500 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-center gap-2">
          <i class="fas fa-sign-in-alt"></i>ログイン
        </button>
      </div>
    </div>

    <!-- 登録フォーム -->
    <div id="registerForm" class="hidden bg-slate-800/60 rounded-2xl p-6">
      <div class="space-y-4">
        <div>
          <label class="text-sm text-slate-400 mb-1.5 block">メールアドレス</label>
          <input id="registerEmail" type="email" placeholder="example@email.com"
            class="w-full bg-slate-700 border border-slate-600 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors">
        </div>
        <div>
          <label class="text-sm text-slate-400 mb-1.5 block">パスワード <span class="text-slate-500">（8文字以上）</span></label>
          <input id="registerPassword" type="password" placeholder="パスワード（8文字以上）"
            class="w-full bg-slate-700 border border-slate-600 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors">
        </div>
        <div>
          <label class="text-sm text-slate-400 mb-1.5 block">パスワード確認</label>
          <input id="registerPasswordConfirm" type="password" placeholder="パスワードを再入力"
            onkeydown="if(event.key==='Enter') doRegister()"
            class="w-full bg-slate-700 border border-slate-600 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors">
        </div>
        <p id="registerError" class="hidden text-red-400 text-xs"></p>
        <button onclick="doRegister()"
          class="w-full bg-green-600 hover:bg-green-500 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-center gap-2">
          <i class="fas fa-user-plus"></i>アカウント作成
        </button>
      </div>
    </div>
  </div>
</div>

<!-- ==================== メインアプリ ==================== -->
<div id="mainApp" class="hidden max-w-3xl mx-auto px-4 py-10">

  <!-- ヘッダー -->
  <header class="text-center mb-10 relative">
    <h1 class="text-4xl font-black tracking-tight mb-2">
      <i class="fas fa-running text-blue-400 mr-2"></i>RunLens
    </h1>
    <p class="text-slate-400">MediaPipe WASM によるブラウザ内ランニングフォーム分析</p>
    <!-- ユーザー情報・ログアウト -->
    <div class="absolute right-0 top-0 flex items-center gap-2">
      <span id="userEmailBadge" class="text-xs text-slate-400"></span>
      <button onclick="doLogout()"
        class="text-xs bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-lg transition-colors">
        <i class="fas fa-sign-out-alt mr-1"></i>ログアウト
      </button>
    </div>
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
    <button id="tabHistBtn" onclick="switchTab('history')"
      class="tab-btn flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2">
      <i class="fas fa-folder-open"></i>履歴・検索
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

  <!-- ─── 履歴・検索タブ ─── -->
  <section id="historySection" class="hidden mb-6">

    <!-- 保存済みセッション一覧 -->
    <div class="bg-slate-800/60 rounded-2xl p-6 mb-6">
      <div class="flex items-center justify-between mb-5">
        <h2 class="text-xl font-bold">
          <i class="fas fa-folder-open text-yellow-400 mr-2"></i>保存済みセッション
        </h2>
        <span id="sessionCount" class="text-xs text-slate-400">0 件</span>
      </div>
      <div id="sessionList" class="space-y-3">
        <p class="text-slate-500 text-sm text-center py-6">
          <i class="fas fa-inbox text-3xl mb-3 block text-slate-600"></i>
          保存されたセッションはありません
        </p>
      </div>
    </div>

    <!-- 類似フォーム検索結果 -->
    <div id="similarSection" class="hidden bg-slate-800/60 rounded-2xl p-6">
      <h3 class="text-lg font-bold mb-4">
        <i class="fas fa-search text-cyan-400 mr-2"></i>類似フォーム検索結果
      </h3>
      <p class="text-xs text-slate-400 mb-4" id="similarBaseInfo"></p>
      <div id="similarList" class="space-y-3"></div>
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
      <p class="text-sm text-slate-400 mt-1">MediaPipe骨格データによるルールベース分析</p>
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

    <!-- 詳細フィードバック（ルールベース） -->
    <div class="bg-gradient-to-br from-blue-900/50 to-purple-900/50 rounded-2xl p-6 mb-6">
      <h4 class="font-bold mb-4 text-blue-300"><i class="fas fa-comment-alt mr-2"></i>詳細フィードバック</h4>
      <pre id="detailedFeedback" class="whitespace-pre-wrap text-slate-300 text-sm leading-relaxed"></pre>
    </div>

    <!-- Workers AI フィードバック -->
    <div id="aiFeedbackCard" class="bg-gradient-to-br from-violet-900/50 to-indigo-900/50 border border-violet-700/40 rounded-2xl p-6 mb-6">
      <h4 class="font-bold mb-4 text-violet-300">
        <i class="fas fa-robot mr-2"></i>AI アドバイス
        <span class="text-xs font-normal text-slate-400 ml-2">Cloudflare Workers AI (Llama 3.1)</span>
      </h4>
      <!-- ローディング -->
      <div id="aiLoading" class="flex items-center gap-3 text-slate-400 text-sm">
        <svg class="animate-spin h-5 w-5 text-violet-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path>
        </svg>
        AIがフォームを分析中...
      </div>
      <!-- 結果 -->
      <div id="aiResult" class="hidden">
        <div id="aiStrengths" class="mb-4"></div>
        <div id="aiImprovements" class="mb-4"></div>
        <div id="aiAdvice" class="bg-violet-900/30 rounded-xl p-4 text-slate-300 text-sm leading-relaxed border border-violet-700/30"></div>
      </div>
      <!-- エラー -->
      <div id="aiError" class="hidden text-slate-400 text-sm">
        <i class="fas fa-exclamation-circle text-yellow-500 mr-2"></i>
        AIフィードバックの取得に失敗しました（ルールベース結果をご参照ください）
      </div>
    </div>

    <!-- 名前をつけて保存 -->
    <div id="saveSessionCard" class="bg-gradient-to-br from-green-900/50 to-teal-900/50 border border-green-700/40 rounded-2xl p-6 mb-4">
      <h4 class="font-bold mb-3 text-green-300">
        <i class="fas fa-save mr-2"></i>この分析を保存する
      </h4>
      <p class="text-xs text-slate-400 mb-4">名前をつけてブラウザに保存。後から履歴・類似検索が使えます。</p>
      <div class="flex gap-2">
        <input id="sessionNameInput" type="text" placeholder="例: 朝練 5km、レース前チェック..."
          class="flex-1 bg-slate-700/80 border border-slate-600 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-green-500 transition-colors"
          maxlength="40">
        <button id="saveSessionBtn" onclick="saveCurrentSession()"
          class="bg-green-600 hover:bg-green-500 px-5 py-2.5 rounded-xl font-semibold text-sm transition-colors whitespace-nowrap flex items-center gap-2">
          <i class="fas fa-save"></i>保存
        </button>
      </div>
      <div id="savedBadge" class="hidden mt-3 text-sm">
        <span class="save-badge"><i class="fas fa-check"></i>保存済み</span>
        <span id="savedName" class="text-slate-300 ml-2 text-xs"></span>
      </div>
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

</div><!-- /mainApp -->

<!-- MediaPipe Tasks Vision (CDN) -->
<script type="module">
import { PoseLandmarker, FilesetResolver, DrawingUtils }
  from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs'

// ==========================================
// 認証
// ==========================================
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' })
    const data = await res.json()
    if (data.authenticated) {
      document.getElementById('userEmailBadge').textContent = data.email
      document.getElementById('authScreen').classList.add('hidden')
      document.getElementById('mainApp').classList.remove('hidden')
    } else {
      document.getElementById('authScreen').classList.remove('hidden')
      document.getElementById('mainApp').classList.add('hidden')
    }
  } catch(e) {
    document.getElementById('authScreen').classList.remove('hidden')
    document.getElementById('mainApp').classList.add('hidden')
  }
}

window.switchAuthTab = function(tab) {
  const isLogin = tab === 'login'
  document.getElementById('authTabLogin').classList.toggle('active', isLogin)
  document.getElementById('authTabRegister').classList.toggle('active', !isLogin)
  document.getElementById('loginForm').classList.toggle('hidden', !isLogin)
  document.getElementById('registerForm').classList.toggle('hidden', isLogin)
  document.getElementById('loginError').classList.add('hidden')
  document.getElementById('registerError').classList.add('hidden')
}

window.doLogin = async function() {
  const email    = document.getElementById('loginEmail').value.trim()
  const password = document.getElementById('loginPassword').value
  const errEl    = document.getElementById('loginError')
  errEl.classList.add('hidden')

  if (!email || !password) { errEl.textContent = 'メールアドレスとパスワードを入力してください'; errEl.classList.remove('hidden'); return }

  const btn = document.querySelector('#loginForm button')
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin mr-2"></i>ログイン中...'

  try {
    const res  = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
    const data = await res.json()
    if (!res.ok) { errEl.textContent = data.error; errEl.classList.remove('hidden'); return }
    document.getElementById('userEmailBadge').textContent = data.email
    document.getElementById('authScreen').classList.add('hidden')
    document.getElementById('mainApp').classList.remove('hidden')
  } catch(e) {
    errEl.textContent = '通信エラーが発生しました'; errEl.classList.remove('hidden')
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-sign-in-alt"></i>ログイン'
  }
}

window.doRegister = async function() {
  const email    = document.getElementById('registerEmail').value.trim()
  const password = document.getElementById('registerPassword').value
  const confirm  = document.getElementById('registerPasswordConfirm').value
  const errEl    = document.getElementById('registerError')
  errEl.classList.add('hidden')

  if (!email || !password) { errEl.textContent = 'メールアドレスとパスワードを入力してください'; errEl.classList.remove('hidden'); return }
  if (password.length < 8) { errEl.textContent = 'パスワードは8文字以上にしてください'; errEl.classList.remove('hidden'); return }
  if (password !== confirm) { errEl.textContent = 'パスワードが一致しません'; errEl.classList.remove('hidden'); return }

  const btn = document.querySelector('#registerForm button')
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin mr-2"></i>登録中...'

  try {
    const res  = await fetch('/api/auth/register', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
    const data = await res.json()
    if (!res.ok) { errEl.textContent = data.error; errEl.classList.remove('hidden'); return }
    document.getElementById('userEmailBadge').textContent = data.email
    document.getElementById('authScreen').classList.add('hidden')
    document.getElementById('mainApp').classList.remove('hidden')
  } catch(e) {
    errEl.textContent = '通信エラーが発生しました'; errEl.classList.remove('hidden')
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-user-plus"></i>アカウント作成'
  }
}

window.doLogout = async function() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
  document.getElementById('mainApp').classList.add('hidden')
  document.getElementById('authScreen').classList.remove('hidden')
  document.getElementById('loginEmail').value = ''
  document.getElementById('loginPassword').value = ''
  switchAuthTab('login')
}

// 起動時に認証チェック
checkAuth()

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
// サーバーAPI ユーティリティ
// ==========================================

// サムネイル生成（reviewVideoの現フレームをbase64に）
function captureThumbnail() {
  try {
    const rv = document.getElementById('reviewVideo')
    const c  = document.createElement('canvas')
    c.width  = 160; c.height = 90
    c.getContext('2d').drawImage(rv, 0, 0, 160, 90)
    return c.toDataURL('image/jpeg', 0.7)
  } catch(_) { return '' }
}

// 類似度計算用ベクトル生成（11次元）
function makeVector(result, summary) {
  return [
    result.posture_score      / 100,
    result.stride_score       / 100,
    result.arm_swing_score    / 100,
    result.foot_strike_score  / 100,
    summary.avgAngles.leftKnee    / 180,
    summary.avgAngles.rightKnee   / 180,
    summary.avgAngles.leftElbow   / 180,
    summary.avgAngles.rightElbow  / 180,
    summary.avgAngles.trunkLean   / 45,
    summary.symmetryScore,
    Math.min(1, summary.trunkStability / 10),
  ]
}

// コサイン類似度
function cosineSim(a, b) {
  const dot = a.reduce((s, v, i) => s + v * b[i], 0)
  const ma  = Math.sqrt(a.reduce((s, v) => s + v * v, 0))
  const mb  = Math.sqrt(b.reduce((s, v) => s + v * v, 0))
  return (ma && mb) ? dot / (ma * mb) : 0
}

// ==========================================
// 現在の分析をD1/R2に保存
// ==========================================
let currentResult  = null
let currentSummary = null
let currentSavedId = null

window.saveCurrentSession = async function() {
  if (!currentResult || !currentSummary) {
    alert('まず動画を解析してください')
    return
  }
  const nameInput = document.getElementById('sessionNameInput')
  const name = nameInput.value.trim() || '無題のセッション'

  const btn = document.getElementById('saveSessionBtn')
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 保存中...'

  try {
    // 1. 動画をR2にアップロード
    let videoKey = ''
    if (selectedFile) {
      btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 動画をアップロード中...'
      const fd = new FormData()
      fd.append('video', selectedFile)
      const upRes = await fetch('/api/sessions/upload-video', {
        method: 'POST', credentials: 'include', body: fd
      })
      if (upRes.ok) {
        const upData = await upRes.json()
        videoKey = upData.videoKey || ''
      }
    }

    // 2. 分析結果をD1に保存
    btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 結果を保存中...'
    const vector = makeVector(currentResult, currentSummary)
    const res = await fetch('/api/sessions', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, videoKey, result: currentResult, summary: currentSummary, vector })
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || '保存失敗')
    }
    const data = await res.json()
    currentSavedId = data.id

    // 保存済みバッジ表示
    document.getElementById('savedBadge').classList.remove('hidden')
    document.getElementById('savedName').textContent = name
    btn.innerHTML = '<i class="fas fa-check"></i> 保存済み'
    btn.classList.replace('bg-green-600', 'bg-slate-600')
    btn.disabled = true
    nameInput.disabled = true

  } catch(e) {
    console.error('Save error:', e)
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-save"></i>保存'
    alert('保存に失敗しました: ' + e.message)
  }
}

// ==========================================
// 履歴タブ：セッション一覧を描画（APIから取得）
// ==========================================
let _cachedSessions = []

async function renderSessionList() {
  const list    = document.getElementById('sessionList')
  const countEl = document.getElementById('sessionCount')
  list.innerHTML = '<p class="text-slate-400 text-sm text-center py-4"><i class="fas fa-circle-notch fa-spin mr-2"></i>読み込み中...</p>'

  try {
    const res = await fetch('/api/sessions', { credentials: 'include' })
    if (!res.ok) throw new Error('取得失敗')
    const { sessions } = await res.json()
    _cachedSessions = sessions || []
    countEl.textContent = _cachedSessions.length + ' 件'

    if (_cachedSessions.length === 0) {
      list.innerHTML = \`
        <p class="text-slate-500 text-sm text-center py-6">
          <i class="fas fa-inbox text-3xl mb-3 block text-slate-600"></i>
          保存されたセッションはありません
        </p>\`
      return
    }

    list.innerHTML = _cachedSessions.map(s => {
      const date = new Date(s.created_at).toLocaleString('ja-JP', {
        year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit'
      })
      const hasVideo = s.video_key && s.video_key.startsWith('users/')
      const thumb = hasVideo
        ? \`<div class="w-20 h-12 rounded-lg bg-slate-700 flex items-center justify-center flex-shrink-0 relative overflow-hidden">
             <i class="fas fa-film text-slate-400 text-lg"></i>
           </div>\`
        : \`<div class="w-20 h-12 rounded-lg bg-slate-700 flex items-center justify-center flex-shrink-0">
             <i class="fas fa-running text-slate-500"></i></div>\`

      return \`
        <div class="session-card bg-slate-700/60 rounded-xl p-4 flex gap-3 items-start" data-id="\${s.id}">
          \${thumb}
          <div class="flex-1 min-w-0">
            <div class="flex items-start justify-between gap-2">
              <p class="font-semibold text-sm truncate">\${s.name}</p>
              <div class="flex gap-1.5 flex-shrink-0">
                \${hasVideo ? \`<button onclick="playSessionVideo(\${s.id})"
                  class="bg-slate-600 hover:bg-slate-500 text-xs px-2.5 py-1 rounded-lg transition-colors"
                  title="動画を再生"><i class="fas fa-play mr-1"></i>再生</button>\` : ''}
                <button onclick="findSimilar(\${s.id})"
                  class="bg-cyan-700 hover:bg-cyan-600 text-xs px-2.5 py-1 rounded-lg transition-colors whitespace-nowrap"
                  title="この記録に似たフォームを検索">
                  <i class="fas fa-search mr-1"></i>類似検索
                </button>
                <button onclick="deleteSession(\${s.id})"
                  class="bg-red-900/60 hover:bg-red-800 text-xs px-2 py-1 rounded-lg transition-colors"
                  title="削除">
                  <i class="fas fa-trash"></i>
                </button>
              </div>
            </div>
            <p class="text-xs text-slate-400 mt-1">\${date}</p>
            <div class="flex gap-3 mt-2 text-xs">
              <span class="text-blue-300 font-bold">総合 \${s.overall_score}点</span>
              <span class="text-slate-400">姿勢 \${s.posture_score}</span>
              <span class="text-slate-400">ストライド \${s.stride_score}</span>
              <span class="text-slate-400">腕 \${s.arm_swing_score}</span>
              <span class="text-slate-400">着地 \${s.foot_strike_score}</span>
            </div>
          </div>
        </div>\`
    }).join('')

  } catch(e) {
    list.innerHTML = '<p class="text-red-400 text-sm text-center py-4">読み込みエラー: ' + e.message + '</p>'
  }
}

// 履歴から動画を再生
window.playSessionVideo = function(id) {
  const url = \`/api/sessions/\${id}/video\`
  const rv  = document.getElementById('reviewVideo')
  if (!rv) return
  // 結果セクションを表示して動画をセット
  show('resultSection')
  hide('historySection')
  rv.src = url
  rv.load()
  rv.play()
  document.getElementById('tabFileBtn').classList.remove('active')
  document.getElementById('tabHistBtn').classList.remove('active')
}

// セッション削除
window.deleteSession = async function(id) {
  if (!confirm('このセッションを削除しますか？動画も削除されます。')) return
  try {
    const res = await fetch(\`/api/sessions/\${id}\`, { method: 'DELETE', credentials: 'include' })
    if (!res.ok) throw new Error('削除失敗')
    await renderSessionList()
    document.getElementById('similarSection').classList.add('hidden')
  } catch(e) {
    alert('削除に失敗しました: ' + e.message)
  }
}

// ==========================================
// 類似フォーム検索（キャッシュから計算）
// ==========================================
window.findSimilar = async function(baseId) {
  // キャッシュが空なら再取得
  if (_cachedSessions.length === 0) await renderSessionList()
  const base = _cachedSessions.find(s => s.id === baseId)
  if (!base || !base.vector || base.vector.length === 0) {
    alert('このセッションには類似検索用データがありません')
    return
  }

  const ranked = _cachedSessions
    .filter(s => s.id !== baseId && s.vector && s.vector.length > 0)
    .map(s => ({ ...s, similarity: cosineSim(base.vector, s.vector) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5)

  const sec    = document.getElementById('similarSection')
  const infoEl = document.getElementById('similarBaseInfo')
  const listEl = document.getElementById('similarList')

  sec.classList.remove('hidden')
  infoEl.textContent = \`「\${base.name}」（総合 \${base.overall_score}点）に似たフォームを検索しました\`

  if (ranked.length === 0) {
    listEl.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">比較できるセッションが他にありません</p>'
    sec.scrollIntoView({ behavior: 'smooth' })
    return
  }

  listEl.innerHTML = ranked.map((s, i) => {
    const simPct = Math.round(s.similarity * 100)
    const date = new Date(s.created_at).toLocaleString('ja-JP', {
      month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'
    })
    const medal = ['🥇','🥈','🥉','4.','5.'][i]
    return \`
      <div class="bg-slate-700/50 rounded-xl p-4">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <span class="text-lg">\${medal}</span>
            <p class="font-semibold text-sm">\${s.name}</p>
          </div>
          <div class="text-right">
            <p class="text-cyan-300 font-bold text-sm">\${simPct}% 一致</p>
            <p class="text-slate-500 text-xs">\${date}</p>
          </div>
        </div>
        <div class="mb-2">
          <div class="h-1.5 bg-slate-600 rounded-full overflow-hidden">
            <div class="sim-bar" style="width:\${simPct}%"></div>
          </div>
        </div>
        <div class="flex gap-3 text-xs text-slate-400">
          <span class="text-blue-300 font-bold">総合 \${s.overall_score}点</span>
          <span>姿勢 \${s.posture_score}</span>
          <span>ストライド \${s.stride_score}</span>
          <span>腕 \${s.arm_swing_score}</span>
          <span>着地 \${s.foot_strike_score}</span>
        </div>
      </div>\`
  }).join('')

  sec.scrollIntoView({ behavior: 'smooth' })
}

// ==========================================
// タブ切替
// ==========================================
window.switchTab = function(tab) {
  const isFile    = tab === 'file'
  const isCamera  = tab === 'camera'
  const isHistory = tab === 'history'

  document.getElementById('tabFileBtn').classList.toggle('active', isFile)
  document.getElementById('tabCamBtn').classList.toggle('active', isCamera)
  document.getElementById('tabHistBtn').classList.toggle('active', isHistory)

  document.getElementById('uploadSection').classList.toggle('hidden', !isFile)
  document.getElementById('cameraSection').classList.toggle('hidden', !isCamera)
  document.getElementById('historySection').classList.toggle('hidden', !isHistory)

  if (isCamera) initCamera()
  else stopCamera()

  if (isHistory) renderSessionList()
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

  // 体幹前傾角: 左右股関節中点 → 左右肩中点 のベクトルと
  // 垂直軸（真上 = y が減少する方向）のなす角度
  // MediaPipe正規化座標はY軸下向きなので、垂直上向き = (0, -1)
  function trunkLeanAngle() {
    const hipMid = {
      x: (L(23).x + L(24).x) / 2,
      y: (L(23).y + L(24).y) / 2,
    }
    const shoulderMid = {
      x: (L(11).x + L(12).x) / 2,
      y: (L(11).y + L(12).y) / 2,
    }
    // 股関節中点 → 肩中点 のベクトル
    const vx = shoulderMid.x - hipMid.x
    const vy = shoulderMid.y - hipMid.y  // 上向きなので通常マイナス
    // 垂直上向きベクトル (0, -1) との角度
    const mag = Math.sqrt(vx * vx + vy * vy)
    if (mag === 0) return 0
    // dot product with (0, -1) = -vy
    const cosA = Math.max(-1, Math.min(1, -vy / mag))
    return (Math.acos(cosA) * 180) / Math.PI
  }

  return {
    leftKnee:      angle3(L(23), L(25), L(27)),
    rightKnee:     angle3(L(24), L(26), L(28)),
    leftElbow:     angle3(L(11), L(13), L(15)),
    rightElbow:    angle3(L(12), L(14), L(16)),
    trunkLean:     trunkLeanAngle(),   // 股関節中点→肩中点と垂直軸のなす角
    leftHipAngle:  angle3(L(11), L(23), L(25)),
    rightHipAngle: angle3(L(12), L(24), L(26)),
  }
}

function detectFootStrike(frames) {
  if (frames.length === 0) return 'unknown'

  // 踵(29/30) と つま先(31/32) のY座標差で着地パターンを判定
  // MediaPipe正規化座標: Y軸は下向き（大きい = 画面下）
  // 着地瞬間に近いフレーム（膝角度が小さい = 屈曲が大きい）を優先
  // 側面撮影が前提。正面撮影では信頼性が下がる。
  let heelCount = 0, midfootCount = 0, forefootCount = 0

  for (const f of frames) {
    const lm = f.landmarks
    if (!lm || lm.length < 33) continue

    // 左足
    const leftHeel  = lm[29], leftToe  = lm[31]
    // 右足
    const rightHeel = lm[30], rightToe = lm[32]

    // 可視性が低い場合はスキップ
    const leftVis  = Math.min(leftHeel?.visibility  ?? 0, leftToe?.visibility  ?? 0)
    const rightVis = Math.min(rightHeel?.visibility ?? 0, rightToe?.visibility ?? 0)

    // 左右どちらか可視性が高い方を使う
    let heelY, toeY
    if (leftVis >= rightVis && leftVis > 0.3) {
      heelY = leftHeel.y; toeY = leftToe.y
    } else if (rightVis > 0.3) {
      heelY = rightHeel.y; toeY = rightToe.y
    } else {
      continue
    }

    // Y差（正規化座標）: 踵がつま先より下（大）= ヒール着地
    const diff = heelY - toeY
    if      (diff >  0.03) heelCount++       // 踵が明らかに下
    else if (diff < -0.03) forefootCount++   // つま先が明らかに下
    else                   midfootCount++    // ほぼ同じ高さ
  }

  const total = heelCount + midfootCount + forefootCount
  if (total === 0) return 'unknown'

  if      (heelCount     / total > 0.5) return 'heel'
  else if (forefootCount / total > 0.4) return 'forefoot'
  else                                  return 'midfoot'
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
  if (frames.length < 2) return 0

  // ── ヘルパー ──────────────────────────────────────────────────
  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length
  const std = (arr) => {
    const m = avg(arr)
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length)
  }

  // ── 各関節の時系列を抽出 ──────────────────────────────────────
  const lKnee  = frames.map(f => f.angles.leftKnee)
  const rKnee  = frames.map(f => f.angles.rightKnee)
  const lElbow = frames.map(f => f.angles.leftElbow)
  const rElbow = frames.map(f => f.angles.rightElbow)

  // ── 統計量（平均・標準偏差）を左右で比較 ─────────────────────
  // ランニングは左右が逆位相で動くため、同フレームの差ではなく
  // 「動きの統計量の差」で非対称性を評価する
  //
  // 膝: 平均差（閾値15°）+ 標準偏差差（閾値10°）
  const kneeMeanDiff = Math.abs(avg(lKnee)  - avg(rKnee))
  const kneeStdDiff  = Math.abs(std(lKnee)  - std(rKnee))
  const kneeAsym     = kneeMeanDiff / 15 + kneeStdDiff / 10

  // 肘: 平均差（閾値15°）+ 標準偏差差（閾値10°）
  const elbowMeanDiff = Math.abs(avg(lElbow) - avg(rElbow))
  const elbowStdDiff  = Math.abs(std(lElbow) - std(rElbow))
  const elbowAsym     = elbowMeanDiff / 15 + elbowStdDiff / 10

  // kneeAsym / elbowAsym = 0 → 完全対称、≥1 → 明らかな非対称
  const kneeScore  = Math.max(0, 1 - kneeAsym)
  const elbowScore = Math.max(0, 1 - elbowAsym)

  // 膝を重視（ストライドの左右差は走行効率に直結）
  return kneeScore * 0.7 + elbowScore * 0.3
}

function trunkStability(frames) {
  if (frames.length < 2) return 1
  const leans    = frames.map(f => f.angles.trunkLean)
  const mean     = leans.reduce((s, v) => s + v, 0) / leans.length
  const variance = leans.reduce((s, v) => s + (v - mean) ** 2, 0) / leans.length
  // variance < 1 のときは安定度が非常に高い（≒1.0）
  // variance が大きいほど前傾角がぶれている → スコアが下がる
  // Math.min(1.0, ...) で上限を1.0に固定
  return variance < 1 ? 1.0 : Math.min(1.0, 1 / Math.sqrt(variance))
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
  // trunkLean = 垂直軸からのずれ角（0° = 直立、正の値 = 前傾）
  // ランニングの理想は5〜10°前傾
  const trunkLean  = summary.avgAngles.trunkLean
  const trunkIdeal = trunkLean >= 5  && trunkLean <= 10
  const trunkOk    = trunkLean >= 3  && trunkLean <= 20
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
    improvements.push(\`体幹前傾角 \${trunkLean.toFixed(1)}° — 理想は 5〜10°。\${trunkLean < 5 ? '少し前傾を意識すると推進力が上がります' : '前傾しすぎると腰への負担が増えます。上体を少し起こしましょう'}\`)
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

  // 現在の結果をグローバルに保存（IndexedDB保存・類似検索で使用）
  currentResult  = data
  currentSummary = summary
  currentSavedId = null

  // 保存UIをリセット
  document.getElementById('savedBadge').classList.add('hidden')
  document.getElementById('savedName').textContent = ''
  document.getElementById('sessionNameInput').value = ''
  document.getElementById('sessionNameInput').disabled = false
  const saveBtn = document.getElementById('saveSessionBtn')
  saveBtn.disabled = false
  saveBtn.innerHTML = '<i class="fas fa-save"></i>保存'
  saveBtn.classList.replace('bg-slate-600', 'bg-green-600')

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

  // ── Workers AI フィードバック（非同期・バックグラウンド）──
  fetchAIFeedback(summary)

  // ── ワイヤーフレームレビューをセットアップ ──
  setupReview()
}

// ==========================================
// Workers AI フィードバック取得
// ==========================================
async function fetchAIFeedback(summary) {
  const loading = document.getElementById('aiLoading')
  const result  = document.getElementById('aiResult')
  const error   = document.getElementById('aiError')

  // ローディング状態にリセット
  loading.classList.remove('hidden')
  result.classList.add('hidden')
  error.classList.add('hidden')

  try {
    const res = await fetch('/api/analyze-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary }),
    })
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`)
    const ai = await res.json()

    // 良い点（AI版）
    document.getElementById('aiStrengths').innerHTML = ai.strengths?.length ? \`
      <p class="text-xs font-semibold text-green-400 mb-2 uppercase tracking-wide">
        <i class="fas fa-check-circle mr-1"></i>良い点
      </p>
      <ul class="space-y-2">
        \${ai.strengths.map(s => \`
          <li class="flex items-start gap-2 text-sm text-slate-300">
            <i class="fas fa-check text-green-400 mt-0.5 shrink-0"></i>\${s}
          </li>
        \`).join('')}
      </ul>
    \` : ''

    // 改善点（AI版）
    document.getElementById('aiImprovements').innerHTML = ai.improvements?.length ? \`
      <p class="text-xs font-semibold text-yellow-400 mb-2 uppercase tracking-wide">
        <i class="fas fa-lightbulb mr-1"></i>改善点
      </p>
      <ul class="space-y-2">
        \${ai.improvements.map(s => \`
          <li class="flex items-start gap-2 text-sm text-slate-300">
            <i class="fas fa-arrow-right text-yellow-400 mt-0.5 shrink-0"></i>\${s}
          </li>
        \`).join('')}
      </ul>
    \` : ''

    // 総合アドバイス
    document.getElementById('aiAdvice').textContent = ai.advice || ''

    loading.classList.add('hidden')
    result.classList.remove('hidden')
  } catch (e) {
    console.error('AI feedback error:', e)
    loading.classList.add('hidden')
    error.classList.remove('hidden')
  }
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
  currentResult = null; currentSummary = null; currentSavedId = null

  hide('progressSection'); hide('resultSection'); hide('errorBox')
  hide('cameraSection'); hide('historySection')
  show('uploadSection')
  document.getElementById('fileInfo').classList.add('hidden')
  document.getElementById('videoInput').value = ''
  document.getElementById('playPauseBtn').innerHTML = '<i class="fas fa-play mr-1"></i>再生'
  // タブをファイルに戻す
  document.getElementById('tabFileBtn').classList.add('active')
  document.getElementById('tabCamBtn').classList.remove('active')
  document.getElementById('tabHistBtn').classList.remove('active')
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
