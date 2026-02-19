const parseUrl = (value: string) => {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

export const getOAuthRedirectUrl = () => {
  const configured = import.meta.env.VITE_SUPABASE_REDIRECT_URL as string | undefined
  const configuredUrl = configured ? parseUrl(configured) : null
  // Prefer explicit config so all aliases resolve to a single OAuth callback origin.
  if (configuredUrl) return configuredUrl.origin

  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : undefined
  return currentOrigin
}
