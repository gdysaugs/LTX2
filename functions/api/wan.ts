import workflowTemplate from './wan-workflow.json'
import nodeMapTemplate from './wan-node-map.json'
import { createClient, type User } from '@supabase/supabase-js'

type Env = {
  RUNPOD_API_KEY: string
  RUNPOD_ENDPOINT_URL?: string
  RUNPOD_WAN_ENDPOINT_URL?: string
  COMFY_ORG_API_KEY?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const resolveEndpoint = (env: Env) =>
  (env.RUNPOD_WAN_ENDPOINT_URL ?? env.RUNPOD_ENDPOINT_URL)?.replace(/\/$/, '')

type NodeMapEntry = {
  id: string
  input: string
}

type NodeMapValue = NodeMapEntry | NodeMapEntry[]

type NodeMap = Partial<{
  image: NodeMapValue
  prompt: NodeMapValue
  negative_prompt: NodeMapValue
  seed: NodeMapValue
  steps: NodeMapValue
  cfg: NodeMapValue
  width: NodeMapValue
  height: NodeMapValue
  num_frames: NodeMapValue
  fps: NodeMapValue
  start_step: NodeMapValue
  end_step: NodeMapValue
}>

const SIGNUP_TICKET_GRANT = 3
const VIDEO_TICKET_COST = 2

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

const requireGoogleUser = async (request: Request, env: Env) => {
  const token = extractBearerToken(request)
  if (!token) {
    return { response: jsonResponse({ error: 'Login required.' }, 401) }
  }
  const admin = getSupabaseAdmin(env)
  if (!admin) {
    return { response: jsonResponse({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.' }, 500) }
  }
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) {
    return { response: jsonResponse({ error: 'Authentication failed.' }, 401) }
  }
  if (!isGoogleUser(data.user)) {
    return { response: jsonResponse({ error: 'Google login only.' }, 403) }
  }
  return { admin, user: data.user }
}

const makeUsageId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
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
  requiredTickets = 1,
) => {
  const email = user.email
  if (!email) {
    return { response: jsonResponse({ error: 'Email not available.' }, 400) }
  }

  const { data: existing, error } = await ensureTicketRow(admin, user)

  if (error) {
    return { response: jsonResponse({ error: error.message }, 500) }
  }

  if (!existing) {
    return { response: jsonResponse({ error: 'No tickets available.' }, 402) }
  }

  if (!existing.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  }

  if (existing.tickets < requiredTickets) {
    return { response: jsonResponse({ error: 'No tickets remaining.' }, 402) }
  }

  return { existing }
}

const consumeTicket = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  metadata: Record<string, unknown>,
  usageId?: string,
  ticketCost = 1,
) => {
  const cost = Math.max(1, Math.floor(ticketCost))
  const email = user.email
  if (!email) {
    return { response: jsonResponse({ error: 'Email not available.' }, 400) }
  }

  if (usageId) {
    const { data: existingEvent, error: eventCheckError } = await admin
      .from('ticket_events')
      .select('usage_id')
      .eq('usage_id', usageId)
      .maybeSingle()

    if (eventCheckError) {
      return { response: jsonResponse({ error: eventCheckError.message }, 500) }
    }

    if (existingEvent) {
      return { alreadyConsumed: true }
    }
  }

  const { data: existing, error } = await fetchTicketRow(admin, user)

  if (error) {
    return { response: jsonResponse({ error: error.message }, 500) }
  }

  if (!existing) {
    return { response: jsonResponse({ error: 'No tickets available.' }, 402) }
  }

  if (!existing.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  }

  if (existing.tickets < cost) {
    return { response: jsonResponse({ error: 'No tickets remaining.' }, 402) }
  }

  const { data: updated, error: updateError } = await admin
    .from('user_tickets')
    .update({ tickets: existing.tickets - cost, updated_at: new Date().toISOString() })
    .eq('id', existing.id)
    .select('tickets')
    .maybeSingle()

  if (updateError || !updated) {
    return { response: jsonResponse({ error: 'Failed to update tickets.' }, 409) }
  }

  const resolvedUsageId = usageId ?? makeUsageId()
  const { error: eventError } = await admin.from('ticket_events').insert({
    usage_id: resolvedUsageId,
    email: existing.email,
    user_id: user.id,
    delta: -cost,
    reason: 'generate_video',
    metadata,
  })

  if (eventError) {
    return { response: jsonResponse({ error: eventError.message }, 500) }
  }

  return { ticketsLeft: updated.tickets }
}

const refundTicket = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  metadata: Record<string, unknown>,
  usageId?: string,
  ticketCost = 1,
) => {
  const refundAmount = Math.max(1, Math.floor(ticketCost))
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
    return { response: jsonResponse({ error: chargeError.message }, 500) }
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
    return { response: jsonResponse({ error: refundCheckError.message }, 500) }
  }

  if (existingRefund) {
    return { alreadyRefunded: true }
  }

  const { data: existing, error } = await ensureTicketRow(admin, user)

  if (error) {
    return { response: jsonResponse({ error: error.message }, 500) }
  }

  if (!existing) {
    return { response: jsonResponse({ error: 'No tickets available.' }, 402) }
  }

  if (!existing.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  }

  const { data: updated, error: updateError } = await admin
    .from('user_tickets')
    .update({ tickets: existing.tickets + refundAmount, updated_at: new Date().toISOString() })
    .eq('id', existing.id)
    .select('tickets')
    .maybeSingle()

  if (updateError || !updated) {
    return { response: jsonResponse({ error: 'Failed to refund tickets.' }, 409) }
  }

  const { error: eventError } = await admin.from('ticket_events').insert({
    usage_id: refundUsageId,
    email: existing.email,
    user_id: user.id,
    delta: refundAmount,
    reason: 'refund',
    metadata,
  })

  if (eventError) {
    return { response: jsonResponse({ error: eventError.message }, 500) }
  }

  return { ticketsLeft: updated.tickets }
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

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

