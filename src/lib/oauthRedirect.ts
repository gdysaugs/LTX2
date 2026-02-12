const parseUrl = (value: string) => {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

export const getOAuthRedirectUrl = () => {
  const currentOrigin =
    typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : undefined
  const configured = import.meta.env.VITE_SUPABASE_REDIRECT_URL as string | undefined
  // In browser runtime, always prefer the current domain to avoid cross-site redirects.
  if (currentOrigin) return currentOrigin
  if (!configured) return undefined

  const configuredUrl = parseUrl(configured)
  if (!configuredUrl) return undefined
  return configured
}
