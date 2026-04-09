import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
  R2: R2Bucket
}

const app = new Hono<{ Bindings: Bindings }>()

// CORS設定
app.use('/api/*', cors())

// ==========================================
// API Routes
// ==========================================

// 動画アップロードAPI
app.post('/api/upload', async (c) => {
  try {
    const formData = await c.req.formData()
    const file = formData.get('video') as File
    
    if (!file) {
      return c.json({ error: 'No video file provided' }, 400)
    }

    // ファイルサイズチェック（50MB制限）
    if (file.size > 50 * 1024 * 1024) {
      return c.json({ error: 'File size exceeds 50MB limit' }, 400)
    }

    // ファイルタイプチェック
    if (!file.type.startsWith('video/')) {
      return c.json({ error: 'Invalid file type. Please upload a video file.' }, 400)
    }

    // ユニークなキーを生成
    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(7)
    const fileExt = file.name.split('.').pop() || 'mp4'
    const videoKey = `videos/${timestamp}-${random}.${fileExt}`

    // R2にアップロード
    const arrayBuffer = await file.arrayBuffer()
    await c.env.R2.put(videoKey, arrayBuffer, {
      httpMetadata: {
        contentType: file.type,
      },
    })

    // データベースに分析レコードを作成
    const result = await c.env.DB.prepare(`
      INSERT INTO analyses (video_key, status)
      VALUES (?, 'pending')
    `).bind(videoKey).run()

    const analysisId = result.meta.last_row_id

    // 非同期で分析を実行（バックグラウンド処理のシミュレーション）
    // 実際のプロダクションではQueue/Durable Objectsを使用
    c.executionCtx.waitUntil(analyzeVideo(c.env, analysisId as number, videoKey))

    return c.json({
      success: true,
      analysisId,
      message: 'Video uploaded successfully. Analysis in progress...'
    })
  } catch (error) {
    console.error('Upload error:', error)
    return c.json({ error: 'Failed to upload video' }, 500)
  }
})

// 分析結果取得API
app.get('/api/analysis/:id', async (c) => {
  try {
    const id = c.req.param('id')
    
    const result = await c.env.DB.prepare(`
      SELECT * FROM analyses WHERE id = ?
    `).bind(id).first()

    if (!result) {
      return c.json({ error: 'Analysis not found' }, 404)
    }

    // JSON文字列をパース
    const analysis = {
      ...result,
      strengths: result.strengths ? JSON.parse(result.strengths as string) : [],
      improvements: result.improvements ? JSON.parse(result.improvements as string) : [],
    }

    return c.json(analysis)
  } catch (error) {
    console.error('Get analysis error:', error)
    return c.json({ error: 'Failed to get analysis' }, 500)
  }
})

// 全分析結果一覧取得API
app.get('/api/analyses', async (c) => {
  try {
    const result = await c.env.DB.prepare(`
      SELECT id, video_key, status, overall_score, created_at
      FROM analyses
      ORDER BY created_at DESC
      LIMIT 20
    `).all()

    return c.json({ analyses: result.results })
  } catch (error) {
    console.error('Get analyses error:', error)
    return c.json({ error: 'Failed to get analyses' }, 500)
  }
})