const fetchImageBase64 = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error('Failed to fetch image_url.')
  }
  const buffer = await res.arrayBuffer()
  return arrayBufferToBase64(buffer)
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

export const onRequestOptions: PagesFunction = async () => new Response(null, { headers: corsHeaders })

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireGoogleUser(request, env)
  if ('response' in auth) {
    return auth.response
  }

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  if (!id) {
    return jsonResponse({ error: 'id is required.' }, 400)
  }
  if (!env.RUNPOD_API_KEY) {
    return jsonResponse({ error: 'RUNPOD_API_KEY is not set.' }, 500)
  }

  const endpoint = resolveEndpoint(env)
  if (!endpoint) {
    return jsonResponse({ error: 'RUNPOD_WAN_ENDPOINT_URL is not set.' }, 500)
  }
  const upstream = await fetch(`${endpoint}/status/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` },
  })
  const raw = await upstream.text()
  let payload: any = null
  let ticketsLeft: number | null = null
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = null
  }

  if (payload && shouldConsumeTicket(payload)) {
    const usageId = `wan:${id}`
    const ticketMeta = {
      job_id: id,
      status: payload?.status ?? payload?.state ?? null,
      source: 'status',
      ticket_cost: VIDEO_TICKET_COST,
    }
    const result = await consumeTicket(auth.admin, auth.user, ticketMeta, usageId, VIDEO_TICKET_COST)
    const nextTickets = Number((result as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
  }

  if (payload && (isFailureStatus(payload) || hasOutputError(payload))) {
    const usageId = `wan:${id}`
    const refundMeta = {
      job_id: id,
      status: payload?.status ?? payload?.state ?? null,
      source: 'status',
      reason: 'failure',
      ticket_cost: VIDEO_TICKET_COST,
    }
    const refundResult = await refundTicket(auth.admin, auth.user, refundMeta, usageId, VIDEO_TICKET_COST)
    const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
  }

  if (ticketsLeft !== null && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    payload.ticketsLeft = ticketsLeft
    return jsonResponse(payload, upstream.status)
  }

  return new Response(raw, {
    status: upstream.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireGoogleUser(request, env)
  if ('response' in auth) {
    return auth.response
  }

  if (!env.RUNPOD_API_KEY) {
    return jsonResponse({ error: 'RUNPOD_API_KEY is not set.' }, 500)
  }

  const endpoint = resolveEndpoint(env)
  if (!endpoint) {
    return jsonResponse({ error: 'RUNPOD_WAN_ENDPOINT_URL is not set.' }, 500)
  }

  const payload = await request.json().catch(() => null)
  if (!payload) {
    return jsonResponse({ error: 'Invalid request body.' }, 400)
  }

  const input = payload.input ?? payload
  const imageValue = input?.image_base64 ?? input?.image ?? input?.image_url
  if (!imageValue) {
    return jsonResponse({ error: 'image is required.' }, 400)
  }

  let imageBase64 = ''
  try {
    imageBase64 =
      typeof input?.image_url === 'string' && input.image_url
        ? await fetchImageBase64(input.image_url)
        : stripDataUrl(String(imageValue))
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Failed to read image.' }, 400)
  }

  if (!imageBase64) {
    return jsonResponse({ error: 'image is empty.' }, 400)
  }

  const prompt = String(input?.prompt ?? input?.text ?? '')
  const negativePrompt = String(input?.negative_prompt ?? input?.negative ?? '')
  const steps = Number(input?.steps ?? input?.num_inference_steps ?? 4)
  const cfg = Number(input?.cfg ?? input?.guidance_scale ?? 5)
  const width = Number(input?.width ?? 832)
  const height = Number(input?.height ?? 576)
  const fps = Number(input?.fps ?? 24)
  const seconds = Number(input?.seconds ?? input?.duration ?? 5)
  const requestedFrames = Number(input?.num_frames ?? input?.frames)
  const numFrames =
    Number.isFinite(requestedFrames) && requestedFrames > 0
      ? Math.floor(requestedFrames)
      : Math.max(1, Math.round(fps * seconds))
  const seed = input?.randomize_seed
    ? Math.floor(Math.random() * 2147483647)
    : Number(input?.seed ?? 0)

  const totalSteps = Math.max(1, Math.floor(steps))
  const splitStep = Math.max(1, Math.floor(totalSteps / 2))

  const ticketMeta = {
    prompt_length: prompt.length,
    width,
    height,
    frames: numFrames,
    fps,
    steps: totalSteps,
    mode: 'comfyui',
    ticket_cost: VIDEO_TICKET_COST,
  }
  const ticketCheck = await ensureTicketAvailable(auth.admin, auth.user, VIDEO_TICKET_COST)
  if ('response' in ticketCheck) {
    return ticketCheck.response
  }

  const imageName = String(input?.image_name ?? 'input.png')
  const workflow = input?.workflow ? clone(input.workflow) : clone(await getWorkflowTemplate())
  if (!workflow || Object.keys(workflow).length === 0) {
    return jsonResponse({ error: 'wan-workflow.json is empty. Export a ComfyUI API workflow.' }, 500)
  }

  const nodeMap = await getNodeMap().catch(() => null)
  const hasNodeMap = nodeMap && Object.keys(nodeMap).length > 0
  const shouldApplyNodeMap = input?.apply_node_map !== false

  if (shouldApplyNodeMap && hasNodeMap) {
    const nodeValues: Record<string, unknown> = {
      image: imageName,
      prompt,
      negative_prompt: negativePrompt,
      seed,
      steps: totalSteps,
      cfg,
      width,
      height,
      num_frames: numFrames,
      fps,
      end_step: splitStep,
      start_step: splitStep,
    }
    applyNodeMap(workflow as Record<string, any>, nodeMap, nodeValues)
  } else if (!input?.workflow) {
    return jsonResponse({ error: 'wan-node-map.json is empty. Provide a node map or send workflow directly.' }, 500)
  }

  const comfyKey = String(input?.comfy_org_api_key ?? env.COMFY_ORG_API_KEY ?? '')
  const images = [{ name: imageName, image: imageBase64 }]
  const runpodInput: Record<string, unknown> = {
    workflow,
    images,
  }
  if (comfyKey) {
    runpodInput.comfy_org_api_key = comfyKey
  }

  const upstream = await fetch(`${endpoint}/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: runpodInput }),
  })
  const raw = await upstream.text()
  let upstreamPayload: any = null
  let ticketsLeft: number | null = null
  try {
    upstreamPayload = JSON.parse(raw)
  } catch {
    upstreamPayload = null
  }

  const jobId = extractJobId(upstreamPayload)
  const shouldCharge =
    upstream.ok && Boolean(jobId) && !isFailureStatus(upstreamPayload) && !hasOutputError(upstreamPayload)

  if (shouldCharge && jobId) {
    const usageId = `wan:${jobId}`
    const ticketMetaWithJob = {
      ...ticketMeta,
      job_id: jobId,
      status: upstreamPayload?.status ?? upstreamPayload?.state ?? null,
      source: 'run',
    }
    const result = await consumeTicket(auth.admin, auth.user, ticketMetaWithJob, usageId, VIDEO_TICKET_COST)
    const nextTickets = Number((result as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
  } else if (upstreamPayload && shouldConsumeTicket(upstreamPayload)) {
    const jobId = extractJobId(upstreamPayload)
    const usageId = jobId ? `wan:${jobId}` : undefined
    const ticketMetaWithJob = {
      ...ticketMeta,
      job_id: jobId ?? undefined,
      status: upstreamPayload?.status ?? upstreamPayload?.state ?? null,
      source: 'run',
    }
    const result = await consumeTicket(auth.admin, auth.user, ticketMetaWithJob, usageId, VIDEO_TICKET_COST)
    const nextTickets = Number((result as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
  }

  if (ticketsLeft !== null && upstreamPayload && typeof upstreamPayload === 'object' && !Array.isArray(upstreamPayload)) {
    upstreamPayload.ticketsLeft = ticketsLeft
    return jsonResponse(upstreamPayload, upstream.status)
  }

  return new Response(raw, {
    status: upstream.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}


