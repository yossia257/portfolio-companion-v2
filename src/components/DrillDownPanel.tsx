import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { PriceEntry, ErrorEntry } from '../lib/prices'

// ── Types ──────────────────────────────────────────────────────────────────

interface Holding {
  id: string
  ticker: string
  name: string | null
  quantity: number | string | null
  buy_price: number | string | null
  currency: string | null
  category: string | null
}

interface NewsItem {
  headline: string | null
  summary: string | null
  source: string | null
  datetime: number | null
  url: string | null
}

interface ResearchData {
  ticker: string
  description: string | null
  industry: string | null
  sector: string | null
  news: NewsItem[]
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

export interface DrillDownPanelProps {
  holding: Holding
  priceEntry: PriceEntry | ErrorEntry | undefined
  onClose: () => void
}

// ── Constants ─────────────────────────────────────────────────────────────

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  he: 'Hebrew',
  es: 'Spanish',
  de: 'German',
  fr: 'French',
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtNum(v: number | null | undefined, decimals = 2): string {
  if (v == null) return '—'
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
}

function pnlColor(v: number | null): string {
  if (v == null) return 'text-gray-400'
  if (v > 0) return 'text-green-400'
  if (v < 0) return 'text-red-400'
  return 'text-gray-400'
}

function timeAgo(unixSec: number | null): string {
  if (!unixSec) return ''
  const mins = Math.floor((Date.now() - unixSec * 1000) / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function rsiLabel(rsi: number): string {
  if (rsi < 30) return 'Oversold'
  if (rsi > 70) return 'Overbought'
  return 'Neutral'
}

function rsiColor(rsi: number): string {
  if (rsi < 30) return 'text-green-400'
  if (rsi > 70) return 'text-red-400'
  return 'text-gray-300'
}

// ── Skeleton pieces ────────────────────────────────────────────────────────

function Skel({ className }: { className?: string }) {
  return <div className={`rounded bg-gray-800 animate-pulse ${className ?? ''}`} />
}

function SectionSkeleton() {
  return (
    <div className="px-5 py-4 border-t border-gray-800 space-y-2">
      <Skel className="h-3 w-24" />
      <Skel className="h-4 w-full" />
      <Skel className="h-4 w-3/4" />
    </div>
  )
}

// ── Stat chip ──────────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-gray-500">{label}</span>
      <span className="text-sm font-medium text-gray-200">{value}</span>
    </div>
  )
}

// ── Component ──────────────────────────────────────────────────────────────

export default function DrillDownPanel({ holding, priceEntry, onClose }: DrillDownPanelProps) {
  const [isVisible, setIsVisible] = useState(false)
  const [research, setResearch] = useState<ResearchData | null>(null)
  const [language, setLanguage] = useState<string>('en')
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Slide-in: set visible on next tick so CSS transition fires from translate-x-full → 0
  useEffect(() => {
    const id = setTimeout(() => setIsVisible(true), 10)
    return () => clearTimeout(id)
  }, [])

  // ESC to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') handleClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Fetch research on open
  useEffect(() => {
    loadResearch(false)
  }, [holding.ticker])

  async function loadResearch(force: boolean) {
    setLoading(true)
    setFetchError(null)
    try {
      const { data, error } = await supabase.functions.invoke('fetch-research', {
        body: { ticker: holding.ticker, ...(force ? { force: true } : {}) },
      })
      if (error) throw new Error(error.message)
      setResearch(data?.research ?? null)
      setLanguage(data?.language ?? 'en')
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : 'Failed to load research data.')
    } finally {
      setLoading(false)
    }
  }

  function handleClose() {
    setIsVisible(false)
    setTimeout(onClose, 280)
  }

  // Derived price data from parent's price_cache state — no re-fetch
  const isLive = priceEntry != null && !('error' in priceEntry)
  const curPrice = isLive ? (priceEntry as PriceEntry).price : null
  const dailyChange = isLive ? (priceEntry as PriceEntry).daily_change_pct : null
  const ccySym = holding.currency?.toUpperCase() === 'USD' ? '$' : '₪'
  const buyPrice = holding.buy_price != null ? Number(holding.buy_price) : null
  const pnl = curPrice && buyPrice && buyPrice !== 0
    ? ((curPrice - buyPrice) / buyPrice) * 100
    : null

