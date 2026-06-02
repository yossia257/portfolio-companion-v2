import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)

  // Restore session on mount and listen for auth changes (covers magic-link redirect)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    await supabase.auth.signInWithOtp({ email })
    setSubmitted(true)
    setLoading(false)
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-4">
      <h1 className="text-4xl font-bold text-white mb-10">
        Portfolio Companion — v2
      </h1>

      {session ? (
        // Logged-in view
        <div className="flex flex-col items-center gap-6">
          <p className="text-xl text-gray-300">
            Hello, <span className="text-white font-semibold">{session.user.email}</span>
          </p>
          <button
            onClick={signOut}
            className="px-6 py-2 rounded-lg bg-gray-800 text-gray-200 hover:bg-gray-700 transition-colors"
          >
            Sign out
          </button>
        </div>
      ) : submitted ? (
        // Post-submit confirmation
        <p className="text-gray-400 text-lg">
          Check your inbox at <span className="text-white font-medium">{email}</span>
        </p>
      ) : (
        // Logged-out view
        <form onSubmit={sendMagicLink} className="flex flex-col items-center gap-4 w-full max-w-sm">
          <input
            type="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-3 rounded-lg bg-gray-800 text-white placeholder-gray-500 border border-gray-700 focus:outline-none focus:border-gray-500"
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full px-6 py-3 rounded-lg bg-white text-gray-950 font-semibold hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            {loading ? 'Sending…' : 'Send magic link'}
          </button>
        </form>
      )}
    </div>
  )
}
