// Pure signal generation — testable, reusable, UI-agnostic
// No side effects, no async, no dependencies on React or Supabase

// ── Types ──────────────────────────────────────────────────────────────────

export type Signal = {
  id: string // unique key for React (ticker-category-subtype or similar)
  ticker: string
  severity: 'info' | 'warn' | 'action'
  category: 'pl' | 'daily' | 'rsi' | 'concentration' | 'watch'
  title: string // e.g., "AMZN: +43% — consider profit-taking"
  reason: string // 1-2 sentence explanation
  pnl_pct?: number
  value_nis?: number
}

export type Holding = {
  id: string
  ticker: string
  name: string | null
  quantity: number | string | null
  currency: string | null
  buy_price: number | string | null
  category: string | null
}

export type PriceEntry = {
  price: number
  daily_change_pct: number
  pre_market_price?: number
  pre_market_change_pct?: number
}

export type PriceCache = Record<string, PriceEntry | { error: string }>

export type ResearchCacheRow = {
  ticker: string
  description: string | null
  industry: string | null
  sector: string | null
  news: unknown[]
  analyst_buy: number | null
  analyst_hold: number | null
  analyst_sell: number | null
  pe_ratio: number | null
  beta: number | null
  eps: number | null
  week52_high: number | null
  week52_low: number | null
  target_price_mean: number | null
  target_price_high: number | null
  target_price_low: number | null
  ma_20: number | null
  ma_50: number | null
  rsi_14: number | null
  ai_summary: string | null
  ai_summary_at: string | null
  fetched_at: string
}

export type SignalThresholds = {
  pnl_win_threshold: number // 100
  pnl_win_action_threshold: number // 150
  pnl_loss_threshold: number // -15
  pnl_loss_action_threshold: number // -30
  daily_gain_threshold: number // 5
  daily_loss_threshold: number // -5
  rsi_overbought: number // 70
  rsi_oversold: number // 30
  concentration_warn: number // 0.15
  concentration_action: number // 0.25
}

