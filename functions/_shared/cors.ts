type CorsEnv = {
  CORS_ALLOWED_ORIGINS?: string
}

const DEFAULT_ALLOWED_ORIGINS = [
  'https://civitai.uk',
  'https://www.civitai.uk',
  'https://ltx2.pages.dev',
  '*.ltx2.pages.dev',
]

const normalize = (value: string) => value.trim().toLowerCase()

const parseAllowedOrigins = (env?: CorsEnv) => {
  const raw = env?.CORS_ALLOWED_ORIGINS ?? ''
  const entries = raw
    .split(',')
    .map(normalize)
    .filter(Boolean)

  if (!entries.length) return DEFAULT_ALLOWED_ORIGINS

  // Keep civitai defaults even when old env values remain configured.
  return Array.from(new Set([...DEFAULT_ALLOWED_ORIGINS.map(normalize), ...entries]))
}

const matchAllowedOrigin = (origin: string, allowed: string[]) => {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const hostname = normalize(parsed.hostname)
  const normalizedOrigin = normalize(origin)
  return allowed.some((entry) => {
    if (entry.startsWith('http://') || entry.startsWith('https://')) {
      return normalizedOrigin === entry
    }
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(2)
      return hostname === suffix || hostname.endsWith(`.${suffix}`)
    }
    return hostname === entry
  })
}

export const getAllowedOrigin = (request: Request, env?: CorsEnv) => {
  const origin = request.headers.get('Origin')
  if (!origin) return null
  const allowed = parseAllowedOrigins(env)
  if (matchAllowedOrigin(origin, allowed)) return origin
  return null
}

export const isCorsBlocked = (request: Request, env?: CorsEnv) => {
  const origin = request.headers.get('Origin')
  if (!origin) return false
  return !getAllowedOrigin(request, env)
}

export const buildCorsHeaders = (request: Request, env: CorsEnv | undefined, methods: string) => {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
  const allowedOrigin = getAllowedOrigin(request, env)
  if (allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin
    headers['Vary'] = 'Origin'
  }
  return headers
}
