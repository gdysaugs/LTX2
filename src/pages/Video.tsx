import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { GuestIntro } from '../components/GuestIntro'
import { TopNav } from '../components/TopNav'
import { isAuthConfigured, supabase } from '../lib/supabaseClient'
import { getOAuthRedirectUrl } from '../lib/oauthRedirect'
import './camera.css'

type RenderResult = {
  id: string
  status: 'queued' | 'running' | 'done' | 'error'
  image?: string
  error?: string
}

// Anime image generation tab.
const API_ENDPOINT = '/api/anima'
const IMAGE_TICKET_COST = 1

// Recommended defaults.
const FIXED_STEPS = 45
const FIXED_CFG = 4.5
const FIXED_WIDTH = 1024
const FIXED_HEIGHT = 1024
const DEFAULT_DENOISE = 1
const DEFAULT_SAMPLER = 'er_sde'
const DEFAULT_SCHEDULER = 'simple'

const SAMPLER_OPTIONS = [
  'er_sde',
  'euler',
  'euler_ancestral',
  'dpmpp_2m',
  'dpmpp_sde',
  'dpmpp_2m_sde',
  'ddim',
  'lcm',
]

const SCHEDULER_OPTIONS = ['simple', 'normal', 'karras', 'sgm_uniform', 'exponential', 'ddim_uniform', 'beta']

const OAUTH_REDIRECT_URL = getOAuthRedirectUrl()

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const makeId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return String(Date.now()) + '-' + Math.random().toString(16).slice(2)
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
  return 'data:' + mime + ';base64,' + value
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
  if (!value) return 'リクエストに失敗しました。'
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