const DEFAULT_THRESHOLDS: SignalThresholds = {
  pnl_win_threshold: 100,
  pnl_win_action_threshold: 150,
  pnl_loss_threshold: -15,
  pnl_loss_action_threshold: -30,
  daily_gain_threshold: 5,
  daily_loss_threshold: -5,
  rsi_overbought: 70,
  rsi_oversold: 30,
  concentration_warn: 0.15,
  concentration_action: 0.25,
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getPrice(ticker: string, prices: PriceCache): PriceEntry | null {
  const entry = prices[ticker]
  if (!entry || 'error' in entry) return null
  return entry as PriceEntry
}

function calculatePnL(buyPrice: number, currentPrice: number): number {
  if (buyPrice === 0) return 0
  return ((currentPrice - buyPrice) / buyPrice) * 100
}

function calculateTotalValue(holdings: Holding[], prices: PriceCache, usdNisRate: number): number {
  return holdings.reduce((sum, h) => {
    const qty = typeof h.quantity === 'string' ? parseFloat(h.quantity) : h.quantity ?? 0

    const priceEntry = getPrice(h.ticker, prices)
    if (!priceEntry) return sum

    const currentPrice = priceEntry.price
    let valueUSD = qty * currentPrice
    if (h.currency?.toUpperCase() === 'NIS') valueUSD = valueUSD / usdNisRate
    return sum + valueUSD * usdNisRate
  }, 0)
}

function formatPct(pct: number): string {
  return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%'
}

// ── Signal generators ──────────────────────────────────────────────────────

function generatePnLSignals(
  holdings: Holding[],
  prices: PriceCache,
  thresholds: SignalThresholds
): Signal[] {
  const signals: Signal[] = []

  holdings.forEach((holding) => {
    const qty = typeof holding.quantity === 'string' ? parseFloat(holding.quantity) : holding.quantity ?? 0
    const buyPrice = typeof holding.buy_price === 'string' ? parseFloat(holding.buy_price) : holding.buy_price ?? 0

    if (qty === 0 || buyPrice === 0) return

    const priceEntry = getPrice(holding.ticker, prices)
    if (!priceEntry) return

    const currentPrice = priceEntry.price
    const pnl = calculatePnL(buyPrice, currentPrice)
    const valueUSD = qty * currentPrice

    // Winner signals
    if (pnl >= thresholds.pnl_win_action_threshold) {
      signals.push({
        id: `${holding.ticker}-pl-action`,
        ticker: holding.ticker,
        severity: 'action',
        category: 'pl',
        title: `${holding.ticker}: ${formatPct(pnl)} — consider trimming`,
        reason: 'Up over 150% from buy. Significant gains may warrant profit-taking to lock in returns.',
        pnl_pct: pnl,
        value_nis: valueUSD,
      })
    } else if (pnl >= thresholds.pnl_win_threshold) {
      signals.push({
        id: `${holding.ticker}-pl-info`,
        ticker: holding.ticker,
        severity: 'info',
        category: 'pl',
        title: `${holding.ticker}: ${formatPct(pnl)} — long-running winner`,
        reason: 'Up over 100% from buy. Review if profit-taking matches your plan.',
        pnl_pct: pnl,
        value_nis: valueUSD,
      })
    }

    // Loser signals
    if (pnl <= thresholds.pnl_loss_action_threshold) {
      signals.push({
        id: `${holding.ticker}-pl-loss-action`,
        ticker: holding.ticker,
        severity: 'action',
        category: 'pl',
        title: `${holding.ticker}: ${formatPct(pnl)} — set a decision point`,
        reason: 'Down sharply. Set a stop-loss or commit to a hold-and-monitor decision.',
        pnl_pct: pnl,
        value_nis: valueUSD,
      })
    } else if (pnl <= thresholds.pnl_loss_threshold) {
      signals.push({
        id: `${holding.ticker}-pl-loss-warn`,
        ticker: holding.ticker,
        severity: 'warn',
        category: 'pl',
        title: `${holding.ticker}: ${formatPct(pnl)} — review thesis`,
        reason: 'Down significantly. Worth re-evaluating whether the original thesis still holds.',
        pnl_pct: pnl,
        value_nis: valueUSD,
      })
    }
  })

  return signals
}

function generateDailySignals(
  holdings: Holding[],
  prices: PriceCache,
  thresholds: SignalThresholds
): Signal[] {
  const signals: Signal[] = []

  holdings.forEach((holding) => {
    const priceEntry = getPrice(holding.ticker, prices)
    if (!priceEntry) return

    const dailyChange = priceEntry.daily_change_pct

    if (dailyChange >= thresholds.daily_gain_threshold) {
      signals.push({
        id: `${holding.ticker}-daily-gain`,
        ticker: holding.ticker,
        severity: 'info',
        category: 'daily',
        title: `${holding.ticker}: ${formatPct(dailyChange)} today — momentum signal`,
        reason: 'Sharp daily rise. Check news for catalyst.',
      })
    } else if (dailyChange <= -thresholds.daily_loss_threshold) {
      signals.push({
        id: `${holding.ticker}-daily-loss`,
        ticker: holding.ticker,
        severity: 'warn',
        category: 'daily',
        title: `${holding.ticker}: ${formatPct(dailyChange)} today — sharp daily fall`,
        reason: 'Significant daily decline. Watch for further weakness.',
      })
    }
  })

  return signals
}

function generateRsiSignals(
  holdings: Holding[],
  research: Record<string, ResearchCacheRow>,
  thresholds: SignalThresholds
): Signal[] {
  const signals: Signal[] = []

  holdings.forEach((holding) => {
    const ticker = holding.ticker
    const researchData = research[ticker]

    // Only generate RSI signals for USD tickers (IL tickers don't have reliable RSI)
    if (!researchData || researchData.rsi_14 == null || ticker.endsWith('.TA')) {
      return
    }

    const rsi = researchData.rsi_14

    if (rsi >= thresholds.rsi_overbought) {
      signals.push({
        id: `${ticker}-rsi-overbought`,
        ticker,
        severity: 'info',
        category: 'rsi',
        title: `${ticker}: overbought (RSI ${rsi.toFixed(1)})`,
        reason: 'Momentum looks stretched. Pullback risk increases at these levels.',
      })
    } else if (rsi <= thresholds.rsi_oversold) {
      signals.push({
        id: `${ticker}-rsi-oversold`,
        ticker,
        severity: 'info',
        category: 'rsi',
        title: `${ticker}: oversold (RSI ${rsi.toFixed(1)})`,
        reason: 'Selling pressure looks exhausted. Watch for a bounce setup.',
      })
    }
  })

  return signals
}

function generateConcentrationSignals(
  holdings: Holding[],
  prices: PriceCache,
  usdNisRate: number,
  thresholds: SignalThresholds
): Signal[] {
  const signals: Signal[] = []

  const totalValue = calculateTotalValue(holdings, prices, usdNisRate)
  if (totalValue === 0) return signals

  holdings.forEach((holding) => {
    const qty = typeof holding.quantity === 'string' ? parseFloat(holding.quantity) : holding.quantity ?? 0
    const priceEntry = getPrice(holding.ticker, prices)
    if (!priceEntry || qty === 0) return

    const currentPrice = priceEntry.price
    let valueUSD = qty * currentPrice
    if (holding.currency?.toUpperCase() === 'NIS') {
      valueUSD = valueUSD / usdNisRate
    }
    const valueNIS = valueUSD * usdNisRate
    const concentration = (valueUSD * usdNisRate) / totalValue

    if (concentration >= thresholds.concentration_action) {
      signals.push({
        id: `${holding.ticker}-concentration-action`,
        ticker: holding.ticker,
        severity: 'action',
        category: 'concentration',
        title: `${holding.ticker}: ${(concentration * 100).toFixed(1)}% of portfolio`,
        reason: 'Very high concentration. Consider trimming for portfolio balance.',
        value_nis: valueNIS,
      })
    } else if (concentration >= thresholds.concentration_warn) {
      signals.push({
        id: `${holding.ticker}-concentration-warn`,
        ticker: holding.ticker,
        severity: 'warn',
        category: 'concentration',
        title: `${holding.ticker}: ${(concentration * 100).toFixed(1)}% of portfolio`,
        reason: 'Significant concentration. Single-position risk is elevated.',
        value_nis: valueNIS,
      })
    }
  })

  return signals
}

function generateWatchSignals(holdings: Holding[]): Signal[] {
  const signals: Signal[] = []

  holdings.forEach((holding) => {
    const flags = (holding as any).flags as Record<string, any> | null
    if (!flags) return

    if (flags.thesis_broken === true && flags.note) {
      signals.push({
        id: `${holding.ticker}-watch-broken`,
        ticker: holding.ticker,
        severity: 'action',
        category: 'watch',
        title: `${holding.ticker}: thesis broken (per your note)`,
        reason: flags.note,
      })
    } else if (flags.watch === true && flags.note) {
      signals.push({
        id: `${holding.ticker}-watch-list`,
        ticker: holding.ticker,
        severity: 'info',
        category: 'watch',
        title: `${holding.ticker}: on your watch list`,
        reason: flags.note,
      })
    }
  })

  return signals
}

// ── Main function ──────────────────────────────────────────────────────────

export function generateSignals(
  holdings: Holding[],
  prices: PriceCache,
  research: Record<string, ResearchCacheRow> = {},
  usdNisRate: number = 3.75,
  settings?: Partial<SignalThresholds>
): Signal[] {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...settings }

  const allSignals = [
    ...generatePnLSignals(holdings, prices, thresholds),
    ...generateDailySignals(holdings, prices, thresholds),
    ...generateRsiSignals(holdings, research, thresholds),
    ...generateConcentrationSignals(holdings, prices, usdNisRate, thresholds),
    ...generateWatchSignals(holdings),
  ]

  // Sort by severity (action > warn > info), then by absolute pnl_pct within each severity
  const severityOrder = { action: 0, warn: 1, info: 2 }
  allSignals.sort((a, b) => {
    const severityDiff = severityOrder[a.severity] - severityOrder[b.severity]
    if (severityDiff !== 0) return severityDiff

    // Within same severity, sort by absolute pnl_pct (largest moves first)
    const pnlA = Math.abs(a.pnl_pct ?? 0)
    const pnlB = Math.abs(b.pnl_pct ?? 0)
    return pnlB - pnlA
  })

  return allSignals
}

// ── Why separate from UI? ──────────────────────────────────────────────────
//
// 1. TESTABILITY: Pure function with no dependencies on React, Supabase, or DOM.
//    Tests can call generateSignals() directly with mock data, verify output shape,
//    test edge cases (zero prices, missing data, threshold boundaries) without
//    rendering components.
//
// 2. REUSABILITY: Function works in CLI tools, batch jobs, webhooks, or any UI.
//    Could be called from a Supabase function to push notifications, or a Node.js
//    script to scan portfolios hourly.
//
// 3. MAINTAINABILITY: Signal logic is centralized. Change a threshold or add a new
//    rule once; it applies everywhere. No need to hunt through component code.
//
// 4. PERFORMANCE: Algorithm runs once, produces immutable output. UI just displays
//    it. No signal re-generation on every re-render or prop change.
//
// 5. EVOLUTION: Easy to add async enrichment later (e.g., fetch earnings dates,
//    news sentiment) — wrap the call, not the function itself.
