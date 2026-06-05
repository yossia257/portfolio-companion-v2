import { useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { refreshPrices, fetchUsdToNis, type PriceMap, type PriceEntry, type MarketData } from '../lib/prices'
import TickerBar from '../components/TickerBar'
import DrillDownPanel from '../components/DrillDownPanel'

// ── Types ──────────────────────────────────────────────────────────────────

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

// ── Formatters ─────────────────────────────────────────────────────────────

function fmtQty(v: number | string | null): string {
  if (v == null) return '—'
  const n = Number(v)
  return isNaN(n) ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

function fmtPrice(v: number | string | null): string {
  if (v == null) return '—'
  const n = Number(v)
  return isNaN(n) ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
}

function fmtNis(v: number | null | undefined): string {
  if (v == null) return '—'
  return '₪ ' + Math.round(v).toLocaleString()
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ── Per-holding calculations ───────────────────────────────────────────────

function liveEntry(h: Holding, prices: PriceMap): PriceEntry | null {
  const e = prices[h.ticker]
  if (!e || 'error' in e) return null
  return e
}


function nisValue(h: Holding, prices: PriceMap, usdNis: number | null): number | null {
  const qty = h.quantity != null ? Number(h.quantity) : null
  if (qty == null || isNaN(qty)) return null

  const live = liveEntry(h, prices)?.price ?? null
  const ccy = h.currency?.toUpperCase()

  if (ccy === 'USD') {
    if (live == null || usdNis == null) return null
    return qty * live * usdNis
  }
  if (ccy === 'NIS') {
    if (live != null) return qty * live // live price from yahoo-proxy (.TA)
    const bp = h.buy_price != null ? Number(h.buy_price) : null
    if (bp == null || isNaN(bp)) return null
    return qty * bp // book fallback for IL-* pseudo-tickers
  }
  return null
}

function pnlPct(h: Holding, prices: PriceMap): number | null {
  const buy = h.buy_price != null ? Number(h.buy_price) : null
  if (buy == null || buy === 0 || isNaN(buy)) return null
  const live = liveEntry(h, prices)?.price ?? null
  if (live == null) return null
  return ((live - buy) / buy) * 100
}

function pnlColor(v: number | null): string {
  if (v == null) return 'text-gray-500'
  if (v > 0) return 'text-green-400'
  if (v < 0) return 'text-red-400'
  return 'text-gray-400'
}

// ── Sort types ────────────────────────────────────────────────────────────

type SortCol =
  | 'ticker' | 'name' | 'qty' | 'buy_price'
  | 'cur_price' | 'daily_pct' | 'pre_price' | 'pre_pct'
  | 'total_nis' | 'pnl_pct'
type SortDir = 'asc' | 'desc'
const SORT_LS_KEY = 'holdings_sort'

function readSortState(): { column: SortCol; direction: SortDir } {
  try {
    const v = JSON.parse(localStorage.getItem(SORT_LS_KEY) ?? '{}')
    return { column: v.column ?? 'total_nis', direction: v.direction ?? 'desc' }
  } catch {
    return { column: 'total_nis', direction: 'desc' }
  }
}

function getColumnValue(h: Holding, col: SortCol, prices: PriceMap, usdNis: number | null): number | string | null {
  switch (col) {
    case 'ticker': return h.ticker ?? null
    case 'name': return h.name ?? null
    case 'qty': return h.quantity != null ? Number(h.quantity) : null
    case 'buy_price': return h.buy_price != null ? Number(h.buy_price) : null
    case 'cur_price': {
      const entry = prices[h.ticker]
      return entry != null && !('error' in entry) ? (entry as PriceEntry).price : null
    }
    case 'daily_pct': {
      const entry = prices[h.ticker]
      return entry != null && !('error' in entry) ? (entry as PriceEntry).daily_change_pct : null
    }
    case 'pre_price': {
      const entry = prices[h.ticker]
      return entry != null && !('error' in entry) ? ((entry as PriceEntry).pre_market_price ?? null) : null
    }
    case 'pre_pct': {
      const entry = prices[h.ticker]
      return entry != null && !('error' in entry) ? ((entry as PriceEntry).pre_market_change_pct ?? null) : null
    }
    case 'total_nis': return nisValue(h, prices, usdNis)
    case 'pnl_pct': return pnlPct(h, prices)
  }
}

function compareValues(aVal: number | string | null, bVal: number | string | null, direction: SortDir): number {
  // Nulls last in both ascending and descending
  if (aVal == null && bVal == null) return 0
  if (aVal == null) return 1
  if (bVal == null) return -1

  const isNum = typeof aVal === 'number'
  let cmp: number

  if (isNum) {
    cmp = (aVal as number) - (bVal as number)
  } else {
    cmp = (aVal as string).localeCompare(bVal as string)
  }

  return direction === 'asc' ? cmp : -cmp
}

// ── Spinner ────────────────────────────────────────────────────────────────

function Pulse() {
  return <span className="inline-block w-14 h-3 rounded bg-gray-800 animate-pulse align-middle" />
}

// ── Component ──────────────────────────────────────────────────────────────

export default function MainPage({
  session,
  onNavigateUpload,
  onNavigateSettings,
}: {
  session: Session
  onNavigateUpload: () => void
  onNavigateSettings: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [holdings, setHoldings] = useState<Holding[] | null>(null)

  const [selectedHolding, setSelectedHolding] = useState<Holding | null>(null)

  const [prices, setPrices] = useState<PriceMap>({})
  const [market, setMarket] = useState<MarketData>({})
  const [usdNis, setUsdNis] = useState<number | null>(null)
  const [pricesLoading, setPricesLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const [sortState, setSortState] = useState(() => readSortState())

  const REFRESH_MS = 60 * 60 * 1000 // 60 minutes

  // Refs so interval/visibilitychange callbacks always see current values
  // without needing to be re-registered when state changes.
  const doRefreshRef = useRef<() => void>(() => {})
  const lastUpdatedRef = useRef<Date | null>(null)

  // Keep doRefreshRef pointing at the latest doRefreshPrices + holdings closure.
  // No dependency array: runs after every render so the ref is always fresh.
  useEffect(() => {
    doRefreshRef.current = () => doRefreshPrices(holdings ?? [])
  })

  // Keep lastUpdatedRef in sync for stale-check inside visibilitychange.
  useEffect(() => {
    lastUpdatedRef.current = lastUpdated
  }, [lastUpdated])

  // Fetches prices for ALL tickers in holdingsList + the USD/NIS FX rate.
  // The backend partitions USD / .TA / IL-* internally.
  // Safe to call multiple times; used both on mount and by the Refresh button.
  async function doRefreshPrices(holdingsList: Holding[]) {
    const allTickers = [...new Set(holdingsList.filter((h) => h.ticker).map((h) => h.ticker))]

    setPricesLoading(true)

    const [priceOutcome, fxOutcome] = await Promise.allSettled([
      refreshPrices(allTickers), // always call — market tickers returned regardless
      fetchUsdToNis(),
    ])

    if (priceOutcome.status === 'fulfilled') {
      setPrices(priceOutcome.value.prices)
      setMarket(priceOutcome.value.market)
      setLastUpdated(new Date())
    } else {
      console.error('Price refresh failed:', priceOutcome.reason)
    }

    if (fxOutcome.status === 'fulfilled') {
      setUsdNis(fxOutcome.value)
    } else {
      console.error('FX fetch failed:', fxOutcome.reason)
    }

    setPricesLoading(false)
  }

  // Fetches portfolio + holdings once on mount, then triggers price refresh.
  useEffect(() => {
    let cancelled = false

    async function fetchPortfolio() {
      setLoading(true)

      const { data: profileData } = await supabase
        .from('profiles')
        .select('display_name, display_currency')
        .eq('id', session.user.id)
        .single()

      if (cancelled) return
      if (profileData) setProfile(profileData)

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
        if (!cancelled) doRefreshPrices([]) // still fetch market strip + FX rate
        return
      }

      const { data: holdingsData } = await supabase
        .from('holdings')
        .select('id, ticker, name, quantity, currency, buy_price, category')
        .eq('portfolio_id', portfolio.id)
        .is('deleted_at', null)
        .order('ticker', { ascending: true })

      if (cancelled) return

      const list = holdingsData ?? []
      setHoldings(list)
      setLoading(false)

      // Kick off price refresh immediately after holdings are available.
      // We don't await this — the table renders at once and prices fill in.
      if (!cancelled) doRefreshPrices(list)
    }

    fetchPortfolio()
    return () => { cancelled = true }
  }, [session.user.id])

  // Auto-refresh: interval every 60 min (tab visible only) + stale-check on focus.
  useEffect(() => {
    const tick = setInterval(() => {
      if (document.visibilityState === 'visible') doRefreshRef.current()
    }, REFRESH_MS)

    function onVisibility() {
      if (document.visibilityState !== 'visible') return
      const lu = lastUpdatedRef.current
      const isStale = !lu || Date.now() - lu.getTime() >= REFRESH_MS
      if (isStale) doRefreshRef.current()
    }

    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, []) // runs once on mount; refs keep callbacks current without re-registering

  // ── Derived KPI values ───────────────────────────────────────────────────

  const rawList = holdings ?? []
  const list = rawList.length > 0
    ? rawList.slice().sort((a, b) => {
        const aVal = getColumnValue(a, sortState.column, prices, usdNis)
        const bVal = getColumnValue(b, sortState.column, prices, usdNis)
        return compareValues(aVal, bVal, sortState.direction)
      })
    : []

  let totalNis: number | null = null
  const performers: { ticker: string; pnl: number }[] = []

  for (const h of rawList) {
    const v = nisValue(h, prices, usdNis)
    if (v != null) totalNis = (totalNis ?? 0) + v
    const pnl = pnlPct(h, prices)
    if (pnl != null) performers.push({ ticker: h.ticker, pnl })
  }

  performers.sort((a, b) => a.pnl - b.pnl)
  const worst = performers[0] ?? null
  const best = performers[performers.length - 1] ?? null

  // Show pre-market columns only when at least one holding has a non-null
  // pre_market_price — which only happens during the 4:00–9:30 AM ET window.
  const showPreMarket = list.some(h => {
    const e = prices[h.ticker]
    return e != null && !('error' in e) && (e as PriceEntry).pre_market_price != null
  })

  // ── Helpers ──────────────────────────────────────────────────────────────

  function handleSortClick(col: SortCol) {
    const current = sortState
    let newState: { column: SortCol; direction: SortDir }

    if (current.column === col) {
      newState = { column: col, direction: current.direction === 'asc' ? 'desc' : 'asc' }
    } else {
      newState = { column: col, direction: 'asc' }
    }

    setSortState(newState)
    localStorage.setItem(SORT_LS_KEY, JSON.stringify(newState))
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">

      {/* ── Sticky chrome: header + ticker bar ── */}
      <div className="sticky top-0 z-20">
      <header className="bg-gray-950 border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Portfolio Companion</h1>
        <div className="flex items-center gap-3">
          {(pricesLoading || lastUpdated) && (
            <span className="hidden sm:flex items-center gap-1.5 text-xs text-gray-500">
              {pricesLoading && (
                <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse shrink-0" />
              )}
              {lastUpdated
                ? `Updated ${fmtTime(lastUpdated)}`
                : 'Refreshing…'}
            </span>
          )}
          {holdings !== null && holdings.length > 0 && (
            <button
              onClick={() => doRefreshPrices(holdings)}
              disabled={pricesLoading}
              className="px-3 py-2 rounded-lg bg-gray-800 text-gray-200 text-sm hover:bg-gray-700 transition-colors disabled:opacity-40"
            >
              {pricesLoading ? 'Refreshing…' : 'Refresh ↻'}
            </button>
          )}
          {holdings !== null && (
            <button
              onClick={onNavigateUpload}
              className="px-4 py-2 rounded-lg bg-gray-800 text-gray-200 text-sm hover:bg-gray-700 transition-colors"
            >
              Re-upload
            </button>
          )}
          <button
            onClick={onNavigateSettings}
            className="px-4 py-2 rounded-lg bg-gray-800 text-gray-200 text-sm hover:bg-gray-700 transition-colors"
            aria-label="Settings"
          >
            ⚙
          </button>
          <button
            onClick={signOut}
            className="px-4 py-2 rounded-lg bg-gray-800 text-gray-200 text-sm hover:bg-gray-700 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>
      <TickerBar usdNis={usdNis} market={market} lastUpdated={lastUpdated} />
      </div>{/* end sticky wrapper */}

      {/* ── Body ── */}
      <main className="flex-1 px-6 py-8 max-w-7xl w-full mx-auto">

        {/* Loading skeleton */}
        {loading && (
          <div className="flex items-center justify-center h-64 text-gray-500">
            Loading portfolio…
          </div>
        )}

        {/* Empty state */}
        {!loading && holdings === null && (
          <div className="flex flex-col items-center justify-center h-[60vh] gap-6 text-center">
            <div>
              <p className="text-2xl font-semibold mb-2">Welcome — let's get your portfolio in</p>
              <p className="text-gray-400 text-sm">Upload a CSV or Excel file to import your holdings in seconds.</p>
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
            {/* ── KPI row ── */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">

              {/* Total Value */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-4">
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Total Value ({profile?.display_currency ?? 'NIS'})</p>
                {pricesLoading && totalNis == null ? (
                  <div className="h-7 w-28 rounded bg-gray-800 animate-pulse mt-1" />
                ) : (
                  <p className="text-xl font-bold">{fmtNis(totalNis)}</p>
                )}
              </div>

              {/* Best performer */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-4">
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Best Performer</p>
                {pricesLoading && !best ? (
                  <div className="h-7 w-28 rounded bg-gray-800 animate-pulse mt-1" />
                ) : best ? (
                  <p className="text-xl font-bold">
                    <span className="font-mono">{best.ticker}</span>{' '}
                    <span className="text-green-400 text-base">{fmtPct(best.pnl)}</span>
                  </p>
                ) : (
                  <p className="text-xl font-bold text-gray-600">—</p>
                )}
              </div>

              {/* Worst performer */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-4">
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Worst Performer</p>
                {pricesLoading && !worst ? (
                  <div className="h-7 w-28 rounded bg-gray-800 animate-pulse mt-1" />
                ) : worst ? (
                  <p className="text-xl font-bold">
                    <span className="font-mono">{worst.ticker}</span>{' '}
                    <span className="text-red-400 text-base">{fmtPct(worst.pnl)}</span>
                  </p>
                ) : (
                  <p className="text-xl font-bold text-gray-600">—</p>
                )}
              </div>

              {/* Holdings count */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-4">
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Holdings</p>
                <p className="text-xl font-bold">{list.length}</p>
              </div>
            </div>

            {/* Empty portfolio */}
            {list.length === 0 && (
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

            {/* ── Holdings table ── */}
            {list.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-gray-800">
                <table className="w-full text-sm">
                  <thead className="bg-gray-900 text-gray-400">
                    <tr>
                      <th
                        className="px-4 py-3 text-left font-medium cursor-pointer hover:text-white transition-colors"
                        onClick={() => handleSortClick('ticker')}
                      >
                        Ticker {sortState.column === 'ticker' && (sortState.direction === 'asc' ? '▲' : '▼')}
                      </th>
                      <th
                        className="px-4 py-3 text-left font-medium cursor-pointer hover:text-white transition-colors"
                        onClick={() => handleSortClick('name')}
                      >
                        Name {sortState.column === 'name' && (sortState.direction === 'asc' ? '▲' : '▼')}
                      </th>
                      <th
                        className="px-4 py-3 text-right font-medium cursor-pointer hover:text-white transition-colors"
                        onClick={() => handleSortClick('qty')}
                      >
                        Qty {sortState.column === 'qty' && (sortState.direction === 'asc' ? '▲' : '▼')}
                      </th>
                      <th
                        className="px-4 py-3 text-right font-medium cursor-pointer hover:text-white transition-colors"
                        onClick={() => handleSortClick('buy_price')}
                      >
                        Buy Price {sortState.column === 'buy_price' && (sortState.direction === 'asc' ? '▲' : '▼')}
                      </th>
                      <th
                        className="px-4 py-3 text-right font-medium cursor-pointer hover:text-white transition-colors"
                        onClick={() => handleSortClick('cur_price')}
                      >
                        Current Price {sortState.column === 'cur_price' && (sortState.direction === 'asc' ? '▲' : '▼')}
                      </th>
                      <th
                        className="px-4 py-3 text-right font-medium cursor-pointer hover:text-white transition-colors"
                        onClick={() => handleSortClick('daily_pct')}
                      >
                        Daily % {sortState.column === 'daily_pct' && (sortState.direction === 'asc' ? '▲' : '▼')}
                      </th>
                      {showPreMarket && (
                        <th
                          className="px-4 py-3 text-right font-medium cursor-pointer hover:text-white transition-colors"
                          onClick={() => handleSortClick('pre_price')}
                        >
                          Pre-Market {sortState.column === 'pre_price' && (sortState.direction === 'asc' ? '▲' : '▼')}
                        </th>
                      )}
                      {showPreMarket && (
                        <th
                          className="px-4 py-3 text-right font-medium cursor-pointer hover:text-white transition-colors"
                          onClick={() => handleSortClick('pre_pct')}
                        >
                          Pre-Mkt % {sortState.column === 'pre_pct' && (sortState.direction === 'asc' ? '▲' : '▼')}
                        </th>
                      )}
                      <th
                        className="px-4 py-3 text-right font-medium cursor-pointer hover:text-white transition-colors"
                        onClick={() => handleSortClick('total_nis')}
                      >
                        Total ({profile?.display_currency ?? 'NIS'}) {sortState.column === 'total_nis' && (sortState.direction === 'asc' ? '▲' : '▼')}
                      </th>
                      <th
                        className="px-4 py-3 text-right font-medium cursor-pointer hover:text-white transition-colors"
                        onClick={() => handleSortClick('pnl_pct')}
                      >
                        P&amp;L % {sortState.column === 'pnl_pct' && (sortState.direction === 'asc' ? '▲' : '▼')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((h, i) => {
                      const isUsd    = h.currency?.toUpperCase() === 'USD'
                      const isNis    = h.currency?.toUpperCase() === 'NIS'
                      const ccySym   = isUsd ? '$' : isNis ? '₪' : ''
                      const entry    = prices[h.ticker]           // PriceEntry | ErrorEntry | undefined
                      const hasLive  = entry != null && !('error' in entry)
                      const isNoData = entry != null && 'error' in entry
                      const cur           = hasLive ? (entry as PriceEntry).price : null
                      const daily         = hasLive ? (entry as PriceEntry).daily_change_pct : null
                      const prePrice      = hasLive ? ((entry as PriceEntry).pre_market_price      ?? null) : null
                      const preChangePct  = hasLive ? ((entry as PriceEntry).pre_market_change_pct ?? null) : null
                      const total    = nisValue(h, prices, usdNis)
                      const pnl      = pnlPct(h, prices)
                      // Show spinner only while fetching and no answer yet for this ticker
                      const waiting  = pricesLoading && entry == null

                      return (
                        <tr
                          key={h.id}
                          className={`border-t border-gray-800 hover:bg-gray-900/50 transition-colors ${
                            i % 2 === 0 ? '' : 'bg-gray-900/20'
                          }`}
                        >
                          {/* Ticker — click to open drill-down */}
                          <td className="px-4 py-3 whitespace-nowrap">
                            <button
                              onClick={() => setSelectedHolding(h)}
                              className="font-mono font-semibold text-white cursor-pointer hover:underline underline-offset-2 decoration-gray-500"
                            >
                              {h.ticker}
                            </button>
                          </td>

                          {/* Name */}
                          <td className="px-4 py-3 text-gray-300 max-w-[180px] truncate">
                            {h.name ?? <span className="text-gray-600">—</span>}
                          </td>

                          {/* Qty */}
                          <td className="px-4 py-3 text-right text-gray-200 tabular-nums">
                            {fmtQty(h.quantity)}
                          </td>

                          {/* Buy Price — show currency symbol */}
                          <td className="px-4 py-3 text-right text-gray-200 tabular-nums">
                            {h.buy_price != null ? `${ccySym}${fmtPrice(h.buy_price)}` : '—'}
                          </td>

                          {/* Current Price */}
                          <td className="px-4 py-3 text-right tabular-nums">
                            {waiting ? (
                              <Pulse />
                            ) : cur != null ? (
                              <span className="text-white">{ccySym}{fmtPrice(cur)}</span>
                            ) : isNoData ? (
                              <span className="text-xs text-gray-600">no live data</span>
                            ) : (
                              <span className="text-gray-600">—</span>
                            )}
                          </td>

                          {/* Daily % */}
                          <td className="px-4 py-3 text-right tabular-nums">
                            {waiting ? (
                              <Pulse />
                            ) : daily != null ? (
                              <span className={pnlColor(daily)}>{fmtPct(daily)}</span>
                            ) : (
                              <span className="text-gray-600">—</span>
                            )}
                          </td>

                          {/* Pre-Market Price — only rendered when showPreMarket */}
                          {showPreMarket && (
                            <td className="px-4 py-3 text-right tabular-nums">
                              {prePrice != null ? (
                                <span className="text-amber-300">{ccySym}{fmtPrice(prePrice)}</span>
                              ) : (
                                <span className="text-gray-700">—</span>
                              )}
                            </td>
                          )}

                          {/* Pre-Market % — only rendered when showPreMarket */}
                          {showPreMarket && (
                            <td className="px-4 py-3 text-right tabular-nums">
                              {preChangePct != null ? (
                                <span className={pnlColor(preChangePct)}>{fmtPct(preChangePct)}</span>
                              ) : (
                                <span className="text-gray-700">—</span>
                              )}
                            </td>
                          )}

                          {/* Total NIS */}
                          <td className="px-4 py-3 text-right tabular-nums">
                            {waiting ? (
                              <Pulse />
                            ) : total != null ? (
                              <span className="text-gray-200">{fmtNis(total)}</span>
                            ) : (
                              <span className="text-gray-600">—</span>
                            )}
                          </td>

                          {/* P&L % */}
                          <td className="px-4 py-3 text-right tabular-nums">
                            {waiting ? (
                              <Pulse />
                            ) : pnl != null ? (
                              <span className={`font-medium ${pnlColor(pnl)}`}>{fmtPct(pnl)}</span>
                            ) : isNoData ? (
                              <span className="text-xs text-gray-600">no live data</span>
                            ) : (
                              <span className="text-gray-600">—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* FX footnote */}
            {usdNis != null && (
              <p className="mt-3 text-xs text-gray-600">
                USD/NIS rate: {usdNis.toFixed(4)} · IL-* fund tickers show book price (no Yahoo symbol available)
              </p>
            )}
          </>
        )}
      </main>

      {selectedHolding && (
        <DrillDownPanel
          holding={selectedHolding}
          priceEntry={prices[selectedHolding.ticker]}
          onClose={() => setSelectedHolding(null)}
        />
      )}
    </div>
  )
}
