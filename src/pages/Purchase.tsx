import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isAuthConfigured, supabase } from '../lib/supabaseClient'
import { PURCHASE_PLANS } from '../lib/purchasePlans'
import { getOAuthRedirectUrl } from '../lib/oauthRedirect'
import { TopNav } from '../components/TopNav'
import './camera.css'

const OAUTH_REDIRECT_URL = getOAuthRedirectUrl()

const formatRemaining = (targetIso: string | null) => {
  if (!targetIso) return ''
  const target = new Date(targetIso).getTime()
  if (!Number.isFinite(target)) return ''
  const diff = target - Date.now()
  if (diff <= 0) return ''
  const hours = Math.floor(diff / 3_600_000)
  const minutes = Math.floor((diff % 3_600_000) / 60_000)
  const seconds = Math.floor((diff % 60_000) / 1000)
  return `${hours}時間${minutes.toString().padStart(2, '0')}分${seconds.toString().padStart(2, '0')}秒`
}

const normalizeErrorMessage = (value: unknown) => {
  if (!value) return 'デイリーボーナスに失敗しました。'
  if (typeof value === 'string') return value
  if (value instanceof Error && value.message) return value.message
  if (typeof value === 'object' && value) {
    const maybe = value as { error?: unknown; message?: unknown; detail?: unknown }
    const picked = maybe.error ?? maybe.message ?? maybe.detail
    if (typeof picked === 'string' && picked) return picked
  }
  return 'デイリーボーナスに失敗しました。'
}