// 動画取得API（署名付きURL）
app.get('/api/video/:key', async (c) => {
  try {
    const key = c.req.param('key')
    
    // R2から動画を取得
    const object = await c.env.R2.get(key)
    
    if (!object) {
      return c.json({ error: 'Video not found' }, 404)
    }

    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'video/mp4',
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch (error) {
    console.error('Get video error:', error)
    return c.json({ error: 'Failed to get video' }, 500)
  }
})

// ==========================================
// AI分析関数（シミュレーション）
// ==========================================
async function analyzeVideo(env: Bindings, analysisId: number, videoKey: string) {
  try {
    // ステータスを処理中に更新
    await env.DB.prepare(`
      UPDATE analyses 
      SET status = 'processing', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(analysisId).run()

    // AIによる動画分析をシミュレート（実際はAI APIを呼び出す）
    await new Promise(resolve => setTimeout(resolve, 3000)) // 3秒待機

    // ダミーの分析結果を生成
    const analysisResult = generateDummyAnalysis()

    // 分析結果をデータベースに保存
    await env.DB.prepare(`
      UPDATE analyses 
      SET status = 'completed',
          overall_score = ?,
          posture_score = ?,
          stride_score = ?,
          arm_swing_score = ?,
          foot_strike_score = ?,
          strengths = ?,
          improvements = ?,
          detailed_feedback = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      analysisResult.overall_score,
      analysisResult.posture_score,
      analysisResult.stride_score,
      analysisResult.arm_swing_score,
      analysisResult.foot_strike_score,
      JSON.stringify(analysisResult.strengths),
      JSON.stringify(analysisResult.improvements),
      analysisResult.detailed_feedback,
      analysisId
    ).run()

    console.log(`Analysis completed for ID: ${analysisId}`)
  } catch (error) {
    console.error('Analysis error:', error)
    
    // エラーをデータベースに記録
    await env.DB.prepare(`
      UPDATE analyses 
      SET status = 'error',
          error_message = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(String(error), analysisId).run()
  }
}

// ダミー分析結果生成
function generateDummyAnalysis() {
  const scores = {
    posture: 75 + Math.floor(Math.random() * 20),
    stride: 70 + Math.floor(Math.random() * 25),
    arm_swing: 80 + Math.floor(Math.random() * 15),
    foot_strike: 65 + Math.floor(Math.random() * 30),
  }

  const overall = Math.floor((scores.posture + scores.stride + scores.arm_swing + scores.foot_strike) / 4)

  const strengths = [
    '腕の振りが適切で、左右対称性が良好です',
    '上半身の姿勢が安定しています',
    'リズムが一定で、ペース配分が良いです'
  ]

  const improvements = [
    '着地時の足の位置をもう少し体の真下に持ってくると、膝への負担が減ります',
    '歩幅を若干広げることで、推進力が向上する可能性があります',
    '腰の位置をもう少し高く保つことで、効率が上がります'
  ]

  const detailed_feedback = `
総合評価: ${overall}点

あなたのランニングフォームは全体的に良好です。特に上半身の使い方と腕振りに優れています。
改善の余地がある点としては、足の着地位置と歩幅の調整が挙げられます。

【姿勢 (${scores.posture}点)】
上半身は安定していますが、疲労時に前傾姿勢になる傾向があります。
腰の位置を意識的に高く保つことで、より効率的なフォームになります。

【ストライド (${scores.stride}点)】
現在のストライドは安定していますが、やや保守的です。
体力に余裕があれば、歩幅を10-15cm程度広げてみることをお勧めします。

【腕振り (${scores.arm_swing}点)】
腕振りは非常に良好です。左右対称で、リズムも一定しています。
この調子を維持してください。

【着地 (${scores.foot_strike}点)】
着地時に体の前方で接地する傾向が見られます。
これは膝への負担を増やす可能性があります。
足の着地位置を体の真下に近づけることを意識してみてください。
  `.trim()

  return {
    overall_score: overall,
    posture_score: scores.posture,
    stride_score: scores.stride,
    arm_swing_score: scores.arm_swing,
    foot_strike_score: scores.foot_strike,
    strengths,
    improvements,
    detailed_feedback,
  }
}

// ==========================================
// Frontend Routes
// ==========================================

app.get('/', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>ランニングフォーム分析</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <style>
          .score-circle {
            width: 120px;
            height: 120px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 2rem;
            font-weight: bold;
            background: conic-gradient(#3b82f6 0deg, #3b82f6 calc(var(--score) * 3.6deg), #e5e7eb calc(var(--score) * 3.6deg));
          }
          .score-inner {
            width: 100px;
            height: 100px;
            border-radius: 50%;
            background: white;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .loading {
            border: 3px solid #f3f3f3;
            border-top: 3px solid #3b82f6;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        </style>
    </head>
    <body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen">
        <div class="container mx-auto px-4 py-8 max-w-6xl">
            <!-- Header -->
            <div class="text-center mb-12">
                <h1 class="text-4xl font-bold text-gray-800 mb-3">
                    <i class="fas fa-running text-blue-600 mr-3"></i>
                    ランニングフォーム分析
                </h1>
                <p class="text-gray-600 text-lg">AIがあなたのランニングフォームを分析し、改善アドバイスを提供します</p>
            </div>

            <!-- Upload Section -->
            <div class="bg-white rounded-2xl shadow-xl p-8 mb-8">
                <h2 class="text-2xl font-bold text-gray-800 mb-6">
                    <i class="fas fa-video text-blue-600 mr-2"></i>
                    動画をアップロード
                </h2>
                
                <div class="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center hover:border-blue-500 transition-colors">
                    <input type="file" id="videoInput" accept="video/*" class="hidden">
                    <label for="videoInput" class="cursor-pointer">
                        <i class="fas fa-cloud-upload-alt text-6xl text-gray-400 mb-4"></i>
                        <p class="text-lg text-gray-600 mb-2">クリックして動画を選択</p>
                        <p class="text-sm text-gray-400">MP4, MOV, AVI形式 (最大50MB)</p>
                    </label>
                </div>

                <div id="selectedFile" class="hidden mt-4">
                    <div class="flex items-center justify-between bg-blue-50 p-4 rounded-lg">
                        <div class="flex items-center">
                            <i class="fas fa-file-video text-blue-600 text-2xl mr-3"></i>
                            <div>
                                <p id="fileName" class="font-medium text-gray-800"></p>
                                <p id="fileSize" class="text-sm text-gray-500"></p>
                            </div>
                        </div>
                        <button onclick="uploadVideo()" class="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-medium transition-colors">
                            <i class="fas fa-upload mr-2"></i>
                            アップロード
                        </button>
                    </div>
                </div>

                <div id="uploadProgress" class="hidden mt-4">
                    <div class="bg-gray-200 rounded-full h-2 overflow-hidden">
                        <div id="progressBar" class="bg-blue-600 h-full transition-all duration-300" style="width: 0%"></div>
                    </div>
                    <p class="text-center text-sm text-gray-600 mt-2">アップロード中...</p>
                </div>
            </div>

            <!-- Analysis Result Section -->
            <div id="analysisResult" class="hidden bg-white rounded-2xl shadow-xl p-8">
                <h2 class="text-2xl font-bold text-gray-800 mb-6">
                    <i class="fas fa-chart-line text-green-600 mr-2"></i>
                    分析結果
                </h2>

                <!-- Loading State -->
                <div id="analysisLoading" class="text-center py-12">
                    <div class="loading mx-auto mb-4"></div>
                    <p class="text-gray-600">動画を分析中です...</p>
                    <p class="text-sm text-gray-400 mt-2">数秒お待ちください</p>
                </div>

                <!-- Result Content -->
                <div id="analysisContent" class="hidden">
                    <!-- Overall Score -->
                    <div class="text-center mb-8">
                        <div class="score-circle mx-auto mb-4" id="overallScoreCircle">
                            <div class="score-inner">
                                <span id="overallScore">0</span>
                            </div>
                        </div>
                        <h3 class="text-2xl font-bold text-gray-800">総合スコア</h3>
                    </div>

                    <!-- Detailed Scores -->
                    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                        <div class="bg-blue-50 p-4 rounded-lg text-center">
                            <i class="fas fa-male text-blue-600 text-2xl mb-2"></i>
                            <p class="text-sm text-gray-600 mb-1">姿勢</p>
                            <p class="text-2xl font-bold text-gray-800"><span id="postureScore">0</span>点</p>
                        </div>
                        <div class="bg-green-50 p-4 rounded-lg text-center">
                            <i class="fas fa-shoe-prints text-green-600 text-2xl mb-2"></i>
                            <p class="text-sm text-gray-600 mb-1">ストライド</p>
                            <p class="text-2xl font-bold text-gray-800"><span id="strideScore">0</span>点</p>
                        </div>
                        <div class="bg-purple-50 p-4 rounded-lg text-center">
                            <i class="fas fa-hands text-purple-600 text-2xl mb-2"></i>
                            <p class="text-sm text-gray-600 mb-1">腕振り</p>
                            <p class="text-2xl font-bold text-gray-800"><span id="armSwingScore">0</span>点</p>
                        </div>
                        <div class="bg-orange-50 p-4 rounded-lg text-center">
                            <i class="fas fa-walking text-orange-600 text-2xl mb-2"></i>
                            <p class="text-sm text-gray-600 mb-1">着地</p>
                            <p class="text-2xl font-bold text-gray-800"><span id="footStrikeScore">0</span>点</p>
                        </div>
                    </div>

                    <!-- Strengths -->
                    <div class="mb-8">
                        <h4 class="text-xl font-bold text-gray-800 mb-4">
                            <i class="fas fa-check-circle text-green-600 mr-2"></i>
                            良い点
                        </h4>
                        <ul id="strengthsList" class="space-y-2">
                        </ul>
                    </div>

                    <!-- Improvements -->
                    <div class="mb-8">
                        <h4 class="text-xl font-bold text-gray-800 mb-4">
                            <i class="fas fa-lightbulb text-yellow-600 mr-2"></i>
                            改善点
                        </h4>
                        <ul id="improvementsList" class="space-y-2">
                        </ul>
                    </div>

                    <!-- Detailed Feedback -->
                    <div class="bg-gray-50 p-6 rounded-lg">
                        <h4 class="text-xl font-bold text-gray-800 mb-4">
                            <i class="fas fa-comment-alt text-blue-600 mr-2"></i>
                            詳細フィードバック
                        </h4>
                        <pre id="detailedFeedback" class="whitespace-pre-wrap text-gray-700 leading-relaxed"></pre>
                    </div>
                </div>
            </div>
        </div>

        <script>
            let selectedFile = null;
            let currentAnalysisId = null;

            // ファイル選択
            document.getElementById('videoInput').addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    selectedFile = file;
                    document.getElementById('fileName').textContent = file.name;
                    document.getElementById('fileSize').textContent = \`\${(file.size / 1024 / 1024).toFixed(2)} MB\`;
                    document.getElementById('selectedFile').classList.remove('hidden');
                }
            });

            // 動画アップロード
            async function uploadVideo() {
                if (!selectedFile) return;

                const formData = new FormData();
                formData.append('video', selectedFile);

                // プログレス表示
                document.getElementById('selectedFile').classList.add('hidden');
                document.getElementById('uploadProgress').classList.remove('hidden');
                document.getElementById('progressBar').style.width = '50%';

                try {
                    const response = await fetch('/api/upload', {
                        method: 'POST',
                        body: formData
                    });

                    const result = await response.json();

                    if (result.success) {
                        document.getElementById('progressBar').style.width = '100%';
                        currentAnalysisId = result.analysisId;
                        
                        // 分析結果セクションを表示
                        setTimeout(() => {
                            document.getElementById('uploadProgress').classList.add('hidden');
                            document.getElementById('analysisResult').classList.remove('hidden');
                            pollAnalysisResult(currentAnalysisId);
                        }, 500);
                    } else {
                        alert('アップロードに失敗しました: ' + result.error);
                        document.getElementById('uploadProgress').classList.add('hidden');
                        document.getElementById('selectedFile').classList.remove('hidden');
                    }
                } catch (error) {
                    console.error('Upload error:', error);
                    alert('アップロードに失敗しました');
                    document.getElementById('uploadProgress').classList.add('hidden');
                    document.getElementById('selectedFile').classList.remove('hidden');
                }
            }

            // 分析結果をポーリング
            async function pollAnalysisResult(analysisId) {
                const maxAttempts = 30;
                let attempts = 0;

                const poll = async () => {
                    try {
                        const response = await fetch(\`/api/analysis/\${analysisId}\`);
                        const analysis = await response.json();

                        if (analysis.status === 'completed') {
                            displayAnalysisResult(analysis);
                        } else if (analysis.status === 'error') {
                            document.getElementById('analysisLoading').innerHTML = \`
                                <div class="text-center text-red-600">
                                    <i class="fas fa-exclamation-circle text-4xl mb-4"></i>
                                    <p>分析中にエラーが発生しました</p>
                                </div>
                            \`;
                        } else if (attempts < maxAttempts) {
                            attempts++;
                            setTimeout(poll, 2000);
                        } else {
                            document.getElementById('analysisLoading').innerHTML = \`
                                <div class="text-center text-yellow-600">
                                    <i class="fas fa-clock text-4xl mb-4"></i>
                                    <p>分析に時間がかかっています...</p>
                                </div>
                            \`;
                        }
                    } catch (error) {
                        console.error('Poll error:', error);
                    }
                };

                poll();
            }

            // 分析結果を表示
            function displayAnalysisResult(analysis) {
                document.getElementById('analysisLoading').classList.add('hidden');
                document.getElementById('analysisContent').classList.remove('hidden');

                // スコア表示
                document.getElementById('overallScore').textContent = analysis.overall_score;
                document.getElementById('overallScoreCircle').style.setProperty('--score', analysis.overall_score);
                document.getElementById('postureScore').textContent = analysis.posture_score;
                document.getElementById('strideScore').textContent = analysis.stride_score;
                document.getElementById('armSwingScore').textContent = analysis.arm_swing_score;
                document.getElementById('footStrikeScore').textContent = analysis.foot_strike_score;

                // 良い点
                const strengthsList = document.getElementById('strengthsList');
                strengthsList.innerHTML = '';
                analysis.strengths.forEach(strength => {
                    const li = document.createElement('li');
                    li.className = 'flex items-start';
                    li.innerHTML = \`
                        <i class="fas fa-check text-green-600 mr-3 mt-1"></i>
                        <span class="text-gray-700">\${strength}</span>
                    \`;
                    strengthsList.appendChild(li);
                });

                // 改善点
                const improvementsList = document.getElementById('improvementsList');
                improvementsList.innerHTML = '';
                analysis.improvements.forEach(improvement => {
                    const li = document.createElement('li');
                    li.className = 'flex items-start';
                    li.innerHTML = \`
                        <i class="fas fa-arrow-right text-yellow-600 mr-3 mt-1"></i>
                        <span class="text-gray-700">\${improvement}</span>
                    \`;
                    improvementsList.appendChild(li);
                });

                // 詳細フィードバック
                document.getElementById('detailedFeedback').textContent = analysis.detailed_feedback;
            }
        </script>
    </body>
    </html>
  `)
})

export default app
