import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from 'react'
import { useNavigate } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { isAuthConfigured, supabase } from '../lib/supabaseClient'
import { TopNav } from '../components/TopNav'
import './camera.css'

type RenderResult = {
  id: string
  status: 'queued' | 'running' | 'done' | 'error'
  image?: string
  seed?: number
  error?: string
}

const MAX_PARALLEL = 1
const API_ENDPOINT = '/api/qwen'
const FIXED_STEPS = 4
const FIXED_WIDTH = 1024
const FIXED_HEIGHT = 1024
const OAUTH_REDIRECT_URL =
  import.meta.env.VITE_SUPABASE_REDIRECT_URL ?? (typeof window !== 'undefined' ? window.location.origin : undefined)

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const runQueue = async (tasks: Array<() => Promise<void>>, concurrency: number) => {
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= tasks.length) return
      await tasks[index]()
    }
  })
  await Promise.all(runners)
}

const makeId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

type DirectionPreset = {
  id: string
  label: string
  prompt: string
}

type ElevationPreset = {
  id: string
  label: string
  prompt: string
}

type PurchasePlan = {
  id: string
  label: string
  price: number
  tickets: number
  priceId: string
}

const DIRECTION_PRESETS: DirectionPreset[] = [
  { id: 'front', label: '正面', prompt: 'front view' },
  { id: 'front-right', label: '右前', prompt: 'front-right quarter view' },
  { id: 'right', label: '右', prompt: 'right side view' },
  { id: 'back-right', label: '右後', prompt: 'back-right quarter view' },
  { id: 'back', label: '後ろ', prompt: 'back view' },
  { id: 'back-left', label: '左後', prompt: 'back-left quarter view' },
  { id: 'left', label: '左', prompt: 'left side view' },
  { id: 'front-left', label: '左前', prompt: 'front-left quarter view' },
]

const ELEVATION_PRESETS: ElevationPreset[] = [
  { id: 'level', label: '水平 0°', prompt: 'eye-level shot' },
  { id: 'up45', label: '上 45°', prompt: 'high-angle shot' },
  { id: 'up90', label: '上 90°', prompt: 'top-down view' },
  { id: 'down45', label: '下 45°', prompt: 'low-angle shot' },
  { id: 'down90', label: '下 90°', prompt: 'extreme low-angle shot' },
]

const PURCHASE_PLANS: PurchasePlan[] = [
  { id: 'light', label: 'ライト', price: 700, tickets: 30, priceId: 'price_1St4C9AL4umhcfEPAVXlq2RJ' },
  { id: 'standard', label: 'スタンダード', price: 1500, tickets: 80, priceId: 'price_1St4CaAL4umhcfEP3UzuJtTy' },
  { id: 'pro', label: 'プロ', price: 3200, tickets: 200, priceId: 'price_1St4D7AL4umhcfEPY3qOc74l' },
]

const buildEditPrompt = (value: string, directionPrompt?: string, elevationPrompt?: string) => {
  const trimmed = value.trim()
  const angleParts = [directionPrompt, elevationPrompt, 'medium shot'].filter(Boolean).join(', ')
  const angleText = angleParts ? `<sks> ${angleParts}` : ''
  return [trimmed, angleText].filter(Boolean).join(', ')
}

const toBase64 = (dataUrl: string) => {
  const parts = dataUrl.split(',')
  return parts.length > 1 ? parts[1] : dataUrl
}

const normalizeImage = (value: unknown) => {
  if (typeof value !== 'string' || !value) return null
  if (value.startsWith('data:') || value.startsWith('http')) return value
  return `data:image/png;base64,${value}`
}

const extractImageList = (payload: any) => {
  const output = payload?.output ?? payload?.result ?? payload
  const listCandidates = [output?.images, output?.outputs, output?.output_images, output?.data, payload?.images]
  for (const candidate of listCandidates) {
    if (!Array.isArray(candidate)) continue
    const normalized = candidate
      .map((item: any) => normalizeImage(item?.image ?? item?.url ?? item?.data ?? item))
      .filter(Boolean) as string[]
    if (normalized.length) return normalized
  }
  const singleCandidates = [
    output?.image,
    output?.output_image,
    output?.output_image_base64,
    output?.message,
    output?.data,
    payload?.image,
    payload?.data,
  ]
  for (const candidate of singleCandidates) {
    const normalized = normalizeImage(candidate)
    if (normalized) return [normalized]
  }
  return []
}

