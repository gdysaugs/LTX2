import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Session } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import { GuestIntro } from '../components/GuestIntro'
import { TopNav } from '../components/TopNav'
import { getOAuthRedirectUrl } from '../lib/oauthRedirect'
import { isAuthConfigured, supabase } from '../lib/supabaseClient'
import './camera.css'

type VoiceResult = {
  jobId: string
  mime: string
  filename?: string
  promptId?: string
}

type SampleVoice = {
  id: string
  label: string
  urlPath: string
}

type PresignUploadResult = {
  key: string
  getUrl: string
}

type PollStatus = 'AUDIO' | 'VIDEO' | null

const OAUTH_REDIRECT_URL = getOAuthRedirectUrl()
const VOICE_TICKET_COST = 1
const DIALOG_MAX_CHARS = 100
const FIXED_TEXT_LANG = 'ja'
const FIXED_PROMPT_LANG = 'ja'
const FIXED_FACE_MASK = '0'
const FIXED_FACE_OCCLUDER = '1'
const FIXED_GFPGAN = '1'
const FIXED_GFPGAN_BLEND_PERCENT = '30'

const SAMPLE_VOICES: SampleVoice[] = [
  { id: 'screen_0102_160027', label: '妖艶な女', urlPath: '/sample-voices/screenrecording_2026-01-02_160027.wav' },
  { id: 'datte_hiccup', label: '泣き叫ぶ女', urlPath: '/sample-voices/datte_datte_hiccup.mp3' },
  { id: 'screen_0219_131531', label: '女性の泣き声', urlPath: '/sample-voices/screenrecording_2026-02-19_131531.mp3' },
  { id: 'screen_0219_131617', label: '明るい女の子ボイス', urlPath: '/sample-voices/screenrecording_2026-02-19_131617.mp3' },
  { id: 'screen_0219_131708', label: '後輩の女の子ボイス', urlPath: '/sample-voices/screenrecording_2026-02-19_131708.mp3' },
  { id: 'screen_0219_134143', label: 'かわいい妹ボイス', urlPath: '/sample-voices/screenrecording_2026-02-19_134143.mp3' },
]

const FIXED_PROMPT_TEXT_BY_SAMPLE_ID: Record<string, string> = {}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const b64ToBlob = (b64: string, mime: string) => {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i)
  }
  return new Blob([bytes], { type: mime })
}

const b64ToBlobUrl = (b64: string, mime: string) => URL.createObjectURL(b64ToBlob(b64, mime))

const b64ToFile = (b64: string, mime: string, filename: string) => new File([b64ToBlob(b64, mime)], filename, { type: mime })

const sanitizeUiErrorMessage = (error: unknown) => {
  const raw = String((error as { message?: unknown })?.message ?? error ?? '').trim()
  if (!raw) return '処理に失敗しました。時間をおいて再試行してください。'
  const hasSystemTerms = /runpod|wav2lip|gpt-?sovits|sovits|\/api\//i.test(raw)
  if (hasSystemTerms) return '処理に失敗しました。時間をおいて再試行してください。'
  return raw
}

const readString = (value: unknown) => (typeof value === 'string' ? value : '')

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

const parseDataUrl = (value: string) => {
  const match = value.match(/^data:([^;]+);base64,(.*)$/)
  if (!match) return null
  return { mime: match[1] || 'video/mp4', dataB64: match[2] || '' }
}

