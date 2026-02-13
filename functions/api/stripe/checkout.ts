import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../../_shared/cors'

type Env = {
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_SUCCESS_URL?: string
  STRIPE_CANCEL_URL?: string
}

const corsMethods = 'POST, OPTIONS'

const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
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

const PRICE_MAP = new Map([
  ['price_1T0FbRADIkb9D0vbJU219i32', { label: 'ミニパック', tickets: 30 }],
  ['price_1T0FcJADIkb9D0vbswnpncgW', { label: 'お得パック', tickets: 80 }],
  ['price_1T0Ff0ADIkb9D0vbdH1cayHz', { label: '大容量パック', tickets: 200 }],
])

const getRedirectUrl = (env: Env, request: Request, key: 'STRIPE_SUCCESS_URL' | 'STRIPE_CANCEL_URL', fallback: string) =>
  env[key] ?? new URL(fallback, request.url).toString()

export const onRequestOptions: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }
  return new Response(null, { headers: corsHeaders })
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) {
    return auth.response
  }

  const stripeKey = env.STRIPE_SECRET_KEY
  if (!stripeKey) {
    return jsonResponse({ error: 'STRIPE_SECRET_KEY is not set.' }, 500, corsHeaders)
  }

  const payload = await request.json().catch(() => null)
  if (!payload) {
    return jsonResponse({ error: 'Invalid request body.' }, 400, corsHeaders)
  }

  const priceId = String(payload.price_id ?? payload.priceId ?? '')
  const plan = PRICE_MAP.get(priceId)
  if (!plan) {
    return jsonResponse({ error: '不正なプランです。' }, 400, corsHeaders)
  }

  const email = auth.user.email ?? ''
  const successUrl = getRedirectUrl(env, request, 'STRIPE_SUCCESS_URL', '/?checkout=success')
  const cancelUrl = getRedirectUrl(env, request, 'STRIPE_CANCEL_URL', '/?checkout=cancel')

  const params = new URLSearchParams()
  params.set('mode', 'payment')
  params.set('success_url', successUrl)
  params.set('cancel_url', cancelUrl)
  params.set('line_items[0][price]', priceId)
  params.set('line_items[0][quantity]', '1')
  params.set('client_reference_id', auth.user.id)
  if (email) {
    params.set('customer_email', email)
  }
  params.set('metadata[user_id]', auth.user.id)
  params.set('metadata[email]', email)
  params.set('metadata[tickets]', String(plan.tickets))
  params.set('metadata[price_id]', priceId)
  params.set('metadata[plan_label]', plan.label)
  params.set('metadata[app]', 'meltai')
  params.set('payment_intent_data[statement_descriptor]', 'MELTAI')

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })

  const stripeText = await stripeRes.text()
  const stripeData = stripeText ? JSON.parse(stripeText) : null
  if (!stripeRes.ok) {
    return jsonResponse({ error: stripeData?.error?.message || 'Stripeのセッション作成に失敗しました。' }, 500, corsHeaders)
  }

  return jsonResponse({ url: stripeData?.url }, 200, corsHeaders)
}
