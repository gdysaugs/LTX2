import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { TopNav } from '../components/TopNav'
import { GuestIntro } from '../components/GuestIntro'
import { getOAuthRedirectUrl } from '../lib/oauthRedirect'
import { isAuthConfigured, supabase } from '../lib/supabaseClient'
import './camera.css'

type RenderResult = {
  id: string
  status: 'queued' | 'running' | 'done' | 'error'
  video?: string
  error?: string
}

type I2VSourcePreset = {
  usageId?: string
}

const API_ENDPOINT = '/api/wan'
const VIDEO_TICKET_COST = 1
const FIXED_FPS = 12
const FIXED_SECONDS = 5
const FIXED_FRAME_COUNT = FIXED_FPS * FIXED_SECONDS
const OAUTH_REDIRECT_URL = getOAuthRedirectUrl()
const I2V_SOURCE_STORAGE_KEY = 'wan:i2v-source'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const makeId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
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
  const mime = ext === 'webm' ? 'video/webm' : ext === 'gif' ? 'image/gif' : 'video/mp4'
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

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('failed_to_read_blob'))
    reader.readAsDataURL(blob)
  })

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
    lowered.includes('no tickets') ||
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
  const bounds = height >= width ? PORTRAIT_MAX : LANDSCAPE_MAX
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
  return value.startsWith('data:video/') || value.startsWith('data:image/gif')
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