const findVideoAsset = (payload: unknown) => {
  const node = asRecord(payload)
  if (!node) return null

  const candidateValues: unknown[] = [
    node.data,
    node.video,
    node.output_video_base64,
    node.output_video,
    node.output,
  ]

  for (const value of candidateValues) {
    const text = readString(value).trim()
    if (!text) continue
    const dataUrl = parseDataUrl(text)
    if (dataUrl) {
      return {
        mime: dataUrl.mime,
        dataB64: dataUrl.dataB64,
        filename: readString(node.filename) || undefined,
        promptId: readString(node.prompt_id) || undefined,
      }
    }
    return {
      mime: readString(node.mime) || 'video/mp4',
      dataB64: text,
      filename: readString(node.filename) || undefined,
      promptId: readString(node.prompt_id) || undefined,
    }
  }

  const listCandidates = [node.videos, node.outputs, node.output_videos, node.data]
  for (const list of listCandidates) {
    if (!Array.isArray(list) || !list.length) continue
    for (const item of list) {
      const nested = findVideoAsset(item)
      if (nested) return nested
    }
  }

  const nestedCandidates = [node.output, node.result]
  for (const nestedValue of nestedCandidates) {
    const nested = findVideoAsset(nestedValue)
    if (nested) return nested
  }

  return null
}

async function decodeAudioToBuffer(file: File): Promise<AudioBuffer> {
  const buf = await file.arrayBuffer()
  const webkitAudioContext = (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  const AudioCtx = window.AudioContext || webkitAudioContext
  if (!AudioCtx) throw new Error('AudioContext is not available in this browser.')
  const ctx = new AudioCtx()
  try {
    return await ctx.decodeAudioData(buf.slice(0))
  } finally {
    await ctx.close().catch(() => undefined)
  }
}

function audioBufferToMonoFloat32(ab: AudioBuffer): Float32Array {
  const samples = ab.length
  const channels = ab.numberOfChannels || 1
  if (channels === 1) return new Float32Array(ab.getChannelData(0))

  const out = new Float32Array(samples)
  for (let c = 0; c < channels; c += 1) {
    const data = ab.getChannelData(c)
    for (let i = 0; i < samples; i += 1) {
      out[i] += data[i] / channels
    }
  }
  return out
}

function encodeWavPcm16(mono: Float32Array, sampleRate: number): Uint8Array {
  const numChannels = 1
  const bytesPerSample = 2
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = mono.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i))
    }
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < mono.length; i += 1, offset += 2) {
    const sample = Math.max(-1, Math.min(1, mono[i] || 0))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Uint8Array(buffer)
}

function removeSilentSegmentsRms(
  mono: Float32Array,
  sampleRate: number,
  opts?: {
    thresholdRms?: number
    frameMs?: number
    padMs?: number
    keepSilenceMs?: number
    minKeepMs?: number
  },
): { trimmed: Float32Array; changed: boolean } {
  const thresholdRms = opts?.thresholdRms ?? 0.002
  const frameMs = opts?.frameMs ?? 20
  const padMs = opts?.padMs ?? 60
  const keepSilenceMs = opts?.keepSilenceMs ?? 0
  const minKeepMs = opts?.minKeepMs ?? 250
  const totalSamples = mono.length
  if (!totalSamples) return { trimmed: mono, changed: false }

  const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000))
  const numFrames = Math.max(1, Math.ceil(totalSamples / frameLen))
  const rms = new Float32Array(numFrames)

  for (let f = 0; f < numFrames; f += 1) {
    const start = f * frameLen
    const end = Math.min(totalSamples, start + frameLen)
    let sumSq = 0
    for (let i = start; i < end; i += 1) {
      const x = mono[i] || 0
      sumSq += x * x
    }
    rms[f] = Math.sqrt(sumSq / Math.max(1, end - start))
  }

  const padFrames = Math.max(0, Math.round(padMs / frameMs))
  const speech = new Uint8Array(numFrames)
  for (let f = 0; f < numFrames; f += 1) {
    if (rms[f] <= thresholdRms) continue
    const lo = Math.max(0, f - padFrames)
    const hi = Math.min(numFrames - 1, f + padFrames)
    for (let k = lo; k <= hi; k += 1) speech[k] = 1
  }

  const segments: Array<{ a: number; b: number }> = []
  let frame = 0
  while (frame < numFrames) {
    while (frame < numFrames && !speech[frame]) frame += 1
    if (frame >= numFrames) break
    const start = frame
    while (frame < numFrames && speech[frame]) frame += 1
    segments.push({ a: start, b: frame })
  }
  if (!segments.length) return { trimmed: mono, changed: false }

  let keptFrames = 0
  for (let i = 0; i < numFrames; i += 1) {
    if (speech[i]) keptFrames += 1
  }
  if (keptFrames / numFrames > 0.9) return { trimmed: mono, changed: false }

  const keepSilenceFrames = Math.max(0, Math.round(keepSilenceMs / frameMs))
  const chunks: Float32Array[] = []
  for (let i = 0; i < segments.length; i += 1) {
    const start = segments[i].a * frameLen
    const end = Math.min(totalSamples, segments[i].b * frameLen)
    if (end > start) chunks.push(mono.slice(start, end))
    if (keepSilenceFrames > 0 && i !== segments.length - 1) {
      chunks.push(new Float32Array(keepSilenceFrames * frameLen))
    }
  }

  let outputLength = 0
  for (const chunk of chunks) outputLength += chunk.length
  const minKeepSamples = Math.max(1, Math.round((sampleRate * minKeepMs) / 1000))
  if (outputLength < minKeepSamples) return { trimmed: mono, changed: false }

  const output = new Float32Array(outputLength)
  let cursor = 0
  for (const chunk of chunks) {
    output.set(chunk, cursor)
    cursor += chunk.length
  }
  return { trimmed: output, changed: true }
}

