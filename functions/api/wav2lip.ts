import { createClient, type User } from '@supabase/supabase-js'
import { arrayBufferToBase64 } from '../_shared/base64'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'

type Env = {
  CORS_ALLOWED_ORIGINS?: string
  RUNPOD_API_KEY?: string
  RUNPOD_ENDPOINT_URL?: string
  RUNPOD_WAV2LIP_ENDPOINT_URL?: string
  R2_BUCKET?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

type RunpodRunResponse = {
  id?: string
  status?: string
  output?: unknown
  error?: unknown
  [key: string]: unknown
}

type RunpodStatusResponse = {
  id?: string
  status?: string
  output?: unknown
  error?: unknown
  [key: string]: unknown
}

const corsMethods = 'POST, GET, DELETE, OPTIONS'
const SIGNUP_TICKET_GRANT = 5
const VOICE_TICKET_COST = 1
const MAX_VIDEO_SIZE_BYTES = 200 * 1024 * 1024
const MAX_AUDIO_SIZE_BYTES = 50 * 1024 * 1024
const DEFAULT_R2_BUCKET = 'wav2lipsovits'
const R2_HOST_SUFFIX = '.r2.cloudflarestorage.com'

const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })

const normalizeEndpoint = (value?: string) => {
  if (!value) return ''
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '')
  if (!trimmed) return ''
  const normalized = trimmed.replace(/\/+$/, '')
  try {
    const parsed = new URL(normalized)
    if (!/^https?:$/.test(parsed.protocol)) return ''
    return normalized
  } catch {
    return ''
  }
}

const resolveEndpoint = (env: Env) =>
  normalizeEndpoint(env.RUNPOD_WAV2LIP_ENDPOINT_URL) || normalizeEndpoint(env.RUNPOD_ENDPOINT_URL)

const extractBearerToken = (request: Request) => {
  const header = request.headers.get('Authorization') || ''
  const match = header.match(/Bearer\s+(.+)/i)
  return match ? match[1] : ''
}

const getSupabaseAdmin = (env: Env) => {
  const url = env.SUPABASE_URL
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

const isGoogleUser = (user: User) => {
  if (user.app_metadata?.provider === 'google') return true
  if (Array.isArray(user.identities)) {
    return user.identities.some((identity) => identity.provider === 'google')
  }
  return false
}

const requireGoogleUser = async (request: Request, env: Env, corsHeaders: HeadersInit) => {
  const token = extractBearerToken(request)
  if (!token) {
    return { response: jsonResponse({ error: 'ログインが必要です。' }, 401, corsHeaders) }
  }
  const admin = getSupabaseAdmin(env)
  if (!admin) {
    return { response: jsonResponse({ error: 'SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定です。' }, 500, corsHeaders) }
  }
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) {
    return { response: jsonResponse({ error: '認証に失敗しました。' }, 401, corsHeaders) }
  }
  if (!isGoogleUser(data.user)) {
    return { response: jsonResponse({ error: 'Google ログインのみ対応しています。' }, 403, corsHeaders) }
  }
  return { admin, user: data.user }
}

