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
import { GuestIntro } from '../components/GuestIntro'
import './camera.css'

type RenderResult = {
  id: string
  status: 'queued' | 'running' | 'done' | 'error'
  image?: string
  error?: string
}

const API_ENDPOINT = '/api/qwen'
const IMAGE_TICKET_COST = 1
const FIXED_STEPS = 4
const FIXED_CFG = 1
const FIXED_ANGLE_STRENGTH = 0
const OAUTH_REDIRECT_URL =
  import.meta.env.VITE_SUPABASE_REDIRECT_URL ?? (typeof window !== 'undefined' ? window.location.origin : undefined)

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const makeId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const toBase64 = (dataUrl: string) => {
  const parts = dataUrl.split(',')
  return parts.length > 1 ? parts[1] : dataUrl
}

const normalizeImage = (value: unknown, filename?: string) => {
  if (typeof value !== 'string' || !value) return null
  if (value.startsWith('data:') || value.startsWith('http')) return value
  const ext = filename?.split('.').pop()?.toLowerCase()
  const mime =
    ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'webp'
      ? 'image/webp'
      : ext === 'gif'
      ? 'image/gif'
      : 'image/png'
  return `data:${mime};base64,${value}`
}

const base64ToBlob = (base64: string, mime: string) => {
  const chunkSize = 0x8000
  const byteChars = atob(base64)
  const byteArrays: Uint8Array[] = []
  for (let offset = 0; offset < byteChars.length; offset += chunkSize) {
    const slice = byteChars.slice(offset, offset + chunkSize)
    const byteNumbers = new Array(slice.length)
    for (let i = 0; i < slice.length; i += 1) {
      byteNumbers[i] = slice.charCodeAt(i)
    }
    byteArrays.push(new Uint8Array(byteNumbers))
  }
  return new Blob(byteArrays, { type: mime })
}

const dataUrlToBlob = (dataUrl: string, fallbackMime: string) => {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/)
  if (!match) {
    return base64ToBlob(dataUrl, fallbackMime)
  }
  const mime = match[1] || fallbackMime
  const base64 = match[2] || ''
  return base64ToBlob(base64, mime)
}

const extractErrorMessage = (payload: any) =>
  payload?.error ||
  payload?.message ||
  payload?.output?.error ||
  payload?.result?.error ||
  payload?.output?.output?.error ||
  payload?.result?.output?.error

const normalizeErrorMessage = (value: unknown) => {
  if (!value) return 'Request failed.'
  if (typeof value === 'object') {
    const maybe = value as { error?: unknown; message?: unknown; detail?: unknown }
    const picked = maybe.error ?? maybe.message ?? maybe.detail
    if (typeof picked === 'string' && picked) return picked
    if (value instanceof Error && value.message) return value.message
  }
  const raw = typeof value === 'string' ? value : value instanceof Error ? value.message : String(value)
  const lowered = raw.toLowerCase()
  if (
    lowered.includes('out of memory') ||
    lowered.includes('would exceed allowed memory') ||
    lowered.includes('allocation on device') ||
    lowered.includes('cuda') ||
    lowered.includes('oom')
  ) {
    return '画像サイズエラーです。サイズの小さい画像で再生成してください。'
  }
  const trimmed = raw.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed)
      const message = parsed?.error || parsed?.message || parsed?.detail
      if (typeof message === 'string' && message) return message
    } catch {
      // ignore parse errors
    }
  }
  return raw
}

const isTicketShortage = (status: number, message: string) => {
  if (status === 402) return true
  const lowered = message.toLowerCase()
  return (
    lowered.includes('no ticket') ||
    lowered.includes('insufficient_tickets') ||
    lowered.includes('insufficient tickets') ||
    lowered.includes('token') ||
    lowered.includes('credit')
  )
}

const isFailureStatus = (status: string) => {
  const normalized = status.toLowerCase()
  return normalized.includes('fail') || normalized.includes('error') || normalized.includes('cancel')
}