const extractJobId = (payload: any) => payload?.id || payload?.jobId || payload?.job_id || payload?.output?.id

export function Camera() {
  const [sourcePreview, setSourcePreview] = useState<string | null>(null)
  const [sourcePayload, setSourcePayload] = useState<string | null>(null)
  const [sourceName, setSourceName] = useState('')
  const [sourcePreviewSub, setSourcePreviewSub] = useState<string | null>(null)
  const [sourcePayloadSub, setSourcePayloadSub] = useState<string | null>(null)
  const [sourceNameSub, setSourceNameSub] = useState('')
  const [prompt, setPrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [guidanceScale, setGuidanceScale] = useState(1.0)
  const [useAngle, setUseAngle] = useState(false)
  const [angleDirectionId, setAngleDirectionId] = useState(DIRECTION_PRESETS[0].id)
  const [angleElevationId, setAngleElevationId] = useState(ELEVATION_PRESETS[0].id)
  const [results, setResults] = useState<RenderResult[]>([])
  const [statusMessage, setStatusMessage] = useState('画像をアップロードしてください。')
  const [isRunning, setIsRunning] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [authStatus, setAuthStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [authMessage, setAuthMessage] = useState('')
  const [ticketCount, setTicketCount] = useState<number | null>(null)
  const [ticketStatus, setTicketStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [ticketMessage, setTicketMessage] = useState('')
  const [showTicketModal, setShowTicketModal] = useState(false)
  const runIdRef = useRef(0)
  const navigate = useNavigate()

  const totalFrames = results.length || 1
  const completedCount = useMemo(() => results.filter((item) => item.image).length, [results])
  const progress = totalFrames ? completedCount / totalFrames : 0
  const displayImage = results[0]?.image ?? null
  const hasAnySource = Boolean(sourcePayload || sourcePayloadSub)
  const emptyMessage = hasAnySource ? '生成ボタンを押してください。' : '画像をアップロードしてください。'
  const accessToken = session?.access_token ?? ''

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setAuthStatus('idle')
      setAuthMessage('')
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!supabase) return
    const hasCode = typeof window !== 'undefined' && window.location.search.includes('code=')
    const hasState = typeof window !== 'undefined' && window.location.search.includes('state=')
    if (!hasCode || !hasState) return
    supabase.auth.exchangeCodeForSession(window.location.href).then(({ error }) => {
      if (error) {
        setAuthStatus('error')
        setAuthMessage(error.message)
        return
      }
      const url = new URL(window.location.href)
      url.searchParams.delete('code')
      url.searchParams.delete('state')
      window.history.replaceState({}, document.title, url.toString())
    })
  }, [])

  const fetchTickets = useCallback(
    async (token: string) => {
      if (!token) return
      setTicketStatus('loading')
      setTicketMessage('')
      const res = await fetch('/api/tickets', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setTicketStatus('error')
        setTicketMessage(data?.error || 'チケット情報の取得に失敗しました。')
        setTicketCount(null)
        return
      }
      setTicketStatus('idle')
      setTicketMessage('')
      setTicketCount(Number(data?.tickets ?? 0))
    },
    [],
  )

  useEffect(() => {
    if (!session || !accessToken) {
      setTicketCount(null)
      setTicketStatus('idle')
      setTicketMessage('')
      return
    }
    void fetchTickets(accessToken)
  }, [accessToken, fetchTickets, session])

  useEffect(() => {
    if (session && hasAnySource && statusMessage.includes('ログイン')) {
      setStatusMessage('生成準備OK')
    }
  }, [hasAnySource, session, statusMessage])

  useEffect(() => {
    if (!session && hasAnySource && !isRunning) {
      setStatusMessage('Googleでログインしてください。')
    }
  }, [hasAnySource, isRunning, session])

  const viewerStyle = useMemo(
    () =>
      ({
        '--progress': progress,
      }) as CSSProperties,
    [progress],
  )

  const applyImageAt = useCallback((index: number, image: string) => {
    setResults((prev) =>
      prev.map((item, itemIndex) => ({
        ...item,
        status: itemIndex === index ? 'done' : item.status,
        image: itemIndex === index ? image : item.image,
      })),
    )
  }, [])

  const submitEdit = useCallback(
    async (
      editPrompt: string,
      payload: string,
      subPayload: string | null,
      payloadName: string,
      subName: string | null,
      token: string,
      angleStrength: number,
    ) => {
      if (!payload) throw new Error('画像がありません。')
      const input: Record<string, unknown> = {
        image_base64: payload,
        image_name: payloadName || 'input.png',
        prompt: editPrompt,
        negative_prompt: negativePrompt,
        guidance_scale: guidanceScale,
        num_inference_steps: FIXED_STEPS,
        width: FIXED_WIDTH,
        height: FIXED_HEIGHT,
        seed: 0,
        randomize_seed: true,
        worker_mode: 'comfyui',
        angle_strength: angleStrength,
      }
      if (subPayload) {
        input.sub_image_base64 = subPayload
        input.sub_image_name = subName || 'sub.png'
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) {
        headers.Authorization = `Bearer ${token}`
      }
      const res = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = data?.error || data?.message || '生成に失敗しました。'
        throw new Error(message)
      }
      const images = extractImageList(data)
      if (images.length) {
        return { images }
      }
      const jobId = extractJobId(data)
      if (!jobId) throw new Error('ジョブIDが取得できませんでした。')
      return { jobId }
    },
    [guidanceScale, negativePrompt],
  )

  const pollJob = useCallback(async (jobId: string, runId: number, token?: string) => {
    for (let i = 0; i < 120; i += 1) {
      if (runIdRef.current !== runId) return { status: 'cancelled' as const, images: [] }
      const headers: Record<string, string> = {}
      if (token) {
        headers.Authorization = `Bearer ${token}`
      }
      const res = await fetch(`${API_ENDPOINT}?id=${encodeURIComponent(jobId)}`, { headers })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = data?.error || data?.message || 'ステータス取得に失敗しました。'
        throw new Error(message)
      }
      const status = String(data?.status || data?.state || '').toLowerCase()
      if (status.includes('fail')) {
        throw new Error(data?.error || '生成に失敗しました。')
      }
      const images = extractImageList(data)
      if (images.length) {
        return { status: 'done' as const, images }
      }
      await wait(1500 + i * 40)
    }
    throw new Error('生成がタイムアウトしました。')
  }, [])

  const startBatch = useCallback(
    async (payload: string, subPayload: string | null, payloadName: string, subName: string | null) => {
      if (!payload) return
      if (!session) {
        setStatusMessage('Googleでログインしてください。')
        return
      }
      const runId = runIdRef.current + 1
      runIdRef.current = runId
      setIsRunning(true)
      setStatusMessage('生成中… 約1分で完了予定')
      setResults([{ id: makeId(), status: 'queued' as const }])

      try {
        const tasks = [async () => {
          if (runIdRef.current !== runId) return
          setResults((prev) =>
            prev.map((item, itemIndex) =>
              itemIndex === 0 ? { ...item, status: 'running' as const, error: undefined } : item,
            ),
          )
          const directionPrompt = useAngle
            ? DIRECTION_PRESETS.find((preset) => preset.id === angleDirectionId)?.prompt
            : undefined
          const elevationPrompt = useAngle
            ? ELEVATION_PRESETS.find((preset) => preset.id === angleElevationId)?.prompt
            : undefined
          const editPrompt = buildEditPrompt(prompt, directionPrompt, elevationPrompt)
          try {
            const angleStrength = useAngle ? 1 : 0
            const submitted = await submitEdit(
              editPrompt,
              payload,
              subPayload,
              payloadName,
              subName,
              accessToken,
              angleStrength,
            )
            if (runIdRef.current !== runId) return
            if ('images' in submitted && submitted.images.length) {
              applyImageAt(0, submitted.images[0])
              return
            }
            if ('jobId' in submitted) {
              const polled = await pollJob(submitted.jobId, runId, accessToken)
              if (runIdRef.current !== runId) return
              if (polled.status === 'done' && polled.images.length) {
                applyImageAt(0, polled.images[0])
              }
            }
          } catch (error) {
            if (runIdRef.current !== runId) return
            const message = error instanceof Error ? error.message : 'リクエストに失敗しました。'
            setResults((prev) =>
              prev.map((item, itemIndex) =>
                itemIndex === 0 ? { ...item, status: 'error' as const, error: message } : item,
              ),
            )
            setStatusMessage(message)
          }
        }]

        await runQueue(tasks, MAX_PARALLEL)
        if (runIdRef.current === runId) {
          setStatusMessage('生成完了')
          if (accessToken) {
            void fetchTickets(accessToken)
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '生成に失敗しました。'
        setStatusMessage(message)
        setResults((prev) => prev.map((item) => ({ ...item, status: 'error', error: message })))
      } finally {
        if (runIdRef.current === runId) {
          setIsRunning(false)
        }
      }
    },
    [
      accessToken,
      angleDirectionId,
      angleElevationId,
      applyImageAt,
      fetchTickets,
      pollJob,
      prompt,
      session,
      submitEdit,
      useAngle,
    ],
  )

  const handleGoogleSignIn = async () => {
    if (!supabase || !isAuthConfigured) {
      setAuthStatus('error')
      setAuthMessage('認証の設定が未完了です。')
      return
    }
    setAuthStatus('loading')
    setAuthMessage('')
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: OAUTH_REDIRECT_URL, skipBrowserRedirect: true },
    })
    if (error) {
      setAuthStatus('error')
      setAuthMessage(error.message)
      return
    }
    if (data?.url) {
      window.location.assign(data.url)
      return
    }
    setAuthStatus('error')
    setAuthMessage('認証URLを取得できませんでした。')
  }

  const handleSignOut = async () => {
    if (!supabase) return
    try {
      await supabase.auth.signOut({ scope: 'local' })
    } catch (error) {
      setAuthStatus('error')
      setAuthMessage(error instanceof Error ? error.message : 'ログアウトに失敗しました。')
    }
  }

  const clearMainImage = useCallback(() => {
    setSourcePreview(null)
    setSourcePayload(null)
    setSourceName('')
  }, [])

  const clearSubImage = useCallback(() => {
    setSourcePreviewSub(null)
    setSourcePayloadSub(null)
    setSourceNameSub('')
  }, [])

  const handleMainFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const payload = toBase64(dataUrl)
      setSourcePreview(dataUrl)
      setSourcePayload(payload)
      setSourceName(file.name)
      setStatusMessage(session ? '生成準備OK' : 'Googleでログインしてください。')
    }
    reader.readAsDataURL(file)
  }

  const handleSubFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const payload = toBase64(dataUrl)
      setSourcePreviewSub(dataUrl)
      setSourcePayloadSub(payload)
      setSourceNameSub(file.name)
      setStatusMessage(session ? '生成準備OK' : 'Googleでログインしてください。')
    }
    reader.readAsDataURL(file)
  }

  const handleGenerate = async () => {
    const primaryPayload = sourcePayload ?? sourcePayloadSub
    if (!primaryPayload || isRunning) {
      if (!primaryPayload) {
        setStatusMessage('画像をアップロードしてください。')
      }
      return
    }
    if (!session) {
      setStatusMessage('Googleでログインしてください。')
      return
    }
    if (ticketStatus === 'loading') {
      setStatusMessage('チケット確認中…')
      return
    }
    if (ticketCount !== null && ticketCount <= 0) {
      setShowTicketModal(true)
      return
    }
    const primaryName = sourcePayload ? sourceName : sourceNameSub
    const secondaryPayload = sourcePayload && sourcePayloadSub ? sourcePayloadSub : null
    const secondaryName = sourcePayload && sourcePayloadSub ? sourceNameSub : null
    await startBatch(primaryPayload, secondaryPayload, primaryName, secondaryName)
  }

  return (
    <div className="camera-app">
      <TopNav />
      <header className="camera-hero">
        <div>
          <p className="camera-hero__eyebrow">YAJU AI</p>
          <h1>YAJU AI</h1>
          <p className="camera-hero__lede">画像をアップロードして、指示を書いて、生成を押すだけ。</p>
        </div>
        <div className="camera-hero__badge">
          <span>革命的AI</span>
          <strong>画像を自由に編集</strong>
        </div>
      </header>

      <div className="camera-shell">
        <section className="camera-panel">
          <div className="panel-header">
            <div className="panel-title">
              <h2>入力</h2>
              <span>{statusMessage}</span>
            </div>
            <div className="panel-auth">
              {session ? (
                <div className="auth-status">
                  <span className="auth-email">{session.user?.email ?? 'ログイン中'}</span>
                  <button type="button" className="ghost-button" onClick={handleSignOut}>
                    ログアウト
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={handleGoogleSignIn}
                  disabled={authStatus === 'loading'}
                >
                  {authStatus === 'loading' ? '接続中…' : 'Googleで新規登録 / ログイン'}
                </button>
              )}
            </div>
          </div>
          {authMessage && <div className="auth-message">{authMessage}</div>}
          {session && (
            <div className="ticket-message">
              {ticketStatus === 'loading' && 'チケット確認中…'}
              {ticketStatus !== 'loading' && `残りチケット: ${ticketCount ?? 0}`}
              {ticketStatus === 'error' && ticketMessage ? ` / ${ticketMessage}` : ''}
            </div>
          )}
          <label className="upload-box">
            <input type="file" accept="image/*" onChange={handleMainFileChange} />
            <div>
              <strong>{sourceName || 'メイン画像をアップロード'}</strong>
              <span>PNG/JPGに対応。アップロード後に生成できます。</span>
            </div>
          </label>
          {sourcePreview && (
            <div className="preview-card">
              <button
                type="button"
                className="preview-card__remove"
                onClick={clearMainImage}
                aria-label="Remove image"
              >
                x
              </button>
              <img src={sourcePreview} alt="メイン画像プレビュー" />
            </div>
          )}
          <label className="upload-box">
            <input type="file" accept="image/*" onChange={handleSubFileChange} />
            <div>
              <strong>{sourceNameSub || 'サブ画像（任意）をアップロード'}</strong>
              <span>PNG/JPGに対応。アップロード後に生成できます。</span>
            </div>
          </label>
          {sourcePreviewSub && (
            <div className="preview-card">
              <button
                type="button"
                className="preview-card__remove"
                onClick={clearSubImage}
                aria-label="Remove image"
              >
                x
              </button>
              <img src={sourcePreviewSub} alt="サブ画像プレビュー" />
            </div>
          )}

          <div className="settings-block">
            <h3>設定</h3>
            <label>
              <span>プロンプト</span>
              <input value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </label>
            <label>
              <span>ネガティブプロンプト</span>
              <input value={negativePrompt} onChange={(e) => setNegativePrompt(e.target.value)} />
            </label>
            <label>
              <span>プロンプト適用度（推奨1）</span>
              <input
                type="range"
                min={1}
                max={2}
                step={0.1}
                value={guidanceScale}
                onChange={(e) => setGuidanceScale(Number(e.target.value))}
              />
              <em>{guidanceScale.toFixed(1)}</em>
            </label>
            <label className="toggle">
              <span>アングル変更</span>
              <input type="checkbox" checked={useAngle} onChange={(e) => setUseAngle(e.target.checked)} />
            </label>
            {useAngle && (
              <>
                <label>
                  <span>方角（8方向）</span>
                  <select value={angleDirectionId} onChange={(e) => setAngleDirectionId(e.target.value)}>
                    {DIRECTION_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>上下角度</span>
                  <select value={angleElevationId} onChange={(e) => setAngleElevationId(e.target.value)}>
                    {ELEVATION_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </div>

          <button
            type="button"
          className="primary-button"
          onClick={handleGenerate}
          disabled={(!sourcePayload && !sourcePayloadSub) || isRunning || !session}
        >
            {isRunning ? '生成中…' : '生成'}
          </button>
        </section>

        <section className="camera-stage">
          <div className="stage-header">
            <div>
              <h2>プレビュー</h2>
              <p>最新の出力をここに表示します。</p>
            </div>
          </div>

          <div className="stage-viewer" style={viewerStyle}>
            <div className="viewer-progress" aria-hidden="true" />
            {displayImage ? (
              <img src={displayImage} alt="生成結果" />
            ) : (
              <div className="stage-placeholder">{emptyMessage}</div>
            )}
            {isRunning && (
              <div className="loading-overlay" role="status" aria-live="polite">
                <div className="loading-card">
                  <span className="loading-spinner" aria-hidden="true" />
                  <div>
                    <strong>生成中</strong>
                    <p>約1分で完了予定</p>
                  </div>
                </div>
              </div>
            )}
            {isRunning && (
              <div className="viewer-hud">
                <span>{`生成中 ${completedCount}/${totalFrames}`}</span>
              </div>
            )}
          </div>
        </section>
      </div>
      {showTicketModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>チケットがありません</h3>
            <p>生成にはチケットが必要です。購入ページへ移動しますか？</p>
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setShowTicketModal(false)}>
                閉じる
              </button>
              <button type="button" className="primary-button" onClick={() => navigate('/purchase')}>
                チケット購入へ
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
