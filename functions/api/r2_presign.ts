import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'
import { presignUrl } from '../_shared/sigv4'

type Env = {
  CORS_ALLOWED_ORIGINS?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  R2_ACCOUNT_ID?: string
  R2_BUCKET?: string
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
  R2_REGION?: string
}

type PresignRequest = {
  purpose?: string
  contentType?: string
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
    return { response: jsonResponse({ error: 'SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定です。' }, 500, corsHeaders) }
  }
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) {
    return { response: jsonResponse({ error: '認証に失敗しました。' }, 401, corsHeaders) }
  }
  if (!isGoogleUser(data.user)) {
    return { response: jsonResponse({ error: 'Google ログインのみ対応しています。' }, 403, corsHeaders) }
  }
  return { user: data.user }
}

const safeExtFromContentType = (contentType: string) => {
  const normalized = contentType.toLowerCase()
  if (normalized.includes('video/mp4')) return 'mp4'
  if (normalized.includes('audio/wav')) return 'wav'
  if (normalized.includes('audio/mpeg') || normalized.includes('audio/mp3')) return 'mp3'
  if (normalized.includes('audio/mp4') || normalized.includes('audio/aac')) return 'm4a'
  if (normalized.includes('image/png')) return 'png'
  if (normalized.includes('image/jpeg')) return 'jpg'
  return 'bin'
}

const createObjectKey = (prefix: string, ext: string) => `${prefix}/${crypto.randomUUID()}.${ext}`

const envOrThrow = (env: Env, key: keyof Env) => {
  const value = env[key]
  if (!value) throw new Error(`Missing env var: ${String(key)}`)
  return value
}

export const onRequestOptions: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }
  return new Response(null, { status: 204, headers: corsHeaders })
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) return auth.response

  try {
    const body = (await request.json().catch(() => null)) as PresignRequest | null
    if (!body || typeof body !== 'object') {
      return jsonResponse({ error: 'Invalid request body.' }, 400, corsHeaders)
    }

    const contentType = String(body.contentType || '').trim()
    if (!contentType) {
      return jsonResponse({ error: 'contentType is required.' }, 400, corsHeaders)
    }

    const purpose = String(body.purpose || 'uploads')
      .trim()
      .replace(/[^\w.\-/]+/g, '_')
    const ext = safeExtFromContentType(contentType)
    const key = createObjectKey(purpose, ext)

    const accountId = envOrThrow(env, 'R2_ACCOUNT_ID')
    const bucket = envOrThrow(env, 'R2_BUCKET')
    const accessKeyId = envOrThrow(env, 'R2_ACCESS_KEY_ID')
    const secretAccessKey = envOrThrow(env, 'R2_SECRET_ACCESS_KEY')
    const region = (env.R2_REGION || 'auto').trim().replace(/^#+/, '') || 'auto'

    const host = `${accountId}.r2.cloudflarestorage.com`
    const canonicalUri = `/${bucket}/${key}`

    const put = await presignUrl({
      method: 'PUT',
      host,
      canonicalUri,
      accessKeyId,
      secretAccessKey,
      region,
      expiresSeconds: 15 * 60,
      additionalSignedHeaders: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
    })

    const get = await presignUrl({
      method: 'GET',
      host,
      canonicalUri,
      accessKeyId,
      secretAccessKey,
      region,
      expiresSeconds: 60 * 60,
    })

    return jsonResponse(
      {
        bucket,
        key,
        put: {
          url: put.url,
          headers: {
            'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
            'content-type': contentType,
          },
          expires_seconds: 15 * 60,
        },
        get: { url: get.url, expires_seconds: 60 * 60 },
      },
      200,
      corsHeaders,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown_error'
    return jsonResponse({ error: 'R2署名URLの生成に失敗しました。', message }, 500, corsHeaders)
  }
}
