import { createClient } from '@supabase/supabase-js'

type Env = {
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
}

const ANIMONE_PRICE_IDS = new Set([
  'price_1SxlHuA0Q3zk5h1IlqXtP7tl',
  'price_1SxlJaA0Q3zk5h1INNQoZCdG',
  'price_1SxlKbA0Q3zk5h1IP2SZAIY7',
  'price_1SxlKpA0Q3zk5h1IZLRtKGg2',
])

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature',
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const getSupabaseAdmin = (env: Env) => {
  const url = env.SUPABASE_URL
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

const textEncoder = new TextEncoder()

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

const verifyStripeSignature = async (payload: string, signature: string, secret: string) => {
  const parts = signature.split(',').map((item) => item.trim())
  const timestampPart = parts.find((item) => item.startsWith('t='))
  const v1Parts = parts.filter((item) => item.startsWith('v1='))
  if (!timestampPart || v1Parts.length === 0) return false
  const timestamp = timestampPart.slice(2)
  const signedPayload = `${timestamp}.${payload}`
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, textEncoder.encode(signedPayload))
  const expected = toHex(signatureBuffer)
  return v1Parts.some((part) => timingSafeEqual(part.slice(3), expected))
}

export const onRequestOptions: PagesFunction = async () => new Response(null, { headers: corsHeaders })

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const secret = env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    return jsonResponse({ error: 'STRIPE_WEBHOOK_SECRET is not set.' }, 500)
  }

  const signature = request.headers.get('stripe-signature') || ''
  const body = await request.text()
  const isValid = await verifyStripeSignature(body, signature, secret)
  if (!isValid) {
    return jsonResponse({ error: 'Invalid signature.' }, 401)
  }

  const event = body ? JSON.parse(body) : null
  if (!event?.type) {
    return jsonResponse({ error: 'Invalid event payload.' }, 400)
  }

  if (event.type !== 'checkout.session.completed') {
    return jsonResponse({ received: true })
  }

  const session = event.data?.object ?? {}
  if (session.payment_status && session.payment_status !== 'paid') {
    return jsonResponse({ received: true })
  }

  const appTag = String(session.metadata?.app ?? '')
  if (appTag !== 'animone') {
    return jsonResponse({ received: true })
  }

  const priceId = String(session.metadata?.price_id ?? '')
  if (!priceId || !ANIMONE_PRICE_IDS.has(priceId)) {
    return jsonResponse({ received: true })
  }

  const tickets = Number(session.metadata?.tickets ?? 0)
  const email = String(session.metadata?.email ?? session.customer_details?.email ?? '')
  const userId = String(session.metadata?.user_id ?? session.client_reference_id ?? '')
  const usageId = String(event.id ?? session.id ?? '')
  const stripeCustomerId = session.customer ? String(session.customer) : null

  if (!tickets || !email || !userId || !usageId) {
    return jsonResponse({ error: 'Missing metadata.' }, 400)
  }

  const admin = getSupabaseAdmin(env)
  if (!admin) {
    return jsonResponse({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.' }, 500)
  }

  const { data: userCheck, error: userCheckError } = await admin.auth.admin.getUserById(userId)
  if (userCheckError || !userCheck?.user) {
    return jsonResponse({ received: true })
  }

  const { data: rpcData, error: rpcError } = await admin.rpc('grant_tickets', {
    p_usage_id: usageId,
    p_user_id: userId,
    p_email: email,
    p_amount: tickets,
    p_reason: 'stripe_purchase',
    p_metadata: {
      price_id: session.metadata?.price_id ?? null,
      plan_label: session.metadata?.plan_label ?? null,
      session_id: session.id ?? null,
    },
    p_stripe_customer_id: stripeCustomerId,
  })

  if (rpcError) {
    const message = rpcError.message ?? 'Failed to grant tickets.'
    if (message.includes('INVALID')) {
      return jsonResponse({ error: message }, 400)
    }
    return jsonResponse({ error: message }, 500)
  }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  if (result?.already_processed) {
    return jsonResponse({ received: true, duplicate: true })
  }

  return jsonResponse({ received: true })
}