const extractImageList = (payload: any) => {
  const output = payload?.output ?? payload?.result ?? payload
  const nested = output?.output ?? output?.result ?? output?.data ?? payload?.output?.output ?? payload?.result?.output
  const listCandidates = [
    output?.images,
    output?.output_images,
    output?.outputs,
    output?.data,
    payload?.images,
    payload?.output_images,
    nested?.images,
    nested?.output_images,
    nested?.outputs,
    nested?.data,
  ]

  for (const candidate of listCandidates) {
    if (!Array.isArray(candidate)) continue
    const normalized = candidate
      .map((item: any) => {
        const raw = item?.image ?? item?.data ?? item?.url ?? item
        const name = item?.filename
        return normalizeImage(raw, name)
      })
      .filter(Boolean) as string[]
    if (normalized.length) return normalized
  }

  const singleCandidates = [
    output?.image,
    output?.output_image,
    output?.output_image_base64,
    payload?.image,
    payload?.output_image_base64,
    nested?.image,
    nested?.output_image,
    nested?.output_image_base64,
  ]

  for (const candidate of singleCandidates) {
    const normalized = normalizeImage(candidate)
    if (normalized) return [normalized]
  }

  return []
}

const extractJobId = (payload: any) => payload?.id || payload?.jobId || payload?.job_id || payload?.output?.id

const alignTo16 = (value: number) => Math.max(256, Math.round(value / 16) * 16)

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

const getTargetSize = (width: number, height: number) => fitWithinBounds(width, height, 1024, 1024)

const buildPaddedDataUrl = (img: HTMLImageElement, targetWidth: number, targetHeight: number) => {
  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight)
  return canvas.toDataURL('image/png')
}

