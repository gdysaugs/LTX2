import { useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isAuthConfigured, supabase } from '../lib/supabaseClient'
import { CHARACTER_PROFILES, type CharacterProfile } from '../lib/characterProfiles'
import './chat.css'

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  isLoading?: boolean
  error?: string
}

type ChatMessageRow = {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

const OAUTH_REDIRECT_URL =
  import.meta.env.VITE_SUPABASE_REDIRECT_URL ?? (typeof window !== 'undefined' ? window.location.origin : undefined)

const makeId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const formatTime = (value: string) => {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

const resolveProfile = (id?: string | null) =>
  CHARACTER_PROFILES.find((profile) => profile.id === id) ?? CHARACTER_PROFILES[0]

const buildSystemPrompt = (profile: CharacterProfile) =>
  [
    `You are ${profile.name}.`,
    `Title: ${profile.title}${profile.location ? ` / ${profile.location}` : ''}.`,
    `Bio: ${profile.bio}`,
    `Motto: ${profile.motto}`,
    'Explain XM in simple terms and highlight benefits without guaranteeing profits.',
    'Do not claim zero risk or guaranteed wins. Avoid financial advice or trade instructions.',
    'If asked for actions, keep it general (education only).',
    'Use a tsundere tone (confident, slightly sharp, but kind at the end).',
    'Respond in Japanese.',
  ].join('\n')

export function Chat() {
  const profile = useMemo(() => resolveProfile('ayaka'), [])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatStatus, setChatStatus] = useState<'idle' | 'loading'>('idle')
  const [guestTurns, setGuestTurns] = useState(0)
  const [session, setSession] = useState<Session | null>(null)
  const [historyStatus, setHistoryStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [historyMessage, setHistoryMessage] = useState('')
  const [authStatus, setAuthStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [authMessage, setAuthMessage] = useState('')
  const [showAuthModal, setShowAuthModal] = useState(false)
  const messagesRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!messagesRef.current) return
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight
  }, [messages])

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
    const hasCode = typeof window !== 'undefined' && window.location.search.includes('code=')
    const hasState = typeof window !== 'undefined' && window.location.search.includes('state=')
    if (!hasCode || !hasState) return
    supabase.auth.exchangeCodeForSession(window.location.href).then(({ error }) => {
      if (error) {
        setAuthStatus('error')
        setAuthMessage(error.message)
        return
      }
      const url = new URL(window.location.href)
      url.searchParams.delete('code')
      url.searchParams.delete('state')
      window.history.replaceState({}, document.title, url.toString())
    })
  }, [])

  useEffect(() => {
    if (session) {
      setShowAuthModal(false)
      setGuestTurns(0)
    }
  }, [session])

  useEffect(() => {
    const client = supabase
    if (!client || !session?.user?.id) {
      setMessages([])
      setHistoryStatus('idle')
      setHistoryMessage('')
      return
    }
    let active = true
    const loadHistory = async () => {
      setHistoryStatus('loading')
      setHistoryMessage('')
      const { data, error } = await client
        .from('chat_messages')
        .select('id, role, content, created_at')
        .eq('user_id', session.user.id)
        .eq('character_id', profile.id)
        .order('created_at', { ascending: false })
        .limit(200)
      if (!active) return
      if (error) {
        setHistoryStatus('error')
        setHistoryMessage(error.message)
        return
      }
      const rows: ChatMessage[] = ((data ?? []) as ChatMessageRow[]).map((row) => ({
        id: row.id,
        role: row.role === 'assistant' ? 'assistant' : 'user',
        content: row.content,
        createdAt: row.created_at,
      }))
      setMessages(rows.reverse())
      setHistoryStatus('success')
    }
    void loadHistory()
    return () => {
      active = false
    }
  }, [profile.id, session?.user?.id])

  const openAuthModal = () => setShowAuthModal(true)
  const closeAuthModal = () => setShowAuthModal(false)

  const handleGoogleSignIn = async () => {
    if (!supabase || !isAuthConfigured) {
      setAuthStatus('error')
      setAuthMessage('Auth is not configured.')
      return
    }
    setAuthStatus('loading')
    setAuthMessage('')
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: OAUTH_REDIRECT_URL, skipBrowserRedirect: true },
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
    setAuthMessage('Could not fetch auth URL.')
  }

  const handleSignOut = async () => {
    if (!supabase) return
    try {
      await supabase.auth.signOut({ scope: 'local' })
    } catch (error) {
      setAuthStatus('error')
      setAuthMessage(error instanceof Error ? error.message : 'Sign out failed.')
    }
  }

  const persistMessage = async (message: ChatMessage) => {
    const client = supabase
    if (!client || !session?.user?.id) return
    const payload = {
      user_id: session.user.id,
      character_id: profile.id,
      role: message.role,
      content: message.content,
    }
    const { error } = await client.from('chat_messages').insert(payload)
    if (error) {
      setHistoryStatus('error')
      setHistoryMessage(error.message)
    }
  }

  const appendMessage = (message: ChatMessage) => {
    setMessages((prev) => [...prev, message])
  }

  const updateMessage = (id: string, updater: (prev: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((message) => (message.id === id ? updater(message) : message)))
  }

  const removeMessage = (id: string) => {
    setMessages((prev) => prev.filter((message) => message.id !== id))
  }

  const handleSend = async () => {
    const trimmed = chatInput.trim()
    if (!trimmed || chatStatus === 'loading') return
    if (!session && guestTurns >= 1) {
      openAuthModal()
      return
    }

    const userMessage: ChatMessage = {
      id: makeId(),
      role: 'user',
      content: trimmed,
      createdAt: new Date().toISOString(),
    }
    const placeholderId = makeId()
    appendMessage(userMessage)
    appendMessage({
      id: placeholderId,
      role: 'assistant',
      content: '...',
      createdAt: new Date().toISOString(),
      isLoading: true,
    })
    setChatInput('')
    setChatStatus('loading')
    if (!session) setGuestTurns((prev) => prev + 1)
    void persistMessage(userMessage)

    try {
      const history = [...messages, userMessage]
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .slice(-8)
        .map((message) => ({ role: message.role, content: message.content }))

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (session?.access_token) {
        headers.Authorization = `Bearer ${session.access_token}`
      }

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          systemPrompt: buildSystemPrompt(profile),
          messages: history,
        }),
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok && res.status === 401) {
        removeMessage(placeholderId)
        openAuthModal()
        setChatStatus('idle')
        return
      }
      if (!res.ok) {
        const error = data?.error || 'Failed to generate response.'
        updateMessage(placeholderId, (prev) => ({
          ...prev,
          content: error,
          isLoading: false,
          error,
        }))
        setChatStatus('idle')
        return
      }

      const text =
        (data?.choices?.[0]?.message?.content as string) ||
        (data?.output_text as string) ||
        (data?.text as string) ||
        ''

      updateMessage(placeholderId, (prev) => ({
        ...prev,
        content: text || 'No response.',
        isLoading: false,
      }))
      void persistMessage({
        id: placeholderId,
        role: 'assistant',
        content: text || 'No response.',
        createdAt: new Date().toISOString(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate response.'
      updateMessage(placeholderId, (prev) => ({
        ...prev,
        content: message,
        isLoading: false,
        error: message,
      }))
    } finally {
      setChatStatus('idle')
    }
  }

  return (
    <div className="chat-page">
      <header className="chat-header">
        <div className="chat-header__profile">
          <img src={profile.image} alt={profile.name} />
          <div>
            <div className="chat-header__name">{profile.name}</div>
            <div className="chat-header__meta">{profile.title}</div>
          </div>
        </div>
        <div className="chat-header__actions">
          {session ? (
            <>
              <span className="chat-header__email">{session.user?.email || 'Signed in'}</span>
              <button type="button" className="ghost" onClick={handleSignOut}>
                Sign out
              </button>
            </>
          ) : (
            <button type="button" className="primary" onClick={handleGoogleSignIn}>
              Sign in with Google
            </button>
          )}
        </div>
      </header>

      <section className="chat-hero">
        <div className="chat-hero__card">
          <div className="chat-hero__title">{profile.name}</div>
          <div className="chat-hero__handle">{profile.handle}</div>
          <p className="chat-hero__bio">{profile.bio}</p>
          <p className="chat-hero__motto">{profile.motto}</p>
        </div>
      </section>

      <main className="chat-thread">
        <div className="chat-thread__messages" ref={messagesRef}>
          {historyStatus === 'loading' && <div className="chat-thread__notice">Loading history...</div>}
          {historyStatus === 'error' && (
            <div className="chat-thread__notice">History error: {historyMessage}</div>
          )}
          {messages.length === 0 && (
            <div className="chat-row chat-row--assistant">
              <div className="chat-avatar">
                <img src={profile.image} alt={profile.name} />
              </div>
              <div className="chat-bubble chat-bubble--assistant">
                <div className="chat-bubble__meta">{profile.name}</div>
                <div className="chat-bubble__text">Say hi to start the chat.</div>
              </div>
            </div>
          )}

          {messages.map((message) => (
            <div
              key={message.id}
              className={`chat-row ${message.role === 'user' ? 'chat-row--user' : 'chat-row--assistant'}`}
            >
              {message.role === 'assistant' && (
                <div className="chat-avatar">
                  <img src={profile.image} alt={profile.name} />
                </div>
              )}
              <div className={`chat-bubble ${message.role === 'user' ? 'chat-bubble--user' : 'chat-bubble--assistant'}`}>
                <div className="chat-bubble__meta">
                  <span>{message.role === 'user' ? 'You' : profile.name}</span>
                  <span>{formatTime(message.createdAt)}</span>
                </div>
                <div className="chat-bubble__text">{message.content}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="chat-input">
          <textarea
            value={chatInput}
            onChange={(event) => setChatInput(event.target.value)}
            placeholder="Type your message..."
            rows={2}
          />
          <button type="button" className="primary" onClick={handleSend} disabled={chatStatus === 'loading'}>
            {chatStatus === 'loading' ? 'Sending...' : 'Send'}
          </button>
        </div>
      </main>

      {showAuthModal && (
        <div className="auth-modal" role="dialog" aria-modal="true">
          <button type="button" className="auth-modal__backdrop" onClick={closeAuthModal} aria-label="Close" />
          <div className="auth-modal__content">
            <h2>Sign in required</h2>
            <p>Please sign in with Google to continue.</p>
            <button
              type="button"
              className="primary"
              onClick={handleGoogleSignIn}
              disabled={authStatus === 'loading'}
            >
              {authStatus === 'loading' ? 'Opening...' : 'Sign in with Google'}
            </button>
            {authMessage && <div className="auth-message">{authMessage}</div>}
          </div>
        </div>
      )}
    </div>
  )
}
