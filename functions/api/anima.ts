import workflowTemplate from './anima-workflow.json'
import nodeMapTemplate from './anima-node-map.json'
import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'

type Env = {
  RUNPOD_API_KEY: string
  RUNPOD_ANIMA_ENDPOINT_URL?: string
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

// Default to the endpoint you provided so the system works even before secrets are set.
const DEFAULT_ANIMA_ENDPOINT = 'https://api.runpod.ai/v2/r5iv3ydliscz0m'

const resolveEndpoint = (env: Env) =>
  normalizeEndpoint(env.RUNPOD_ANIMA_ENDPOINT_URL) || DEFAULT_ANIMA_ENDPOINT

type NodeMapEntry = {
  id: string
  input: string
}

type NodeMapValue = NodeMapEntry | NodeMapEntry[]

type NodeMap = Partial<{
  prompt: NodeMapValue
  negative_prompt: NodeMapValue
  seed: NodeMapValue
  steps: NodeMapValue
  cfg: NodeMapValue
  width: NodeMapValue
  height: NodeMapValue
}>

const SIGNUP_TICKET_GRANT = 5
const MAX_PROMPT_LENGTH = 400
const MAX_NEGATIVE_PROMPT_LENGTH = 400
const MIN_DIMENSION = 256
const MAX_DIMENSION = 2048
const MIN_CFG = 0
const MAX_CFG = 10
const MIN_STEPS = 1
const MAX_STEPS = 60

const getWorkflowTemplate = async () => workflowTemplate as Record<string, unknown>
const getNodeMap = async () => nodeMapTemplate as NodeMap

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
    return { response: jsonResponse({ error: 'ログインが必要です。' }, 401, corsHeaders) }
  }
  const admin = getSupabaseAdmin(env)
  if (!admin) {
    return {
      response: jsonResponse(
        { error: 'SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が設定されていません。' },
        500,
        corsHeaders,
      ),
    }
  }
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) {
    return { response: jsonResponse({ error: '認証に失敗しました。' }, 401, corsHeaders) }
  }
  if (!isGoogleUser(data.user)) {
    return { response: jsonResponse({ error: 'Googleログインのみ対応しています。' }, 403, corsHeaders) }
  }
  return { admin, user: data.user }
}

