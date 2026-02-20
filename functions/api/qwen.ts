import zimageWorkflowTemplate from './qwen-workflow.json'
import zimageNodeMapTemplate from './qwen-node-map.json'
import qwenEditWorkflowTemplate from './qwen-edit-workflow.json'
import qwenEditNodeMapTemplate from './qwen-edit-node-map.json'
import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'
import { isUnderageImage } from '../_shared/rekognition'
import { presignUrl } from '../_shared/sigv4'

type Env = {
  RUNPOD_API_KEY: string
  RUNPOD_ZIMAGE_ENDPOINT_URL?: string
  RUNPOD_QWEN_ENDPOINT_URL?: string
  RUNPOD_ENDPOINT_URL?: string
  COMFY_ORG_API_KEY?: string
  RUNPOD_WORKER_MODE?: string
  R2_ANIMA_BUCKET?: string
  R2_ACCOUNT_ID?: string
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
  R2_REGION?: string
  AWS_ACCESS_KEY_ID?: string
  AWS_SECRET_ACCESS_KEY?: string
  AWS_REGION?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

const corsMethods = 'POST, GET, OPTIONS'

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

const DEFAULT_ZIMAGE_ENDPOINT = 'https://api.runpod.ai/v2/nk5f686wu3645s'
const DEFAULT_QWEN_EDIT_ENDPOINT = 'https://api.runpod.ai/v2/278qoim6xsktcb'

type WorkflowVariant = 'zimage' | 'qwen_edit'

const resolveEndpoint = (env: Env, variant: WorkflowVariant) => {
  if (variant === 'qwen_edit') {
    return (
      normalizeEndpoint(env.RUNPOD_QWEN_ENDPOINT_URL) ||
      DEFAULT_QWEN_EDIT_ENDPOINT
    )
  }
  return (
    normalizeEndpoint(env.RUNPOD_ZIMAGE_ENDPOINT_URL) ||
    normalizeEndpoint(env.RUNPOD_ENDPOINT_URL) ||
    DEFAULT_ZIMAGE_ENDPOINT
  )
}

type NodeMapEntry = {
  id: string
  input: string
}

type NodeMapValue = NodeMapEntry | NodeMapEntry[]

type NodeMap = Partial<{
  image: NodeMapValue
  image2: NodeMapValue
  prompt: NodeMapValue
  negative_prompt: NodeMapValue
  seed: NodeMapValue
  steps: NodeMapValue
  cfg: NodeMapValue
  width: NodeMapValue
  height: NodeMapValue
  angle_strength: NodeMapValue
}>

const SIGNUP_TICKET_GRANT = 5
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_PROMPT_LENGTH = 500
const MAX_NEGATIVE_PROMPT_LENGTH = 500
const FIXED_STEPS = 4
const MIN_DIMENSION = 256
const MAX_DIMENSION = 3000
const MIN_GUIDANCE = 0
const MAX_GUIDANCE = 10
const MIN_ANGLE_STRENGTH = 0
const MAX_ANGLE_STRENGTH = 1
const UNDERAGE_BLOCK_MESSAGE =
  'This image may contain violent, underage, or policy-violating content. Please try another image.'
const DEFAULT_R2_BUCKET = 'anima'
const R2_PUT_EXPIRES_SECONDS = 15 * 60
const R2_GET_EXPIRES_SECONDS = 7 * 24 * 60 * 60

type R2Config = {
  host: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region: string
}

type UploadedImageRef = {
  key: string
  url: string
}

type GenerationSummary = {
  prompt: string
  negative_prompt: string
  width: number
  height: number
  steps: number
  cfg: number
  seed: number
  randomize_seed: boolean
  sampler_name: string
  scheduler: string
  denoise: number
}

type GenerationRecordPatch = {
  runpod_job_id?: string | null
  status?: string
  error_message?: string | null
  r2_key?: string | null
}

const getWorkflowTemplate = (variant: WorkflowVariant) =>
  (variant === 'qwen_edit' ? qwenEditWorkflowTemplate : zimageWorkflowTemplate) as Record<string, unknown>

const getNodeMap = (variant: WorkflowVariant) =>
  (variant === 'qwen_edit' ? qwenEditNodeMapTemplate : zimageNodeMapTemplate) as NodeMap

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

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
    return { response: jsonResponse({ error: 'Login is required.' }, 401, corsHeaders) }
  }
  const admin = getSupabaseAdmin(env)
  if (!admin) {
    return {
      response: jsonResponse(
        { error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured.' },
        500,
        corsHeaders,
      ),
    }
  }
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) {
    return { response: jsonResponse({ error: 'Authentication failed.' }, 401, corsHeaders) }
  }
  if (!isGoogleUser(data.user)) {
    return { response: jsonResponse({ error: 'Google login is required.' }, 403, corsHeaders) }
  }
  return { admin, user: data.user }
}

const makeUsageId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const normalizeVariant = (value: unknown): WorkflowVariant => {
  const raw = typeof value === 'string' ? value : value == null ? '' : String(value)
  const normalized = raw.trim().toLowerCase()
  if (!normalized) return 'zimage'
  if (normalized === 'qwen' || normalized === 'edit' || normalized === 'qwen_edit' || normalized === 'qwen-edit') {
    return 'qwen_edit'
  }
  if (normalized.includes('qwen')) return 'qwen_edit'
  return 'zimage'
}

const inferVariantFromUsageId = (usageId: string): WorkflowVariant => {
  const normalized = String(usageId || '').trim().toLowerCase()
  if (!normalized) return 'zimage'
  if (normalized.startsWith('qwen_edit:') || normalized.startsWith('qwen-edit:')) return 'qwen_edit'
  // Backward-compat: old IDs were prefixed with "qwen:" for edit jobs.
  if (normalized.startsWith('qwen:')) return 'qwen_edit'
  if (normalized.startsWith('zimage:') || normalized.startsWith('z:')) return 'zimage'
  return 'zimage'
}

