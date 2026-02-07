import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabaseClient'
import './account.css'

export function Account() {
  const [session, setSession] = useState<Session | null>(null)

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
    })
    return () => subscription.unsubscribe()
  }, [])

  const handleSignOut = async () => {
    if (!supabase) return
    await supabase.auth.signOut({ scope: 'local' })
  }

  if (!session) {
    return (
      <div className="account-page">
        <div className="account-card">
          <h1>アカウント</h1>
          <p>ログインしてアカウントを表示してください。</p>
          <a className="primary" href="/">
            アプリに戻る
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="account-page">
      <div className="account-card">
        <h1>アカウント</h1>
        <p>{session.user?.email || 'ログイン中ユーザー'}</p>
        <button className="ghost" type="button" onClick={handleSignOut}>
          ログアウト
        </button>
      </div>
    </div>
  )
}