const makeUsageId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`

const fetchTicketRow = async (admin: ReturnType<typeof createClient>, user: User) => {
  const email = user.email
  const { data: byUser, error: userError } = await admin
    .from('user_tickets')
    .select('id, email, user_id, tickets')
    .eq('user_id', user.id)
    .maybeSingle()
  if (userError) return { error: userError }
  if (byUser) return { data: byUser, error: null }
  if (!email) return { data: null, error: null }
  const { data: byEmail, error: emailError } = await admin
    .from('user_tickets')
    .select('id, email, user_id, tickets')
    .eq('email', email)
    .maybeSingle()
  if (emailError) return { error: emailError }
  return { data: byEmail, error: null }
}

const ensureTicketRow = async (admin: ReturnType<typeof createClient>, user: User) => {
  const email = user.email
  if (!email) return { data: null, error: null }

  const { data: existing, error } = await fetchTicketRow(admin, user)
  if (error) return { data: null, error }
  if (existing) return { data: existing, error: null, created: false }

  const { data: inserted, error: insertError } = await admin
    .from('user_tickets')
    .insert({ email, user_id: user.id, tickets: SIGNUP_TICKET_GRANT })
    .select('id, email, user_id, tickets')
    .maybeSingle()

  if (insertError || !inserted) {
    const { data: retry, error: retryError } = await fetchTicketRow(admin, user)
    if (retryError) return { data: null, error: retryError }
    return { data: retry, error: null, created: false }
  }

  await admin.from('ticket_events').insert({
    usage_id: makeUsageId(),
    email,
    user_id: user.id,
    delta: SIGNUP_TICKET_GRANT,
    reason: 'signup_bonus',
    metadata: { source: 'auto_grant' },
  })

  return { data: inserted, error: null, created: true }
}

const ensureTicketAvailable = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  requiredTickets: number,
  corsHeaders: HeadersInit,
) => {
  const email = user.email
  if (!email) return { response: jsonResponse({ error: 'Email is required.' }, 400, corsHeaders) }

  const { data: existing, error } = await ensureTicketRow(admin, user)
  if (error) return { response: jsonResponse({ error: error.message }, 500, corsHeaders) }
  if (!existing) return { response: jsonResponse({ error: 'No tickets remaining.' }, 402, corsHeaders) }

  if (!existing.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  }
  if (existing.tickets < requiredTickets) {
    return { response: jsonResponse({ error: 'No tickets remaining.' }, 402, corsHeaders) }
  }
  return { existing }
}

const consumeTicket = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  metadata: Record<string, unknown>,
  usageId: string,
  corsHeaders: HeadersInit,
) => {
  const email = user.email
  if (!email) return { response: jsonResponse({ error: 'Email is required.' }, 400, corsHeaders) }

  const { data: existing, error } = await fetchTicketRow(admin, user)
  if (error) return { response: jsonResponse({ error: error.message }, 500, corsHeaders) }
  if (!existing) return { response: jsonResponse({ error: 'No tickets available.' }, 402, corsHeaders) }

  const { data: rpcData, error: rpcError } = await admin.rpc('consume_tickets', {
    p_ticket_id: existing.id,
    p_usage_id: usageId,
    p_cost: VOICE_TICKET_COST,
    p_reason: 'generate_voice',
    p_metadata: metadata,
  })

  if (rpcError) {
    const message = rpcError.message || 'Ticket consumption failed.'
    if (message.includes('INSUFFICIENT_TICKETS')) {
      return { response: jsonResponse({ error: 'No tickets remaining.' }, 402, corsHeaders) }
    }
    if (message.includes('INVALID')) {
      return { response: jsonResponse({ error: 'Invalid ticket request.' }, 400, corsHeaders) }
    }
    return { response: jsonResponse({ error: message }, 500, corsHeaders) }
  }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const ticketsLeft = Number(result?.tickets_left)
  return { ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined }
}

const refundTicket = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  metadata: Record<string, unknown>,
  usageId: string | null,
  corsHeaders: HeadersInit,
) => {
  const email = user.email
  if (!email || !usageId) return { skipped: true }

  let chargeEvent: { usage_id?: string } | null = null
  const { data: chargeByUser, error: chargeByUserError } = await admin
    .from('ticket_events')
    .select('usage_id')
    .eq('usage_id', usageId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (chargeByUserError) return { response: jsonResponse({ error: chargeByUserError.message }, 500, corsHeaders) }
  chargeEvent = chargeByUser

  if (!chargeEvent) {
    const { data: chargeByEmail, error: chargeByEmailError } = await admin
      .from('ticket_events')
      .select('usage_id')
      .eq('usage_id', usageId)
      .eq('email', email)
      .maybeSingle()
    if (chargeByEmailError) return { response: jsonResponse({ error: chargeByEmailError.message }, 500, corsHeaders) }
    chargeEvent = chargeByEmail
  }

  if (!chargeEvent) return { skipped: true }

  const refundUsageId = `${usageId}:refund`
  const { data: existingRefund, error: refundCheckError } = await admin
    .from('ticket_events')
    .select('usage_id')
    .eq('usage_id', refundUsageId)
    .maybeSingle()
  if (refundCheckError) return { response: jsonResponse({ error: refundCheckError.message }, 500, corsHeaders) }
  if (existingRefund) return { alreadyRefunded: true }

  const { data: existing, error } = await ensureTicketRow(admin, user)
  if (error) return { response: jsonResponse({ error: error.message }, 500, corsHeaders) }
  if (!existing) return { response: jsonResponse({ error: 'No ticket row.' }, 500, corsHeaders) }

  const { data: rpcData, error: rpcError } = await admin.rpc('refund_tickets', {
    p_ticket_id: existing.id,
    p_usage_id: refundUsageId,
    p_amount: VOICE_TICKET_COST,
    p_reason: 'refund',
    p_metadata: metadata,
  })
  if (rpcError) return { response: jsonResponse({ error: rpcError.message }, 500, corsHeaders) }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const ticketsLeft = Number(result?.tickets_left)
  return { ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined }
}

const parseBool = (value: FormDataEntryValue | null) => {
  if (value == null) return false
  const lowered = String(value).trim().toLowerCase()
  if (!lowered) return false
  return lowered === '1' || lowered === 'true' || lowered === 'yes' || lowered === 'on'
}

const parseNumber = (value: FormDataEntryValue | null) => {
  if (value == null) return null
  const num = Number(String(value))
  return Number.isFinite(num) ? num : null
}


type ParsedR2Url = {
  bucket: string
  key: string
}

const parseR2ObjectUrl = (rawUrl: string, env: Env): ParsedR2Url | null => {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:') return null
    const hostname = parsed.hostname.toLowerCase()
    if (!hostname.endsWith(R2_HOST_SUFFIX)) return null

    const pathParts = parsed.pathname.split('/').filter(Boolean)
    if (pathParts.length < 2) return null

    const bucket = pathParts[0]
    const key = pathParts.slice(1).join('/')
    const expectedBucket = (env.R2_BUCKET || DEFAULT_R2_BUCKET).trim()
    if (expectedBucket && bucket !== expectedBucket) return null
    return { bucket, key }
  } catch {
    return null
  }
}

const hasAllowedR2Prefix = (parsed: ParsedR2Url, prefixes: string[]) =>
  prefixes.some((prefix) => parsed.key.startsWith(prefix))

const parseTotalBytesFromHeaders = (headers: Headers) => {
  const contentRange = headers.get('content-range') || ''
  const rangeMatch = contentRange.match(/\/(\d+)\s*$/)
  if (rangeMatch) {
    const totalFromRange = Number(rangeMatch[1])
    if (Number.isFinite(totalFromRange) && totalFromRange >= 0) return totalFromRange
  }

  const contentLength = headers.get('content-length') || ''
  const totalFromLength = Number(contentLength)
  if (Number.isFinite(totalFromLength) && totalFromLength >= 0) return totalFromLength
  return null
}

const probeRemoteFileSize = async (rawUrl: string) => {
  const rangeRes = await fetch(rawUrl, {
    method: 'GET',
    headers: { Range: 'bytes=0-0' },
  })
  try {
    if (rangeRes.ok || rangeRes.status === 206 || rangeRes.status === 416) {
      const total = parseTotalBytesFromHeaders(rangeRes.headers)
      if (total !== null) return total
    }
  } finally {
    await rangeRes.body?.cancel().catch(() => undefined)
  }

  const headRes = await fetch(rawUrl, { method: 'HEAD' })
  try {
    if (headRes.ok) {
      const total = parseTotalBytesFromHeaders(headRes.headers)
      if (total !== null) return total
    }
  } finally {
    await headRes.body?.cancel().catch(() => undefined)
  }

  return null
}

const ensureRemoteFileSizeWithinLimit = async (
  rawUrl: string,
  maxBytes: number,
  label: string,
  corsHeaders: HeadersInit,
) => {
  let totalBytes: number | null = null
  try {
    totalBytes = await probeRemoteFileSize(rawUrl)
  } catch {
    return { response: jsonResponse({ error: `${label}のサイズ確認に失敗しました。` }, 400, corsHeaders) }
  }

  if (totalBytes === null) {
    return { response: jsonResponse({ error: `${label}のサイズ確認に失敗しました。` }, 400, corsHeaders) }
  }

  if (totalBytes > maxBytes) {
    const maxMb = Math.floor(maxBytes / (1024 * 1024))
    return { response: jsonResponse({ error: `${label}サイズは最大${maxMb}MBまでです。` }, 400, corsHeaders) }
  }

  return { size: totalBytes }
}

const waitMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const runpodFetch = async (endpoint: string, apiKey: string, path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${apiKey}`)
  headers.set('Content-Type', 'application/json')
  return fetch(`${endpoint}${path}`, { ...init, headers })
}