export function Purchase() {
  const [session, setSession] = useState<Session | null>(null)
  const [authStatus, setAuthStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [authMessage, setAuthMessage] = useState('')
  const [ticketCount, setTicketCount] = useState<number | null>(null)
  const [ticketStatus, setTicketStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [ticketMessage, setTicketMessage] = useState('')
  const [purchaseStatus, setPurchaseStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [purchaseMessage, setPurchaseMessage] = useState('')
  const [dailyClaimStatus, setDailyClaimStatus] = useState<string | null>(null)
  const [isClaimingDaily, setIsClaimingDaily] = useState(false)

  const accessToken = session?.access_token ?? ''

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setAuthStatus('idle')
      setAuthMessage('')
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!supabase) return
    const url = new URL(window.location.href)
    const oauthError = url.searchParams.get('error_description') || url.searchParams.get('error')
    if (oauthError) {
      console.error('OAuth callback error', oauthError)
      setAuthStatus('error')
      setAuthMessage('ログインに失敗しました。もう一度お試しください。')
      url.searchParams.delete('error')
      url.searchParams.delete('error_description')
      window.history.replaceState({}, document.title, url.toString())
      return
    }
    const hasCode = url.searchParams.has('code')
    const hasState = url.searchParams.has('state')
    if (!hasCode || !hasState) return
    supabase.auth.exchangeCodeForSession(window.location.href).then(({ error }) => {
      if (error) {
        console.error('exchangeCodeForSession failed', error)
        setAuthStatus('error')
        setAuthMessage('ログインに失敗しました。もう一度お試しください。')
        return
      }
      const cleaned = new URL(window.location.href)
      cleaned.searchParams.delete('code')
      cleaned.searchParams.delete('state')
      window.history.replaceState({}, document.title, cleaned.toString())
    })
  }, [])

  const fetchTickets = useCallback(async (token: string) => {
    if (!token) return
    setTicketStatus('loading')
    setTicketMessage('')
    const res = await fetch('/api/tickets', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setTicketStatus('error')
      setTicketMessage(data?.error || 'トークン取得に失敗しました。')
      setTicketCount(null)
      return
    }
    setTicketStatus('idle')
    setTicketMessage('')
    setTicketCount(Number(data?.tickets ?? 0))
  }, [])

  useEffect(() => {
    if (!session || !accessToken) {
      setTicketCount(null)
      setTicketStatus('idle')
      setTicketMessage('')
      return
    }
    void fetchTickets(accessToken)
  }, [accessToken, fetchTickets, session])

  const handleGoogleSignIn = async () => {
    if (!supabase || !isAuthConfigured) {
      setAuthStatus('error')
      setAuthMessage('認証設定が未完了です。')
      return
    }
    setAuthStatus('loading')
    setAuthMessage('')
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: OAUTH_REDIRECT_URL, queryParams: { prompt: 'select_account' } },
    })
    if (error) {
      setAuthStatus('error')
      setAuthMessage(error.message)
      return
    }
    if (data?.url) {
      window.location.assign(data.url)
      return
    }
    setAuthStatus('error')
    setAuthMessage('認証URLの取得に失敗しました。')
  }

  const handleSignOut = async () => {
    if (!supabase) return
    try {
      await supabase.auth.signOut({ scope: 'local' })
    } catch (error) {
      setAuthStatus('error')
      setAuthMessage(error instanceof Error ? error.message : 'ログアウトに失敗しました。')
    }
  }

  const handleCheckout = async (priceId: string) => {
    if (!session || !accessToken) {
      setPurchaseStatus('error')
      setPurchaseMessage('購入するにはログインが必要です。')
      return
    }
    setPurchaseStatus('loading')
    setPurchaseMessage('決済ページへ移動中...')
    const res = await fetch('/api/stripe/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ price_id: priceId }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data?.url) {
      setPurchaseStatus('error')
      setPurchaseMessage(data?.error || '決済作成に失敗しました。')
      return
    }
    window.location.assign(data.url)
  }

  const handleClaimDaily = async () => {
    if (!accessToken || !session) {
      setDailyClaimStatus('ログインしてください。')
      return
    }
    if (isClaimingDaily) return
    setIsClaimingDaily(true)
    setDailyClaimStatus(null)
    try {
      const res = await fetch('/api/daily-bonus', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = normalizeErrorMessage(data?.error ?? data?.message ?? data?.detail)
        setDailyClaimStatus(message)
        window.alert(message)
        return
      }
      if (data?.granted) {
        setDailyClaimStatus('無料トークンを付与しました。')
        void fetchTickets(accessToken)
      } else {
        const reason = data?.reason
        if (reason === 'cooldown' || reason === 'not_eligible_yet') {
          const remain = formatRemaining(data?.next_eligible_at ?? null)
          setDailyClaimStatus(remain ? `次の受け取りまで ${remain}` : 'まだ受け取れません。')
        } else {
          setDailyClaimStatus('まだ受け取れません。')
        }
      }
    } catch (error) {
      const message = normalizeErrorMessage(error)
      setDailyClaimStatus(message)
      window.alert(message)
    } finally {
      setIsClaimingDaily(false)
    }
  }

  return (
    <div className="camera-app purchase-app">
      <TopNav />
      <div className="purchase-shell">
        <section className="purchase-panel">
          <div className="panel-header">
            <div className="panel-title">
              <h2>アカウント</h2>
              <span>{session ? 'ログイン中' : 'ログインしてください。'}</span>
            </div>
            <div className="panel-auth">
              {session ? (
                <div className="auth-status">
                  <span className="auth-email">{session.user?.email ?? 'ログイン中'}</span>
                  <button type="button" className="ghost-button" onClick={handleSignOut}>
                    ログアウト
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={handleGoogleSignIn}
                  disabled={authStatus === 'loading'}
                >
                  {authStatus === 'loading' ? '接続中...' : 'Googleで登録 / ログイン'}
                </button>
              )}
            </div>
          </div>
          {authMessage && <div className="auth-message">{authMessage}</div>}
          {session && (
            <div className="ticket-message">
              {ticketStatus === 'loading' && 'トークン確認中...'}
              {ticketStatus !== 'loading' && `トークン残り: ${ticketCount ?? 0}`}
              {ticketStatus === 'error' && ticketMessage ? ` / ${ticketMessage}` : ''}
            </div>
          )}
          {session && (
            <div className="daily-bonus">
              <div className="daily-bonus__row">
                <strong>無料トークン</strong>
                <button type="button" className="ghost-button" onClick={handleClaimDaily} disabled={isClaimingDaily}>
                  {isClaimingDaily ? '受け取り中...' : '受け取る'}
                </button>
              </div>
              {dailyClaimStatus && <span>{dailyClaimStatus}</span>}
            </div>
          )}
        </section>

        <section className="purchase-panel">
          <div className="panel-header">
            <div className="panel-title">
              <h2>トークン購入</h2>
              <span>必要な分だけ購入。</span>
            </div>
          </div>
          <div className="plan-grid">
            {PURCHASE_PLANS.map((plan) => (
              <div key={plan.id} className="plan-card">
                <div>
                  <div className="plan-label">{plan.label}</div>
                  <div className="plan-tickets">{plan.tickets} トークン</div>
                </div>
                <div className="plan-price">¥{plan.price.toLocaleString()}</div>
                <button
                  type="button"
                  className="plan-action"
                  onClick={() => handleCheckout(plan.priceId)}
                  disabled={!session || purchaseStatus === 'loading'}
                >
                  購入
                </button>
              </div>
            ))}
          </div>
          {purchaseMessage && <div className="purchase-message">{purchaseMessage}</div>}
        </section>
      </div>
    </div>
  )
}
