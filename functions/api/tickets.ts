import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'

type Env = {
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

const SIGNUP_TICKET_GRANT = 5

const corsMethods = 'GET, OPTIONS'

const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

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

const fetchTicketRow = async (
  admin: ReturnType<typeof createClient>,
  user: User,
) => {
  const email = user.email
  const { data: byUser, error: userError } = await admin
    .from('user_tickets')
    .select('tickets')
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
    .select('tickets')
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
    .select('tickets')
    .maybeSingle()

  if (insertError || !inserted) {
    const { data: retry, error: retryError } = await fetchTicketRow(admin, user)
    if (retryError) {
      return { data: null, error: retryError }
    }
    return { data: retry, error: null, created: false }
  }

  const usageId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  await admin.from('ticket_events').insert({
    usage_id: usageId,
    email,
    user_id: user.id,
    delta: SIGNUP_TICKET_GRANT,
    reason: 'signup_bonus',
    metadata: { source: 'auto_grant' },
  })

  return { data: inserted, error: null, created: true }
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
    return { response: jsonResponse({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.' }, 500, corsHeaders) }
  }
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) {
    return { response: jsonResponse({ error: '認証に失敗しました。' }, 401, corsHeaders) }
  }
  if (!isGoogleUser(data.user)) {
    return { response: jsonResponse({ error: 'Googleログインのみ利用できます。' }, 403, corsHeaders) }
  }
  return { admin, user: data.user }
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
  if ('response' in auth) {
    return auth.response
  }

  const email = auth.user.email
  if (!email) {
    return jsonResponse({ error: 'メールアドレスが取得できません。' }, 400, corsHeaders)
  }

  const { data, error } = await ensureTicketRow(auth.admin, auth.user)

  if (error) {
    return jsonResponse({ error: error.message }, 500, corsHeaders)
  }

  return jsonResponse({ tickets: data?.tickets ?? 0, hasRecord: Boolean(data) }, 200, corsHeaders)
}
