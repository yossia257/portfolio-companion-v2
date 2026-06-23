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

interface GroupedSignal {
  ticker: string
  signals: Signal[]
  severity: 'action' | 'warn' | 'info'
  pnl_pct?: number
  value_nis?: number
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

  // Group signals by ticker
  const groupedSignals = useMemo(() => {
    const groupedMap: Record<string, GroupedSignal> = {}
    const severityOrder = { action: 0, warn: 1, info: 2 }

    signals.forEach((signal) => {
      if (!groupedMap[signal.ticker]) {
        groupedMap[signal.ticker] = {
          ticker: signal.ticker,
          signals: [],
          severity: signal.severity,
          pnl_pct: signal.pnl_pct,
          value_nis: signal.value_nis,
        }
      }

      groupedMap[signal.ticker].signals.push(signal)

      // Update severity to highest (lowest order value = highest severity)
      if (severityOrder[signal.severity] < severityOrder[groupedMap[signal.ticker].severity]) {
        groupedMap[signal.ticker].severity = signal.severity
      }

      // Keep pnl_pct if signal has it
      if (signal.pnl_pct != null && !groupedMap[signal.ticker].pnl_pct) {
        groupedMap[signal.ticker].pnl_pct = signal.pnl_pct
      }

      // Keep value_nis if signal has it
      if (signal.value_nis != null && !groupedMap[signal.ticker].value_nis) {
        groupedMap[signal.ticker].value_nis = signal.value_nis
      }
    })

    // Sort by severity (action > warn > info), then by absolute P&L
    return Object.values(groupedMap).sort((a, b) => {
      const severityDiff = severityOrder[a.severity] - severityOrder[b.severity]
      if (severityDiff !== 0) return severityDiff
      return Math.abs(b.pnl_pct ?? 0) - Math.abs(a.pnl_pct ?? 0)
    })
  }, [signals])

  const displayCcy = profile?.display_currency ?? 'NIS'
  const ccySymbol = displayCcy === 'NIS' ? '₪' : displayCcy === 'USD' ? '$' : displayCcy

  const severityConfig = {
    action: { label: '⚠️ Action Items', bgColor: 'bg-red-950/20', badgeBg: 'bg-red-600', badgeText: 'text-white', borderColor: 'border-l-4 border-l-red-500' },
    warn: { label: '🔍 Worth Watching', bgColor: 'bg-amber-950/20', badgeBg: 'bg-amber-500', badgeText: 'text-gray-950', borderColor: 'border-l-4 border-l-amber-500' },
    info: { label: 'ℹ️ FYI', bgColor: 'bg-blue-950/20', badgeBg: 'bg-blue-500', badgeText: 'text-white', borderColor: 'border-l-4 border-l-blue-500' },
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
          {/* Grouped by severity, one card per ticker */}
          {(['action', 'warn', 'info'] as const).map((severity) => {
            const tickerCards = groupedSignals.filter((g) => g.severity === severity)
            if (tickerCards.length === 0) return null

            const config = severityConfig[severity]

            return (
              <div key={severity} className="mb-8">
                <h2 className="text-sm uppercase tracking-wider text-gray-400 mb-4">{config.label}</h2>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {tickerCards.map((grouped) => (
                    <button
                      key={grouped.ticker}
                      onClick={() => setSelectedTicker(grouped.ticker)}
                      className="text-left"
                    >
                      <div className={`p-4 rounded-lg border border-gray-800 ${config.bgColor} ${config.borderColor} hover:border-gray-700 transition-all hover:shadow-lg cursor-pointer`}>
                        {/* Top row: severity badge and ticker */}
                        <div className="flex items-start justify-between gap-4 mb-3">
                          <span className={`px-2 py-1 rounded text-xs font-bold ${config.badgeBg} ${config.badgeText} uppercase tracking-wider whitespace-nowrap`}>
                            {grouped.severity}
                          </span>
                          <span className="font-mono text-2xl font-bold text-white">{grouped.ticker}</span>
                        </div>

                        {/* Context chips: P&L and value */}
                        <div className="flex flex-wrap gap-2 mb-3">
                          {grouped.pnl_pct != null && (
                            <div className="px-3 py-1 rounded-full bg-gray-800/50 text-xs text-gray-300 font-mono">
                              {grouped.pnl_pct >= 0 ? '+' : ''}
                              {grouped.pnl_pct.toFixed(1)}%
                            </div>
                          )}
                          {grouped.value_nis != null && (
                            <div className="px-3 py-1 rounded-full bg-gray-800/50 text-xs text-gray-300 font-mono">
                              {ccySymbol}
                              {(grouped.value_nis / 1000).toFixed(0)}k
                            </div>
                          )}
                        </div>

                        {/* Signal list */}
                        <div className="space-y-2 text-xs">
                          {grouped.signals.map((signal) => (
                            <div key={signal.id} className="pl-3 border-l border-gray-700 text-gray-300">
                              <p className="font-medium text-gray-200 mb-0.5">{signal.title}</p>
                              <p className="text-gray-500 leading-snug">{signal.reason}</p>
                            </div>
                          ))}
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