function trimTrailingSilenceRms(
  mono: Float32Array,
  sampleRate: number,
  opts?: {
    thresholdRms?: number
    frameMs?: number
    padMs?: number
    minKeepMs?: number
  },
): { trimmed: Float32Array; changed: boolean } {
  const thresholdRms = opts?.thresholdRms ?? 0.002
  const frameMs = opts?.frameMs ?? 20
  const padMs = opts?.padMs ?? 150
  const minKeepMs = opts?.minKeepMs ?? 300

  const totalSamples = mono.length
  if (!totalSamples) return { trimmed: mono, changed: false }

  const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000))
  const numFrames = Math.max(1, Math.ceil(totalSamples / frameLen))

  let lastSpeechFrame = -1
  for (let f = numFrames - 1; f >= 0; f -= 1) {
    const start = f * frameLen
    const end = Math.min(totalSamples, start + frameLen)
    let sumSq = 0
    for (let i = start; i < end; i += 1) {
      const x = mono[i] || 0
      sumSq += x * x
    }
    const rms = Math.sqrt(sumSq / Math.max(1, end - start))
    if (rms > thresholdRms) {
      lastSpeechFrame = f
      break
    }
  }

  if (lastSpeechFrame < 0) return { trimmed: mono, changed: false }
  const pad = Math.max(0, Math.round((sampleRate * padMs) / 1000))
  const end = Math.min(totalSamples, (lastSpeechFrame + 1) * frameLen + pad)
  const minKeepSamples = Math.max(1, Math.round((sampleRate * minKeepMs) / 1000))
  if (end < minKeepSamples || end >= totalSamples) return { trimmed: mono, changed: false }
  return { trimmed: mono.slice(0, end), changed: true }
}

