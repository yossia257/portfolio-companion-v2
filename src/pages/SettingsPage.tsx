import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'he', label: 'עברית' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
] as const

type LangCode = typeof LANGUAGES[number]['code']

export default function SettingsPage({
  session,
  onBack,
}: {
  session: Session
  onBack: () => void
}) {
  const [language, setLanguage] = useState<LangCode>('en')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedOk, setSavedOk] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    supabase
      .from('profiles')
      .select('ai_response_language')
      .eq('id', session.user.id)
      .single()
      .then(({ data }) => {
        setLanguage((data?.ai_response_language as LangCode) ?? 'en')
        setLoading(false)
      })
  }, [session.user.id])

  async function save() {
    setSaving(true)
    setErrorMsg(null)
    const { error } = await supabase
      .from('profiles')
      .update({ ai_response_language: language })
      .eq('id', session.user.id)

    if (error) {
      setErrorMsg(error.message)
    } else {
      setSavedOk(true)
      setTimeout(() => setSavedOk(false), 2500)
    }
    setSaving(false)
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      {/* Header */}
      <header className="bg-gray-950 border-b border-gray-800 px-6 py-4 flex items-center gap-4">
        <button
          onClick={onBack}
          className="text-gray-400 hover:text-white transition-colors text-sm"
        >
          ← Back
        </button>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
      </header>

      <main className="flex-1 px-6 py-10 max-w-lg w-full mx-auto">
        {loading ? (
          <div className="h-8 w-48 rounded bg-gray-800 animate-pulse" />
        ) : (
          <section className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-5">
            <h2 className="text-xs uppercase tracking-wider text-gray-500 mb-4">
              AI Response Language
            </h2>

            <div className="space-y-2 mb-6">
              {LANGUAGES.map(({ code, label }) => (
                <label
                  key={code}
                  className={`flex items-center gap-3 px-4 py-3 rounded-lg cursor-pointer transition-colors border ${
                    language === code
                      ? 'border-blue-600 bg-blue-950/30 text-white'
                      : 'border-gray-800 hover:border-gray-700 text-gray-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="language"
                    value={code}
                    checked={language === code}
                    onChange={() => setLanguage(code)}
                    className="accent-blue-500"
                  />
                  <span className="text-sm font-medium">{label}</span>
                </label>
              ))}
            </div>

            {errorMsg && (
              <p className="text-sm text-red-400 mb-3">{errorMsg}</p>
            )}

            <button
              onClick={save}
              disabled={saving}
              className="px-5 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : savedOk ? 'Saved ✓' : 'Save'}
            </button>
          </section>
        )}
      </main>
    </div>
  )
}
