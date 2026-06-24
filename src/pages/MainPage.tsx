import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { RefreshCw, Upload, LogOut } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useUserProfile } from '../lib/useUserProfile'
import { refreshPrices, fetchUsdToNis, type PriceMap, type MarketData } from '../lib/prices'
import TickerBar from '../components/TickerBar'
import TabBar from '../components/TabBar'
import PortfolioTab from '../components/PortfolioTab'
import RsuTab from '../components/RsuTab'
import SignalsTab from '../components/SignalsTab'
import WatchlistTab from '../components/WatchlistTab'
import AskClaudeTab from '../components/AskClaudeTab'
import SettingsTab from '../components/SettingsTab'
import PremiumBadge from '../components/PremiumBadge'

// ── Types ──────────────────────────────────────────────────────────────────

interface Profile {
  display_name: string | null
  display_currency: string
}

export interface Holding {
  id: string
  ticker: string
  name: string | null
  quantity: number | string | null
  currency: string | null
  buy_price: number | string | null
  category: string | null
}

// ── Formatters ─────────────────────────────────────────────────────────────

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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

function getColumnValue(h: Holding, col: SortCol, prices: PriceMap, usdNis: number | null = null): number | string | null {
  switch (col) {
    case 'ticker': return h.ticker ?? null
    case 'name': return h.name ?? null
    case 'qty': return h.quantity != null ? Number(h.quantity) : null
    case 'buy_price': return h.buy_price != null ? Number(h.buy_price) : null
    case 'cur_price': {
      const entry = prices[h.ticker]
      return entry != null && !('error' in entry) ? (entry as any).price : null
    }
    case 'daily_pct': {
      const entry = prices[h.ticker]
      return entry != null && !('error' in entry) ? (entry as any).daily_change_pct : null
    }
    case 'pre_price': {
      const entry = prices[h.ticker]
      return entry != null && !('error' in entry) ? ((entry as any).pre_market_price ?? null) : null
    }
    case 'pre_pct': {
      const entry = prices[h.ticker]
      return entry != null && !('error' in entry) ? ((entry as any).pre_market_change_pct ?? null) : null
    }
    case 'total_nis': {
      const cur = prices[h.ticker]
      if (cur == null || 'error' in cur) return null
      const qty = h.quantity != null ? Number(h.quantity) : 0
      const price = (cur as any).price ?? 0
      const rate = h.currency === 'USD' && usdNis ? usdNis : 1
      return qty * price * rate
    }
    case 'pnl_pct': {
      const cur = prices[h.ticker]
      if (cur == null || 'error' in cur) return null
      const buyPrice = h.buy_price != null ? Number(h.buy_price) : 0
      const curPrice = (cur as any).price ?? 0
      if (buyPrice === 0) return null
      return ((curPrice - buyPrice) / buyPrice) * 100
    }
  }
}

