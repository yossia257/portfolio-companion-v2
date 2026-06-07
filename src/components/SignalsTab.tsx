import { useMemo, useState } from 'react'
import { generateSignals, type Signal } from '../lib/signals'
import DrillDownPanel from './DrillDownPanel'
import { useUserProfile } from '../lib/useUserProfile'
import type { Holding } from '../pages/MainPage'
import type { PriceMap, PriceEntry, ErrorEntry } from '../lib/prices'
import type { ResearchCacheRow } from '../lib/signals'

interface SignalsTabProps {
  holdings: Holding[]
  prices: PriceMap
  research?: Record<string, ResearchCacheRow>
  usdNisRate: number
}

export default function SignalsTab({
  holdings,
  prices,
  research = {},
  usdNisRate,
}: SignalsTabProps) {
  const { profile } = useUserProfile()
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null)

  const signals = useMemo(
    () => generateSignals(holdings, prices, research, usdNisRate),
    [holdings, prices, research, usdNisRate]
  )

  const displayCcy = profile?.display_currency ?? 'NIS'
  const ccySymbol = displayCcy === 'NIS' ? '₪' : displayCcy === 'USD' ? '$' : displayCcy

  // Group signals by severity for optional section headers
  const grouped = signals.reduce(
    (acc, signal) => {
      if (!acc[signal.severity]) acc[signal.severity] = []
      acc[signal.severity].push(signal)
      return acc
    },
    { action: [] as Signal[], warn: [] as Signal[], info: [] as Signal[] }
  )

  const severityConfig = {
    action: { label: '⚠️ Action Items', bgColor: 'bg-red-950/20', badgeBg: 'bg-red-600', badgeText: 'text-white' },
    warn: { label: '🔍 Worth Watching', bgColor: 'bg-amber-950/20', badgeBg: 'bg-amber-500', badgeText: 'text-gray-950' },
    info: { label: 'ℹ️ FYI', bgColor: 'bg-blue-950/20', badgeBg: 'bg-blue-500', badgeText: 'text-white' },
  }

  // Get holding for selected ticker to pass to DrillDownPanel
  const selectedHolding = selectedTicker
    ? holdings.find((h) => h.ticker === selectedTicker)
    : null

  return (
    <div className="px-6 py-8 max-w-6xl w-full mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">⚡ Signals — things worth a look</h1>
        <p className="text-sm text-gray-400 mb-6">
          Auto-generated from your current portfolio and market data. Click any card to see full research.
        </p>
        <button
          onClick={() => {
            // Force re-run of useMemo by changing deps
            window.location.reload()
          }}
          className="px-4 py-2 rounded-lg bg-gray-800 text-gray-200 text-sm hover:bg-gray-700 transition-colors"
        >
          Refresh Now ↻
        </button>
      </div>

      {/* Empty state */}
      {signals.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-gray-500 text-lg">All quiet. No flags right now.</p>
          <p className="text-gray-600 text-sm mt-2">
            Check back as market conditions change or your portfolio evolves.
          </p>
        </div>
      ) : (
        <>
          {/* Grouped sections */}
          {(['action', 'warn', 'info'] as const).map((severity) => {
            const sectionSignals = grouped[severity]
            if (sectionSignals.length === 0) return null

            const config = severityConfig[severity]

            return (
              <div key={severity} className="mb-8">
                <h2 className="text-sm uppercase tracking-wider text-gray-400 mb-4">{config.label}</h2>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {sectionSignals.map((signal) => (
                    <button
                      key={signal.id}
                      onClick={() => setSelectedTicker(signal.ticker)}
                      className="text-left"
                    >
                      <div className={`p-4 rounded-lg border border-gray-800 ${config.bgColor} hover:border-gray-700 transition-all hover:shadow-lg cursor-pointer`}>
                        {/* Top row: severity badge and ticker */}
                        <div className="flex items-start justify-between gap-4 mb-3">
                          <span className={`px-2 py-1 rounded text-xs font-bold ${config.badgeBg} ${config.badgeText} uppercase tracking-wider whitespace-nowrap`}>
                            {severity}
                          </span>
                          <span className="font-mono text-2xl font-bold text-white">{signal.ticker}</span>
                        </div>

                        {/* Title */}
                        <h3 className="font-semibold text-gray-100 mb-2 leading-snug">{signal.title}</h3>

                        {/* Reason */}
                        <p className="text-sm text-gray-400 mb-4 leading-relaxed">{signal.reason}</p>

                        {/* Context chips */}
                        <div className="flex flex-wrap gap-2">
                          {signal.pnl_pct != null && (
                            <div className="px-3 py-1 rounded-full bg-gray-800/50 text-xs text-gray-300 font-mono">
                              {signal.pnl_pct >= 0 ? '+' : ''}
                              {signal.pnl_pct.toFixed(1)}%
                            </div>
                          )}
                          {signal.value_nis != null && (
                            <div className="px-3 py-1 rounded-full bg-gray-800/50 text-xs text-gray-300 font-mono">
                              {ccySymbol}
                              {(signal.value_nis / 1000).toFixed(0)}k
                            </div>
                          )}
                          {signal.category && (
                            <div className="px-3 py-1 rounded-full bg-gray-800/50 text-xs text-gray-500">
                              {signal.category}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </>
      )}

      {/* DrillDownPanel */}
      {selectedTicker && selectedHolding && (
        <DrillDownPanel
          holding={selectedHolding}
          priceEntry={prices[selectedTicker] as (PriceEntry | ErrorEntry | undefined)}
          onClose={() => setSelectedTicker(null)}
        />
      )}
    </div>
  )
}
