import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import { TopNav } from '../components/TopNav'
import { getOAuthRedirectUrl } from '../lib/oauthRedirect'
import { isAuthConfigured, supabase } from '../lib/supabaseClient'
import './account.css'
import './camera.css'

type HistoryItem = {
  usage_id: string
  runpod_job_id: string | null
  prompt: string
  negative_prompt: string
  width: number
  height: number
  steps: number
  cfg: number
  seed: number | null
  randomize_seed: boolean
  sampler_name: string
  scheduler: string
  denoise: number
  status: string
  error_message: string | null
  image_url: string | null
  created_at: string
  updated_at: string
}

const OAUTH_REDIRECT_URL = getOAuthRedirectUrl()
const REGENERATE_STORAGE_KEY = 'anima:regenerate-preset'
const EDIT_SOURCE_STORAGE_KEY = 'image:edit-source'

const formatDate = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function Account() {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(!supabase)
  const [items, setItems] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [deletingUsageId, setDeletingUsageId] = useState<string | null>(null)
  const [historyBlobUrls, setHistoryBlobUrls] = useState<Record<string, string>>({})
  const historyBlobUrlsRef = useRef<Record<string, string>>({})
  const navigate = useNavigate()

  const accessToken = session?.access_token ?? ''
  const hasHistory = items.length > 0

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true)
      return
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
      setAuthReady(true)
    })
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setAuthReady(true)
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!supabase) return
    const url = new URL(window.location.href)
    const hasCode = url.searchParams.has('code')
    const hasState = url.searchParams.has('state')
    if (!hasCode || !hasState) return
    supabase.auth.exchangeCodeForSession(window.location.href).then(({ error }) => {
      if (error) {
        setErrorMessage('ログインに失敗しました。もう一度お試しください。')
        return
      }
      const cleaned = new URL(window.location.href)
      cleaned.searchParams.delete('code')
      cleaned.searchParams.delete('state')
      window.history.replaceState({}, document.title, cleaned.toString())
    })
  }, [])

  const fetchHistory = useCallback(async (token: string) => {
    if (!token) {
      setItems([])
      return
    }
    setLoading(true)
    setErrorMessage('')
    const res = await fetch('/api/anima_history?limit=50', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setItems([])
      setErrorMessage(data?.error || '履歴の取得に失敗しました。')
      setLoading(false)
      return
    }
    if (data?.tableMissing) {
      setItems([])
      setErrorMessage('履歴テーブルが未作成です。SQLを実行してください。')
      setLoading(false)
      return
    }
    setItems(Array.isArray(data?.items) ? data.items : [])
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!accessToken) {
      setItems([])
      return
    }
    void fetchHistory(accessToken)
  }, [accessToken, fetchHistory])

  useEffect(() => {
    if (!accessToken) {
      for (const url of Object.values(historyBlobUrlsRef.current)) {
        URL.revokeObjectURL(url)
      }
      historyBlobUrlsRef.current = {}
      setHistoryBlobUrls({})
      return
    }

    const activeUsageIds = new Set(items.map((item) => item.usage_id))
    const nextBlobMap = { ...historyBlobUrlsRef.current }
    let shouldSyncBlobMap = false
    for (const [usageId, objectUrl] of Object.entries(nextBlobMap)) {
      if (activeUsageIds.has(usageId)) continue
      URL.revokeObjectURL(objectUrl)
      delete nextBlobMap[usageId]
      shouldSyncBlobMap = true
    }
    if (shouldSyncBlobMap) {
      historyBlobUrlsRef.current = nextBlobMap
      setHistoryBlobUrls({ ...nextBlobMap })
    }

    let cancelled = false
    const run = async () => {
      for (const item of items) {
        if (cancelled) return
        if (!item.image_url) continue
        if (historyBlobUrlsRef.current[item.usage_id]) continue

        try {
          const res = await fetch('/api/anima_history', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + accessToken,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ usage_id: item.usage_id }),
          })
          if (!res.ok) continue
          const blob = await res.blob()
          const objectUrl = URL.createObjectURL(blob)
          if (cancelled) {
            URL.revokeObjectURL(objectUrl)
            return
          }
          historyBlobUrlsRef.current[item.usage_id] = objectUrl
          setHistoryBlobUrls((prev) => ({ ...prev, [item.usage_id]: objectUrl }))
        } catch {
          // keep placeholder on fetch error
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [accessToken, items])

  useEffect(
    () => () => {
      for (const url of Object.values(historyBlobUrlsRef.current)) {
        URL.revokeObjectURL(url)
      }
      historyBlobUrlsRef.current = {}
    },
    [],
  )

  const handleSignOut = useCallback(async () => {
    if (!supabase) return
    await supabase.auth.signOut({ scope: 'local' })
  }, [])

  const handleGoogleSignIn = useCallback(async () => {
    if (!supabase || !isAuthConfigured) {
      window.alert('認証設定が不足しています。')
      return
    }
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: OAUTH_REDIRECT_URL,
        queryParams: { prompt: 'select_account' },
      },
    })
    if (error) {
      window.alert(error.message)
      return
    }
    if (data?.url) {
      window.location.assign(data.url)
      return
    }
    window.alert('OAuth URLの取得に失敗しました。')
  }, [])

  const handleRegenerate = useCallback(
    (item: HistoryItem) => {
      const preset = {
        prompt: item.prompt,
        negativePrompt: item.negative_prompt,
        width: item.width,
        height: item.height,
        steps: item.steps,
        cfg: item.cfg,
        seed: item.seed ?? 0,
        randomizeSeed: item.randomize_seed,
        samplerName: item.sampler_name,
        scheduler: item.scheduler,
      }
      try {
        window.sessionStorage.setItem(REGENERATE_STORAGE_KEY, JSON.stringify(preset))
      } catch {
        // no-op
      }
      navigate('/anime')
    },
    [navigate],
  )

  const handleDelete = useCallback(
    async (usageId: string) => {
      if (!accessToken) return
      const ok = window.confirm('この履歴を削除します。画像も削除されます。')
      if (!ok) return

      try {
        setDeletingUsageId(usageId)
        const res = await fetch('/api/anima_history', {
          method: 'DELETE',
          headers: {
            Authorization: 'Bearer ' + accessToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ usage_id: usageId }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          setErrorMessage(data?.error || '削除に失敗しました。')
          return
        }

        const objectUrl = historyBlobUrlsRef.current[usageId]
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl)
          delete historyBlobUrlsRef.current[usageId]
          setHistoryBlobUrls((prev) => {
            const next = { ...prev }
            delete next[usageId]
            return next
          })
        }

        setItems((prev) => prev.filter((item) => item.usage_id !== usageId))
      } catch {
        setErrorMessage('削除に失敗しました。')
      } finally {
        setDeletingUsageId(null)
      }
    },
    [accessToken],
  )

  const handleEdit = useCallback(
    (item: HistoryItem) => {
      if (!item.image_url) {
        setErrorMessage('編集用の画像が見つかりません。')
        return
      }
      try {
        window.sessionStorage.setItem(
          EDIT_SOURCE_STORAGE_KEY,
          JSON.stringify({
            imageUrl: item.image_url,
            usageId: item.usage_id,
          }),
        )
      } catch {
        // no-op
      }
      navigate('/image')
    },
    [navigate],
  )

  const historyBody = useMemo(() => {
    if (loading) return <div className='account-empty'>履歴を読み込み中...</div>
    if (errorMessage) return <div className='account-empty account-empty--error'>{errorMessage}</div>
    if (!hasHistory) return <div className='account-empty'>まだ生成履歴がありません。</div>

    return (
      <div className='account-history-grid'>
        {items.map((item) => (
          <article className='account-history-card' key={item.usage_id}>
            <div className='account-history-image-wrap'>
              {historyBlobUrls[item.usage_id] ? (
                <img src={historyBlobUrls[item.usage_id]} alt='生成画像' loading='lazy' />
              ) : item.image_url ? (
                <div className='account-history-image-placeholder'>読み込み中...</div>
              ) : (
                <div className='account-history-image-placeholder'>画像なし</div>
              )}
            </div>

            <div className='account-history-footer'>
              <div className='account-history-meta'>
                <span className='account-time'>{formatDate(item.created_at)}</span>
              </div>

              <div className='account-item-actions'>
                <button
                  className='ghost-button account-action-button'
                  type='button'
                  onClick={() => handleEdit(item)}
                  disabled={!item.image_url}
                >
                  編集
                </button>
                <button className='ghost-button account-action-button' type='button' onClick={() => handleRegenerate(item)}>
                  i2i
                </button>
                <button
                  className='ghost-button account-action-button account-action-button--danger'
                  type='button'
                  onClick={() => void handleDelete(item.usage_id)}
                  disabled={deletingUsageId === item.usage_id}
                >
                  {deletingUsageId === item.usage_id ? '削除中...' : '削除'}
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    )
  }, [deletingUsageId, errorMessage, handleDelete, handleEdit, handleRegenerate, hasHistory, items, loading])

  if (!authReady) {
    return (
      <div className='camera-app'>
        <TopNav />
      </div>
    )
  }

  if (!session) {
    return (
      <div className='camera-app'>
        <TopNav />
        <main className='account-shell'>
          <section className='account-panel'>
            <h1>アカウント</h1>
            <p>ログインすると過去の生成履歴を確認できます。</p>
            <button className='primary-button' type='button' onClick={handleGoogleSignIn}>
              Googleでログイン
            </button>
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className='camera-app'>
      <TopNav />
      <main className='account-shell'>
        <section className='account-panel'>
          <div className='account-header'>
            <div>
              <h1>アカウント</h1>
              <p>{session.user?.email || 'ログイン中ユーザー'}</p>
            </div>
            <div className='account-actions'>
              <button className='ghost-button' type='button' onClick={() => void fetchHistory(accessToken)}>
                更新
              </button>
              <button className='ghost-button' type='button' onClick={handleSignOut}>
                ログアウト
              </button>
            </div>
          </div>
          {historyBody}
        </section>
      </main>
    </div>
  )
}
