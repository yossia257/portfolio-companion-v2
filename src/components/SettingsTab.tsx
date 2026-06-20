import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useUserProfile } from '../lib/useUserProfile'

interface ArchivedHolding {
  id: string
  ticker: string
  name: string | null
  deleted_at: string
}

interface SettingsTabProps {
  onHoldingUpdated?: () => Promise<void>
}

export default function SettingsTab({ onHoldingUpdated }: SettingsTabProps) {
  const { profile, updateProfile, loading } = useUserProfile()
  const [saved, setSaved] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [archivedHoldings, setArchivedHoldings] = useState<ArchivedHolding[]>([])
  const [archivedLoading, setArchivedLoading] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [investmentProfile, setInvestmentProfile] = useState({
    investment_horizon: '',
    risk_tolerance: '',
    portfolio_style: '',
    themes_of_interest: '',
    themes_to_avoid: '',
    tax_sensitivity: '',
  })

  // Sync display name and investment profile when profile loads
  useEffect(() => {
    if (profile) {
      setDisplayName(profile.display_name || '')
      setInvestmentProfile({
        investment_horizon: (profile as any)?.investment_horizon || '',
        risk_tolerance: (profile as any)?.risk_tolerance || '',
        portfolio_style: (profile as any)?.portfolio_style || '',
        themes_of_interest: (profile as any)?.themes_of_interest || '',
        themes_to_avoid: (profile as any)?.themes_to_avoid || '',
        tax_sensitivity: (profile as any)?.tax_sensitivity || '',
      })
    }
  }, [profile])

  // Fetch archived holdings
  useEffect(() => {
    fetchArchivedHoldings()
  }, [])

  async function fetchArchivedHoldings() {
    setArchivedLoading(true)
    try {
      // Get user's active portfolio
      const { data: portfolio } = await supabase
        .from('portfolios')
        .select('id')
        .eq('user_id', (await supabase.auth.getUser()).data.user?.id || '')
        .eq('is_active', true)
        .maybeSingle()

      if (!portfolio) {
        setArchivedHoldings([])
        return
      }

      // Get deleted holdings from last 30 days
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

      const { data } = await supabase
        .from('holdings')
        .select('id, ticker, name, deleted_at')
        .eq('portfolio_id', portfolio.id)
        .not('deleted_at', 'is', null)
        .gte('deleted_at', thirtyDaysAgo.toISOString())
        .order('deleted_at', { ascending: false })

      setArchivedHoldings(data ?? [])
    } catch (e) {
      console.error('Error fetching archived holdings:', e)
    } finally {
      setArchivedLoading(false)
    }
  }

  function formatRelativeTime(dateString: string): string {
    const deleted = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - deleted.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffDays === 0) {
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
      if (diffHours === 0) {
        const diffMins = Math.floor(diffMs / (1000 * 60))
        return diffMins <= 1 ? 'just now' : `${diffMins}m ago`
      }
      return diffHours === 1 ? '1 hour ago' : `${diffHours}h ago`
    }
    return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`
  }

  async function handleRestore(holding: ArchivedHolding) {
    setRestoringId(holding.id)
    try {
      await supabase
        .from('holdings')
        .update({ deleted_at: null })
        .eq('id', holding.id)

      // Show toast
      const toastDiv = document.createElement('div')
      toastDiv.className = 'fixed bottom-4 right-4 px-4 py-2 rounded-lg bg-green-600/20 border border-green-600/50 text-sm text-green-300 animate-fade-out'
      toastDiv.textContent = `Restored ${holding.ticker}`
      document.body.appendChild(toastDiv)
      setTimeout(() => toastDiv.remove(), 2000)

      // Refetch archived holdings and portfolio data
      await fetchArchivedHoldings()
      if (onHoldingUpdated) {
        await onHoldingUpdated()
      }
    } catch (e) {
      console.error('Error restoring holding:', e)
    } finally {
      setRestoringId(null)
    }
  }

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

  async function handleTaxJurisdictionChange(jurisdiction: 'IL' | 'US' | 'UK' | 'EU' | 'OTHER') {
    const success = await updateProfile({ tax_jurisdiction: jurisdiction as any })
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

  async function handleInvestmentProfileChange(field: string, value: string) {
    setInvestmentProfile((prev) => ({ ...prev, [field]: value }))
    const success = await updateProfile({ [field]: value || null })
    if (success) {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }
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
              value={profile?.display_currency || 'NIS'}
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
              value={profile?.ai_response_language || 'en'}
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

          {/* Tax Jurisdiction */}
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-wider mb-2">Tax Jurisdiction</label>
            <select
              value={(profile as any)?.tax_jurisdiction || 'IL'}
              onChange={(e) => handleTaxJurisdictionChange(e.target.value as any)}
              className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="IL">Israel (IL)</option>
              <option value="US">USA (US)</option>
              <option value="UK">UK (UK)</option>
              <option value="EU">EU (EU)</option>
              <option value="OTHER">Other</option>
            </select>
            <p className="text-xs text-gray-600 mt-2">Used for tax calculation rules and RSU estimates</p>
          </div>
        </div>
      </div>

      {/* Investment Profile Section */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-2">🎯 Investment Profile</h2>
        <p className="text-sm text-gray-400 mb-6">Helps Claude generate suggestions tailored to your style. All fields optional.</p>

        <div className="space-y-6">
          {/* Investment Horizon */}
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-wider mb-2">Investment Horizon</label>
            <select
              value={investmentProfile.investment_horizon}
              onChange={(e) => handleInvestmentProfileChange('investment_horizon', e.target.value)}
              className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="">—</option>
              <option value="short">Short-term (&lt; 6 months) — active deployment, near-term needs</option>
              <option value="medium_short">Medium short (6 months – 2 years) — bonus deployment, planned purchases</option>
              <option value="medium">Medium (2–5 years) — general planning</option>
              <option value="long">Long (5+ years) — retirement, generational wealth</option>
              <option value="mixed">Mixed (multiple horizons across positions)</option>
            </select>
          </div>

          {/* Risk Tolerance */}
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-wider mb-2">Risk Tolerance</label>
            <select
              value={investmentProfile.risk_tolerance}
              onChange={(e) => handleInvestmentProfileChange('risk_tolerance', e.target.value)}
              className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="">—</option>
              <option value="low">Low — capital preservation primary, low volatility</option>
              <option value="medium">Medium — balanced; moderate volatility OK</option>
              <option value="high">High — comfortable with leverage, crypto, volatility</option>
            </select>
          </div>

          {/* Portfolio Style */}
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-wider mb-2">Portfolio Style</label>
            <select
              value={investmentProfile.portfolio_style}
              onChange={(e) => handleInvestmentProfileChange('portfolio_style', e.target.value)}
              className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="">—</option>
              <option value="focused">Focused (high-conviction positions, 10–15 holdings)</option>
              <option value="diversified_sector">Diversified by sector (spread across industries)</option>
              <option value="diversified_global">Diversified globally (multi-region + multi-sector)</option>
              <option value="opportunistic">Opportunistic / flexible (no fixed structure)</option>
            </select>
          </div>

          {/* Themes of Interest */}
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-wider mb-2">Themes of Interest (optional)</label>
            <textarea
              value={investmentProfile.themes_of_interest}
              onChange={(e) => handleInvestmentProfileChange('themes_of_interest', e.target.value.slice(0, 500))}
              placeholder="e.g., cybersecurity, longevity, quantum computing, India growth, AI infrastructure"
              maxLength={500}
              className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500 resize-none"
              rows={3}
            />
            <p className="text-xs text-gray-600 mt-1">{investmentProfile.themes_of_interest.length}/500 characters</p>
          </div>

          {/* Themes to Avoid */}
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-wider mb-2">Themes to Avoid (optional)</label>
            <textarea
              value={investmentProfile.themes_to_avoid}
              onChange={(e) => handleInvestmentProfileChange('themes_to_avoid', e.target.value.slice(0, 500))}
              placeholder="e.g., tobacco, defense, gambling, leveraged ETFs, single-name biotech"
              maxLength={500}
              className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500 resize-none"
              rows={3}
            />
            <p className="text-xs text-gray-600 mt-1">
              {investmentProfile.themes_to_avoid.length}/500 characters
            </p>
            <p className="text-xs text-gray-500 mt-2">💡 These will be excluded from AI suggestions strictly.</p>
          </div>

          {/* Tax Sensitivity */}
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-wider mb-2">Tax Sensitivity</label>
            <select
              value={investmentProfile.tax_sensitivity}
              onChange={(e) => handleInvestmentProfileChange('tax_sensitivity', e.target.value)}
              className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="">—</option>
              <option value="tax_aware">Tax-aware — prefer to defer gains; weight tax cost when suggesting position changes</option>
              <option value="neutral">Neutral — tax not a current priority</option>
            </select>
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
              value={profile?.email || ''}
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

      {/* Archived Holdings Section */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-2">📦 Archived Holdings</h2>
        <p className="text-sm text-gray-400 mb-6">Holdings you deleted in the last 30 days. Restore to your portfolio at any time.</p>

        {archivedLoading ? (
          <div className="text-sm text-gray-500">Loading archived holdings…</div>
        ) : archivedHoldings.length === 0 ? (
          <div className="text-sm text-gray-500">No deleted holdings.</div>
        ) : (
          <div className="overflow-x-auto border border-gray-800 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-gray-900">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-400">Ticker</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-400">Name</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-400">Deleted</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-400">Action</th>
                </tr>
              </thead>
              <tbody>
                {archivedHoldings.map((holding) => (
                  <tr
                    key={holding.id}
                    className="border-t border-gray-800 hover:bg-gray-900/50 transition-colors"
                  >
                    <td className="px-4 py-3 font-mono font-semibold text-white">{holding.ticker}</td>
                    <td className="px-4 py-3 text-gray-300">{holding.name ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-400">{formatRelativeTime(holding.deleted_at)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleRestore(holding)}
                        disabled={restoringId === holding.id}
                        className="px-3 py-1 rounded bg-blue-600/20 border border-blue-600/50 text-blue-400 text-xs hover:bg-blue-600/30 transition-colors disabled:opacity-50 font-semibold"
                      >
                        {restoringId === holding.id ? 'Restoring…' : 'Restore'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="text-xs text-gray-600 text-center pt-4">
        Changes save immediately. All settings are stored securely.
      </div>
    </div>
  )
}
