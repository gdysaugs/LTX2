import { createClient, type User } from '@supabase/supabase-js'
import { arrayBufferToBase64 } from '../_shared/base64'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'

type Env = {
  CORS_ALLOWED_ORIGINS?: string
  RUNPOD_API_KEY?: string
  RUNPOD_ENDPOINT_URL?: string
  RUNPOD_GPTSOVITS_ENDPOINT_URL?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

type RunpodRunResponse = {
  id?: string
  status?: string
  [key: string]: unknown
}

type RunpodStatusResponse = {
  id?: string
  status?: string
  output?: unknown
  error?: unknown
  [key: string]: unknown
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

const resolveEndpoint = (env: Env) =>
  normalizeEndpoint(env.RUNPOD_GPTSOVITS_ENDPOINT_URL) || normalizeEndpoint(env.RUNPOD_ENDPOINT_URL)

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

const parseBool = (value: FormDataEntryValue | null) => {
  if (value == null) return null
  const lowered = String(value).trim().toLowerCase()
  if (!lowered) return null
  return lowered === '1' || lowered === 'true' || lowered === 'yes' || lowered === 'on'
}

const runpodFetch = async (endpoint: string, apiKey: string, path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${apiKey}`)
  headers.set('Content-Type', 'application/json')
  return fetch(`${endpoint}${path}`, { ...init, headers })
}

const pickRefAudioFile = (form: FormData) => {
  const value = form.get('ref_audio')
  return value instanceof File ? value : null
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
  if (!endpoint) return jsonResponse({ error: 'RUNPOD_GPTSOVITS_ENDPOINT_URL が未設定です。' }, 500, corsHeaders)
  if (!env.RUNPOD_API_KEY) return jsonResponse({ error: 'RUNPOD_API_KEY が未設定です。' }, 500, corsHeaders)

  const url = new URL(request.url)
  const id = (url.searchParams.get('id') || '').trim()
  if (!id) return jsonResponse({ error: 'id is required.' }, 400, corsHeaders)

  try {
    const stRes = await runpodFetch(endpoint, env.RUNPOD_API_KEY, `/status/${encodeURIComponent(id)}`, { method: 'GET' })
    const payload = (await stRes.json().catch(() => null)) as RunpodStatusResponse | null
    if (!stRes.ok) {
      return jsonResponse(
        { error: '音声ジョブ状態の取得に失敗しました。', detail: payload?.error || payload || 'upstream_error' },
        502,
        corsHeaders,
      )
    }
    return jsonResponse(payload ?? {}, 200, corsHeaders)
  } catch (error) {
    return jsonResponse(
      { error: '音声ジョブ状態の取得に失敗しました。', detail: error instanceof Error ? error.message : 'unknown_error' },
      502,
      corsHeaders,
    )
  }
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) return auth.response

  const endpoint = resolveEndpoint(env)
  if (!endpoint) return jsonResponse({ error: 'RUNPOD_GPTSOVITS_ENDPOINT_URL が未設定です。' }, 500, corsHeaders)
  if (!env.RUNPOD_API_KEY) return jsonResponse({ error: 'RUNPOD_API_KEY が未設定です。' }, 500, corsHeaders)

  try {
    const form = await request.formData()

    const text = String(form.get('text') || '').trim()
    const textLang = String(form.get('text_lang') || 'ja').trim() || 'ja'
    const promptLang = String(form.get('prompt_lang') || 'ja').trim() || 'ja'
    const promptText = String(form.get('prompt_text') || '').trim()
    const autoPromptText = parseBool(form.get('auto_prompt_text'))
    const refAudioUrl = String(form.get('ref_audio_url') || '').trim()
    const refAudioFile = pickRefAudioFile(form)

    if (!text) return jsonResponse({ error: 'text is required.' }, 400, corsHeaders)
    if (!refAudioUrl && !refAudioFile) {
      return jsonResponse({ error: 'ref_audio_url or ref_audio is required.' }, 400, corsHeaders)
    }

    let safeRefName = 'ref.wav'
    const input: Record<string, unknown> = {
      mode: 'gptsovits_v4_tts',
      text,
      text_lang: textLang,
      prompt_lang: promptLang,
      prompt_text: promptText,
      ref_audio: { name: safeRefName },
      aux_ref_audios: [],
      params: {
        top_k: 5,
        top_p: 0.75,
        temperature: 1.2,
        text_split_method: 'cut5',
        batch_size: 1,
        speed_factor: 1.0,
        seed: -1,
        parallel_infer: false,
        max_sec: 120,
        repetition_penalty: 1.2,
        sample_steps: 48,
        super_sampling: false,
        return_fragment: false,
      },
    }

    if (autoPromptText !== null) {
      const params = (input.params as Record<string, unknown>) || {}
      params.auto_prompt_text = autoPromptText
      input.params = params
    }

    if (refAudioFile) {
      safeRefName = (refAudioFile.name || 'ref.wav').replace(/[^\w.\-() ]+/g, '_')
      const b64 = arrayBufferToBase64(await refAudioFile.arrayBuffer())
      ;(input.ref_audio as Record<string, unknown>).name = safeRefName
      ;(input.ref_audio as Record<string, unknown>).data = `data:${refAudioFile.type || 'audio/wav'};base64,${b64}`
    } else if (refAudioUrl) {
      try {
        const parsed = new URL(refAudioUrl)
        const name = (parsed.pathname.split('/').pop() || 'ref.wav').replace(/[^\w.\-() ]+/g, '_')
        if (name) safeRefName = name
      } catch {
        // keep default name
      }
      ;(input.ref_audio as Record<string, unknown>).name = safeRefName
      ;(input.ref_audio as Record<string, unknown>).url = refAudioUrl
    }

    const runRes = await runpodFetch(endpoint, env.RUNPOD_API_KEY, '/run', {
      method: 'POST',
      body: JSON.stringify({ input }),
    })
    const payload = (await runRes.json().catch(() => null)) as RunpodRunResponse | null

    if (!runRes.ok) {
      return jsonResponse(
        { error: '音声生成ジョブの開始に失敗しました。', detail: payload?.error || payload || 'upstream_error' },
        502,
        corsHeaders,
      )
    }
    const id = String(payload?.id || '').trim()
    if (!id) {
      return jsonResponse({ error: '音声生成ジョブIDの取得に失敗しました。' }, 502, corsHeaders)
    }
    return jsonResponse({ id }, 200, corsHeaders)
  } catch (error) {
    return jsonResponse(
      { error: '音声生成ジョブの開始に失敗しました。', detail: error instanceof Error ? error.message : 'unknown_error' },
      500,
      corsHeaders,
    )
  }
}
