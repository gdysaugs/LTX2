import { onRequestGet as qwenGet, onRequestPost as qwenPost, onRequestOptions as qwenOptions } from '../functions/api/qwen'
import { onRequestGet as wanGet, onRequestPost as wanPost, onRequestOptions as wanOptions } from '../functions/api/wan'
import { onRequestGet as ticketsGet, onRequestOptions as ticketsOptions } from '../functions/api/tickets'
import { onRequestPost as stripeCheckoutPost, onRequestOptions as stripeCheckoutOptions } from '../functions/api/stripe/checkout'
import { onRequestPost as stripeWebhookPost, onRequestOptions as stripeWebhookOptions } from '../functions/api/stripe/webhook'

type Env = {
  RUNPOD_API_KEY: string
  RUNPOD_ENDPOINT_URL?: string
  RUNPOD_WAN_ENDPOINT_URL?: string
  COMFY_ORG_API_KEY?: string
  RUNPOD_WORKER_MODE?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  STRIPE_SUCCESS_URL?: string
  STRIPE_CANCEL_URL?: string
  CORS_ALLOWED_ORIGINS?: string
}

type PagesArgs = {
  request: Request
  env: Env
}

const notFound = () => new Response('Not Found', { status: 404 })
const methodNotAllowed = () => new Response('Method Not Allowed', { status: 405 })

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method.toUpperCase()
    const args: PagesArgs = { request, env }

    if (path.startsWith('/api/qwen')) {
      if (method === 'OPTIONS') return qwenOptions(args as any)
      if (method === 'GET') return qwenGet(args as any)
      if (method === 'POST') return qwenPost(args as any)
      return methodNotAllowed()
    }

    if (path.startsWith('/api/wan')) {
      if (method === 'OPTIONS') return wanOptions(args as any)
      if (method === 'GET') return wanGet(args as any)
      if (method === 'POST') return wanPost(args as any)
      return methodNotAllowed()
    }

    if (path.startsWith('/api/tickets')) {
      if (method === 'OPTIONS') return ticketsOptions(args as any)
      if (method === 'GET') return ticketsGet(args as any)
      return methodNotAllowed()
    }

    if (path.startsWith('/api/stripe/checkout')) {
      if (method === 'OPTIONS') return stripeCheckoutOptions(args as any)
      if (method === 'POST') return stripeCheckoutPost(args as any)
      return methodNotAllowed()
    }

    if (path.startsWith('/api/stripe/webhook')) {
      if (method === 'OPTIONS') return stripeWebhookOptions(args as any)
      if (method === 'POST') return stripeWebhookPost(args as any)
      return methodNotAllowed()
    }

    return notFound()
  },
}