const makeUsageId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

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
  if (!email) return { response: jsonResponse({ error: 'Email is required.' }, 400, corsHeaders) }

  const { data: existing, error } = await ensureTicketRow(admin, user)
  if (error) return { response: jsonResponse({ error: error.message }, 500, corsHeaders) }
  if (!existing) return { response: jsonResponse({ error: 'No ticket remaining.' }, 402, corsHeaders) }

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
  usageId: string,
  corsHeaders: HeadersInit,
) => {
  const email = user.email
  if (!email) return { response: jsonResponse({ error: 'Email is required.' }, 400, corsHeaders) }

  const { data: existing, error } = await ensureTicketRow(admin, user)
  if (error) return { response: jsonResponse({ error: error.message }, 500, corsHeaders) }
  if (!existing) return { response: jsonResponse({ error: 'No ticket remaining.' }, 402, corsHeaders) }

  const { data: rpcData, error: rpcError } = await admin.rpc('consume_tickets', {
    p_ticket_id: existing.id,
    p_usage_id: usageId,
    p_cost: 1,
    p_reason: 'generate',
    p_metadata: metadata,
  })

  if (rpcError) {
    const message = rpcError.message ?? 'Ticket consumption failed.'
    if (message.includes('INSUFFICIENT_TICKETS')) {
      return { response: jsonResponse({ error: 'No ticket remaining.' }, 402, corsHeaders) }
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
  usageId: string,
  corsHeaders: HeadersInit,
) => {
  const email = user.email
  if (!email) return { skipped: true }

  const refundUsageId = `${usageId}:refund`
  const { data: existingRefund } = await admin
    .from('ticket_events')
    .select('usage_id')
    .eq('usage_id', refundUsageId)
    .maybeSingle()

  if (existingRefund) return { alreadyRefunded: true }

  const { data: existing, error } = await ensureTicketRow(admin, user)
  if (error) return { response: jsonResponse({ error: error.message }, 500, corsHeaders) }
  if (!existing) return { response: jsonResponse({ error: 'No ticket row.' }, 500, corsHeaders) }

  const { data: rpcData, error: rpcError } = await admin.rpc('refund_tickets', {
    p_ticket_id: existing.id,
    p_usage_id: refundUsageId,
    p_amount: 1,
    p_reason: 'refund',
    p_metadata: metadata,
  })

  if (rpcError) return { response: jsonResponse({ error: rpcError.message }, 500, corsHeaders) }
  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const ticketsLeft = Number(result?.tickets_left)
  return { ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined }
}

const setInputValue = (workflow: Record<string, any>, entry: NodeMapEntry, value: unknown) => {
  const node = workflow[entry.id]
  if (!node?.inputs) throw new Error(`Node ${entry.id} not found in workflow.`)
  node.inputs[entry.input] = value
}

const applyNodeMap = (workflow: Record<string, any>, nodeMap: NodeMap, values: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(values)) {
    const entry = nodeMap[key as keyof NodeMap]
    if (!entry) continue
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

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) return auth.response

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  const usageId = url.searchParams.get('usage_id') ?? url.searchParams.get('usageId') ?? ''
  if (!id) return jsonResponse({ error: 'id is required.' }, 400, corsHeaders)
  if (!usageId) return jsonResponse({ error: 'usage_id is required.' }, 400, corsHeaders)
  if (!env.RUNPOD_API_KEY) return jsonResponse({ error: 'RUNPOD_API_KEY is not set.' }, 500, corsHeaders)

  const endpoint = resolveEndpoint(env)
  let upstream: Response
  try {
    upstream = await fetch(`${endpoint}/status/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` },
    })
  } catch (error) {
    return jsonResponse(
      { error: 'RunPod status request failed.', detail: error instanceof Error ? error.message : 'unknown_error' },
      502,
      corsHeaders,
    )
  }

  const raw = await upstream.text()
  let payload: any = null
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = null
  }

  // Refund on clear failure signals.
  if (payload && typeof payload === 'object') {
    const status = String(payload?.status ?? payload?.state ?? '').toLowerCase()
    const isFailure = status.includes('fail') || status.includes('error') || status.includes('cancel')
    const hasError = Boolean(payload?.error || payload?.output?.error || payload?.result?.error)
    if (isFailure || hasError) {
      await refundTicket(auth.admin, auth.user, { job_id: id, status, source: 'status' }, usageId, corsHeaders)
    }
  }

  return new Response(raw, {
    status: upstream.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) return auth.response

  if (!env.RUNPOD_API_KEY) return jsonResponse({ error: 'RUNPOD_API_KEY is not set.' }, 500, corsHeaders)
  const endpoint = resolveEndpoint(env)

  const payload = await request.json().catch(() => null)
  if (!payload) return jsonResponse({ error: 'Invalid request body.' }, 400, corsHeaders)

  const input = payload.input ?? payload
  const prompt = String(input?.prompt ?? input?.text ?? '')
  const negativePrompt = String(input?.negative_prompt ?? input?.negative ?? '')
  const steps = Math.floor(Number(input?.steps ?? input?.num_inference_steps ?? 35))
  const cfg = Number(input?.cfg ?? input?.guidance_scale ?? 4.5)
  const width = Math.floor(Number(input?.width ?? 1024))
  const height = Math.floor(Number(input?.height ?? 1024))
  const seed = input?.randomize_seed ? Math.floor(Math.random() * 2147483647) : Number(input?.seed ?? 0)

  if (prompt.length > MAX_PROMPT_LENGTH) return jsonResponse({ error: 'プロンプトが長すぎます。' }, 400, corsHeaders)
  if (negativePrompt.length > MAX_NEGATIVE_PROMPT_LENGTH) {
    return jsonResponse({ error: 'ネガティブプロンプトが長すぎます。' }, 400, corsHeaders)
  }
  if (!Number.isFinite(width) || width < MIN_DIMENSION || width > MAX_DIMENSION) {
    return jsonResponse({ error: `width must be between ${MIN_DIMENSION} and ${MAX_DIMENSION}.` }, 400, corsHeaders)
  }
  if (!Number.isFinite(height) || height < MIN_DIMENSION || height > MAX_DIMENSION) {
    return jsonResponse({ error: `height must be between ${MIN_DIMENSION} and ${MAX_DIMENSION}.` }, 400, corsHeaders)
  }
  if (!Number.isFinite(cfg) || cfg < MIN_CFG || cfg > MAX_CFG) {
    return jsonResponse({ error: `cfg must be between ${MIN_CFG} and ${MAX_CFG}.` }, 400, corsHeaders)
  }
  if (!Number.isFinite(steps) || steps < MIN_STEPS || steps > MAX_STEPS) {
    return jsonResponse({ error: `steps must be between ${MIN_STEPS} and ${MAX_STEPS}.` }, 400, corsHeaders)
  }

  const ticketCheck = await ensureTicketAvailable(auth.admin, auth.user, corsHeaders)
  if ('response' in ticketCheck) return ticketCheck.response

  const usageId = `anima:${makeUsageId()}`
  const ticketCharge = await consumeTicket(
    auth.admin,
    auth.user,
    { usage_id: usageId, width, height, steps, cfg, prompt_length: prompt.length, source: 'run' },
    usageId,
    corsHeaders,
  )
  if ('response' in ticketCharge) return ticketCharge.response

  const workflow = clone(await getWorkflowTemplate())
  const nodeMap = await getNodeMap()
  try {
    applyNodeMap(workflow as Record<string, any>, nodeMap, {
      prompt,
      negative_prompt: negativePrompt,
      seed,
      steps,
      cfg,
      width,
      height,
    })
  } catch (error) {
    await refundTicket(
      auth.admin,
      auth.user,
      { usage_id: usageId, reason: 'workflow_apply_failed' },
      usageId,
      corsHeaders,
    )
    return jsonResponse(
      { error: 'Workflow node mapping failed.', detail: error instanceof Error ? error.message : 'unknown_error' },
      400,
      corsHeaders,
    )
  }

  let upstream: Response
  try {
    upstream = await fetch(`${endpoint}/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: { workflow } }),
    })
  } catch (error) {
    await refundTicket(auth.admin, auth.user, { usage_id: usageId, reason: 'network_error' }, usageId, corsHeaders)
    return jsonResponse(
      { error: 'RunPod request failed.', detail: error instanceof Error ? error.message : 'unknown_error' },
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

  const isFailure = !upstream.ok || Boolean(upstreamPayload?.error || upstreamPayload?.output?.error || upstreamPayload?.result?.error)
  if (isFailure) {
    await refundTicket(
      auth.admin,
      auth.user,
      { usage_id: usageId, reason: 'failure', status: upstreamPayload?.status ?? upstreamPayload?.state ?? null },
      usageId,
      corsHeaders,
    )
  }

  const ticketsLeft = Number((ticketCharge as { ticketsLeft?: unknown }).ticketsLeft)

  // Always include usage_id so the frontend can poll status reliably.
  if (upstreamPayload && typeof upstreamPayload === 'object') {
    const payloadWithMeta = {
      ...upstreamPayload,
      usage_id: usageId,
      ...(Number.isFinite(ticketsLeft) ? { ticketsLeft } : {}),
    }
    return jsonResponse(payloadWithMeta, upstream.status, corsHeaders)
  }

  // Upstream returned a non-JSON body; return a minimal JSON wrapper.
  return jsonResponse(
    {
      status: upstream.status,
      usage_id: usageId,
      ...(Number.isFinite(ticketsLeft) ? { ticketsLeft } : {}),
      error: upstream.ok ? 'Upstream response was not JSON.' : 'Upstream request failed.',
    },
    upstream.ok ? 502 : upstream.status,
    corsHeaders,
  )
}
