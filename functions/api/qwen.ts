import workflowTemplate from './qwen-workflow.json'
import nodeMapTemplate from './qwen-node-map.json'
import { createClient, type User } from '@supabase/supabase-js'

type Env = {
  RUNPOD_API_KEY: string
  RUNPOD_ENDPOINT_URL?: string
  COMFY_ORG_API_KEY?: string
  RUNPOD_WORKER_MODE?: string
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

const resolveEndpoint = (env: Env) => env.RUNPOD_ENDPOINT_URL?.replace(/\/$/, '')

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

const SIGNUP_TICKET_GRANT = 3

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
    return { response: jsonResponse({ error: 'ログインが必要です。' }, 401) }
  }
  const admin = getSupabaseAdmin(env)
  if (!admin) {
    return { response: jsonResponse({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.' }, 500) }
  }
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) {
    return { response: jsonResponse({ error: '認証に失敗しました。' }, 401) }
  }
  if (!isGoogleUser(data.user)) {
    return { response: jsonResponse({ error: 'Googleログインのみ利用できます。' }, 403) }
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
) => {
  const email = user.email
  if (!email) {
    return { response: jsonResponse({ error: 'メールアドレスが取得できません。' }, 400) }
  }

  const { data: existing, error } = await ensureTicketRow(admin, user)

  if (error) {
    return { response: jsonResponse({ error: error.message }, 500) }
  }

  if (!existing) {
    return { response: jsonResponse({ error: 'チケットがありません。' }, 402) }
  }

  if (!existing.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  }

  if (existing.tickets < 1) {
    return { response: jsonResponse({ error: 'チケットがありません。' }, 402) }
  }

  return { existing }
}

const consumeTicket = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  metadata: Record<string, unknown>,
  usageId?: string,
) => {
  const email = user.email
  if (!email) {
    return { response: jsonResponse({ error: 'メールアドレスが取得できません。' }, 400) }
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

  const { data: existing, error } = await ensureTicketRow(admin, user)

  if (error) {
    return { response: jsonResponse({ error: error.message }, 500) }
  }

  if (!existing) {
    return { response: jsonResponse({ error: 'チケットがありません。' }, 402) }
  }

  if (!existing.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  }

  if (existing.tickets < 1) {
    return { response: jsonResponse({ error: 'チケットがありません。' }, 402) }
  }

  const { data: updated, error: updateError } = await admin
    .from('user_tickets')
    .update({ tickets: existing.tickets - 1, updated_at: new Date().toISOString() })
    .eq('id', existing.id)
    .eq('tickets', existing.tickets)
    .select('tickets')
    .maybeSingle()

  if (updateError || !updated) {
    return { response: jsonResponse({ error: 'チケット消費に失敗しました。' }, 409) }
  }

  const resolvedUsageId = usageId ?? makeUsageId()
  const { error: eventError } = await admin.from('ticket_events').insert({
    usage_id: resolvedUsageId,
    email: existing.email,
    user_id: user.id,
    delta: -1,
    reason: 'generate',
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
) => {
  const urlValue = pickInputValue(input, urlKeys)
  if (typeof urlValue === 'string' && urlValue) {
    return await fetchImageBase64(urlValue)
  }
  const value = pickInputValue(input, valueKeys)
  if (!value) return ''
  return stripDataUrl(String(value))
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
    return jsonResponse({ error: 'RUNPOD_ENDPOINT_URL is not set.' }, 500)
  }
  const upstream = await fetch(`${endpoint}/status/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` },
  })
  const raw = await upstream.text()
  let payload: any = null
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = null
  }

  if (payload && shouldConsumeTicket(payload)) {
    const usageId = `qwen:${id}`
    const ticketMeta = {
      job_id: id,
      status: payload?.status ?? payload?.state ?? null,
      source: 'status',
    }
    await consumeTicket(auth.admin, auth.user, ticketMeta, usageId)
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
    return jsonResponse({ error: 'RUNPOD_ENDPOINT_URL is not set.' }, 500)
  }

  const payload = await request.json().catch(() => null)
  if (!payload) {
    return jsonResponse({ error: 'Invalid request body.' }, 400)
  }

  const input = payload.input ?? payload
  const safeInput = typeof input === 'object' && input ? (input as Record<string, unknown>) : {}
  let imageBase64 = ''
  let subImageBase64Raw = ''
  try {
    imageBase64 = await resolveImageBase64(
      safeInput,
      ['image_base64', 'image', 'image_base64_1', 'image1'],
      ['image_url'],
    )
    subImageBase64Raw = await resolveImageBase64(
      safeInput,
      ['sub_image_base64', 'sub_image', 'image2', 'image2_base64', 'image_base64_2'],
      ['sub_image_url', 'image2_url', 'image_url_2'],
    )
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Failed to read image.' }, 400)
  }

  if (!imageBase64) {
    return jsonResponse({ error: 'image is required.' }, 400)
  }

  const subImageBase64 = subImageBase64Raw || imageBase64

  const prompt = String(input?.prompt ?? input?.text ?? '')
  const negativePrompt = String(input?.negative_prompt ?? input?.negative ?? '')
  const steps = Number(input?.num_inference_steps ?? input?.steps ?? 4)
  const guidanceScale = Number(input?.guidance_scale ?? input?.cfg ?? 1)
  const width = Number(input?.width ?? 768)
  const height = Number(input?.height ?? 768)
  const angleStrengthInput = input?.angle_strength ?? input?.multiangle_strength ?? undefined
  const angleStrength =
    angleStrengthInput === undefined || angleStrengthInput === null ? undefined : Number(angleStrengthInput)
  const workerMode = String(input?.worker_mode ?? input?.mode ?? env.RUNPOD_WORKER_MODE ?? '').toLowerCase()
  const useComfyUi = workerMode === 'comfyui' || Boolean(input?.workflow)

  const ticketMeta = {
    prompt_length: prompt.length,
    width,
    height,
    steps,
    mode: useComfyUi ? 'comfyui' : 'runpod',
  }
  const ticketCheck = await ensureTicketAvailable(auth.admin, auth.user)
  if ('response' in ticketCheck) {
    return ticketCheck.response
  }

  if (useComfyUi) {
    const seed = input?.randomize_seed
      ? Math.floor(Math.random() * 2147483647)
      : Number(input?.seed ?? 0)
    const imageName = String(safeInput?.image_name ?? 'input.png')
    let subImageName = String(safeInput?.sub_image_name ?? safeInput?.image2_name ?? 'sub.png')
    if (!subImageBase64Raw) {
      subImageName = imageName
    } else if (subImageName === imageName) {
      subImageName = 'sub.png'
    }
    const workflow = input?.workflow ? clone(input.workflow) : clone(await getWorkflowTemplate())
    if (!workflow || Object.keys(workflow).length === 0) {
      return jsonResponse({ error: 'workflow.json is empty. Export a ComfyUI API workflow.' }, 500)
    }

    const nodeMap = await getNodeMap().catch(() => null)
    const hasNodeMap = nodeMap && Object.keys(nodeMap).length > 0
    const shouldApplyNodeMap = input?.apply_node_map !== false

    if (shouldApplyNodeMap && hasNodeMap) {
      const nodeValues: Record<string, unknown> = {
        image: imageName,
        image2: subImageName,
        prompt,
        negative_prompt: negativePrompt,
        seed,
        steps,
        cfg: guidanceScale,
        width,
        height,
        angle_strength: angleStrength,
      }
      applyNodeMap(workflow as Record<string, any>, nodeMap, nodeValues)
    } else if (!input?.workflow) {
      return jsonResponse({ error: 'node_map.json is empty. Provide a node map or send workflow directly.' }, 500)
    }

    const comfyKey = String(input?.comfy_org_api_key ?? env.COMFY_ORG_API_KEY ?? '')
    const images = [{ name: imageName, image: imageBase64 }]
    if (subImageName !== imageName) {
      images.push({ name: subImageName, image: subImageBase64 })
    }
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
    try {
      upstreamPayload = JSON.parse(raw)
    } catch {
      upstreamPayload = null
    }

    if (upstreamPayload && shouldConsumeTicket(upstreamPayload)) {
      const jobId = extractJobId(upstreamPayload)
      const usageId = jobId ? `qwen:${jobId}` : undefined
      const ticketMetaWithJob = {
        ...ticketMeta,
        job_id: jobId ?? undefined,
        status: upstreamPayload?.status ?? upstreamPayload?.state ?? null,
        source: 'run',
      }
      await consumeTicket(auth.admin, auth.user, ticketMetaWithJob, usageId)
    }

    return new Response(raw, {
      status: upstream.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
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
  try {
    upstreamPayload = JSON.parse(raw)
  } catch {
    upstreamPayload = null
  }

  if (upstreamPayload && shouldConsumeTicket(upstreamPayload)) {
    const jobId = extractJobId(upstreamPayload)
    const usageId = jobId ? `qwen:${jobId}` : undefined
    const ticketMetaWithJob = {
      ...ticketMeta,
      job_id: jobId ?? undefined,
      status: upstreamPayload?.status ?? upstreamPayload?.state ?? null,
      source: 'run',
    }
    await consumeTicket(auth.admin, auth.user, ticketMetaWithJob, usageId)
  }

  return new Response(raw, {
    status: upstream.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
