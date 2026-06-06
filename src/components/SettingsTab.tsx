import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useUserProfile } from '../lib/useUserProfile'

export default function SettingsTab() {
  const { profile, updateProfile, loading } = useUserProfile()
  const [saved, setSaved] = useState(false)
  const [displayName, setDisplayName] = useState('')

  // Sync display name when profile loads
  useEffect(() => {
    if (profile) {
      setDisplayName(profile.display_name || '')
    }
  }, [profile])

  async function handleSaveDisplayName() {
    if (!displayName.trim()) return
    const success = await updateProfile({ display_name: displayName.trim() })
    if (success) {
      showSaved()
    }
  }

  async function handleCurrencyChange(currency: 'USD' | 'NIS' | 'EUR' | 'GBP') {
    const success = await updateProfile({ display_currency: currency })
    if (success) {
      showSaved()
    }
  }

  async function handleLanguageChange(lang: 'en' | 'he' | 'es' | 'de' | 'fr') {
    const success = await updateProfile({ ai_response_language: lang })
    if (success) {
      showSaved()
    }
  }

  function showSaved() {
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
  }

  if (loading) {
    return (
      <div className="px-6 py-8 max-w-3xl w-full mx-auto">
        <div className="flex items-center justify-center h-64 text-gray-500">Loading settings…</div>
      </div>
    )
  }

  if (!profile) {
    return (
      <div className="px-6 py-8 max-w-3xl w-full mx-auto">
        <div className="flex items-center justify-center h-64 text-gray-500">Not authenticated</div>
      </div>
    )
  }

  return (
    <div className="px-6 py-8 max-w-3xl w-full mx-auto">
      {/* Saved notification */}
      {saved && (
        <div className="fixed top-4 right-4 px-4 py-2 rounded-lg bg-green-600/20 border border-green-600/50 text-sm text-green-300 animate-fade-out">
          Saved ✓
        </div>
      )}

      {/* Profile Section */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-6">Profile</h2>
        <div className="space-y-6">
          {/* Display Name */}
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-wider mb-2">Display Name (optional)</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                className="flex-1 px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleSaveDisplayName}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 transition-colors"
              >
                Save
              </button>
            </div>
            <p className="text-xs text-gray-600 mt-2">Used in AI summaries and exports</p>
          </div>

          {/* Display Currency */}
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-wider mb-2">Display Currency</label>
            <select
              value={profile.display_currency}
              onChange={(e) => handleCurrencyChange(e.target.value as any)}
              className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="USD">USD ($) – US Dollar</option>
              <option value="NIS">NIS (₪) – Israeli Shekel</option>
              <option value="EUR">EUR (€) – Euro</option>
              <option value="GBP">GBP (£) – British Pound</option>
            </select>
            <p className="text-xs text-gray-600 mt-2">Used for RSU tracker and portfolio aggregates</p>
          </div>

          {/* AI Response Language */}
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-wider mb-2">AI Response Language</label>
            <select
              value={profile.ai_response_language}
              onChange={(e) => handleLanguageChange(e.target.value as any)}
              className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="en">English</option>
              <option value="he">עברית (Hebrew)</option>
              <option value="es">Español (Spanish)</option>
              <option value="de">Deutsch (German)</option>
              <option value="fr">Français (French)</option>
            </select>
            <p className="text-xs text-gray-600 mt-2">Language for AI-generated summaries</p>
          </div>
        </div>
      </div>

      {/* Behavior Section */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-6">Behavior</h2>
        <div className="p-4 rounded-lg bg-gray-900 border border-gray-800 text-gray-500 text-sm">
          More options coming in future sprints (refresh cadence, inline indicators, deletion behavior)
        </div>
      </div>

      {/* Security Section */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-6">Security</h2>
        <div className="space-y-4">
          {/* Email */}
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-wider mb-2">Email (read-only)</label>
            <input
              type="email"
              value={profile.email || ''}
              disabled
              className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-gray-400 text-sm cursor-not-allowed"
            />
          </div>

          {/* Sign Out */}
          <button
            onClick={handleSignOut}
            className="w-full px-4 py-2 rounded-lg bg-red-600/10 border border-red-700/30 text-red-400 text-sm font-semibold hover:bg-red-600/20 transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Footer */}
      <div className="text-xs text-gray-600 text-center pt-4">
        Changes save immediately. All settings are stored securely.
      </div>
    </div>
  )
}