export function Voice() {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(!supabase)
  const [ticketCount, setTicketCount] = useState<number | null>(null)
  const [ticketStatus, setTicketStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [ticketMessage, setTicketMessage] = useState('')
  const [showTicketModal, setShowTicketModal] = useState(false)
  const [errorModalMessage, setErrorModalMessage] = useState<string | null>(null)

  const [video, setVideo] = useState<File | null>(null)
  const [dialog, setDialog] = useState('')
  const [sampleVoiceId, setSampleVoiceId] = useState(SAMPLE_VOICES[0]?.id || '')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<PollStatus>(null)
  const [result, setResult] = useState<VoiceResult | null>(null)

  const accessToken = session?.access_token ?? ''
  const navigate = useNavigate()
  const videoUrlRef = useRef<string | null>(null)
  const dialogLength = useMemo(() => [...dialog].length, [dialog])

  const selectedSampleVoice = useMemo(
    () => SAMPLE_VOICES.find((item) => item.id === sampleVoiceId) || SAMPLE_VOICES[0] || null,
    [sampleVoiceId],
  )

  const selectedSampleVoicePublicUrl = useMemo(() => {
    if (!selectedSampleVoice) return ''
    if (typeof window === 'undefined') return selectedSampleVoice.urlPath
    return new URL(selectedSampleVoice.urlPath, window.location.origin).toString()
  }, [selectedSampleVoice])

  const viewerStyle = useMemo(
    () =>
      ({
        '--viewer-aspect': '16 / 9',
        '--progress': result ? 1 : busy ? 0.5 : 0,
      }) as CSSProperties,
    [busy, result],
  )

  const canGenerate = useMemo(() => {
    if (!video) return false
    if (!dialog.trim()) return false
    if (!selectedSampleVoicePublicUrl) return false
    if (busy) return false
    return true
  }, [video, dialog, selectedSampleVoicePublicUrl, busy])

  useEffect(() => {
    return () => {
      if (videoUrlRef.current) {
        URL.revokeObjectURL(videoUrlRef.current)
        videoUrlRef.current = null
      }
    }
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
    if (!supabase) return
    const url = new URL(window.location.href)
    const oauthError = url.searchParams.get('error_description') || url.searchParams.get('error')
    if (oauthError) {
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
        window.alert('ログインに失敗しました。もう一度お試しください。')
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
    const res = await fetch('/api/tickets', { headers: { Authorization: `Bearer ${token}` } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setTicketStatus('error')
      setTicketMessage(String(data?.error || 'クレジット取得に失敗しました。'))
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

  const handleGoogleSignIn = useCallback(async () => {
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
  }, [])

  const headersWithAuth = useCallback(
    (base: Record<string, string> = {}) => (accessToken ? { ...base, Authorization: `Bearer ${accessToken}` } : base),
    [accessToken],
  )

  const presignAndUpload = useCallback(
    async (file: File, purpose: string): Promise<PresignUploadResult> => {
      const presignRes = await fetch('/api/r2_presign', {
        method: 'POST',
        headers: headersWithAuth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ purpose, contentType: file.type || 'application/octet-stream' }),
      })
      const presignRaw = await presignRes.text()
      const presignJson = JSON.parse(presignRaw || '{}') as {
        key?: unknown
        message?: unknown
        error?: unknown
        put?: { url?: unknown; headers?: Record<string, string> }
        get?: { url?: unknown }
      }

      if (!presignRes.ok) {
        throw new Error(String(presignJson.message || presignJson.error || 'アップロードURL取得に失敗しました。'))
      }

      const putUrl = readString(presignJson.put?.url)
      const putHeaders = presignJson.put?.headers ?? {}
      const getUrl = readString(presignJson.get?.url)
      const key = readString(presignJson.key)
      if (!putUrl || !getUrl) throw new Error('アップロードURLが不正です。')

      const putRes = await fetch(putUrl, {
        method: 'PUT',
        headers: putHeaders,
        body: file,
      })
      if (!putRes.ok) {
        const detail = await putRes.text().catch(() => '')
        throw new Error(`アップロードに失敗しました。${detail.slice(0, 200)}`)
      }
      return { key, getUrl }
    },
    [headersWithAuth],
  )

  const handleGenerate = useCallback(async () => {
    if (!session) {
      setErrorModalMessage('Googleでログインしてください。')
      return
    }
    if (!accessToken) {
      setErrorModalMessage('認証トークンが見つかりません。再ログインしてください。')
      return
    }
    if (!video) {
      setErrorModalMessage('動画ファイルを選択してください。')
      return
    }
    if (!dialog.trim()) {
      setErrorModalMessage('セリフを入力してください。')
      return
    }
    if (dialogLength > DIALOG_MAX_CHARS) {
      setErrorModalMessage(`セリフは${DIALOG_MAX_CHARS}文字以内で入力してください。`)
      return
    }

    if (ticketStatus === 'loading') {
      return
    }
    if (accessToken) {
      const latestCount = await fetchTickets(accessToken)
      if (latestCount !== null && latestCount < VOICE_TICKET_COST) {
        setShowTicketModal(true)
        return
      }
    } else if (ticketCount === null || ticketCount < VOICE_TICKET_COST) {
      setShowTicketModal(true)
      return
    }

    setBusy(true)
    setStatus('AUDIO')
    setResult(null)

    try {
      if (!selectedSampleVoicePublicUrl) throw new Error('音声素材が見つかりません。')

      const uploadedVideo = await presignAndUpload(video, 'wav2lip/video')

      const ttsForm = new FormData()
      ttsForm.set('text', dialog)
      ttsForm.set('text_lang', FIXED_TEXT_LANG)
      ttsForm.set('prompt_lang', FIXED_PROMPT_LANG)
      const forcedPromptText = selectedSampleVoice ? FIXED_PROMPT_TEXT_BY_SAMPLE_ID[selectedSampleVoice.id] || '' : ''
      ttsForm.set('prompt_text', forcedPromptText)
      ttsForm.set('auto_prompt_text', forcedPromptText ? '0' : '1')
      ttsForm.set('ref_audio_url', selectedSampleVoicePublicUrl)

      const ttsStartRes = await fetch('/api/gptsovits', {
        method: 'POST',
        headers: headersWithAuth(),
        body: ttsForm,
      })
      const ttsStartPayload = (await ttsStartRes.json().catch(() => null)) as { id?: unknown; error?: unknown; message?: unknown } | null
      if (!ttsStartRes.ok) {
        throw new Error(String(ttsStartPayload?.message || ttsStartPayload?.error || '音声生成の開始に失敗しました。'))
      }
      const ttsJobId = readString(ttsStartPayload?.id).trim()
      if (!ttsJobId) throw new Error('音声ジョブIDの取得に失敗しました。')

      const ttsTimeoutAt = Date.now() + 10 * 60_000
      let ttsOutput: Record<string, unknown> | null = null
      while (Date.now() < ttsTimeoutAt) {
        const stRes = await fetch(`/api/gptsovits?id=${encodeURIComponent(ttsJobId)}`, {
          method: 'GET',
          headers: headersWithAuth(),
        })
        const stPayload = (await stRes.json().catch(() => null)) as Record<string, unknown> | null
        if (!stRes.ok) {
          throw new Error(String(stPayload?.message || stPayload?.error || '音声ジョブの状態取得に失敗しました。'))
        }
        const st = String(stPayload?.status || '')
        if (st === 'COMPLETED') {
          ttsOutput = asRecord(stPayload?.output)
          break
        }
        if (st === 'FAILED' || st === 'CANCELLED' || st === 'TIMED_OUT') {
          throw new Error(String(stPayload?.error || '音声生成に失敗しました。'))
        }
        await wait(2000)
      }
      if (!ttsOutput) throw new Error('音声生成がタイムアウトしました。')

      const ttsMime = readString(ttsOutput.mime) || 'audio/wav'
      const ttsData = readString(ttsOutput.data)
      if (!ttsData) throw new Error('音声データが空です。')

      const rawTtsFile = b64ToFile(ttsData, ttsMime, 'tts_raw')
      let ttsFileForUpload: File
      try {
        const decoded = await decodeAudioToBuffer(rawTtsFile)
        const mono = audioBufferToMonoFloat32(decoded)
        const { trimmed: noSilence } = removeSilentSegmentsRms(mono, decoded.sampleRate, { keepSilenceMs: 0 })
        const { trimmed } = trimTrailingSilenceRms(noSilence, decoded.sampleRate)
        const wav = encodeWavPcm16(trimmed, decoded.sampleRate)
        const wavBuffer = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer
        ttsFileForUpload = new File([new Blob([wavBuffer], { type: 'audio/wav' })], 'tts.wav', { type: 'audio/wav' })
      } catch {
        ttsFileForUpload = new File([rawTtsFile], 'tts.wav', { type: rawTtsFile.type || 'audio/wav' })
      }

      const uploadedAudio = await presignAndUpload(ttsFileForUpload, 'wav2lip/audio')

      setStatus('VIDEO')

      const lipSyncForm = new FormData()
      lipSyncForm.set('video_url', uploadedVideo.getUrl)
      lipSyncForm.set('audio_url', uploadedAudio.getUrl)
      lipSyncForm.set('face_mask', FIXED_FACE_MASK)
      lipSyncForm.set('face_occluder', FIXED_FACE_OCCLUDER)
      lipSyncForm.set('gfpgan', FIXED_GFPGAN)
      lipSyncForm.set('gfpgan_blend_percent', FIXED_GFPGAN_BLEND_PERCENT)

      const wavStartRes = await fetch('/api/wav2lip', {
        method: 'POST',
        headers: headersWithAuth(),
        body: lipSyncForm,
      })
      const wavStartPayload = (await wavStartRes.json().catch(() => null)) as
        | { id?: unknown; usage_id?: unknown; usageId?: unknown; ticketsLeft?: unknown; tickets_left?: unknown; error?: unknown; message?: unknown }
        | null
      if (!wavStartRes.ok) {
        throw new Error(String(wavStartPayload?.message || wavStartPayload?.error || '動画合成の開始に失敗しました。'))
      }

      const wavJobId = readString(wavStartPayload?.id).trim()
      if (!wavJobId) throw new Error('動画ジョブIDの取得に失敗しました。')
      const usageId = readString(wavStartPayload?.usage_id || wavStartPayload?.usageId)
      const nextTickets = Number(wavStartPayload?.ticketsLeft ?? wavStartPayload?.tickets_left)
      if (Number.isFinite(nextTickets)) setTicketCount(nextTickets)

      const wavTimeoutAt = Date.now() + 10 * 60_000
      let finishedPayload: Record<string, unknown> | null = null
      while (Date.now() < wavTimeoutAt) {
        const query = new URLSearchParams()
        query.set('id', wavJobId)
        if (usageId) query.set('usage_id', usageId)
        const stRes = await fetch(`/api/wav2lip?${query.toString()}`, {
          method: 'GET',
          headers: headersWithAuth(),
        })
        const stPayload = (await stRes.json().catch(() => null)) as Record<string, unknown> | null
        if (!stRes.ok) {
          throw new Error(String(stPayload?.message || stPayload?.error || '動画ジョブの状態取得に失敗しました。'))
        }
        const statusValue = String(stPayload?.status || '')
        const statusLower = statusValue.toLowerCase()
        const updatedTickets = Number(stPayload?.ticketsLeft ?? stPayload?.tickets_left)
        if (Number.isFinite(updatedTickets)) setTicketCount(updatedTickets)

        if (statusValue === 'COMPLETED' || statusLower.includes('complete') || statusLower.includes('success')) {
          finishedPayload = stPayload
          break
        }
        if (
          statusValue === 'FAILED' ||
          statusValue === 'CANCELLED' ||
          statusValue === 'TIMED_OUT' ||
          statusLower.includes('fail') ||
          statusLower.includes('error') ||
          statusLower.includes('cancel')
        ) {
          throw new Error(String(stPayload?.error || '動画合成に失敗しました。'))
        }
        await wait(2500)
      }
      if (!finishedPayload) throw new Error('動画合成がタイムアウトしました。')

      const outputNode = finishedPayload.output ?? finishedPayload.result ?? finishedPayload
      const asset = findVideoAsset(outputNode)
      if (!asset || !asset.dataB64) throw new Error('動画データの取得に失敗しました。')

      if (videoUrlRef.current) {
        URL.revokeObjectURL(videoUrlRef.current)
      }
      videoUrlRef.current = b64ToBlobUrl(asset.dataB64, asset.mime)
      setResult({
        jobId: wavJobId,
        mime: asset.mime,
        filename: asset.filename,
        promptId: asset.promptId,
      })
    } catch (error) {
      setErrorModalMessage(sanitizeUiErrorMessage(error))
    } finally {
      setBusy(false)
      setStatus(null)
      if (accessToken) {
        void fetchTickets(accessToken)
      }
    }
  }, [
    accessToken,
    dialog,
    dialogLength,
    fetchTickets,
    headersWithAuth,
    presignAndUpload,
    selectedSampleVoice,
    selectedSampleVoicePublicUrl,
    session,
    ticketCount,
    ticketStatus,
    video,
  ])

  const handleDownload = useCallback(async () => {
    if (!videoUrlRef.current || !result) return
    try {
      const response = await fetch(videoUrlRef.current)
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = result.filename || 'voice-lipsync.mp4'
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch {
      window.location.assign(videoUrlRef.current)
    }
  }, [result])

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
                {ticketStatus !== 'loading' && `クレジット: ${ticketCount ?? 0}`}
                {ticketStatus === 'error' && ticketMessage ? ` / ${ticketMessage}` : ''}
              </div>
              <h2>ボイスクローン動画生成</h2>
              <p>動画と音声素材を選び、セリフを入力して生成します。</p>
            </div>

            <label className='wizard-field'>
              <span>動画アップロード</span>
              <input
                type='file'
                accept='video/*'
                onChange={(event) => {
                  setVideo(event.target.files?.[0] || null)
                }}
              />
            </label>

            <label className='wizard-field'>
              <span>音声素材</span>
              <select value={sampleVoiceId} onChange={(event) => setSampleVoiceId(event.target.value)} disabled={busy}>
                {SAMPLE_VOICES.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.label}
                  </option>
                ))}
              </select>
            </label>

            <label className='wizard-field'>
              <span>セリフ</span>
              <textarea
                rows={4}
                value={dialog}
                onChange={(event) => setDialog(event.target.value)}
                placeholder='例: こんにちは。今日はいい天気ですね。'
              />
              <small className={`wizard-field__meta${dialogLength > DIALOG_MAX_CHARS ? ' is-over' : ''}`}>
                {dialogLength}/{DIALOG_MAX_CHARS}
              </small>
            </label>

            <div className='wizard-actions'>
              <button type='button' className='primary-button' onClick={() => void handleGenerate()} disabled={!canGenerate}>
                {busy ? 'Generating...' : '生成'}
              </button>
            </div>

            {busy && <p className='wizard-status'>{status === 'VIDEO' ? '動画合成中' : '音声生成中'}</p>}
          </div>
        </section>

        <section className='wizard-panel wizard-panel--preview'>
          <div className='wizard-card wizard-card--preview'>
            <div className='wizard-card__header'>
              <div>
                <p className='wizard-eyebrow'>生成結果</p>
              </div>
              {result && videoUrlRef.current && (
                <button type='button' className='ghost-button' onClick={() => void handleDownload()}>
                  保存
                </button>
              )}
            </div>

            <div className='stage-viewer' style={viewerStyle}>
              <div className='viewer-progress' aria-hidden='true' />
              {busy ? (
                <div className='loading-display' role='status' aria-live='polite'>
                  <div className='loading-rings' aria-hidden='true'>
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className='loading-blink'>{status === 'VIDEO' ? '動画合成中' : '音声生成中'}</span>
                  <p>処理を実行しています</p>
                </div>
              ) : videoUrlRef.current ? (
                <video src={videoUrlRef.current} controls playsInline />
              ) : (
                <div className='stage-placeholder'>動画とセリフを入力して生成してください。</div>
              )}
            </div>
          </div>
        </section>
      </div>

      {showTicketModal && (
        <div className='modal-overlay' role='dialog' aria-modal='true'>
          <div className='modal-card'>
            <h3>クレジット不足</h3>
            <p>ボイス生成は1クレジット必要です。購入ページへ移動しますか？</p>
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
            <h3>エラー</h3>
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