const hasOutputError = (payload: any) =>
  Boolean(
    payload?.error ||
      payload?.output?.error ||
      payload?.result?.error ||
      payload?.output?.output?.error ||
      payload?.result?.output?.error,
  )

const isFailurePayload = (payload: any) => {
  const status = String(payload?.status ?? payload?.state ?? '').toLowerCase()
  return status.includes('fail') || status.includes('error') || status.includes('cancel') || hasOutputError(payload)
}

export const onRequestOptions: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }
  return new Response(null, { status: 204, headers: corsHeaders })
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) return auth.response

  const endpoint = resolveEndpoint(env)
  if (!endpoint) return jsonResponse({ error: 'RUNPOD_WAV2LIP_ENDPOINT_URL が未設定です。' }, 500, corsHeaders)
  if (!env.RUNPOD_API_KEY) return jsonResponse({ error: 'RUNPOD_API_KEY が未設定です。' }, 500, corsHeaders)

  const url = new URL(request.url)
  const id = (url.searchParams.get('id') || '').trim()
  const usageId = (url.searchParams.get('usage_id') || url.searchParams.get('usageId') || '').trim() || null
  if (!id) return jsonResponse({ error: 'id is required.' }, 400, corsHeaders)

  try {
    const upstream = await runpodFetch(endpoint, env.RUNPOD_API_KEY, `/status/${encodeURIComponent(id)}`, { method: 'GET' })
    const raw = await upstream.text()
    const payload = (JSON.parse(raw || '{}') as RunpodStatusResponse) || {}

    let refundedTickets: number | undefined
    if (isFailurePayload(payload) && usageId) {
      const refund = await refundTicket(auth.admin, auth.user, { usage_id: usageId, job_id: id, source: 'status' }, usageId, corsHeaders)
      if ('response' in refund) return refund.response
      refundedTickets = refund.ticketsLeft
    }

    const responsePayload: Record<string, unknown> = {
      ...(typeof payload === 'object' && payload !== null ? payload : {}),
    }
    if (Number.isFinite(refundedTickets)) responsePayload.ticketsLeft = refundedTickets
    return jsonResponse(responsePayload, upstream.status, corsHeaders)
  } catch (error) {
    return jsonResponse(
      { error: '動画ジョブ状態の取得に失敗しました。', detail: error instanceof Error ? error.message : 'unknown_error' },
      502,
      corsHeaders,
    )
  }
}

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) return auth.response

  const endpoint = resolveEndpoint(env)
  if (!endpoint) return jsonResponse({ error: 'RUNPOD_WAV2LIP_ENDPOINT_URL が未設定です。' }, 500, corsHeaders)
  if (!env.RUNPOD_API_KEY) return jsonResponse({ error: 'RUNPOD_API_KEY が未設定です。' }, 500, corsHeaders)

  const url = new URL(request.url)
  const id = (url.searchParams.get('id') || '').trim()
  const usageId = (url.searchParams.get('usage_id') || url.searchParams.get('usageId') || '').trim() || null
  if (!id) return jsonResponse({ error: 'id is required.' }, 400, corsHeaders)

  let cancelAccepted = false
  try {
    const cancelRes = await runpodFetch(endpoint, env.RUNPOD_API_KEY, `/cancel/${encodeURIComponent(id)}`, { method: 'POST' })
    cancelAccepted = cancelRes.ok
  } catch {
    cancelAccepted = false
  }

  let latestStatus = ''
  let shouldRefund = false
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const stRes = await runpodFetch(endpoint, env.RUNPOD_API_KEY, `/status/${encodeURIComponent(id)}`, { method: 'GET' })
      const raw = await stRes.text()
      const payload = (JSON.parse(raw || '{}') as RunpodStatusResponse) || {}
      latestStatus = String(payload?.status || '').toUpperCase()
      if (isFailurePayload(payload)) {
        shouldRefund = true
        break
      }
      const normalized = latestStatus.toLowerCase()
      if (normalized.includes('complete') || normalized.includes('success')) {
        shouldRefund = false
        break
      }
    } catch {
      // ignore transient errors while polling cancellation result
    }
    await waitMs(1500)
  }

  let refundedTickets: number | undefined
  if (usageId && shouldRefund) {
    const refund = await refundTicket(auth.admin, auth.user, { usage_id: usageId, job_id: id, source: 'cancel' }, usageId, corsHeaders)
    if ('response' in refund) return refund.response
    refundedTickets = refund.ticketsLeft
  }

  return jsonResponse(
    {
      id,
      usage_id: usageId,
      cancelAccepted,
      status: latestStatus || 'UNKNOWN',
      refunded: Number.isFinite(refundedTickets),
      ticketsLeft: refundedTickets,
    },
    200,
    corsHeaders,
  )
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) return auth.response

  const endpoint = resolveEndpoint(env)
  if (!endpoint) return jsonResponse({ error: 'RUNPOD_WAV2LIP_ENDPOINT_URL が未設定です。' }, 500, corsHeaders)
  if (!env.RUNPOD_API_KEY) return jsonResponse({ error: 'RUNPOD_API_KEY が未設定です。' }, 500, corsHeaders)

  let usageId: string | null = null

  try {
    const form = await request.formData()
    const videoFile = form.get('video')
    const audioFile = form.get('audio')
    const videoUrl = String(form.get('video_url') || '').trim()
    const audioUrl = String(form.get('audio_url') || '').trim()

    const hasFiles = videoFile instanceof File && audioFile instanceof File
    const hasUrls = Boolean(videoUrl && audioUrl)
    if (!hasFiles && !hasUrls) {
      return jsonResponse({ error: 'video/audio are required (files or video_url/audio_url).' }, 400, corsHeaders)
    }

    if (hasFiles) {
      const inputVideo = videoFile as File
      const inputAudio = audioFile as File
      if (inputVideo.size > MAX_VIDEO_SIZE_BYTES) {
        return jsonResponse({ error: '動画サイズは最大200MBまでです。' }, 400, corsHeaders)
      }
      if (inputAudio.size > MAX_AUDIO_SIZE_BYTES) {
        return jsonResponse({ error: '音声サイズは最大50MBまでです。' }, 400, corsHeaders)
      }
    } else {
      const parsedVideo = parseR2ObjectUrl(videoUrl, env)
      const parsedAudio = parseR2ObjectUrl(audioUrl, env)
      if (!parsedVideo || !hasAllowedR2Prefix(parsedVideo, ['wav2lip/video/'])) {
        return jsonResponse({ error: 'video_url は許可されていないURLです。' }, 400, corsHeaders)
      }
      if (!parsedAudio || !hasAllowedR2Prefix(parsedAudio, ['wav2lip/audio/'])) {
        return jsonResponse({ error: 'audio_url は許可されていないURLです。' }, 400, corsHeaders)
      }

      const videoSizeCheck = await ensureRemoteFileSizeWithinLimit(videoUrl, MAX_VIDEO_SIZE_BYTES, '動画', corsHeaders)
      if ('response' in videoSizeCheck) return videoSizeCheck.response

      const audioSizeCheck = await ensureRemoteFileSizeWithinLimit(audioUrl, MAX_AUDIO_SIZE_BYTES, '音声', corsHeaders)
      if ('response' in audioSizeCheck) return audioSizeCheck.response
    }

    const ticketCheck = await ensureTicketAvailable(auth.admin, auth.user, VOICE_TICKET_COST, corsHeaders)
    if ('response' in ticketCheck) return ticketCheck.response

    usageId = `voice:${makeUsageId()}`
    const ticketCharge = await consumeTicket(
      auth.admin,
      auth.user,
      { usage_id: usageId, source: 'run' },
      usageId,
      corsHeaders,
    )
    if ('response' in ticketCharge) return ticketCharge.response

    const faceMask = parseBool(form.get('face_mask'))
    const faceOccluder = parseBool(form.get('face_occluder'))
    const gfpgan = parseBool(form.get('gfpgan'))
    const gfpganBlendPercent = parseNumber(form.get('gfpgan_blend_percent'))

    const input: Record<string, unknown> = {
      mode: 'wav2lip_onnx_hq',
      checkpoint: 'checkpoints/wav2lip_gan.onnx',
      video: { name: 'input.mp4' },
      audio: { name: 'input.wav' },
      options: {
        face_mask: faceMask,
        face_occluder: faceOccluder,
        enhancer: gfpgan ? 'gfpgan' : 'none',
        gfpgan_blend_percent: gfpganBlendPercent ?? 30,
      },
    }

    if (hasFiles) {
      const video = videoFile as File
      const audio = audioFile as File
      ;(input.video as Record<string, unknown>).name = (video.name || 'input.mp4').replace(/[^\w.\-() ]+/g, '_')
      ;(input.audio as Record<string, unknown>).name = (audio.name || 'input.wav').replace(/[^\w.\-() ]+/g, '_')
      ;(input.video as Record<string, unknown>).data = `data:${video.type || 'video/mp4'};base64,${arrayBufferToBase64(
        await video.arrayBuffer(),
      )}`
      ;(input.audio as Record<string, unknown>).data = `data:${audio.type || 'audio/wav'};base64,${arrayBufferToBase64(
        await audio.arrayBuffer(),
      )}`
    } else {
      ;(input.video as Record<string, unknown>).url = videoUrl
      ;(input.audio as Record<string, unknown>).url = audioUrl
    }

    let upstream: Response
    try {
      upstream = await runpodFetch(endpoint, env.RUNPOD_API_KEY, '/run', {
        method: 'POST',
        body: JSON.stringify({ input }),
      })
    } catch (error) {
      await refundTicket(auth.admin, auth.user, { usage_id: usageId, reason: 'network_error' }, usageId, corsHeaders)
      return jsonResponse(
        { error: '動画合成ジョブの開始に失敗しました。', detail: error instanceof Error ? error.message : 'unknown_error' },
        502,
        corsHeaders,
      )
    }

    const raw = await upstream.text()
    let payload: RunpodRunResponse | null = null
    try {
      payload = JSON.parse(raw) as RunpodRunResponse
    } catch {
      payload = null
    }

    if (!upstream.ok) {
      await refundTicket(auth.admin, auth.user, { usage_id: usageId, reason: 'upstream_error' }, usageId, corsHeaders)
      return jsonResponse(
        { error: '動画合成ジョブの開始に失敗しました。', detail: payload?.error || raw.slice(0, 1000) },
        502,
        corsHeaders,
      )
    }

    if (!payload || !payload.id || isFailurePayload(payload)) {
      await refundTicket(auth.admin, auth.user, { usage_id: usageId, reason: 'invalid_response' }, usageId, corsHeaders)
      return jsonResponse(
        { error: '動画合成ジョブの開始に失敗しました。', detail: payload?.error || 'missing_job_id' },
        502,
        corsHeaders,
      )
    }

    const responsePayload: Record<string, unknown> = {
      ...payload,
      usage_id: usageId,
    }
    if (ticketCharge.ticketsLeft !== undefined) responsePayload.ticketsLeft = ticketCharge.ticketsLeft
    return jsonResponse(responsePayload, 200, corsHeaders)
  } catch (error) {
    if (usageId) {
      const refund = await refundTicket(auth.admin, auth.user, { usage_id: usageId, reason: 'unexpected_error' }, usageId, corsHeaders)
      if ('response' in refund) return refund.response
    }
    return jsonResponse(
      { error: '動画合成ジョブの開始に失敗しました。', detail: error instanceof Error ? error.message : 'unknown_error' },
      500,
      corsHeaders,
    )
  }
}