const resolveR2Config = (env: Env): R2Config | null => {
  const accountId = env.R2_ACCOUNT_ID?.trim()
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim()
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim()
  if (!accountId || !accessKeyId || !secretAccessKey) return null
  const bucket = env.R2_ANIMA_BUCKET?.trim() || DEFAULT_R2_BUCKET
  const region = env.R2_REGION?.trim().replace(/^#+/, '') || 'auto'
  return {
    host: `${accountId}.r2.cloudflarestorage.com`,
    bucket,
    accessKeyId,
    secretAccessKey,
    region,
  }
}

const safeKeyPart = (value: string) => value.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown'

const extFromMime = (mime: string) => {
  const normalized = mime.toLowerCase()
  if (normalized.includes('image/jpeg')) return 'jpg'
  if (normalized.includes('image/webp')) return 'webp'
  if (normalized.includes('image/gif')) return 'gif'
  return 'png'
}

const normalizeBase64 = (value: string) => value.trim().replace(/\s+/g, '')

const parseImageString = (value: unknown): { base64: string; mime: string; ext: string } | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || /^https?:\/\//i.test(trimmed)) return null
  const dataUrlMatch = trimmed.match(/^data:([^;,]+);base64,(.+)$/i)
  if (dataUrlMatch) {
    const mime = dataUrlMatch[1].toLowerCase()
    const base64 = normalizeBase64(dataUrlMatch[2])
    if (!base64) return null
    return { base64, mime, ext: extFromMime(mime) }
  }
  const base64 = normalizeBase64(trimmed)
  if (!base64) return null
  return { base64, mime: 'image/png', ext: 'png' }
}

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

const createImageR2Key = (userId: string, usageId: string, ext: string) =>
  `anima/${safeKeyPart(userId)}/${safeKeyPart(usageId)}/${crypto.randomUUID()}.${ext}`

const uploadBase64ImageToR2 = async (
  config: R2Config,
  parsed: { base64: string; mime: string; ext: string },
  userId: string,
  usageId: string,
) => {
  const key = createImageR2Key(userId, usageId, parsed.ext)
  const canonicalUri = `/${config.bucket}/${key}`
  const put = await presignUrl({
    method: 'PUT',
    host: config.host,
    canonicalUri,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    expiresSeconds: R2_PUT_EXPIRES_SECONDS,
    additionalSignedHeaders: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
  })
  const putRes = await fetch(put.url, {
    method: 'PUT',
    headers: {
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      'content-type': parsed.mime,
    },
    body: base64ToBytes(parsed.base64),
  })
  if (!putRes.ok) {
    throw new Error(`R2 put failed with status ${putRes.status}`)
  }
  const get = await presignUrl({
    method: 'GET',
    host: config.host,
    canonicalUri,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    expiresSeconds: R2_GET_EXPIRES_SECONDS,
  })
  return { key, url: get.url } as UploadedImageRef
}

const maybeUploadImageValue = async (value: unknown, config: R2Config, userId: string, usageId: string) => {
  const parsed = parseImageString(value)
  if (!parsed) return null
  try {
    return await uploadBase64ImageToR2(config, parsed, userId, usageId)
  } catch {
    return null
  }
}

const maybeReplaceObjectImageFields = async (
  record: Record<string, unknown>,
  config: R2Config,
  userId: string,
  usageId: string,
) => {
  let firstUploaded: UploadedImageRef | null = null
  for (const field of ['image', 'data', 'url', 'output_image', 'output_image_base64']) {
    if (!(field in record)) continue
    const replaced = await maybeUploadImageValue(record[field], config, userId, usageId)
    if (replaced) {
      record[field] = replaced.url
      if (!firstUploaded) firstUploaded = replaced
    }
  }
  return firstUploaded
}

const isCompletedStatus = (value: unknown) => {
  const status = String(value ?? '').toLowerCase()
  return (
    status.includes('complete') ||
    status.includes('success') ||
    status.includes('succeed') ||
    status.includes('finished')
  )
}

const persistImagesToR2 = async (payload: unknown, env: Env, userId: string, usageId: string) => {
  if (!payload || typeof payload !== 'object') return { firstKey: null as string | null }
  const config = resolveR2Config(env)
  if (!config) return { firstKey: null as string | null }

  let firstKey: string | null = null
  const data = payload as Record<string, any>
  const seenArrays = new Set<any[]>()
  const listCandidates: unknown[] = [
    data.output?.images,
    data.output?.output_images,
    data.output?.outputs,
    data.output?.data,
    data.result?.images,
    data.result?.output_images,
    data.result?.outputs,
    data.result?.data,
    data.images,
    data.output_images,
    data.outputs,
    data.data,
    data.output?.output?.images,
    data.output?.output?.output_images,
    data.output?.output?.outputs,
    data.output?.output?.data,
    data.result?.output?.images,
    data.result?.output?.output_images,
    data.result?.output?.outputs,
    data.result?.output?.data,
  ]

  for (const candidate of listCandidates) {
    if (!Array.isArray(candidate) || seenArrays.has(candidate)) continue
    seenArrays.add(candidate)
    for (let i = 0; i < candidate.length; i += 1) {
      const item = candidate[i]
      if (typeof item === 'string') {
        const replaced = await maybeUploadImageValue(item, config, userId, usageId)
        if (replaced) {
          candidate[i] = replaced.url
          if (!firstKey) firstKey = replaced.key
        }
        continue
      }
      if (item && typeof item === 'object') {
        const replaced = await maybeReplaceObjectImageFields(item as Record<string, unknown>, config, userId, usageId)
        if (replaced && !firstKey) firstKey = replaced.key
      }
    }
  }

  const singleCandidates: Array<{ read: () => unknown; write: (next: string) => void }> = [
    { read: () => data.output?.image, write: (next) => { if (data.output) data.output.image = next } },
    { read: () => data.output?.output_image, write: (next) => { if (data.output) data.output.output_image = next } },
    {
      read: () => data.output?.output_image_base64,
      write: (next) => {
        if (data.output) data.output.output_image_base64 = next
      },
    },
    { read: () => data.result?.image, write: (next) => { if (data.result) data.result.image = next } },
    { read: () => data.result?.output_image, write: (next) => { if (data.result) data.result.output_image = next } },
    {
      read: () => data.result?.output_image_base64,
      write: (next) => {
        if (data.result) data.result.output_image_base64 = next
      },
    },
    { read: () => data.image, write: (next) => { data.image = next } },
    { read: () => data.output_image, write: (next) => { data.output_image = next } },
    { read: () => data.output_image_base64, write: (next) => { data.output_image_base64 = next } },
    {
      read: () => data.output?.output?.image,
      write: (next) => {
        if (data.output?.output) data.output.output.image = next
      },
    },
    {
      read: () => data.output?.output?.output_image,
      write: (next) => {
        if (data.output?.output) data.output.output.output_image = next
      },
    },
    {
      read: () => data.output?.output?.output_image_base64,
      write: (next) => {
        if (data.output?.output) data.output.output.output_image_base64 = next
      },
    },
  ]

  for (const ref of singleCandidates) {
    const replaced = await maybeUploadImageValue(ref.read(), config, userId, usageId)
    if (replaced) {
      ref.write(replaced.url)
      if (!firstKey) firstKey = replaced.key
    }
  }

  return { firstKey }
}