export function Video() {
  const [prompt, setPrompt] = useState(
    [
      'masterpiece',
      'best quality',
      'good quality',
      'highres',
      'score_9, score_8',
      'newest',
      'recent',
      'detailed',
      'high detail',
    ].join(', '),
  )
  const [negativePrompt, setNegativePrompt] = useState(
    'worst quality, low quality, blurry, jpeg artifacts, text, watermark, logo, bad hands, extra fingers, deformed, bad anatomy',
  )
  const [steps, setSteps] = useState(FIXED_STEPS)
  const [cfg, setCfg] = useState(FIXED_CFG)
  const [samplerName, setSamplerName] = useState(DEFAULT_SAMPLER)
  const [scheduler, setScheduler] = useState(DEFAULT_SCHEDULER)
  const [denoise, setDenoise] = useState(DEFAULT_DENOISE)
  const [randomizeSeed, setRandomizeSeed] = useState(true)
  const [seed, setSeed] = useState(0)
  const [result, setResult] = useState<RenderResult | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const [isRunning, setIsRunning] = useState(false)
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
  const canGenerate = prompt.trim().length > 0
  const displayImage = result?.image ?? null

  const viewerStyle = useMemo(
    () =>
      ({
        '--viewer-aspect': String(FIXED_WIDTH) + ' / ' + String(FIXED_HEIGHT),
        '--progress': result?.status === 'done' ? 1 : isRunning ? 0.5 : 0,
      }) as CSSProperties,
    [isRunning, result?.status],
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
    const url = new URL(window.location.href)
    const oauthError = url.searchParams.get('error_description') || url.searchParams.get('error')
    if (oauthError) {
      console.error('OAuth callback error', oauthError)
      window.alert('ログインに失敗しました。もう一度お試しください。')
      url.searchParams.delete('error')
      url.searchParams.delete('error_description')
      window.history.replaceState({}, document.title, url.toString())
      return
    }
    const hasCode = url.searchParams.has('code')
    const hasState = url.searchParams.has('state')
    if (!hasCode || !hasState) return
    supabase.auth.exchangeCodeForSession(window.location.href).then(({ error }) => {
      if (error) {
        console.error('exchangeCodeForSession failed', error)
        window.alert('ログインに失敗しました。もう一度お試しください。')
        setStatusMessage('ログインに失敗しました。もう一度お試しください。')
        return
      }
      const cleaned = new URL(window.location.href)
      cleaned.searchParams.delete('code')
      cleaned.searchParams.delete('state')
      window.history.replaceState({}, document.title, cleaned.toString())
    })
  }, [])

  const fetchTickets = useCallback(async (token: string) => {
    if (!token) return null
    setTicketStatus('loading')
    setTicketMessage('')
    const res = await fetch('/api/tickets', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setTicketStatus('error')
      setTicketMessage(data?.error || 'クレジットの取得に失敗しました。')
      setTicketCount(null)
      return null
    }
    const nextCount = Number(data?.tickets ?? 0)
    setTicketStatus('idle')
    setTicketMessage('')
    setTicketCount(nextCount)
    return nextCount
  }, [])

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
    async (token: string) => {
      const input: Record<string, unknown> = {
        prompt,
        negative_prompt: negativePrompt,
        width: FIXED_WIDTH,
        height: FIXED_HEIGHT,
        steps,
        cfg,
        seed,
        randomize_seed: randomizeSeed,
        sampler_name: samplerName,
        scheduler,
        denoise,
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers.Authorization = 'Bearer ' + token
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
          setStatusMessage('クレジット不足')
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
    [cfg, denoise, negativePrompt, prompt, randomizeSeed, samplerName, scheduler, seed, steps],
  )

  const pollJob = useCallback(async (jobId: string, usageId: string, runId: number, token?: string) => {
    for (let i = 0; i < 180; i += 1) {
      if (runIdRef.current !== runId) return { status: 'cancelled' as const, images: [] as string[] }
      const headers: Record<string, string> = {}
      if (token) headers.Authorization = 'Bearer ' + token
      const url = API_ENDPOINT + '?id=' + encodeURIComponent(jobId) + '&usage_id=' + encodeURIComponent(usageId)
      const res = await fetch(url, { headers })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const rawMessage = data?.error || data?.message || data?.detail || 'ステータス確認に失敗しました。'
        const message = normalizeErrorMessage(rawMessage)
        if (isTicketShortage(res.status, message)) {
          setShowTicketModal(true)
          setStatusMessage('クレジット不足')
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
    async () => {
      const runId = runIdRef.current + 1
      runIdRef.current = runId
      setIsRunning(true)
      setStatusMessage('')
      setResult({ id: makeId(), status: 'running' })

      try {
        const submitted = await submitImage(accessToken)
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
          setResult({ id: makeId(), status: 'error', error: 'クレジット不足' })
          setStatusMessage('クレジット不足')
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
    if (isRunning || !canGenerate) return
    if (!session) {
      setStatusMessage('Googleでログインしてください。')
      return
    }
    if (ticketStatus === 'loading') {
      setStatusMessage('クレジットを確認中...')
      return
    }
    if (accessToken) {
      setStatusMessage('クレジットを確認中...')
      const latestCount = await fetchTickets(accessToken)
      if (latestCount !== null && latestCount < IMAGE_TICKET_COST) {
        setShowTicketModal(true)
        return
      }
    } else if (ticketCount === null) {
      setStatusMessage('クレジットを確認中...')
      return
    } else if (ticketCount < IMAGE_TICKET_COST) {
      setShowTicketModal(true)
      return
    }
    await startGenerate()
  }

  const handleGoogleSignIn = async () => {
    if (!supabase || !isAuthConfigured) {
      window.alert('認証設定が不足しています。')
      return
    }
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: OAUTH_REDIRECT_URL,
        queryParams: { prompt: 'select_account' },
      },
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

  const handleDownload = useCallback(async () => {
    if (!displayImage) return
    const filename = 'anime-result.png'
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
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch {
      window.location.assign(displayImage)
    }
  }, [displayImage])

  if (!authReady) {
    return (
      <div className='camera-app'>
        <TopNav />
        <div className='auth-boot' />
      </div>
    )
  }

  if (!session) {
    return (
      <div className='camera-app'>
        <TopNav />
        <GuestIntro mode='image' onSignIn={handleGoogleSignIn} />
      </div>
    )
  }

  return (
    <div className='camera-app'>
      <TopNav />
      <div className='wizard-shell'>
        <section className='wizard-panel wizard-panel--inputs'>
          <div className='wizard-card wizard-card--step'>
            <div className='wizard-stepper'>
              <div className='wizard-status'>
                {ticketStatus === 'loading' && 'クレジットを確認中...'}
                {ticketStatus !== 'loading' && 'クレジット: ' + String(ticketCount ?? 0)}
                {ticketStatus === 'error' && ticketMessage ? ' / ' + ticketMessage : ''}
              </div>
              <h2>アニメ画像を生成</h2>
            </div>

            <label className='wizard-field'>
              <span>プロンプト</span>
              <textarea
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder='作りたいアニメ画像の内容を入力してください。'
              />
            </label>

            <label className='wizard-field'>
              <span>ネガティブプロンプト</span>
              <textarea
                rows={3}
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                placeholder='任意: 避けたい内容を入力。'
              />
            </label>

            <div className='wizard-section'>
              <p className='wizard-eyebrow'>詳細パラメータ</p>
              <div className='wizard-params-grid'>
                <label className='wizard-field'>
                  <span>Steps (1-60)</span>
                  <input
                    type='number'
                    min={1}
                    max={60}
                    step={1}
                    value={steps}
                    onChange={(e) => setSteps(Math.floor(Number(e.target.value || 1)))}
                  />
                </label>

                <label className='wizard-field'>
                  <span>CFG (0-10)</span>
                  <input
                    type='number'
                    min={0}
                    max={10}
                    step={0.1}
                    value={cfg}
                    onChange={(e) => setCfg(Number(e.target.value || 0))}
                  />
                </label>

                <label className='wizard-field'>
                  <span>Sampler</span>
                  <select value={samplerName} onChange={(e) => setSamplerName(e.target.value)}>
                    {SAMPLER_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>

                <label className='wizard-field'>
                  <span>Scheduler</span>
                  <select value={scheduler} onChange={(e) => setScheduler(e.target.value)}>
                    {SCHEDULER_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>

                <label className='wizard-field'>
                  <span>Denoise (0-1)</span>
                  <input
                    type='number'
                    min={0}
                    max={1}
                    step={0.05}
                    value={denoise}
                    onChange={(e) => setDenoise(Number(e.target.value || 0))}
                  />
                </label>

                <label className='wizard-field'>
                  <span>Seed</span>
                  <input
                    type='number'
                    min={0}
                    step={1}
                    value={seed}
                    onChange={(e) => setSeed(Math.floor(Number(e.target.value || 0)))}
                    disabled={randomizeSeed}
                  />
                </label>
              </div>

              <label className='wizard-field'>
                <span>Seed mode</span>
                <select
                  value={randomizeSeed ? 'random' : 'fixed'}
                  onChange={(e) => setRandomizeSeed(e.target.value === 'random')}
                >
                  <option value='random'>毎回ランダム</option>
                  <option value='fixed'>固定seedを使う</option>
                </select>
              </label>
            </div>

            <div className='wizard-actions'>
              <button type='button' className='primary-button' onClick={handleGenerate} disabled={isRunning || !canGenerate}>
                {isRunning ? 'Generating...' : '生成'}
              </button>
            </div>
          </div>
        </section>

        <section className='wizard-panel wizard-panel--preview'>
          <div className='wizard-card wizard-card--preview'>
            <div className='wizard-card__header'>
              <div>
                <p className='wizard-eyebrow'>生成結果</p>
                {statusMessage && !isRunning && <span>{statusMessage}</span>}
              </div>
              {displayImage && (
                <button type='button' className='ghost-button' onClick={handleDownload}>
                  保存
                </button>
              )}
            </div>

            <div className='stage-viewer' style={viewerStyle}>
              <div className='viewer-progress' aria-hidden='true' />
              {isRunning ? (
                <div className='loading-display' role='status' aria-live='polite'>
                  <div className='loading-rings' aria-hidden='true'>
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className='loading-blink'>Generating...</span>
                  <p>処理を実行しています</p>
                </div>
              ) : displayImage ? (
                <img src={displayImage} alt='生成結果' />
              ) : (
                <div className='stage-placeholder'>プロンプトを入力して生成してください。</div>
              )}
            </div>
          </div>
        </section>
      </div>

      {showTicketModal && (
        <div className='modal-overlay' role='dialog' aria-modal='true'>
          <div className='modal-card'>
            <h3>クレジット不足</h3>
            <p>画像生成は1クレジット必要です。購入ページへ移動しますか？</p>
            <div className='modal-actions'>
              <button type='button' className='ghost-button' onClick={() => setShowTicketModal(false)}>
                閉じる
              </button>
              <button type='button' className='primary-button' onClick={() => navigate('/purchase')}>
                購入する
              </button>
            </div>
          </div>
        </div>
      )}

      {errorModalMessage && (
        <div className='modal-overlay' role='dialog' aria-modal='true'>
          <div className='modal-card'>
            <h3>リクエストが拒否されました</h3>
            <p>{errorModalMessage}</p>
            <div className='modal-actions'>
              <button type='button' className='primary-button' onClick={() => setErrorModalMessage(null)}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

