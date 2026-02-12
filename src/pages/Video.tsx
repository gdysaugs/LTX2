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
const VIDEO_TICKET_COST = 1
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

const isProbablyMobile = () => {
  if (typeof navigator === 'undefined') return false
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData
  if (uaData && typeof uaData.mobile === 'boolean') {
    return uaData.mobile
  }
  const ua = navigator.userAgent || ''
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return true
  if (/Macintosh/i.test(ua) && typeof navigator.maxTouchPoints === 'number') {
    return navigator.maxTouchPoints > 1
  }
  return false
}

const extractErrorMessage = (payload: any) =>
  payload?.error ||
  payload?.message ||
  payload?.output?.error ||
  payload?.result?.error ||
  payload?.output?.output?.error ||
  payload?.result?.output?.error

const POLICY_BLOCK_MESSAGE =
  'この画像には暴力的な表現、低年齢、または規約違反の可能性があります。別の画像でお試しください。'

const normalizeErrorMessage = (value: unknown) => {
  if (!value) return 'リクエストに失敗しました。'
  if (typeof value === 'object') {
    const maybe = value as { error?: unknown; message?: unknown; detail?: unknown }
    const picked = maybe?.error ?? maybe?.message ?? maybe?.detail
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
  if (
    lowered.includes('underage') ||
    lowered.includes('minor') ||
    lowered.includes('child') ||
    lowered.includes('age_range') ||
    lowered.includes('age range') ||
    lowered.includes('agerange') ||
    lowered.includes('policy') ||
    lowered.includes('moderation') ||
    lowered.includes('violence') ||
    lowered.includes('rekognition')
  ) {
    return POLICY_BLOCK_MESSAGE
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
    lowered.includes('no tickets') ||
    lowered.includes('no ticket') ||
    lowered.includes('insufficient_tickets') ||
    lowered.includes('insufficient tickets') ||
    lowered.includes('token不足') ||
    lowered.includes('トークン') ||
    lowered.includes('token') ||
    lowered.includes('credit')
  )
}

const isFailureStatus = (status: string) => {
  const normalized = status.toLowerCase()
  return normalized.includes('fail') || normalized.includes('error') || normalized.includes('cancel')
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

  const totalFrames = results.length || 1
  const completedCount = useMemo(() => results.filter((item) => item.video).length, [results])
  const progress = totalFrames ? completedCount / totalFrames : 0
  const displayVideo = results[0]?.video ?? null
  const emptyMessage = sourcePayload ? '準備完了。' : '画像をアップロードしてください。'
  const accessToken = session?.access_token ?? ''
  const totalSteps = 4
  const stepTitles = ['画像アップロード', 'プロンプト入力', 'ネガティブ入力', '確認して生成'] as const
  const stepDescriptions = [
    '動画化する画像を選択します。',
    '動きの指示を入力します。',
    '任意: 避けたい内容を入力します。',
    '利用規約に同意して内容を確認して生成します。',
  ] as const
  const canAdvanceImage = Boolean(sourcePayload)
  const canAdvancePrompt = prompt.trim().length > 0

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
        window.alert(error.message)
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
        setTicketMessage(data?.error || 'トークン取得に失敗しました。')
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
      if (!payload) throw new Error('画像が指定されていません。')
      const input: Record<string, unknown> = {
        mode: 'i2v',
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
      input.image_base64 = payload
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
        const rawMessage = data?.error || data?.message || data?.detail || '生成に失敗しました。'
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
      if (Number.isFinite(nextTickets)) {
        setTicketCount(nextTickets)
      }
      const videos = extractVideoList(data)
      if (videos.length) {
        return { videos }
      }
      const jobId = extractJobId(data)
      if (!jobId) throw new Error('ジョブID取得に失敗しました。')
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
        const rawMessage = data?.error || data?.message || data?.detail || '状態取得に失敗しました。'
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
      if (Number.isFinite(nextTickets)) {
        setTicketCount(nextTickets)
      }
      const status = String(data?.status || data?.state || '').toLowerCase()
      const statusError = extractErrorMessage(data)
      if (statusError) {
        const normalized = normalizeErrorMessage(statusError)
        if (isTicketShortage(res.status, normalized)) {
          setShowTicketModal(true)
          setStatusMessage('トークン不足')
          throw new Error('TICKET_SHORTAGE')
        }
      }
      if (statusError || isFailureStatus(status)) {
        throw new Error(normalizeErrorMessage(statusError || '生成に失敗しました。'))
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
      setStatusMessage('')
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
            const message = normalizeErrorMessage(error instanceof Error ? error.message : error)
            if (message === 'TICKET_SHORTAGE') {
              setResults((prev) =>
                prev.map((item, itemIndex) =>
                  itemIndex === 0 ? { ...item, status: 'error' as const, error: 'トークン不足' } : item,
                ),
              )
              setStatusMessage('トークン不足')
              return
            }
            setResults((prev) =>
              prev.map((item, itemIndex) =>
                itemIndex === 0 ? { ...item, status: 'error' as const, error: message } : item,
              ),
            )
            setStatusMessage(message)
            setErrorModalMessage(message)
          }
      }]

        await runQueue(tasks, MAX_PARALLEL)
        if (runIdRef.current === runId) {
          setStatusMessage('完了')
          if (accessToken) {
            void fetchTickets(accessToken)
          }
        }
    } catch (error) {
      const message = normalizeErrorMessage(error instanceof Error ? error.message : error)
      setStatusMessage(message)
      setResults((prev) => prev.map((item) => ({ ...item, status: 'error', error: message })))
      setErrorModalMessage(message)
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
      window.alert('認証設定が未完了です。')
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
    window.alert('認証URLの取得に失敗しました。')
  }

  const clearImage = useCallback(() => {
    setSourcePreview(null)
    setSourcePayload(null)
    setSourceName('')
    setStep(0)
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
    if (isRunning) return
    if (!sourcePayload) return
    if (!session) {
      setStatusMessage('Googleでログインしてください。')
      return
    }
    if (ticketStatus === 'loading') {
      setStatusMessage('トークン確認中...')
      return
    }
    if (accessToken) {
      setStatusMessage('トークン確認中...')
      const latestCount = await fetchTickets(accessToken)
      if (latestCount !== null && latestCount < VIDEO_TICKET_COST) {
        setShowTicketModal(true)
        return
      }
    } else if (ticketCount === null) {
      setStatusMessage('トークン確認中...')
      return
    } else if (ticketCount < VIDEO_TICKET_COST) {
      setShowTicketModal(true)
      return
    }
    await startBatch(sourcePayload)
  }

  const handleNext = () => {
    setStep((prev) => Math.min(prev + 1, totalSteps - 1))
  }

  const handleBack = () => {
    setStep((prev) => Math.max(prev - 1, 0))
  }

  const handleSkipNegative = () => {
    setNegativePrompt('')
    setStep(totalSteps - 1)
  }

  const isGif = displayVideo?.startsWith('data:image/gif')
  const canDownload = Boolean(displayVideo && !isGif)

  const handleDownload = useCallback(async () => {
    if (!displayVideo) return
    const baseName = sourceName ? sourceName.replace(/\.[^.]+$/, '') : 'wan-video'
    const ext = isGif ? 'gif' : 'mp4'
    const filename = `${baseName}.${ext}`
    try {
      let blob: Blob
      if (displayVideo.startsWith('data:')) {
        blob = dataUrlToBlob(displayVideo, isGif ? 'image/gif' : 'video/mp4')
      } else if (displayVideo.startsWith('http') || displayVideo.startsWith('blob:')) {
        const response = await fetch(displayVideo)
        blob = await response.blob()
      } else {
        blob = base64ToBlob(displayVideo, isGif ? 'image/gif' : 'video/mp4')
      }
      const fileType = blob.type || (isGif ? 'image/gif' : 'video/mp4')
      const file = new File([blob], filename, { type: fileType })
      const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
      const canShareFiles =
        canShare && typeof navigator.canShare === 'function' ? navigator.canShare({ files: [file] }) : canShare
      if (isProbablyMobile() && canShareFiles) {
        try {
          await navigator.share({ files: [file], title: filename })
          return
        } catch {
          // Ignore share cancellations and fall back to download.
        }
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
      window.location.assign(displayVideo)
    }
  }, [displayVideo, isGif, sourceName])

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
        <GuestIntro mode="video" onSignIn={handleGoogleSignIn} />
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
                    <span
                      key={`i2v-step-${index}`}
                      className={`wizard-dot${index <= step ? ' is-active' : ''}`}
                    />
                  ))}
                </div>
              </div>
              <div className="wizard-status">
                {ticketStatus === 'loading' && 'トークン確認中...'}
                {ticketStatus !== 'loading' && `トークン残り: ${ticketCount ?? 0}`}
                {ticketStatus === 'error' && ticketMessage ? ` / ${ticketMessage}` : ''}
              </div>
              <h2>{stepTitles[step]}</h2>
              <p>{stepDescriptions[step]}</p>
            </div>

            {step === 0 && (
              <div className="wizard-section">
                <label className="upload-box">
                  <input type="file" accept="image/*" onChange={handleFileChange} />
                  <div>
                    <strong>{sourceName || '画像アップロード'}</strong>
                    <span>動画化する画像を選択してください。</span>
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
              </div>
            )}

            {step === 1 && (
              <label className="wizard-field">
                <span>プロンプト</span>
                <textarea
                  rows={4}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="動きや雰囲気を入力してください。"
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
                  <strong>{prompt || '—'}</strong>
                </div>
                <div>
                  <p>ネガティブプロンプト</p>
                  <strong>{negativePrompt || 'なし'}</strong>
                </div>
              </div>
            )}

            <div className="wizard-actions">
              {step > 0 && (
                <button type="button" className="ghost-button" onClick={handleBack}>
                  戻る
                </button>
              )}
              {step === 0 && (
                <button type="button" className="primary-button" onClick={handleNext} disabled={!canAdvanceImage}>
                  次へ
                </button>
              )}
              {step === 1 && (
                <button type="button" className="primary-button" onClick={handleNext} disabled={!canAdvancePrompt}>
                  次へ
                </button>
              )}
              {step === 2 && (
                <button type="button" className="primary-button" onClick={handleNext}>
                  次へ
                </button>
              )}
              {step === 3 && (
                <button
                  type="button"
                  className="primary-button"
                  onClick={handleGenerate}
                  disabled={!sourcePayload || isRunning || !session}
                >
                  {isRunning ? '生成中...' : '動画を生成'}
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
              {canDownload && (
                <button type="button" className="ghost-button" onClick={handleDownload}>
                  ダウンロード
                </button>
              )}
            </div>

            <div className="stage-viewer" style={viewerStyle}>
              <div className="viewer-progress" aria-hidden="true" />
              {isRunning ? (
                <div className="loading-display" role="status" aria-live="polite">
                  <div className="loading-orb" aria-hidden="true" />
                  <span className="loading-blink">生成中...</span>
                  <p>まもなく完了します。</p>
                </div>
              ) : displayVideo ? (
                isGif ? (
                  <img src={displayVideo} alt="結果" />
                ) : (
                  <video controls src={displayVideo} />
                )
              ) : (
                <div className="stage-placeholder">{emptyMessage}</div>
              )}
            </div>
          </div>
        </section>
      </div>{showTicketModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>トークン不足</h3>
            <p>動画生成は1トークンです。購入ページへ移動しますか？</p>
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setShowTicketModal(false)}>
                閉じる
              </button>
              <button type="button" className="primary-button" onClick={() => navigate('/purchase')}>
                トークン購入
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