const extractRunpodJobId = (payload: any) =>
  payload?.id || payload?.jobId || payload?.job_id || payload?.output?.id || null

const normalizeGenerationStatus = (value: unknown, fallback = 'queued') => {
  const status = String(value ?? '').trim().toLowerCase()
  return status || fallback
}

const safeInsertGenerationRecord = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  usageId: string,
  summary: GenerationSummary,
) => {
  if (!user.email) return
  try {
    await admin.from('anima_generations').insert({
      usage_id: usageId,
      user_id: user.id,
      email: user.email,
      prompt: summary.prompt,
      negative_prompt: summary.negative_prompt,
      width: summary.width,
      height: summary.height,
      steps: summary.steps,
      cfg: summary.cfg,
      seed: summary.seed,
      randomize_seed: summary.randomize_seed,
      sampler_name: summary.sampler_name,
      scheduler: summary.scheduler,
      denoise: summary.denoise,
      status: 'queued',
    })
  } catch {
    // Best-effort logging table.
  }
}

const safeUpdateGenerationRecord = async (
  admin: ReturnType<typeof createClient>,
  usageId: string,
  patch: GenerationRecordPatch,
) => {
  try {
    const updatePayload: Record<string, unknown> = {}
    if (patch.runpod_job_id !== undefined) updatePayload.runpod_job_id = patch.runpod_job_id
    if (patch.status !== undefined) updatePayload.status = patch.status
    if (patch.error_message !== undefined) updatePayload.error_message = patch.error_message
    if (patch.r2_key !== undefined) updatePayload.r2_key = patch.r2_key
    if (!Object.keys(updatePayload).length) return
    await admin.from('anima_generations').update(updatePayload).eq('usage_id', usageId)
  } catch {
    // Best-effort logging table.
  }
}