export function WanI2V() {
  const [sourcePreview, setSourcePreview] = useState<string | null>(null)
  const [sourcePayload, setSourcePayload] = useState<string | null>(null)
  const [sourceName, setSourceName] = useState('')
  const [sourceUsageId, setSourceUsageId] = useState('')
  const [sourcePreset, setSourcePreset] = useState<I2VSourcePreset | null>(null)
  const [prompt, setPrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [width, setWidth] = useState(832)
  const [height, setHeight] = useState(576)
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
  const canGenerate = Boolean(sourcePayload) && prompt.trim().length > 0 && !isRunning
  const displayVideo = result?.video ?? null
  const isGifResult = Boolean(displayVideo && displayVideo.startsWith('data:image/gif'))

  const viewerStyle = useMemo(
    () =>
      ({
        '--viewer-aspect': `${Math.max(1, width)} / ${Math.max(1, height)}`,
        '--progress': result?.status === 'done' ? 1 : isRunning ? 0.5 : 0,
      }) as CSSProperties,
    [height, isRunning, result?.status, width],
  )

  const applySourceDataUrl = useCallback((dataUrl: string, fileName: string) => {
    return new Promise<void>((resolve, reject) => {
      const img = new window.Image()
      img.onload = () => {
        const { width: targetWidth, height: targetHeight } = getTargetSize(img.naturalWidth, img.naturalHeight)
        const paddedDataUrl = buildPaddedDataUrl(img, targetWidth, targetHeight) ?? dataUrl
        setWidth(targetWidth)
        setHeight(targetHeight)
        setSourcePreview(paddedDataUrl)
        setSourcePayload(toBase64(paddedDataUrl))
        setSourceName(fileName)
        resolve()
      }
      img.onerror = () => reject(new Error('invalid_image'))
      img.src = dataUrl
    })
  }, [])

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
    let raw = ''
    try {
      raw = window.sessionStorage.getItem(I2V_SOURCE_STORAGE_KEY) || ''
      if (raw) window.sessionStorage.removeItem(I2V_SOURCE_STORAGE_KEY)
    } catch {
      raw = ''
    }
    if (!raw) return
    try {
      setSourcePreset(JSON.parse(raw) as I2VSourcePreset)
    } catch {
      setSourcePreset(null)
    }
  }, [])

  useEffect(() => {
    if (!sourcePreset) return
    const usageId = String(sourcePreset.usageId ?? '').trim()
    if (!usageId) {
      setStatusMessage('履歴ページから動画化を押して元画像を選択してください。')
      return
    }
    setSourceUsageId(usageId)
    if (!accessToken) return

    let cancelled = false
    const run = async () => {
      setStatusMessage('履歴画像を読み込み中...')
      try {
        const res = await fetch('/api/anima_history', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ usage_id: usageId }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(String(err?.error || 'history_image_fetch_failed'))
        }
        const blob = await res.blob()
        const dataUrl = await blobToDataUrl(blob)
        if (cancelled) return
        await applySourceDataUrl(dataUrl, `history-${usageId}.png`)
        if (!cancelled) {
          setStatusMessage('')
          setSourcePreset(null)
        }
      } catch {
        if (!cancelled) {
          setStatusMessage('履歴画像の読み込みに失敗しました。履歴ページから動画化を押し直してください。')
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [accessToken, applySourceDataUrl, sourcePreset])

  useEffect(() => {
    if (!sourcePayload && !sourcePreset && !statusMessage) {
      setStatusMessage('履歴ページから動画化を押して元画像を選択してください。')
    }
  }, [sourcePayload, sourcePreset, statusMessage])

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
      headers: { Authorization: `Bearer ${token}` },
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

  const submitVideo = useCallback(
    async (payload: string, token: string) => {
      const input: Record<string, unknown> = {
        mode: 'i2v',
        prompt,
        negative_prompt: negativePrompt,
        image_base64: payload,
        width,
        height,
        steps: 4,
        cfg: 1,
        fps: FIXED_FPS,
        seconds: FIXED_SECONDS,
        num_frames: FIXED_FRAME_COUNT,
        seed: 0,
        randomize_seed: true,
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
          setStatusMessage('クレジット不足')
          throw new Error('TICKET_SHORTAGE')
        }
        setErrorModalMessage(message)
        throw new Error(message)
      }
      const nextTickets = Number(data?.ticketsLeft ?? data?.tickets_left)
      if (Number.isFinite(nextTickets)) setTicketCount(nextTickets)
      const videos = extractVideoList(data)
      if (videos.length) return { videos }
      const jobId = extractJobId(data)
      if (!jobId) throw new Error('ジョブIDの取得に失敗しました。')
      return { jobId }
    },
    [height, negativePrompt, prompt, width],
  )

  const pollJob = useCallback(async (jobId: string, runId: number, token?: string) => {
    for (let i = 0; i < 180; i += 1) {
      if (runIdRef.current !== runId) return { status: 'cancelled' as const, videos: [] as string[] }
      const headers: Record<string, string> = {}
      if (token) headers.Authorization = `Bearer ${token}`
      const res = await fetch(`${API_ENDPOINT}?id=${encodeURIComponent(jobId)}`, { headers })
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
      const videos = extractVideoList(data)
      if (videos.length) return { status: 'done' as const, videos }
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
        const submitted = await submitVideo(payload, accessToken)
        if (runIdRef.current !== runId) return
        if ('videos' in submitted && submitted.videos.length) {
          setResult({ id: makeId(), status: 'done', video: submitted.videos[0] })
          setStatusMessage('完了')
          if (accessToken) void fetchTickets(accessToken)
          return
        }

        const polled = await pollJob(submitted.jobId, runId, accessToken)
        if (runIdRef.current !== runId) return
        if (polled.status === 'done' && polled.videos.length) {
          setResult({ id: makeId(), status: 'done', video: polled.videos[0] })
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
    [accessToken, fetchTickets, pollJob, submitVideo],
  )

  const handleGenerate = async () => {
    if (isRunning) return
    if (!sourcePayload) {
      setStatusMessage('履歴ページから動画化を押して元画像を選択してください。')
      return
    }
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
      if (latestCount !== null && latestCount < VIDEO_TICKET_COST) {
        setShowTicketModal(true)
        return
      }
    } else if (ticketCount === null) {
      setStatusMessage('クレジットを確認中...')
      return
    } else if (ticketCount < VIDEO_TICKET_COST) {
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
    if (!displayVideo) return
    const baseName = sourceName ? sourceName.replace(/\.[^.]+$/, '') : 'wan-video'
    const filename = `${baseName}.${isGifResult ? 'gif' : 'mp4'}`
    try {
      let blob: Blob
      if (displayVideo.startsWith('data:')) {
        blob = dataUrlToBlob(displayVideo, isGifResult ? 'image/gif' : 'video/mp4')
      } else if (displayVideo.startsWith('http') || displayVideo.startsWith('blob:')) {
        const response = await fetch(displayVideo)
        blob = await response.blob()
      } else {
        blob = base64ToBlob(displayVideo, isGifResult ? 'image/gif' : 'video/mp4')
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
      window.location.assign(displayVideo)
    }
  }, [displayVideo, isGifResult, sourceName])

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
        <GuestIntro mode='video' onSignIn={handleGoogleSignIn} />
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
              <h2>画像から動画を生成</h2>
            </div>

            <div className='wizard-section'>
              {sourcePreview ? (
                <div className='preview-card'>
                  <img src={sourcePreview} alt='元画像プレビュー' />
                </div>
              ) : (
                <div className='source-placeholder'>履歴ページから動画化を押して元画像を選択してください。</div>
              )}
              {sourceName && <p className='wizard-note'>元画像: {sourceName}</p>}
              {sourceUsageId && <p className='wizard-note'>履歴ID: {sourceUsageId}</p>}
            </div>

            <label className='wizard-field'>
              <span>プロンプト</span>
              <textarea
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder='動画の動きや演出を入力してください。'
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

            <div className='wizard-actions'>
              <button type='button' className='primary-button' onClick={handleGenerate} disabled={!canGenerate}>
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
              {displayVideo && (
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
              ) : displayVideo ? (
                isGifResult ? (
                  <img src={displayVideo} alt='生成結果' />
                ) : (
                  <video controls src={displayVideo} />
                )
              ) : (
                <div className='stage-placeholder'>履歴ページで画像を選択してから生成してください。</div>
              )}
            </div>
          </div>
        </section>
      </div>

      {showTicketModal && (
        <div className='modal-overlay' role='dialog' aria-modal='true'>
          <div className='modal-card'>
            <h3>クレジット不足</h3>
            <p>動画生成は1クレジット必要です。購入ページへ移動しますか？</p>
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