  return (
    <>
      {/* Backdrop — click outside to close */}
      <div
        className={`fixed inset-0 bg-black/60 z-30 transition-opacity duration-300 ${
          isVisible ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={handleClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className={`fixed right-0 top-0 h-full w-full sm:w-[480px] z-40 bg-gray-950 border-l border-gray-800
          flex flex-col transform transition-transform duration-300 ease-out
          ${isVisible ? 'translate-x-0' : 'translate-x-full'}`}
        role="dialog"
        aria-modal="true"
      >
        {/* ── Header ── */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <div>
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-2xl font-bold text-white">{holding.ticker}</span>
              {curPrice != null && (
                <span className="text-lg font-semibold text-white tabular-nums">
                  {ccySym}{fmtNum(curPrice)}
                </span>
              )}
              {dailyChange != null && (
                <span className={`text-sm tabular-nums ${pnlColor(dailyChange)}`}>
                  {fmtPct(dailyChange)}
                </span>
              )}
            </div>
            {holding.name && (
              <p className="text-sm text-gray-300 mt-0.5">{holding.name}</p>
            )}
            {/* Industry / sector tags from profile — rendered once research loads */}
            {research && (research.industry || research.sector) && (
              <p className="text-xs text-gray-500 mt-1">
                {[research.sector, research.industry].filter(Boolean).join(' · ')}
              </p>
            )}
            {research?.description && (
              <p className="text-xs text-gray-500 mt-1.5 leading-relaxed line-clamp-2 max-w-[340px]">
                {research.description}
              </p>
            )}
          </div>
          <button
            onClick={handleClose}
            className="text-gray-500 hover:text-white transition-colors text-xl leading-none p-1 -mr-1"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto">

          {/* ── My Position ── */}
          <section className="px-5 py-4 border-b border-gray-800">
            <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3">My Position</h3>
            <div className="grid grid-cols-3 gap-y-3 gap-x-4">
              <Stat label="Quantity"   value={holding.quantity != null ? Number(holding.quantity).toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—'} />
              <Stat label="Buy Price"  value={buyPrice != null ? `${ccySym}${fmtNum(buyPrice)}` : '—'} />
              <Stat label="P&L"        value={fmtPct(pnl)} />
              <Stat label="Currency"   value={holding.currency ?? '—'} />
              <Stat label="Category"   value={holding.category ?? '—'} />
            </div>
          </section>

          {loading ? (
            <>
              <SectionSkeleton />
              <SectionSkeleton />
              <SectionSkeleton />
              <SectionSkeleton />
            </>
          ) : fetchError ? (
            <div className="px-5 py-6 text-center">
              <p className="text-red-400 text-sm mb-3">{fetchError}</p>
              <button
                onClick={() => loadResearch(false)}
                className="px-4 py-2 rounded-lg bg-gray-800 text-gray-200 text-sm hover:bg-gray-700 transition-colors"
              >
                Retry
              </button>
            </div>
          ) : research ? (
            <>
              {/* ── Recent News ── */}
              <section className="px-5 py-4 border-b border-gray-800">
                <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3">Recent News</h3>
                {research.news.length === 0 ? (
                  <p className="text-sm text-gray-600">No recent news available.</p>
                ) : (
                  <div className="space-y-3">
                    {research.news.map((item, i) => (
                      <div key={i} className="space-y-0.5">
                        {item.url ? (
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-gray-200 hover:text-white leading-snug line-clamp-2 transition-colors"
                          >
                            {item.headline}
                          </a>
                        ) : (
                          <p className="text-sm text-gray-200 leading-snug line-clamp-2">{item.headline}</p>
                        )}
                        <div className="flex items-center gap-2 text-[11px] text-gray-600">
                          {item.source && <span>{item.source}</span>}
                          {item.datetime && <span>{timeAgo(item.datetime)}</span>}
                        </div>
                        {item.summary && (
                          <p className="text-xs text-gray-500 leading-relaxed">{item.summary}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* ── Analyst Sentiment ── */}
              <section className="px-5 py-4 border-b border-gray-800">
                <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3">Analyst Sentiment</h3>
                {research.analyst_buy == null && research.analyst_hold == null ? (
                  <p className="text-sm text-gray-600">Analyst data not available for local stocks.</p>
                ) : (() => {
                  const total = (research.analyst_buy ?? 0) + (research.analyst_hold ?? 0) + (research.analyst_sell ?? 0)
                  const buyPct  = total > 0 ? ((research.analyst_buy  ?? 0) / total) * 100 : 0
                  const holdPct = total > 0 ? ((research.analyst_hold ?? 0) / total) * 100 : 0
                  const sellPct = total > 0 ? ((research.analyst_sell ?? 0) / total) * 100 : 0
                  return (
                    <div className="space-y-2">
                      <div className="flex h-2.5 rounded-full overflow-hidden">
                        <div className="bg-green-500 transition-all" style={{ width: `${buyPct}%` }} />
                        <div className="bg-yellow-500 transition-all" style={{ width: `${holdPct}%` }} />
                        <div className="bg-red-500 transition-all"   style={{ width: `${sellPct}%` }} />
                      </div>
                      <div className="flex gap-4 text-xs text-gray-400">
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block" />{research.analyst_buy ?? 0} Buy</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-500 inline-block" />{research.analyst_hold ?? 0} Hold</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" />{research.analyst_sell ?? 0} Sell</span>
                      </div>
                      {research.target_price_mean != null && (
                        <p className="text-sm text-gray-300 mt-1">
                          Target: {ccySym}{fmtNum(research.target_price_mean)}
                          {research.target_price_low != null && research.target_price_high != null && (
                            <span className="text-gray-500"> (range {ccySym}{fmtNum(research.target_price_low)}–{ccySym}{fmtNum(research.target_price_high)})</span>
                          )}
                        </p>
                      )}
                    </div>
                  )
                })()}
              </section>

              {/* ── Technical Indicators ── */}
              <section className="px-5 py-4 border-b border-gray-800">
                <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3">Technical Indicators</h3>
                <div className="space-y-3">

                  {/* MA comparison */}
                  {(research.ma_20 != null || research.ma_50 != null) && curPrice != null && (
                    <p className="text-sm text-gray-300">
                      Price is{' '}
                      {[
                        research.ma_20 != null
                          ? (curPrice > research.ma_20
                              ? <span key="ma20" className="text-green-400">above 20d MA</span>
                              : <span key="ma20" className="text-red-400">below 20d MA</span>)
                          : null,
                        research.ma_50 != null
                          ? (curPrice > research.ma_50
                              ? <span key="ma50" className="text-green-400">above 50d MA</span>
                              : <span key="ma50" className="text-red-400">below 50d MA</span>)
                          : null,
                      ].filter(Boolean).reduce<React.ReactNode[]>((acc, el, i) =>
                        i === 0 ? [el] : [...acc, <span key={`sep${i}`} className="text-gray-600"> and </span>, el], []
                      )}
                    </p>
                  )}

                  {/* RSI */}
                  {research.rsi_14 != null && (
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-gray-400">RSI(14):</span>
                      <span className="text-sm font-semibold text-white tabular-nums">{research.rsi_14.toFixed(1)}</span>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full bg-gray-800 ${rsiColor(research.rsi_14)}`}>
                        {rsiLabel(research.rsi_14)}
                      </span>
                    </div>
                  )}

                  {/* 52-week range bar */}
                  {research.week52_low != null && research.week52_high != null && (
                    <div>
                      <div className="flex justify-between text-xs text-gray-500 mb-1">
                        <span>{ccySym}{fmtNum(research.week52_low)}</span>
                        <span className="text-gray-600">52-week range</span>
                        <span>{ccySym}{fmtNum(research.week52_high)}</span>
                      </div>
                      <div className="relative h-2 rounded-full bg-gray-700">
                        {curPrice != null && research.week52_high > research.week52_low && (
                          <div
                            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white border-2 border-gray-950 shadow"
                            style={{
                              left: `${Math.max(2, Math.min(98, ((curPrice - research.week52_low) / (research.week52_high - research.week52_low)) * 100))}%`,
                            }}
                          />
                        )}
                      </div>
                    </div>
                  )}

                  {/* Fundamentals */}
                  <div className="grid grid-cols-3 gap-y-3 gap-x-4 pt-1">
                    <Stat label="PE (TTM)" value={research.pe_ratio != null ? fmtNum(research.pe_ratio, 1) : '—'} />
                    <Stat label="Beta"     value={research.beta     != null ? fmtNum(research.beta,     2) : '—'} />
                    <Stat label="EPS (TTM)" value={research.eps     != null ? `${ccySym}${fmtNum(research.eps, 2)}` : '—'} />
                  </div>
                </div>
              </section>

              {/* ── AI Summary ── */}
              <section className="px-5 py-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs uppercase tracking-wider text-gray-500">AI Summary</h3>
                  <button
                    onClick={() => loadResearch(true)}
                    className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    Regenerate ↺
                  </button>
                </div>
                {research.ai_summary ? (
                  <>
                    <p
                      className="text-sm text-gray-300 leading-relaxed"
                      dir={language === 'he' ? 'rtl' : 'ltr'}
                    >
                      {research.ai_summary}
                    </p>
                    {research.ai_summary_at && (
                      <p className="text-xs text-gray-600 mt-3">
                        Generated by Claude in {LANG_NAMES[language] ?? language} · {fmtDateTime(research.ai_summary_at)}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-gray-600">
                    Summary not available.{' '}
                    <button onClick={() => loadResearch(true)} className="underline hover:text-gray-400 transition-colors">
                      Generate now
                    </button>
                  </p>
                )}
              </section>
            </>
          ) : null}
        </div>
      </div>
    </>
  )
}