const resolveSourceGeneration = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  sourceUsageId: string,
) => {
  const usageId = sourceUsageId.trim()
  if (!usageId) return null
  try {
    const { data, error } = await admin
      .from('anima_generations')
      .select(
        'prompt, negative_prompt, width, height, steps, cfg, seed, randomize_seed, sampler_name, scheduler, denoise',
      )
      .eq('usage_id', usageId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (error || !data) return null
    return {
      prompt: typeof data.prompt === 'string' ? data.prompt : '',
      negative_prompt: typeof data.negative_prompt === 'string' ? data.negative_prompt : '',
      width: Number(data.width),
      height: Number(data.height),
      steps: Number(data.steps),
      cfg: Number(data.cfg),
      seed: Number(data.seed),
      randomize_seed: Boolean(data.randomize_seed),
      sampler_name: typeof data.sampler_name === 'string' ? data.sampler_name : '',
      scheduler: typeof data.scheduler === 'string' ? data.scheduler : '',
      denoise: Number(data.denoise),
    } as Partial<GenerationSummary>
  } catch {
    return null
  }
}

const fetchTicketRow = async (
  admin: ReturnType<typeof createClient>,
  user: User,
) => {
  const email = user.email
  const { data: byUser, error: userError } = await admin
    .from('user_tickets')
    .select('id, email, user_id, tickets')
    .eq('user_id', user.id)
    .maybeSingle()
  if (userError) {
    return { error: userError }
  }
  if (byUser) {
    return { data: byUser, error: null }
  }
  if (!email) {
    return { data: null, error: null }
  }
  const { data: byEmail, error: emailError } = await admin
    .from('user_tickets')
    .select('id, email, user_id, tickets')
    .eq('email', email)
    .maybeSingle()
  if (emailError) {
    return { error: emailError }
  }
  return { data: byEmail, error: null }
}

const ensureTicketRow = async (
  admin: ReturnType<typeof createClient>,
  user: User,
) => {
  const email = user.email
  if (!email) {
    return { data: null, error: null }
  }

  const { data: existing, error } = await fetchTicketRow(admin, user)
  if (error) {
    return { data: null, error }
  }
  if (existing) {
    return { data: existing, error: null, created: false }
  }

  const { data: inserted, error: insertError } = await admin
    .from('user_tickets')
    .insert({ email, user_id: user.id, tickets: SIGNUP_TICKET_GRANT })
    .select('id, email, user_id, tickets')
    .maybeSingle()

  if (insertError || !inserted) {
    const { data: retry, error: retryError } = await fetchTicketRow(admin, user)
    if (retryError) {
      return { data: null, error: retryError }
    }
    return { data: retry, error: null, created: false }
  }

  const grantUsageId = makeUsageId()
  await admin.from('ticket_events').insert({
    usage_id: grantUsageId,
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
  corsHeaders: HeadersInit,
) => {
  const email = user.email
  if (!email) {
    return { response: jsonResponse({ error: 'Email is required.' }, 400, corsHeaders) }
  }

  const { data: existing, error } = await ensureTicketRow(admin, user)

  if (error) {
    return { response: jsonResponse({ error: error.message }, 500, corsHeaders) }
  }

  if (!existing) {
    return { response: jsonResponse({ error: 'No ticket remaining.' }, 402, corsHeaders) }
  }

  if (!existing.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  }

  if (existing.tickets < 1) {
    return { response: jsonResponse({ error: 'No ticket remaining.' }, 402, corsHeaders) }
  }

  return { existing }
}

const consumeTicket = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  metadata: Record<string, unknown>,
  usageId: string | undefined,
  corsHeaders: HeadersInit,
) => {
  const email = user.email
  if (!email) {
    return { response: jsonResponse({ error: 'Email is required.' }, 400, corsHeaders) }
  }

  const { data: existing, error } = await ensureTicketRow(admin, user)

  if (error) {
    return { response: jsonResponse({ error: error.message }, 500, corsHeaders) }
  }

  if (!existing) {
    return { response: jsonResponse({ error: 'No ticket remaining.' }, 402, corsHeaders) }
  }

  if (!existing.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  }

  if (existing.tickets < 1) {
    return { response: jsonResponse({ error: 'No ticket remaining.' }, 402, corsHeaders) }
  }

  const resolvedUsageId = usageId ?? makeUsageId()
  const { data: rpcData, error: rpcError } = await admin.rpc('consume_tickets', {
    p_ticket_id: existing.id,
    p_usage_id: resolvedUsageId,
    p_cost: 1,
    p_reason: 'generate',
    p_metadata: metadata,
  })

  if (rpcError) {
    const message = rpcError.message ?? 'Ticket consumption failed.'
    if (message.includes('INSUFFICIENT_TICKETS')) {
      return { response: jsonResponse({ error: 'No ticket remaining.' }, 402, corsHeaders) }
    }
    if (message.includes('INVALID')) {
      return { response: jsonResponse({ error: 'Invalid ticket request.' }, 400, corsHeaders) }
    }
    return { response: jsonResponse({ error: message }, 500, corsHeaders) }
  }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const ticketsLeft = Number(result?.tickets_left)
  const alreadyConsumed = Boolean(result?.already_consumed)
  return {
    ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined,
    alreadyConsumed,
  }
}

const refundTicket = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  metadata: Record<string, unknown>,
  usageId: string | undefined,
  corsHeaders: HeadersInit,
) => {
  const email = user.email
  if (!email || !usageId) {
    return { skipped: true }
  }

  const { data: chargeEvent, error: chargeError } = await admin
    .from('ticket_events')
    .select('usage_id')
    .eq('usage_id', usageId)
    .maybeSingle()

  if (chargeError) {
    return { response: jsonResponse({ error: chargeError.message }, 500, corsHeaders) }
  }

  if (!chargeEvent) {
    return { skipped: true }
  }

  const refundUsageId = `${usageId}:refund`
  const { data: existingRefund, error: refundCheckError } = await admin
    .from('ticket_events')
    .select('usage_id')
    .eq('usage_id', refundUsageId)
    .maybeSingle()

  if (refundCheckError) {
    return { response: jsonResponse({ error: refundCheckError.message }, 500, corsHeaders) }
  }

  if (existingRefund) {
    return { alreadyRefunded: true }
  }

  const { data: existing, error } = await ensureTicketRow(admin, user)

  if (error) {
    return { response: jsonResponse({ error: error.message }, 500, corsHeaders) }
  }

  if (!existing) {
    return { response: jsonResponse({ error: 'No ticket remaining.' }, 402, corsHeaders) }
  }

  if (!existing.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  }

  const { data: rpcData, error: rpcError } = await admin.rpc('refund_tickets', {
    p_ticket_id: existing.id,
    p_usage_id: refundUsageId,
    p_amount: 1,
    p_reason: 'refund',
    p_metadata: metadata,
  })

  if (rpcError) {
    const message = rpcError.message ?? 'Ticket refund failed.'
    if (message.includes('INVALID')) {
      return { response: jsonResponse({ error: message }, 400, corsHeaders) }
    }
    return { response: jsonResponse({ error: message }, 500, corsHeaders) }
  }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const ticketsLeft = Number(result?.tickets_left)
  const alreadyRefunded = Boolean(result?.already_refunded)
  return {
    ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined,
    alreadyRefunded,
  }
}

const hasOutputList = (value: unknown) => Array.isArray(value) && value.length > 0

const hasOutputString = (value: unknown) => typeof value === 'string' && value.trim() !== ''

const hasAssets = (payload: any) => {
  if (!payload || typeof payload !== 'object') return false
  const data = payload as Record<string, unknown>
  const listCandidates = [
    data.images,
    data.videos,
    data.gifs,
    data.outputs,
    data.output_images,
    data.output_videos,
    data.data,
  ]
  if (listCandidates.some(hasOutputList)) return true
  const singleCandidates = [
    data.image,
    data.video,
    data.gif,
    data.output_image,
    data.output_video,
    data.output_image_base64,
  ]
  return singleCandidates.some(hasOutputString)
}

const hasOutputError = (payload: any) =>
  Boolean(
    payload?.error ||
      payload?.output?.error ||
      payload?.result?.error ||
      payload?.output?.output?.error ||
      payload?.result?.output?.error,
  )

const isFailureStatus = (payload: any) => {
  const status = String(payload?.status ?? payload?.state ?? '').toLowerCase()
  return status.includes('fail') || status.includes('error') || status.includes('cancel')
}

const shouldConsumeTicket = (payload: any) => {
  const status = String(payload?.status ?? payload?.state ?? '').toLowerCase()
  const isFailure = status.includes('fail') || status.includes('error') || status.includes('cancel')
  const isSuccess =
    status.includes('complete') ||
    status.includes('success') ||
    status.includes('succeed') ||
    status.includes('finished')
  const hasAnyAssets =
    hasAssets(payload) ||
    hasAssets(payload?.output) ||
    hasAssets(payload?.result) ||
    hasAssets(payload?.output?.output) ||
    hasAssets(payload?.result?.output)
  if (isFailure) return false
  if (hasOutputError(payload)) return false
  return isSuccess || hasAnyAssets
}

const extractJobId = (payload: any) =>
  payload?.id || payload?.jobId || payload?.job_id || payload?.output?.id

const stripDataUrl = (value: string) => {
  const comma = value.indexOf(',')
  if (value.startsWith('data:') && comma !== -1) {
    return value.slice(comma + 1)
  }
  return value
}

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value.trim())

const estimateBase64Bytes = (value: string) => {
  const trimmed = value.trim()
  const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

const ensureBase64Input = (label: string, value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) return ''
  const trimmed = value.trim()
  if (isHttpUrl(trimmed)) {
    throw new Error(`${label} must be base64 (image_url is not allowed).`)
  }
  const base64 = stripDataUrl(trimmed)
  if (!base64) return ''
  const bytes = estimateBase64Bytes(base64)
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error(`${label} is too large.`)
  }
  return base64
}

const pickInputValue = (input: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = input[key]
    if (value !== undefined && value !== null && value !== '') {
      return value
    }
  }
  return undefined
}

const resolveImageBase64 = async (
  input: Record<string, unknown>,
  valueKeys: string[],
  urlKeys: string[],
  label: string,
) => {
  const urlValue = pickInputValue(input, urlKeys)
  if (typeof urlValue === 'string' && urlValue) {
    throw new Error(`${label} must be base64 (image_url is not allowed).`)
  }
  const value = pickInputValue(input, valueKeys)
  if (!value) return ''
  return ensureBase64Input(label, value)
}

