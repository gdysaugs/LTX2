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
  video?: string
  error?: string
}

const MAX_PARALLEL = 1
const API_ENDPOINT = '/api/wan'
const FIXED_FPS = 10
const FIXED_SECONDS = 5
const FIXED_STEPS = 4
const FIXED_CFG = 1
const FIXED_FRAME_COUNT = FIXED_FPS * FIXED_SECONDS
const VIDEO_TICKET_COST = 2
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

const toBase64 = (dataUrl: string) => {
  const parts = dataUrl.split(',')
  return parts.length > 1 ? parts[1] : dataUrl
}

const normalizeVideo = (value: unknown, filename?: string) => {
  if (typeof value !== 'string' || !value) return null
  if (value.startsWith('data:') || value.startsWith('http')) return value
  const ext = filename?.split('.').pop()?.toLowerCase()
  const mime =
    ext === 'webm' ? 'video/webm' : ext === 'gif' ? 'image/gif' : ext === 'mp4' ? 'video/mp4' : 'video/mp4'
  return `data:${mime};base64,${value}`
}

const alignTo16 = (value: number) => Math.max(16, Math.round(value / 16) * 16)
const PORTRAIT_MAX = { width: 576, height: 832 }
const LANDSCAPE_MAX = { width: 832, height: 576 }

const fitWithinBounds = (width: number, height: number, maxWidth: number, maxHeight: number) => {
  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  const scaledWidth = width * scale
  const scaledHeight = height * scale
  const aspect = width / height

  if (aspect >= 1) {
    const targetWidth = Math.min(maxWidth, alignTo16(scaledWidth))
    const targetHeight = Math.min(maxHeight, alignTo16(targetWidth / aspect))
    return { width: targetWidth, height: targetHeight }
  }
  const targetHeight = Math.min(maxHeight, alignTo16(scaledHeight))
  const targetWidth = Math.min(maxWidth, alignTo16(targetHeight * aspect))
  return { width: targetWidth, height: targetHeight }
}

const getTargetSize = (width: number, height: number) => {
  const isPortrait = height >= width
  const bounds = isPortrait ? PORTRAIT_MAX : LANDSCAPE_MAX
  return fitWithinBounds(width, height, bounds.width, bounds.height)
}

const buildPaddedDataUrl = (img: HTMLImageElement, targetWidth: number, targetHeight: number) => {
  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight)
  return canvas.toDataURL('image/png')
}

const isVideoLike = (value: unknown, filename?: string) => {
  const ext = filename?.split('.').pop()?.toLowerCase()
  if (ext && ['mp4', 'webm', 'gif'].includes(ext)) return true
  if (typeof value !== 'string') return false
  if (value.startsWith('data:video/') || value.startsWith('data:image/gif')) return true
  return false
}

const extractVideoList = (payload: any) => {
  const output = payload?.output ?? payload?.result ?? payload
  const nested = output?.output ?? output?.result ?? output?.data ?? payload?.output?.output ?? payload?.result?.output
  const listCandidates = [
    output?.videos,
    output?.outputs,
    output?.output_videos,
    output?.gifs,
    output?.images,
    payload?.videos,
    payload?.gifs,
    payload?.images,
    nested?.videos,
    nested?.outputs,
    nested?.output_videos,
    nested?.gifs,
    nested?.images,
    nested?.data,
  ]
  for (const candidate of listCandidates) {
    if (!Array.isArray(candidate)) continue
    const normalized = candidate
      .map((item: any) => {
        const raw = item?.video ?? item?.data ?? item?.url ?? item
        const name = item?.filename
        if (!isVideoLike(raw, name)) return null
        return normalizeVideo(raw, name)
      })
      .filter(Boolean) as string[]
    if (normalized.length) return normalized
  }
  return []
}

const extractJobId = (payload: any) => payload?.id || payload?.jobId || payload?.job_id || payload?.output?.id

