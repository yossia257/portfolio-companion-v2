import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

interface Profile {
  display_name: string | null
  display_currency: string
}

interface Holding {
  id: string
  ticker: string
  name: string | null
  quantity: number | string | null
  currency: string | null
  buy_price: number | string | null
  category: string | null
}

function fmtQty(val: number | string | null): string {
  if (val == null || val === '') return '—'
  const n = Number(val)
  return isNaN(n) ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

function fmtPrice(val: number | string | null): string {
  if (val == null || val === '') return '—'
  const n = Number(val)
  return isNaN(n) ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function MainPage({
  session,
  onNavigateUpload,
}: {
  session: Session
  onNavigateUpload: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<Profile | null>(null)
  // null = no active portfolio exists; [] = portfolio exists but is empty
  const [holdings, setHoldings] = useState<Holding[] | null>(null)

  useEffect(() => {
    let cancelled = false

    async function fetchData() {
      setLoading(true)

      // 1. Fetch the user's profile for display_currency
      const { data: profileData } = await supabase
        .from('profiles')
        .select('display_name, display_currency')
        .eq('id', session.user.id)
        .single()

      if (cancelled) return
      if (profileData) setProfile(profileData)

      // 2. Fetch the active portfolio (maybeSingle — no error if absent)
      const { data: portfolio } = await supabase
        .from('portfolios')
        .select('id')
        .eq('user_id', session.user.id)
        .eq('is_active', true)
        .maybeSingle()

      if (cancelled) return

      if (!portfolio) {
        setHoldings(null)
        setLoading(false)
        return
      }

      // 3. Fetch non-deleted holdings for that portfolio
      const { data: holdingsData } = await supabase
        .from('holdings')
        .select('id, ticker, name, quantity, currency, buy_price, category')
        .eq('portfolio_id', portfolio.id)
        .is('deleted_at', null)
        .order('ticker', { ascending: true })

      if (cancelled) return
      setHoldings(holdingsData ?? [])
      setLoading(false)
    }

    fetchData()

    return () => {
      cancelled = true
    }
  }, [session.user.id])

  async function signOut() {
    await supabase.auth.signOut()
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">

      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between shrink-0">
        <h1 className="text-lg font-semibold text-white tracking-tight">
          Portfolio Companion
        </h1>
        <div className="flex items-center gap-3">
          {holdings !== null && (
            <button
              onClick={onNavigateUpload}
              className="px-4 py-2 rounded-lg bg-gray-800 text-gray-200 text-sm hover:bg-gray-700 transition-colors"
            >
              Re-upload
            </button>
          )}
          <button
            onClick={signOut}
            className="px-4 py-2 rounded-lg bg-gray-800 text-gray-200 text-sm hover:bg-gray-700 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Body */}
      <main className="flex-1 px-6 py-8 max-w-6xl w-full mx-auto">

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center h-64 text-gray-500">
            Loading portfolio…
          </div>
        )}

        {/* Empty state — no active portfolio */}
        {!loading && holdings === null && (
          <div className="flex flex-col items-center justify-center h-[60vh] gap-6 text-center">
            <div>
              <p className="text-2xl font-semibold text-white mb-2">
                Welcome — let's get your portfolio in
              </p>
              <p className="text-gray-400 text-sm">
                Upload a CSV or Excel file to import your holdings in seconds.
              </p>
            </div>
            <div className="flex flex-col items-center gap-3">
              <button
                onClick={onNavigateUpload}
                className="px-6 py-3 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-500 transition-colors"
              >
                Upload a file
              </button>
              <button className="text-gray-500 text-sm hover:text-gray-300 transition-colors">
                I'll add manually later
              </button>
            </div>
          </div>
        )}

        {/* Holdings view */}
        {!loading && holdings !== null && (
          <>
            {/* KPI row */}
            <div className="flex items-center gap-6 mb-6">
              <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-0.5">Holdings</p>
                <p className="text-xl font-bold text-white">{holdings.length}</p>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-0.5">Display Currency</p>
                <p className="text-xl font-bold text-white">{profile?.display_currency ?? '—'}</p>
              </div>
            </div>

            {/* Empty portfolio (has portfolio row but no holdings) */}
            {holdings.length === 0 && (
              <div className="flex flex-col items-center justify-center py-24 gap-4 text-center border border-dashed border-gray-800 rounded-xl">
                <p className="text-gray-400">No holdings yet in this portfolio.</p>
                <button
                  onClick={onNavigateUpload}
                  className="px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 transition-colors"
                >
                  Upload a file
                </button>
              </div>
            )}

            {/* Holdings table */}
            {holdings.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-gray-800">
                <table className="w-full text-sm">
                  <thead className="bg-gray-900 text-gray-400">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">Ticker</th>
                      <th className="px-4 py-3 text-left font-medium">Name</th>
                      <th className="px-4 py-3 text-right font-medium">Qty</th>
                      <th className="px-4 py-3 text-left font-medium">Currency</th>
                      <th className="px-4 py-3 text-right font-medium">Buy Price</th>
                      <th className="px-4 py-3 text-left font-medium">Category</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.map((h, i) => (
                      <tr
                        key={h.id}
                        className={`border-t border-gray-800 hover:bg-gray-900/50 transition-colors ${
                          i % 2 === 0 ? '' : 'bg-gray-900/20'
                        }`}
                      >
                        <td className="px-4 py-3 font-mono font-semibold text-white">
                          {h.ticker}
                        </td>
                        <td className="px-4 py-3 text-gray-300 max-w-[200px] truncate">
                          {h.name ?? <span className="text-gray-600">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-200 tabular-nums">
                          {fmtQty(h.quantity)}
                        </td>
                        <td className="px-4 py-3 text-gray-400">
                          {h.currency ?? <span className="text-gray-600">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-200 tabular-nums">
                          {fmtPrice(h.buy_price)}
                        </td>
                        <td className="px-4 py-3 text-gray-400">
                          {h.category ?? <span className="text-gray-600">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