function compareValues(aVal: number | string | null, bVal: number | string | null, direction: SortDir): number {
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

// ── Component ──────────────────────────────────────────────────────────────

export default function MainPage({
  session,
  onNavigateUpload,
}: {
  session: Session
  onNavigateUpload: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [holdings, setHoldings] = useState<Holding[] | null>(null)

  const [prices, setPrices] = useState<PriceMap>({})
  const [market, setMarket] = useState<MarketData>({})
  const [usdNis, setUsdNis] = useState<number | null>(null)
  const [pricesLoading, setPricesLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [research, setResearch] = useState<Record<string, any>>({})

  const [sortState, setSortState] = useState(() => readSortState())
  const [activeTab, setActiveTab] = useState<'portfolio' | 'rsu' | 'signals' | 'watchlist' | 'ask-claude' | 'settings'>('portfolio')

  const { isPremium } = useUserProfile()

  const REFRESH_MS = 60 * 60 * 1000 // 60 minutes

  const doRefreshRef = useRef<() => void>(() => {})
  const lastUpdatedRef = useRef<Date | null>(null)

  useEffect(() => {
    doRefreshRef.current = () => doRefreshPrices(holdings ?? [])
  })

  useEffect(() => {
    lastUpdatedRef.current = lastUpdated
  }, [lastUpdated])

  async function doRefreshPrices(holdingsList: Holding[]) {
    const allTickers = [...new Set(holdingsList.filter((h) => h.ticker).map((h) => h.ticker))]

    setPricesLoading(true)

    const [priceOutcome, fxOutcome] = await Promise.allSettled([
      refreshPrices(allTickers),
      fetchUsdToNis(),
    ])

    if (priceOutcome.status === 'fulfilled') {
      setPrices(prev => ({ ...prev, ...priceOutcome.value.prices }))
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

  const handleRefreshPricesForWatchlist = useCallback(
    async (tickers: string[]) => {
      await doRefreshPrices(
        tickers.map((ticker) => ({ ticker, quantity: 0, currency: 'USD', buy_price: 0 } as Holding))
      )
    },
    []
  )

  const handleFetchPricesForRsu = useCallback(
    async (tickers: string[]) => {
      const allTickers = [...new Set([...tickers, ...Object.keys(prices)])]
      await doRefreshPrices(
        allTickers.map((ticker) => ({ ticker, quantity: 0, currency: 'USD', buy_price: 0 } as Holding))
      )
    },
    [prices]
  )

  const portfolioIdRef = useRef<string | null>(null)

  async function refetchHoldings() {
    if (!portfolioIdRef.current) return

    const { data: holdingsData } = await supabase
      .from('holdings')
      .select('id, ticker, name, quantity, currency, buy_price, category')
      .eq('portfolio_id', portfolioIdRef.current)
      .is('deleted_at', null)
      .order('ticker', { ascending: true })

    const list = holdingsData ?? []
    setHoldings(list)

    // Fetch research cache for all tickers
    if (list.length > 0) {
      const tickers = [...new Set(list.map((h) => h.ticker))]
      const { data: researchData } = await supabase
        .from('ticker_research_cache')
        .select('*')
        .in('ticker', tickers)

      if (researchData) {
        const researchMap = researchData.reduce(
          (acc, row) => {
            acc[row.ticker] = row
            return acc
          },
          {} as Record<string, any>
        )
        setResearch(researchMap)
      }
    }

    await doRefreshPrices(list)
  }

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
        // Defensive: create portfolio on-the-fly if it doesn't exist
        // (e.g., if trigger hasn't fired yet or migration not deployed)
        const { data: newPortfolio, error: createError } = await supabase
          .from('portfolios')
          .insert({ user_id: session.user.id, name: 'My Portfolio', is_active: true })
          .select('id')
          .single()

        if (createError || !newPortfolio) {
          console.error('Failed to create portfolio:', createError)
          setHoldings(null)
          setLoading(false)
          if (!cancelled) doRefreshPrices([])
          return
        }

        portfolioIdRef.current = newPortfolio.id
        setHoldings([])
        setLoading(false)
        if (!cancelled) doRefreshPrices([])
        return
      }

      portfolioIdRef.current = portfolio.id

      const { data: holdingsData } = await supabase
        .from('holdings')
        .select('id, ticker, name, quantity, currency, buy_price, category')
        .eq('portfolio_id', portfolio.id)
        .is('deleted_at', null)
        .order('ticker', { ascending: true })

      if (cancelled) return

      const list = holdingsData ?? []
      setHoldings(list)

      // Fetch research cache for all tickers
      if (list.length > 0) {
        const tickers = [...new Set(list.map((h) => h.ticker))]
        const { data: researchData } = await supabase
          .from('ticker_research_cache')
          .select('*')
          .in('ticker', tickers)

        if (researchData) {
          const researchMap = researchData.reduce(
            (acc, row) => {
              acc[row.ticker] = row
              return acc
            },
            {} as Record<string, any>
          )
          setResearch(researchMap)
        }
      }

      setLoading(false)

      if (!cancelled) doRefreshPrices(list)
    }

    fetchPortfolio()
    return () => { cancelled = true }
  }, [session.user.id])

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
  }, [])

  // Compute sorted holdings list for PortfolioTab
  const rawList = holdings ?? []
  const list = rawList.length > 0
    ? rawList.slice().sort((a, b) => {
        const aVal = getColumnValue(a, sortState.column, prices, usdNis)
        const bVal = getColumnValue(b, sortState.column, prices, usdNis)
        return compareValues(aVal, bVal, sortState.direction)
      })
    : []

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

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">

      {/* ── Sticky navigation chrome: header + ticker + tabs ── */}
      <div className="sticky top-0 z-30 bg-gray-950 border-b border-gray-800">
        <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-white" style={{ backgroundColor: '#F59E0B' }}>
              P
            </div>
            <h1 className="text-lg font-bold tracking-tight">
              <span className="text-white">Portfolio</span>
              <span className="text-accent">Companion</span>
            </h1>
          </div>
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
            {isPremium && <PremiumBadge size="sm" showText={false} />}
            <div className="flex items-center gap-3">
              {holdings !== null && holdings.length > 0 && (
                <button
                  onClick={() => doRefreshPrices(holdings)}
                  disabled={pricesLoading}
                  title="Refresh prices"
                  aria-label="Refresh prices"
                  className="w-10 h-10 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors disabled:opacity-40"
                >
                  <RefreshCw className="w-5 h-5" />
                </button>
              )}
              {holdings !== null && (
                <button
                  onClick={onNavigateUpload}
                  title="Re-upload holdings"
                  aria-label="Re-upload holdings"
                  className="w-10 h-10 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
                >
                  <Upload className="w-5 h-5" />
                </button>
              )}
              <button
                onClick={signOut}
                title="Sign out"
                aria-label="Sign out"
                className="w-10 h-10 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          </div>
        </header>
        <TickerBar usdNis={usdNis} market={market} lastUpdated={lastUpdated} />
        {!loading && holdings !== null && <TabBar activeTab={activeTab} onTabChange={setActiveTab} />}
      </div>

      {/* ── Body ── */}
      <main className="flex-1 w-full max-w-full overflow-x-hidden">

        {/* Loading skeleton */}
        {loading && (
          <div className="flex items-center justify-center h-64 text-gray-500">
            Loading portfolio…
          </div>
        )}

        {/* Empty state */}
        {!loading && holdings === null && (
          <div className="flex flex-col items-center justify-center h-[60vh] gap-6 text-center px-6">
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

        {/* Tab content */}
        {!loading && holdings !== null && activeTab === 'portfolio' && (
          <PortfolioTab
            profile={profile}
            holdings={holdings}
            prices={prices}
            usdNis={usdNis}
            pricesLoading={pricesLoading}
            sortedHoldings={list}
            sortState={sortState}
            onSortClick={handleSortClick}
            onUpload={onNavigateUpload}
            onHoldingUpdated={refetchHoldings}
            research={research}
          />
        )}

        {!loading && holdings !== null && activeTab === 'rsu' && (
          <RsuTab
            prices={prices}
            onFetchPrices={handleFetchPricesForRsu}
          />
        )}

        {!loading && holdings !== null && activeTab === 'signals' && (
          <SignalsTab
            holdings={holdings}
            prices={prices}
            research={research}
            usdNisRate={usdNis ?? 3.75}
          />
        )}

        {!loading && holdings !== null && activeTab === 'watchlist' && (
          <WatchlistTab
            prices={prices}
            pricesLoading={pricesLoading}
            onRefreshPrices={handleRefreshPricesForWatchlist}
            research={research}
          />
        )}

        {!loading && holdings !== null && activeTab === 'ask-claude' && <AskClaudeTab />}

        {!loading && holdings !== null && activeTab === 'settings' && <SettingsTab onHoldingUpdated={refetchHoldings} />}
      </main>
    </div>
  )
}
