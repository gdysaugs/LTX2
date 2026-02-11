import { createClient } from '@supabase/supabase-js'

function normalizeEnvString(v: string | undefined): string {
  // Guard against accidentally quoted/whitespace-padded values in build vars.
  return (v ?? '').trim().replace(/^"(.*)"$/, '$1')
}

function normalizeSupabaseUrl(v: string | undefined): string {
  const s = normalizeEnvString(v)
  if (!s) return ''

  try {
    const u = new URL(s)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return ''
    // Supabase client expects a base URL, not an arbitrary path.
    return u.origin
  } catch {
    return ''
  }
}

const supabaseUrl = normalizeSupabaseUrl(import.meta.env.VITE_SUPABASE_URL)
const supabaseAnonKey = normalizeEnvString(import.meta.env.VITE_SUPABASE_ANON_KEY)

export const isAuthConfigured = Boolean(supabaseUrl && supabaseAnonKey)
export const supabase = isAuthConfigured ? createClient(supabaseUrl, supabaseAnonKey) : null