const setInputValue = (
  workflow: Record<string, any>,
  entry: NodeMapEntry,
  value: unknown,
) => {
  const node = workflow[entry.id]
  if (!node?.inputs) {
    throw new Error(`Node ${entry.id} not found in workflow.`)
  }
  node.inputs[entry.input] = value
}

const applyNodeMap = (
  workflow: Record<string, any>,
  nodeMap: NodeMap,
  values: Record<string, unknown>,
) => {
  for (const [key, value] of Object.entries(values)) {
    const entry = nodeMap[key as keyof NodeMap]
    if (!entry || value === undefined || value === null) continue
    const entries = Array.isArray(entry) ? entry : [entry]
    for (const item of entries) {
      setInputValue(workflow, item, value)
    }
  }
}

export const onRequestOptions: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }
  return new Response(null, { headers: corsHeaders })
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }
  try {

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) {
    return auth.response
  }

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  const usageId = url.searchParams.get('usage_id') ?? url.searchParams.get('usageId') ?? ''
  const variantParam = url.searchParams.get('variant') ?? ''
  if (!id) {
    return jsonResponse({ error: 'id is required.' }, 400, corsHeaders)
  }
  if (!usageId) {
    return jsonResponse({ error: 'usage_id is required.' }, 400, corsHeaders)
  }
  if (!env.RUNPOD_API_KEY) {
    return jsonResponse({ error: 'RUNPOD_API_KEY is not set.' }, 500, corsHeaders)
  }

  const variant = variantParam ? normalizeVariant(variantParam) : inferVariantFromUsageId(usageId)
  const endpoint = resolveEndpoint(env, variant)
  if (!endpoint) {
    return jsonResponse(
      {
        error:
          variant === 'qwen_edit'
            ? 'RUNPOD_QWEN_ENDPOINT_URL is invalid or missing.'
            : 'RUNPOD_ZIMAGE_ENDPOINT_URL is invalid or missing.',
      },
      500,
      corsHeaders,
    )
  }
  let upstream: Response
  try {
    upstream = await fetch(`${endpoint}/status/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` },
    })
  } catch (error) {
    return jsonResponse(
      {
        error: 'RunPod status request failed.',
        detail: error instanceof Error ? error.message : 'unknown_error',
      },
      502,
      corsHeaders,
    )
  }
  const raw = await upstream.text()
  let payload: any = null
  let ticketsLeft: number | null = null
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = null
  }

  if (payload && (isFailureStatus(payload) || hasOutputError(payload))) {
    const ticketMeta = {
      job_id: id,
      status: payload?.status ?? payload?.state ?? null,
      source: 'status',
      reason: 'failure',
    }
    const refundResult = await refundTicket(auth.admin, auth.user, ticketMeta, usageId, corsHeaders)
    const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const status = normalizeGenerationStatus(payload?.status ?? payload?.state, upstream.ok ? 'running' : 'error')
    const payloadError =
      payload?.error ||
      payload?.output?.error ||
      payload?.result?.error ||
      payload?.output?.output?.error ||
      payload?.result?.output?.error
    const isFailure = isFailureStatus(payload) || Boolean(payloadError) || !upstream.ok
    let firstR2Key: string | null = null

    if (variant === 'qwen_edit' && isCompletedStatus(status)) {
      const persisted = await persistImagesToR2(payload, env, auth.user.id, usageId)
      firstR2Key = persisted.firstKey
    }

    if (variant === 'qwen_edit') {
      await safeUpdateGenerationRecord(auth.admin, usageId, {
        runpod_job_id: String(extractRunpodJobId(payload) ?? id),
        status: isFailure ? 'error' : status,
        error_message: isFailure ? String(payloadError ?? `upstream_${upstream.status}`) : isCompletedStatus(status) ? null : undefined,
        ...(firstR2Key ? { r2_key: firstR2Key } : {}),
      })
    }

    if (ticketsLeft !== null) {
      payload.ticketsLeft = ticketsLeft
    }
    payload.usage_id = usageId
    return jsonResponse(payload, upstream.status, corsHeaders)
  }

  return new Response(raw, {
    status: upstream.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
  } catch (error) {
    return jsonResponse(
      {
        error: 'Unexpected error in qwen status.',
        detail: error instanceof Error ? error.message : 'unknown_error',
      },
      500,
      corsHeaders,
    )
  }
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }
  try {

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) {
    return auth.response
  }

  if (!env.RUNPOD_API_KEY) {
    return jsonResponse({ error: 'RUNPOD_API_KEY is not set.' }, 500, corsHeaders)
  }

  const payload = await request.json().catch(() => null)
  if (!payload) {
    return jsonResponse({ error: 'Invalid request body.' }, 400, corsHeaders)
  }

  const input = payload.input ?? payload
  const safeInput = typeof input === 'object' && input ? (input as Record<string, unknown>) : {}
  const variant = normalizeVariant(
    safeInput.variant ?? safeInput.engine ?? safeInput.model ?? safeInput.workflow_variant,
  )

  const endpoint = resolveEndpoint(env, variant)
  if (!endpoint) {
    return jsonResponse(
      {
        error:
          variant === 'qwen_edit'
            ? 'RUNPOD_QWEN_ENDPOINT_URL is invalid or missing.'
            : 'RUNPOD_ZIMAGE_ENDPOINT_URL is invalid or missing.',
      },
      500,
      corsHeaders,
    )
  }
  let imageBase64 = ''
  let subImageBase64Raw = ''
  try {
    imageBase64 = await resolveImageBase64(
      safeInput,
      ['image_base64', 'image', 'image_base64_1', 'image1'],
      ['image_url'],
      'image',
    )
    subImageBase64Raw = await resolveImageBase64(
      safeInput,
      ['sub_image_base64', 'sub_image', 'image2', 'image2_base64', 'image_base64_2'],
      ['sub_image_url', 'image2_url', 'image_url_2'],
      'sub_image',
    )
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Failed to read image.' }, 400, corsHeaders)
  }

  const subImageBase64 = subImageBase64Raw || imageBase64

  try {
    if (imageBase64 && (await isUnderageImage(imageBase64, env))) {
      return jsonResponse({ error: UNDERAGE_BLOCK_MESSAGE }, 400, corsHeaders)
    }
    if (
      subImageBase64Raw &&
      subImageBase64 &&
      subImageBase64 !== imageBase64 &&
      (await isUnderageImage(subImageBase64, env))
    ) {
      return jsonResponse({ error: UNDERAGE_BLOCK_MESSAGE }, 400, corsHeaders)
    }
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : 'Age verification failed.' },
      500,
      corsHeaders,
    )
  }

  const prompt = String(input?.prompt ?? input?.text ?? '')
  const negativePrompt = String(input?.negative_prompt ?? input?.negative ?? '')
  const sourceUsageId =
    variant === 'qwen_edit'
      ? String(safeInput.source_usage_id ?? safeInput.sourceUsageId ?? '').trim()
      : ''
  const steps = FIXED_STEPS
  const guidanceScale = Number(input?.guidance_scale ?? input?.cfg ?? 1)
  const width = Math.floor(Number(input?.width ?? 768))
  const height = Math.floor(Number(input?.height ?? 768))
  const angleStrengthInput = input?.angle_strength ?? input?.multiangle_strength ?? undefined
  const angleStrength =
    angleStrengthInput === undefined || angleStrengthInput === null ? 0 : Number(angleStrengthInput)
  const workerMode = String(input?.worker_mode ?? input?.mode ?? env.RUNPOD_WORKER_MODE ?? '').toLowerCase()
  const useComfyUi = workerMode === 'comfyui'

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return jsonResponse({ error: 'Prompt is too long.' }, 400, corsHeaders)
  }
  if (negativePrompt.length > MAX_NEGATIVE_PROMPT_LENGTH) {
    return jsonResponse({ error: 'Negative prompt is too long.' }, 400, corsHeaders)
  }
  if (!Number.isFinite(guidanceScale) || guidanceScale < MIN_GUIDANCE || guidanceScale > MAX_GUIDANCE) {
    return jsonResponse(
      { error: `guidance_scale must be between ${MIN_GUIDANCE} and ${MAX_GUIDANCE}.` },
      400,
      corsHeaders,
    )
  }
  if (!Number.isFinite(width) || width < MIN_DIMENSION || width > MAX_DIMENSION) {
    return jsonResponse(
      { error: `width must be between ${MIN_DIMENSION} and ${MAX_DIMENSION}.` },
      400,
      corsHeaders,
    )
  }
  if (!Number.isFinite(height) || height < MIN_DIMENSION || height > MAX_DIMENSION) {
    return jsonResponse(
      { error: `height must be between ${MIN_DIMENSION} and ${MAX_DIMENSION}.` },
      400,
      corsHeaders,
    )
  }
  if (!Number.isFinite(angleStrength) || angleStrength < MIN_ANGLE_STRENGTH || angleStrength > MAX_ANGLE_STRENGTH) {
    return jsonResponse(
      { error: `angle_strength must be between ${MIN_ANGLE_STRENGTH} and ${MAX_ANGLE_STRENGTH}.` },
      400,
      corsHeaders,
    )
  }

  if (safeInput?.workflow) {
    return jsonResponse({ error: 'workflow overrides are not allowed.' }, 400, corsHeaders)
  }

  const ticketMeta = {
    prompt_length: prompt.length,
    width,
    height,
    steps,
    mode: useComfyUi ? 'comfyui' : 'runpod',
    ...(sourceUsageId ? { source_usage_id: sourceUsageId } : {}),
  }
  const ticketCheck = await ensureTicketAvailable(auth.admin, auth.user, corsHeaders)
  if ('response' in ticketCheck) {
    return ticketCheck.response
  }

  let generationSummary: GenerationSummary | null = null
  if (variant === 'qwen_edit') {
    const sourceGeneration = await resolveSourceGeneration(auth.admin, auth.user, sourceUsageId)
    const seedValue = Math.floor(Number(input?.seed ?? 0))
    const fallbackCfg = Number.isFinite(guidanceScale) ? Math.max(1, Math.min(5, guidanceScale)) : 1
    const sourcePrompt = typeof sourceGeneration?.prompt === 'string' ? sourceGeneration.prompt.trim() : ''
    const sourceNegative = typeof sourceGeneration?.negative_prompt === 'string' ? sourceGeneration.negative_prompt : ''
    const sourceSampler = typeof sourceGeneration?.sampler_name === 'string' ? sourceGeneration.sampler_name.trim() : ''
    const sourceScheduler = typeof sourceGeneration?.scheduler === 'string' ? sourceGeneration.scheduler.trim() : ''
    const sourceWidth = Number(sourceGeneration?.width)
    const sourceHeight = Number(sourceGeneration?.height)
    const sourceSteps = Number(sourceGeneration?.steps)
    const sourceCfg = Number(sourceGeneration?.cfg)
    const sourceSeed = Number(sourceGeneration?.seed)
    const sourceDenoise = Number(sourceGeneration?.denoise)
    generationSummary = {
      prompt: sourcePrompt || prompt,
      negative_prompt: sourceNegative || negativePrompt,
      width: Number.isFinite(sourceWidth) ? sourceWidth : width,
      height: Number.isFinite(sourceHeight) ? sourceHeight : height,
      steps: Number.isFinite(sourceSteps) && sourceSteps > 0 ? Math.floor(sourceSteps) : Math.max(20, steps),
      cfg: Number.isFinite(sourceCfg) ? sourceCfg : fallbackCfg,
      seed: Number.isFinite(sourceSeed)
        ? Math.max(0, Math.min(2147483647, Math.floor(sourceSeed)))
        : Number.isFinite(seedValue)
        ? Math.max(0, Math.min(2147483647, seedValue))
        : 0,
      randomize_seed:
        typeof sourceGeneration?.randomize_seed === 'boolean'
          ? sourceGeneration.randomize_seed
          : Boolean(input?.randomize_seed ?? true),
      sampler_name: sourceSampler || 'er_sde',
      scheduler: sourceScheduler || 'simple',
      denoise: Number.isFinite(sourceDenoise) ? Math.max(0, Math.min(1, sourceDenoise)) : 1,
    }
  }

  let workflow: Record<string, unknown> | null = null
  let nodeMap: NodeMap | null = null
  if (useComfyUi) {
    workflow = clone(getWorkflowTemplate(variant))
    if (!workflow || Object.keys(workflow).length === 0) {
      return jsonResponse({ error: 'workflow.json is empty. Export a ComfyUI API workflow.' }, 500, corsHeaders)
    }
    nodeMap = getNodeMap(variant)
    const hasNodeMap = nodeMap && Object.keys(nodeMap).length > 0
    if (!hasNodeMap) {
      return jsonResponse({ error: 'node_map.json is empty.' }, 500, corsHeaders)
    }
  }

  const usageId = `${variant}:${makeUsageId()}`
  let ticketsLeft: number | null = null
  const ticketMetaWithUsage = {
    ...ticketMeta,
    usage_id: usageId,
    source: 'run',
  }
  const ticketCharge = await consumeTicket(auth.admin, auth.user, ticketMetaWithUsage, usageId, corsHeaders)
  if ('response' in ticketCharge) {
    return ticketCharge.response
  }
  const consumedTickets = Number((ticketCharge as { ticketsLeft?: unknown }).ticketsLeft)
  if (Number.isFinite(consumedTickets)) {
    ticketsLeft = consumedTickets
  }
  if (variant === 'qwen_edit' && generationSummary) {
    await safeInsertGenerationRecord(auth.admin, auth.user, usageId, generationSummary)
  }

  if (useComfyUi) {
    const seed = input?.randomize_seed
      ? Math.floor(Math.random() * 2147483647)
      : Number(input?.seed ?? 0)
    const hasPrimaryImageNode = Boolean((nodeMap as NodeMap)?.image)
    const hasSecondaryImageNode = Boolean((nodeMap as NodeMap)?.image2)
    if (hasPrimaryImageNode && !imageBase64) {
      return jsonResponse({ error: 'Image is required for this workflow.' }, 400, corsHeaders)
    }
    const secondaryImageBase64 = subImageBase64Raw || imageBase64
    if (hasSecondaryImageNode && !secondaryImageBase64) {
      return jsonResponse({ error: 'Second image is required for this workflow.' }, 400, corsHeaders)
    }

    const imageName = String(safeInput?.image_name ?? 'input.png')
    let subImageName = String(safeInput?.sub_image_name ?? safeInput?.image2_name ?? 'sub.png')
    if (!subImageBase64Raw && imageBase64) {
      subImageName = imageName
    } else if (subImageName === imageName) {
      subImageName = 'sub.png'
    }

    const nodeValues: Record<string, unknown> = {
      prompt,
      negative_prompt: negativePrompt,
      seed,
      steps,
      cfg: guidanceScale,
      width,
      height,
      angle_strength: angleStrength,
    }
    if (hasPrimaryImageNode) {
      nodeValues.image = imageName
    }
    if (hasSecondaryImageNode) {
      nodeValues.image2 = subImageName
    }
    try {
      applyNodeMap(workflow as Record<string, any>, nodeMap as NodeMap, nodeValues)
    } catch (error) {
      const refundResult = await refundTicket(
        auth.admin,
        auth.user,
        { ...ticketMetaWithUsage, reason: 'workflow_apply_failed' },
        usageId,
        corsHeaders,
      )
      const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
      if (Number.isFinite(nextTickets)) {
        ticketsLeft = nextTickets
      }
      if (variant === 'qwen_edit') {
        await safeUpdateGenerationRecord(auth.admin, usageId, {
          status: 'error',
          error_message: error instanceof Error ? error.message : 'workflow_apply_failed',
        })
      }
      return jsonResponse(
        {
          error: 'Workflow node mapping failed.',
          detail: error instanceof Error ? error.message : 'unknown_error',
          usage_id: usageId,
          ticketsLeft,
        },
        400,
        corsHeaders,
      )
    }

    const comfyKey = String(env.COMFY_ORG_API_KEY ?? '')
    const images: Array<{ name: string; image: string }> = []
    if (hasPrimaryImageNode && imageBase64) {
      images.push({ name: imageName, image: imageBase64 })
    }
    if (hasSecondaryImageNode && secondaryImageBase64) {
      const shouldUseSecondaryName = subImageName !== imageName || !hasPrimaryImageNode
      images.push({
        name: shouldUseSecondaryName ? subImageName : imageName,
        image: secondaryImageBase64,
      })
    }
    const runpodInput: Record<string, unknown> = { workflow }
    if (images.length > 0) {
      runpodInput.images = images
    }
    if (comfyKey) {
      runpodInput.comfy_org_api_key = comfyKey
    }

    let upstream: Response
    try {
      upstream = await fetch(`${endpoint}/run`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input: runpodInput }),
      })
    } catch (error) {
      const refundResult = await refundTicket(
        auth.admin,
        auth.user,
        { ...ticketMetaWithUsage, reason: 'network_error' },
        usageId,
        corsHeaders,
      )
      const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
      if (Number.isFinite(nextTickets)) {
        ticketsLeft = nextTickets
      }
      if (variant === 'qwen_edit') {
        await safeUpdateGenerationRecord(auth.admin, usageId, {
          status: 'error',
          error_message: error instanceof Error ? error.message : 'network_error',
        })
      }
      return jsonResponse(
        {
          error: 'RunPod request failed.',
          detail: error instanceof Error ? error.message : 'unknown_error',
          usage_id: usageId,
          ticketsLeft,
        },
        502,
        corsHeaders,
      )
    }
    const raw = await upstream.text()
    let upstreamPayload: any = null
    try {
      upstreamPayload = JSON.parse(raw)
    } catch {
      upstreamPayload = null
    }

    if (!upstreamPayload || typeof upstreamPayload !== 'object' || Array.isArray(upstreamPayload)) {
      const refundResult = await refundTicket(
        auth.admin,
        auth.user,
        { ...ticketMetaWithUsage, reason: 'parse_error' },
        usageId,
        corsHeaders,
      )
      const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
      if (Number.isFinite(nextTickets)) {
        ticketsLeft = nextTickets
      }
      if (variant === 'qwen_edit') {
        await safeUpdateGenerationRecord(auth.admin, usageId, {
          status: 'error',
          error_message: 'upstream_parse_error',
        })
      }
      return jsonResponse({ error: 'Upstream response is invalid.', usage_id: usageId, ticketsLeft }, 502, corsHeaders)
    }

    const upstreamStatus = normalizeGenerationStatus(
      upstreamPayload?.status ?? upstreamPayload?.state,
      upstream.ok ? 'queued' : 'error',
    )
    const runpodJobId = extractRunpodJobId(upstreamPayload)
    const payloadError =
      upstreamPayload?.error ||
      upstreamPayload?.output?.error ||
      upstreamPayload?.result?.error ||
      upstreamPayload?.output?.output?.error ||
      upstreamPayload?.result?.output?.error
    const isFailure = !upstream.ok || isFailureStatus(upstreamPayload) || hasOutputError(upstreamPayload)
    if (isFailure) {
      const refundResult = await refundTicket(
        auth.admin,
        auth.user,
        { ...ticketMetaWithUsage, reason: 'failure', status: upstreamPayload?.status ?? upstreamPayload?.state ?? null },
        usageId,
        corsHeaders,
      )
      const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
      if (Number.isFinite(nextTickets)) {
        ticketsLeft = nextTickets
      }
    }

    let firstR2Key: string | null = null
    if (variant === 'qwen_edit' && isCompletedStatus(upstreamStatus)) {
      const persisted = await persistImagesToR2(upstreamPayload, env, auth.user.id, usageId)
      firstR2Key = persisted.firstKey
    }
    if (variant === 'qwen_edit') {
      await safeUpdateGenerationRecord(auth.admin, usageId, {
        runpod_job_id: runpodJobId ? String(runpodJobId) : undefined,
        status: isFailure ? 'error' : upstreamStatus,
        error_message: isFailure ? String(payloadError ?? `upstream_${upstream.status}`) : isCompletedStatus(upstreamStatus) ? null : undefined,
        ...(firstR2Key ? { r2_key: firstR2Key } : {}),
      })
    }

    upstreamPayload.usage_id = usageId
    if (ticketsLeft !== null) {
      upstreamPayload.ticketsLeft = ticketsLeft
    }
    return jsonResponse(upstreamPayload, upstream.status, corsHeaders)
  }

  const runpodInput = {
    image_base64: imageBase64,
    prompt,
    guidance_scale: guidanceScale,
    num_inference_steps: steps,
    width,
    height,
    seed: Number(input?.seed ?? 0),
    randomize_seed: Boolean(input?.randomize_seed ?? false),
  } as Record<string, unknown>

  if (subImageBase64Raw) {
    runpodInput.sub_image_base64 = subImageBase64Raw
  }

  const views = Array.isArray(input?.views) ? input.views : Array.isArray(input?.angles) ? input.angles : null
  if (views) {
    runpodInput.views = views
    runpodInput.angles = views
  } else {
    runpodInput.azimuth = input?.azimuth
    runpodInput.elevation = input?.elevation
    runpodInput.distance = input?.distance
  }

  let upstream: Response
  try {
    upstream = await fetch(`${endpoint}/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: runpodInput }),
    })
  } catch (error) {
    const refundResult = await refundTicket(
      auth.admin,
      auth.user,
      { ...ticketMetaWithUsage, reason: 'network_error' },
      usageId,
      corsHeaders,
    )
    const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
    if (variant === 'qwen_edit') {
      await safeUpdateGenerationRecord(auth.admin, usageId, {
        status: 'error',
        error_message: error instanceof Error ? error.message : 'network_error',
      })
    }
    return jsonResponse(
      {
        error: 'RunPod request failed.',
        detail: error instanceof Error ? error.message : 'unknown_error',
        usage_id: usageId,
        ticketsLeft,
      },
      502,
      corsHeaders,
    )
  }
  const raw = await upstream.text()
  let upstreamPayload: any = null
  try {
    upstreamPayload = JSON.parse(raw)
  } catch {
    upstreamPayload = null
  }

  if (!upstreamPayload || typeof upstreamPayload !== 'object' || Array.isArray(upstreamPayload)) {
    const refundResult = await refundTicket(
      auth.admin,
      auth.user,
      { ...ticketMetaWithUsage, reason: 'parse_error' },
      usageId,
      corsHeaders,
    )
    const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
    if (variant === 'qwen_edit') {
      await safeUpdateGenerationRecord(auth.admin, usageId, {
        status: 'error',
        error_message: 'upstream_parse_error',
      })
    }
    return jsonResponse({ error: 'Upstream response is invalid.', usage_id: usageId, ticketsLeft }, 502, corsHeaders)
  }

  const upstreamStatus = normalizeGenerationStatus(
    upstreamPayload?.status ?? upstreamPayload?.state,
    upstream.ok ? 'queued' : 'error',
  )
  const runpodJobId = extractRunpodJobId(upstreamPayload)
  const payloadError =
    upstreamPayload?.error ||
    upstreamPayload?.output?.error ||
    upstreamPayload?.result?.error ||
    upstreamPayload?.output?.output?.error ||
    upstreamPayload?.result?.output?.error
  const isFailure = !upstream.ok || isFailureStatus(upstreamPayload) || hasOutputError(upstreamPayload)
  if (isFailure) {
    const refundResult = await refundTicket(
      auth.admin,
      auth.user,
      { ...ticketMetaWithUsage, reason: 'failure', status: upstreamPayload?.status ?? upstreamPayload?.state ?? null },
      usageId,
      corsHeaders,
    )
    const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
  }

  let firstR2Key: string | null = null
  if (variant === 'qwen_edit' && isCompletedStatus(upstreamStatus)) {
    const persisted = await persistImagesToR2(upstreamPayload, env, auth.user.id, usageId)
    firstR2Key = persisted.firstKey
  }
  if (variant === 'qwen_edit') {
    await safeUpdateGenerationRecord(auth.admin, usageId, {
      runpod_job_id: runpodJobId ? String(runpodJobId) : undefined,
      status: isFailure ? 'error' : upstreamStatus,
      error_message: isFailure ? String(payloadError ?? `upstream_${upstream.status}`) : isCompletedStatus(upstreamStatus) ? null : undefined,
      ...(firstR2Key ? { r2_key: firstR2Key } : {}),
    })
  }

  upstreamPayload.usage_id = usageId
  if (ticketsLeft !== null) {
    upstreamPayload.ticketsLeft = ticketsLeft
  }
  return jsonResponse(upstreamPayload, upstream.status, corsHeaders)
  } catch (error) {
    return jsonResponse(
      {
        error: 'Unexpected error in qwen run.',
        detail: error instanceof Error ? error.message : 'unknown_error',
      },
      500,
      corsHeaders,
    )
  }
}