export function Image() {
  const [sourcePreview, setSourcePreview] = useState<string | null>(null)
  const [sourcePayload, setSourcePayload] = useState<string | null>(null)
  const [sourceName, setSourceName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [width, setWidth] = useState(1024)
  const [height, setHeight] = useState(1024)
  const [result, setResult] = useState<RenderResult | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [step, setStep] = useState(0)
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(!supabase)
  const [ticketCount, setTicketCount] = useState<number | null>(null)
  const [ticketStatus, setTicketStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [ticketMessage, setTicketMessage] = useState('')
  const [showTicketModal, setShowTicketModal] = useState(false)
  const [errorModalMessage, setErrorModalMessage] = useState<string | null>(null)
  const runIdRef = useRef(0)
  const navigate = useNavigate()

  const accessToken = session?.access_token ?? ''
  const totalSteps = 4
  const stepTitles = ['画像アップロード', 'プロンプト', 'ネガティブプロンプト', '生成'] as const
  const canAdvanceImage = Boolean(sourcePayload)
  const canAdvancePrompt = prompt.trim().length > 0
  const displayImage = result?.image ?? null

  const viewerStyle = useMemo(
    () =>
      ({
        '--viewer-aspect': `${Math.max(1, width)} / ${Math.max(1, height)}`,
        '--progress': result?.status === 'done' ? 1 : isRunning ? 0.5 : 0,
      }) as CSSProperties,
    [height, isRunning, result?.status, width],
  )

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true)
      return
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
      setAuthReady(true)
    })
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setAuthReady(true)
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
        setStatusMessage(error.message)
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
      if (!token) return null
      setTicketStatus('loading')
      setTicketMessage('')
      const res = await fetch('/api/tickets', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setTicketStatus('error')
        setTicketMessage(data?.error || 'トークンの取得に失敗しました。')
        setTicketCount(null)
        return null
      }
      const nextCount = Number(data?.tickets ?? 0)
      setTicketStatus('idle')
      setTicketMessage('')
      setTicketCount(nextCount)
      return nextCount
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

  const submitImage = useCallback(
    async (payload: string, token: string) => {
      const input: Record<string, unknown> = {
        prompt,
        negative_prompt: negativePrompt,
        image_base64: payload,
        width,
        height,
        steps: FIXED_STEPS,
        cfg: FIXED_CFG,
        seed: 0,
        randomize_seed: true,
        angle_strength: FIXED_ANGLE_STRENGTH,
        worker_mode: 'comfyui',
        mode: 'comfyui',
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers.Authorization = `Bearer ${token}`
      const res = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const rawMessage = data?.error || data?.message || data?.detail || 'Generation failed.'
        const message = normalizeErrorMessage(rawMessage)
        if (isTicketShortage(res.status, message)) {
          setShowTicketModal(true)
          setStatusMessage('トークン不足')
          throw new Error('TICKET_SHORTAGE')
        }
        setErrorModalMessage(message)
        throw new Error(message)
      }
      const nextTickets = Number(data?.ticketsLeft ?? data?.tickets_left)
      if (Number.isFinite(nextTickets)) setTicketCount(nextTickets)
      const images = extractImageList(data)
      if (images.length) return { images }
      const jobId = extractJobId(data)
      if (!jobId) throw new Error('ジョブIDの取得に失敗しました。')
      const usageId = String(data?.usage_id ?? data?.usageId ?? '')
      if (!usageId) throw new Error('usage_id の取得に失敗しました。')
      return { jobId, usageId }
    },
    [height, negativePrompt, prompt, width],
  )

  const pollJob = useCallback(async (jobId: string, usageId: string, runId: number, token?: string) => {
    for (let i = 0; i < 180; i += 1) {
      if (runIdRef.current !== runId) return { status: 'cancelled' as const, images: [] as string[] }
      const headers: Record<string, string> = {}
      if (token) headers.Authorization = `Bearer ${token}`
      const res = await fetch(
        `${API_ENDPOINT}?id=${encodeURIComponent(jobId)}&usage_id=${encodeURIComponent(usageId)}`,
        { headers },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
      const rawMessage = data?.error || data?.message || data?.detail || 'ステータス確認に失敗しました。'
        const message = normalizeErrorMessage(rawMessage)
        if (isTicketShortage(res.status, message)) {
          setShowTicketModal(true)
          setStatusMessage('トークン不足')
          throw new Error('TICKET_SHORTAGE')
        }
        setErrorModalMessage(message)
        throw new Error(message)
      }
      const nextTickets = Number(data?.ticketsLeft ?? data?.tickets_left)
      if (Number.isFinite(nextTickets)) setTicketCount(nextTickets)
      const status = String(data?.status || data?.state || '').toLowerCase()
      const statusError = extractErrorMessage(data)
      if (statusError || isFailureStatus(status)) {
        throw new Error(normalizeErrorMessage(statusError || 'Generation failed.'))
      }
      const images = extractImageList(data)
      if (images.length) return { status: 'done' as const, images }
      await wait(2000 + i * 50)
    }
    throw new Error('生成がタイムアウトしました。')
  }, [])

  const startGenerate = useCallback(
    async (payload: string) => {
      const runId = runIdRef.current + 1
      runIdRef.current = runId
      setIsRunning(true)
      setStatusMessage('')
      setResult({ id: makeId(), status: 'running' })

      try {
        const submitted = await submitImage(payload, accessToken)
        if (runIdRef.current !== runId) return
        if ('images' in submitted && submitted.images.length) {
          setResult({ id: makeId(), status: 'done', image: submitted.images[0] })
          setStatusMessage('完了')
          if (accessToken) void fetchTickets(accessToken)
          return
        }
        const polled = await pollJob(submitted.jobId, submitted.usageId, runId, accessToken)
        if (runIdRef.current !== runId) return
        if (polled.status === 'done' && polled.images.length) {
          setResult({ id: makeId(), status: 'done', image: polled.images[0] })
          setStatusMessage('完了')
          if (accessToken) void fetchTickets(accessToken)
        }
      } catch (error) {
        const message = normalizeErrorMessage(error instanceof Error ? error.message : error)
        if (message === 'TICKET_SHORTAGE') {
          setResult({ id: makeId(), status: 'error', error: 'トークン不足' })
          setStatusMessage('トークン不足')
        } else {
          setResult({ id: makeId(), status: 'error', error: message })
          setStatusMessage(message)
          setErrorModalMessage(message)
        }
      } finally {
        if (runIdRef.current === runId) setIsRunning(false)
      }
    },
    [accessToken, fetchTickets, pollJob, submitImage],
  )

  const handleGenerate = async () => {
    if (!sourcePayload || isRunning) return
    if (!session) {
      setStatusMessage('Googleでログインしてください。')
      return
    }
    if (ticketStatus === 'loading') {
      setStatusMessage('トークンを確認中...')
      return
    }
    if (accessToken) {
      setStatusMessage('トークンを確認中...')
      const latestCount = await fetchTickets(accessToken)
      if (latestCount !== null && latestCount < IMAGE_TICKET_COST) {
        setShowTicketModal(true)
        return
      }
    } else if (ticketCount === null) {
      setStatusMessage('トークンを確認中...')
      return
    } else if (ticketCount < IMAGE_TICKET_COST) {
      setShowTicketModal(true)
      return
    }
    await startGenerate(sourcePayload)
  }

  const handleGoogleSignIn = async () => {
    if (!supabase || !isAuthConfigured) {
      window.alert('認証設定が不足しています。')
      return
    }
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: OAUTH_REDIRECT_URL, skipBrowserRedirect: true },
    })
    if (error) {
      window.alert(error.message)
      return
    }
    if (data?.url) {
      window.location.assign(data.url)
      return
    }
    window.alert('OAuth URLの取得に失敗しました。')
  }

  const clearImage = () => {
    setSourcePreview(null)
    setSourcePayload(null)
    setSourceName('')
    setStatusMessage('')
    setStep(0)
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const img = new window.Image()
      img.onload = () => {
        const { width: targetWidth, height: targetHeight } = getTargetSize(img.naturalWidth, img.naturalHeight)
        const paddedDataUrl = buildPaddedDataUrl(img, targetWidth, targetHeight) ?? dataUrl
        setWidth(targetWidth)
        setHeight(targetHeight)
        setSourcePreview(paddedDataUrl)
        setSourcePayload(toBase64(paddedDataUrl))
        setSourceName(file.name)
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  }

  const handleDownload = useCallback(async () => {
    if (!displayImage) return
    const baseName = sourceName ? sourceName.replace(/\.[^.]+$/, '') : 'i2i-image'
    const filename = `${baseName}-result.png`
    try {
      let blob: Blob
      if (displayImage.startsWith('data:')) {
        blob = dataUrlToBlob(displayImage, 'image/png')
      } else if (displayImage.startsWith('http') || displayImage.startsWith('blob:')) {
        const response = await fetch(displayImage)
        blob = await response.blob()
      } else {
        blob = base64ToBlob(displayImage, 'image/png')
      }
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch {
      window.location.assign(displayImage)
    }
  }, [displayImage, sourceName])

  if (!authReady) {
    return (
      <div className="camera-app">
        <TopNav />
        <div className="auth-boot" />
      </div>
    )
  }

  if (!session) {
    return (
      <div className="camera-app">
        <TopNav />
        <GuestIntro mode="image" onSignIn={handleGoogleSignIn} />
      </div>
    )
  }

  return (
    <div className="camera-app">
      <TopNav />
      <div className="wizard-shell">
        <section className="wizard-panel wizard-panel--inputs">
          <div className="wizard-card wizard-card--step">
            <div className="wizard-stepper">
              <div className="wizard-stepper__meta">
                <span>{`ステップ ${step + 1} / ${totalSteps}`}</span>
                <div className="wizard-dots">
                  {Array.from({ length: totalSteps }).map((_, index) => (
                    <span key={`i2i-step-${index}`} className={`wizard-dot${index <= step ? ' is-active' : ''}`} />
                  ))}
                </div>
              </div>
              <div className="wizard-status">
                {ticketStatus === 'loading' && 'トークンを確認中...'}
                {ticketStatus !== 'loading' && `トークン: ${ticketCount ?? 0}`}
                {ticketStatus === 'error' && ticketMessage ? ` / ${ticketMessage}` : ''}
              </div>
              <h2>{stepTitles[step]}</h2>
            </div>

            {step === 0 && (
              <div className="wizard-section">
                <label className="upload-box">
                  <input type="file" accept="image/*" onChange={handleFileChange} />
                  <div>
                    <strong>{sourceName || '画像をアップロード'}</strong>
                    <span>画像から画像を生成する元画像を選択してください。</span>
                  </div>
                </label>
                {sourcePreview && (
                  <div className="preview-card">
                    <button
                      type="button"
                      className="preview-card__remove"
                      onClick={clearImage}
                      aria-label="画像を削除"
                    >
                      x
                    </button>
                    <img src={sourcePreview} alt="元画像プレビュー" />
                  </div>
                )}
              </div>
            )}

            {step === 1 && (
              <label className="wizard-field">
                <span>プロンプト</span>
                <textarea
                  rows={4}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="例: 女性が笑顔で手を振る"
                />
              </label>
            )}

            {step === 2 && (
              <label className="wizard-field">
                <span>ネガティブプロンプト</span>
                <textarea
                  rows={3}
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  placeholder="任意: 避けたい内容を入力。"
                />
              </label>
            )}

            {step === 3 && (
              <div className="wizard-summary">
                <div>
                  <p>プロンプト</p>
                  <strong>{prompt || '-'}</strong>
                </div>
                <div>
                  <p>ネガティブプロンプト</p>
                  <strong>{negativePrompt || '-'}</strong>
                </div>
                <div>
                  <p>出力サイズ</p>
                  <strong>{`${width} x ${height}`}</strong>
                </div>
              </div>
            )}

            <div className="wizard-actions">
              {step > 0 && (
                <button type="button" className="ghost-button" onClick={() => setStep((prev) => Math.max(prev - 1, 0))}>
                  戻る
                </button>
              )}
              {step === 0 && (
                <button type="button" className="primary-button" onClick={() => setStep(1)} disabled={!canAdvanceImage}>
                  次へ
                </button>
              )}
              {step === 1 && (
                <button type="button" className="primary-button" onClick={() => setStep(2)} disabled={!canAdvancePrompt}>
                  次へ
                </button>
              )}
              {step === 2 && (
                <button type="button" className="primary-button" onClick={() => setStep(3)}>
                  次へ
                </button>
              )}
              {step === 3 && (
                <button type="button" className="primary-button" onClick={handleGenerate} disabled={!sourcePayload || isRunning}>
                  {isRunning ? '生成中...' : '生成'}
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="wizard-panel wizard-panel--preview">
          <div className="wizard-card wizard-card--preview">
            <div className="wizard-card__header">
              <div>
                <p className="wizard-eyebrow">プレビュー</p>
                {statusMessage && !isRunning && <span>{statusMessage}</span>}
              </div>
              {displayImage && (
                <button type="button" className="ghost-button" onClick={handleDownload}>
                  保存
                </button>
              )}
            </div>

            <div className="stage-viewer" style={viewerStyle}>
              <div className="viewer-progress" aria-hidden="true" />
              {isRunning ? (
                <div className="loading-display" role="status" aria-live="polite">
                  <div className="loading-orb" aria-hidden="true" />
                  <span className="loading-blink">生成中...</span>
                </div>
              ) : displayImage ? (
                <img src={displayImage} alt="生成結果" />
              ) : (
                <div className="stage-placeholder">元画像とプロンプトを入力してください。</div>
              )}
            </div>
          </div>
        </section>
      </div>

      {showTicketModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>トークン不足</h3>
            <p>画像生成は1トークン必要です。購入ページへ移動しますか？</p>
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setShowTicketModal(false)}>
                閉じる
              </button>
              <button type="button" className="primary-button" onClick={() => navigate('/purchase')}>
                購入する
              </button>
            </div>
          </div>
        </div>
      )}

      {errorModalMessage && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>リクエストが拒否されました</h3>
            <p>{errorModalMessage}</p>
            <div className="modal-actions">
              <button type="button" className="primary-button" onClick={() => setErrorModalMessage(null)}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