export function Video() {
  const [sourcePreview, setSourcePreview] = useState<string | null>(null)
  const [sourcePayload, setSourcePayload] = useState<string | null>(null)
  const [sourceName, setSourceName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [width, setWidth] = useState(832)
  const [height, setHeight] = useState(576)
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
  const completedCount = useMemo(() => results.filter((item) => item.video).length, [results])
  const progress = totalFrames ? completedCount / totalFrames : 0
  const displayVideo = results[0]?.video ?? null
  const emptyMessage = sourcePayload ? '生成ボタンを押してください。' : '画像をアップロードしてください。'
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
    if (session && sourcePayload && statusMessage.includes('ログイン')) {
      setStatusMessage('生成準備OK')
    }
  }, [session, sourcePayload, statusMessage])

  useEffect(() => {
    if (!session && sourcePayload && !isRunning) {
      setStatusMessage('Googleでログインしてください。')
    }
  }, [isRunning, session, sourcePayload])

  const viewerAspect = displayVideo ? `${width} / ${height}` : '1 / 1'

  const viewerStyle = useMemo(
    () =>
      ({
        '--progress': progress,
        '--viewer-aspect': viewerAspect,
      }) as CSSProperties,
    [progress, viewerAspect],
  )

  const applyVideoAt = useCallback((index: number, video: string) => {
    setResults((prev) =>
      prev.map((item, itemIndex) => ({
        ...item,
        status: itemIndex === index ? 'done' : item.status,
        video: itemIndex === index ? video : item.video,
      })),
    )
  }, [])

  const submitVideo = useCallback(
    async (payload: string, token: string) => {
      if (!payload) throw new Error('画像がありません。')
      const input: Record<string, unknown> = {
        image_base64: payload,
        prompt,
        negative_prompt: negativePrompt,
        width,
        height,
        noise_aug_strength: 0.1,
        fps: FIXED_FPS,
        seconds: FIXED_SECONDS,
        num_frames: FIXED_FRAME_COUNT,
        steps: FIXED_STEPS,
        cfg: FIXED_CFG,
        seed: 0,
        randomize_seed: true,
        worker_mode: 'comfyui',
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
      const nextTickets = Number(data?.ticketsLeft ?? data?.tickets_left)
      if (Number.isFinite(nextTickets)) {
        setTicketCount(nextTickets)
      }
      const videos = extractVideoList(data)
      if (videos.length) {
        return { videos }
      }
      const jobId = extractJobId(data)
      if (!jobId) throw new Error('ジョブIDが取得できませんでした。')
      return { jobId }
    },
    [height, negativePrompt, prompt, width],
  )

  const pollJob = useCallback(async (jobId: string, runId: number, token?: string) => {
    for (let i = 0; i < 180; i += 1) {
      if (runIdRef.current !== runId) return { status: 'cancelled' as const, videos: [] }
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
      const nextTickets = Number(data?.ticketsLeft ?? data?.tickets_left)
      if (Number.isFinite(nextTickets)) {
        setTicketCount(nextTickets)
      }
      const status = String(data?.status || data?.state || '').toLowerCase()
      if (status.includes('fail')) {
        throw new Error(data?.error || '生成に失敗しました。')
      }
      const videos = extractVideoList(data)
      if (videos.length) {
        return { status: 'done' as const, videos }
      }
      await wait(2000 + i * 50)
    }
    throw new Error('生成がタイムアウトしました。')
  }, [])

  const startBatch = useCallback(
    async (payload: string) => {
      if (!payload) return
      if (!session) {
        setStatusMessage('Googleでログインしてください。')
        return
      }
      const runId = runIdRef.current + 1
      runIdRef.current = runId
      setIsRunning(true)
      setStatusMessage('生成中… 約数分で完了予定')
      setResults([{ id: makeId(), status: 'queued' as const }])

      try {
        const tasks = [async () => {
          if (runIdRef.current !== runId) return
          setResults((prev) =>
            prev.map((item, itemIndex) =>
              itemIndex === 0 ? { ...item, status: 'running' as const, error: undefined } : item,
            ),
          )
          try {
            const submitted = await submitVideo(payload, accessToken)
            if (runIdRef.current !== runId) return
            if ('videos' in submitted && submitted.videos.length) {
              applyVideoAt(0, submitted.videos[0])
              return
            }
            if ('jobId' in submitted) {
              const polled = await pollJob(submitted.jobId, runId, accessToken)
              if (runIdRef.current !== runId) return
              if (polled.status === 'done' && polled.videos.length) {
                applyVideoAt(0, polled.videos[0])
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
    [accessToken, applyVideoAt, fetchTickets, pollJob, session, submitVideo],
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

  const clearImage = useCallback(() => {
    setSourcePreview(null)
    setSourcePayload(null)
    setSourceName('')
  }, [])

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const img = new Image()
      img.onload = () => {
        const { width: targetWidth, height: targetHeight } = getTargetSize(img.naturalWidth, img.naturalHeight)
        const paddedDataUrl = buildPaddedDataUrl(img, targetWidth, targetHeight) ?? dataUrl
        const payload = toBase64(paddedDataUrl)
        setWidth(targetWidth)
        setHeight(targetHeight)
        setSourcePreview(paddedDataUrl)
        setSourcePayload(payload)
        setSourceName(file.name)
        setStatusMessage(session ? '生成準備OK' : 'Googleでログインしてください。')
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  }

  const handleGenerate = async () => {
    if (!sourcePayload || isRunning) return
    if (!session) {
      setStatusMessage('Googleでログインしてください。')
      return
    }
    if (ticketStatus === 'loading') {
      setStatusMessage('チケット確認中…')
      return
    }
    if (ticketCount !== null && ticketCount < VIDEO_TICKET_COST) {
      setShowTicketModal(true)
      return
    }
    await startBatch(sourcePayload)
  }

  const isGif = displayVideo?.startsWith('data:image/gif')
  const canDownload = Boolean(displayVideo && !isGif)

  const handleDownload = useCallback(async () => {
    if (!displayVideo) return
    const baseName = sourceName ? sourceName.replace(/\.[^.]+$/, '') : 'wan-video'
    const ext = isGif ? 'gif' : 'mp4'
    const filename = `${baseName}.${ext}`
    try {
      const response = await fetch(displayVideo)
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch {
      window.open(displayVideo, '_blank', 'noopener')
    }
  }, [displayVideo, isGif, sourceName])

  return (
    <div className="camera-app">
      <TopNav />
      <header className="camera-hero">
        <div>
          <p className="camera-hero__eyebrow">YAJU AI</p>
          <h1>YAJU AI Video</h1>
          <p className="camera-hero__lede">静止画から短い動画を生成します。</p>
        </div>
        <div className="camera-hero__badge">
          <span>高速AI生成</span>
          <strong>どんな画像も動画に</strong>
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
            <input type="file" accept="image/*" onChange={handleFileChange} />
            <div>
              <strong>{sourceName || '画像をアップロード'}</strong>
              <span>動画化したい元画像を選択してください。</span>
            </div>
          </label>
          {sourcePreview && (
            <div className="preview-card">
              <button
                type="button"
                className="preview-card__remove"
                onClick={clearImage}
                aria-label="Remove image"
              >
                x
              </button>
              <img src={sourcePreview} alt="入力プレビュー" />
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
          </div>

          <button
            type="button"
            className="primary-button"
            onClick={handleGenerate}
            disabled={!sourcePayload || isRunning || !session}
          >
            {isRunning ? '生成中…' : '動画生成'}
          </button>
        </section>

        <section className="camera-stage">
          <div className="stage-header">
            <div>
              <h2>プレビュー</h2>
              <p>生成された動画を表示します。</p>
            </div>
            {canDownload && (
              <div className="stage-actions">
                <button type="button" className="ghost-button" onClick={handleDownload}>
                  保存
                </button>
              </div>
            )}
          </div>

          <div className="stage-viewer" style={viewerStyle}>
            <div className="viewer-progress" aria-hidden="true" />
            {displayVideo ? (
              isGif ? (
                <img src={displayVideo} alt="生成結果" />
              ) : (
                <video controls src={displayVideo} />
              )
            ) : (
              <div className="stage-placeholder">{emptyMessage}</div>
            )}
            {isRunning && (
              <div className="loading-overlay" role="status" aria-live="polite">
                <div className="loading-card">
                  <span className="loading-spinner" aria-hidden="true" />
                  <div>
                    <strong>生成中</strong>
                    <p>数分かかる可能性があります</p>
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
            <h3>チケットが不足しています</h3>
            <p>動画生成にはチケットが2枚必要です。購入ページへ移動しますか？</p>
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
