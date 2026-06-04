import { useEffect, useState } from 'react'
import type { MarketData } from '../lib/prices'

interface TickerBarProps {
  usdNis: number | null
  market: MarketData
  lastUpdated: Date | null // changes on every portfolio refresh → triggers BTC re-fetch
}

interface BtcData {
  price: number
  change_pct: number
}

async function fetchBtc(): Promise<BtcData> {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true'
  )
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`)
  const data = await res.json()
  return {
    price: data.bitcoin.usd as number,
    change_pct: data.bitcoin.usd_24h_change as number,
  }
}

// ── Chip ──────────────────────────────────────────────────────────────────

function pctColor(v: number | undefined): string {
  if (v == null) return 'text-gray-500'
  if (v > 0) return 'text-green-400'
  if (v < 0) return 'text-red-400'
  return 'text-gray-400'
}

function fmtPct(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
}

function Chip({
  label,
  value,
  change,
  loading = false,
}: {
  label: string
  value: string
  change?: number
  loading?: boolean
}) {
  return (
    <div className="flex flex-col justify-center px-5 py-2.5 border-r border-gray-800 last:border-r-0 shrink-0 min-w-[100px]">
      <span className="text-[10px] uppercase tracking-wider text-gray-500 leading-none mb-1.5">
        {label}
      </span>
      {loading ? (
        <div className="h-4 w-20 rounded bg-gray-800 animate-pulse" />
      ) : (
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className="text-sm font-semibold text-white tabular-nums leading-none">
            {value}
          </span>
          {change != null && (
            <span className={`text-[11px] tabular-nums leading-none ${pctColor(change)}`}>
              {fmtPct(change)}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function ChipSkeleton() {
  return (
    <div className="flex flex-col justify-center px-5 py-2.5 border-r border-gray-800 shrink-0 min-w-[100px] gap-1.5">
      <div className="h-2.5 w-12 rounded bg-gray-800 animate-pulse" />
      <div className="h-4 w-20 rounded bg-gray-800 animate-pulse" />
    </div>
  )
}

// ── TickerBar ─────────────────────────────────────────────────────────────

export default function TickerBar({ usdNis, market, lastUpdated }: TickerBarProps) {
  const [btc, setBtc] = useState<BtcData | null>(null)
  const [btcLoading, setBtcLoading] = useState(true)

  // Re-fetch BTC whenever lastUpdated changes (triggered by portfolio refresh)
  // and also on mount (lastUpdated starts null, effect fires immediately).
  useEffect(() => {
    let cancelled = false
    setBtcLoading(true)
    fetchBtc()
      .then((data) => { if (!cancelled) setBtc(data) })
      .catch((err) => console.error('BTC fetch failed:', err))
      .finally(() => { if (!cancelled) setBtcLoading(false) })
    return () => { cancelled = true }
  }, [lastUpdated])

  const spy  = market['SPY']
  const qqq  = market['QQQ']
  const panw = market['PANW']
  const marketLoading = Object.keys(market).length === 0

  // Show full skeleton before any data arrives
  const allLoading = btcLoading && !btc && marketLoading && usdNis == null
  if (allLoading) {
    return (
      <div className="bg-gray-900 border-b border-gray-800 overflow-x-auto">
        <div className="flex items-stretch min-w-max">
          <ChipSkeleton />
          <ChipSkeleton />
        </div>
      </div>
    )
  }

  return (
    <div className="bg-gray-900 border-b border-gray-800 overflow-x-auto">
      <div className="flex items-stretch min-w-max">
        <Chip
          label="USD / NIS"
          value={usdNis != null ? usdNis.toFixed(4) : '—'}
          loading={usdNis == null}
        />
        <Chip
          label="Bitcoin"
          value={btc ? `$${Math.round(btc.price).toLocaleString()}` : '—'}
          change={btc?.change_pct}
          loading={btcLoading && !btc}
        />
        <Chip
          label="S&P 500"
          value={spy ? spy.price.toFixed(2) : '—'}
          change={spy?.daily_change_pct}
          loading={marketLoading}
        />
        <Chip
          label="Nasdaq"
          value={qqq ? qqq.price.toFixed(2) : '—'}
          change={qqq?.daily_change_pct}
          loading={marketLoading}
        />
        <Chip
          label="PANW"
          value={panw ? panw.price.toFixed(2) : '—'}
          change={panw?.daily_change_pct}
          loading={marketLoading}
        />
      </div>
    </div>
  )
}
