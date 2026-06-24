import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useResearchCache } from '../lib/useResearchCache'
import { useAiSummaryCache } from '../lib/useAiSummaryCache'
import { useUserProfile } from '../lib/useUserProfile'
import { getDirection, getTextAlign } from '../lib/rtl'
import type { PriceEntry, ErrorEntry } from '../lib/prices'
import type { ResearchCacheRow } from '../lib/signals'

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

export interface DrillDownPanelProps {
  holding: Holding | null
  watchlistTicker?: string
  priceEntry: PriceEntry | ErrorEntry | undefined
  onClose: () => void
  rsuContext?: {
    quantity: number
    vestDate: string
  }
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

export default function DrillDownPanel({ holding, watchlistTicker, priceEntry, onClose, rsuContext }: DrillDownPanelProps) {
  const { profile } = useUserProfile()
  const [isVisible, setIsVisible] = useState(false)
  const [research, setResearch] = useState<ResearchCacheRow | null>(null)
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [aiSummary, setAiSummary] = useState<string | null>(null)
  const [aiSummaryAt, setAiSummaryAt] = useState<string | null>(null)
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const { fetch: fetchResearch } = useResearchCache()
  const { fetch: fetchAiSummary } = useAiSummaryCache()

  // Resolved language: use profile language, fall back to English
  const language = selectedLanguage ?? profile?.ai_response_language ?? 'en'

  // Flags state with safe defaults
  const [flags, setFlags] = useState(() => ({
    watch: false,
    thesis_broken: false,
    note: '',
  }))
  const noteDebounceRef = useRef<NodeJS.Timeout | null>(null)

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

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (noteDebounceRef.current) {
        clearTimeout(noteDebounceRef.current)
      }
    }
  }, [])

  // Fetch research on open — cache & deduplication handled by loadResearch
  useEffect(() => {
    const ticker = holding?.ticker ?? watchlistTicker
    if (!ticker) return

    console.log(`[DrillDownPanel] Loading research for ${ticker}`)
    loadResearch(false)
  }, [holding?.ticker, watchlistTicker])

  // Fetch AI summary after research loads
  // If a fresh cached summary exists for the language, use it; otherwise, fetch in background
  useEffect(() => {
    if (!research) return
    const ticker = holding?.ticker ?? watchlistTicker
    if (!ticker) return

    // Capture values in outer scope before async function
    const researchData = research
    const tickerValue = ticker
    const languageValue = language

    async function loadAiSummary() {
      // Check if research includes a fresh cached summary for this language
      const cachedEntry = researchData.ai_summaries?.[languageValue]
      if (cachedEntry?.text) {
        console.log(`[DrillDownPanel] AI summary cached for ${languageValue}`)
        setAiSummary(cachedEntry.text)
        setAiSummaryAt(cachedEntry.at)
        return
      }

      // No fresh cache; fetch in background
      console.log(`[DrillDownPanel] Fetching AI summary for ${tickerValue} (${languageValue})`)
      setAiSummaryLoading(true)
      try {
        const entry = await fetchAiSummary(tickerValue, languageValue)
        if (entry?.summary) {
          setAiSummary(entry.summary)
          setAiSummaryAt(entry.summary_at)
        }
      } catch (e) {
        console.error('[DrillDownPanel] AI summary fetch failed:', e)
      } finally {
        setAiSummaryLoading(false)
      }
    }

    loadAiSummary()
  }, [research, language, fetchAiSummary, holding?.ticker, watchlistTicker])

  // Fetch flags on open
  useEffect(() => {
    if (!holding || !holding.id) return

    async function fetchFlags() {
      try {
        const { data, error } = await supabase
          .from('holdings')
          .select('flags')
          .eq('id', holding!.id)
          .single()

        if (error) {
          console.error('[DrillDownPanel] Error fetching flags:', error)
          return
        }

        if (data && typeof data.flags === 'object' && data.flags !== null) {
          setFlags(data.flags)
        }
      } catch (e) {
        console.error('[DrillDownPanel] Exception fetching flags:', e)
      }
    }

    fetchFlags()
  }, [holding?.id])

  async function loadResearch(force: boolean) {
    const ticker = holding?.ticker ?? watchlistTicker
    if (!ticker) return
    setError(null)
    try {
      let researchData = null

      if (force) {
        // Force refresh: bypass cache and fetch directly with force flag
        const { data, error } = await supabase.functions.invoke('fetch-research', {
          body: { ticker, force: true },
        })
        if (error) throw new Error(error.message)
        researchData = data?.research ?? null
      } else {
        // Normal load: use cache with deduplication
        // If multiple panels open the same ticker simultaneously, they share one fetch
        researchData = await fetchResearch(ticker)
      }

      console.log('[DrillDownPanel] research loaded:', researchData)
      setResearch(researchData)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load research data.')
    }
  }

  function handleClose() {
    setIsVisible(false)
    setTimeout(onClose, 280)
  }

  async function updateFlags(newFlags: typeof flags) {
    if (!holding) return
    setFlags(newFlags)
    try {
      const { error } = await supabase
        .from('holdings')
        .update({ flags: newFlags })
        .eq('id', holding.id)

      if (error) {
        console.error('[DrillDownPanel] Error updating flags:', error)
      } else {
        console.log('[DrillDownPanel] Flags updated:', newFlags)
      }
    } catch (e) {
      console.error('[DrillDownPanel] Exception updating flags:', e)
    }
  }

  function handleToggleWatch() {
    const newFlags = {
      watch: !(flags.watch ?? false),
      thesis_broken: flags.thesis_broken ?? false,
      note: flags.note ?? '',
    }
    updateFlags(newFlags)
  }

  function handleToggleThesisBroken() {
    const newFlags = {
      watch: flags.watch ?? false,
      thesis_broken: !(flags.thesis_broken ?? false),
      note: flags.note ?? '',
    }
    updateFlags(newFlags)
  }

  function handleNoteChange(note: string) {
    const newFlags = {
      watch: flags.watch ?? false,
      thesis_broken: flags.thesis_broken ?? false,
      note,
    }
    setFlags(newFlags)

    // Debounce the DB update
    if (noteDebounceRef.current) {
      clearTimeout(noteDebounceRef.current)
    }

    noteDebounceRef.current = setTimeout(() => {
      updateFlags(newFlags)
    }, 1000)
  }

  // Derived price data from parent's price_cache state — no re-fetch
  const isLive = priceEntry != null && !('error' in priceEntry)
  const curPrice = isLive ? (priceEntry as PriceEntry).price : null
  const dailyChange = isLive ? (priceEntry as PriceEntry).daily_change_pct : null
  const ccySym = holding?.currency?.toUpperCase() === 'USD' ? '$' : '₪'
  const buyPrice = holding && holding.buy_price != null ? Number(holding.buy_price) : null
  const pnl = curPrice && buyPrice && buyPrice !== 0
    ? ((curPrice - buyPrice) / buyPrice) * 100
    : null

  // Defensive flags access with defaults
  const flagsNote = flags.note ?? ''
  const flagsWatch = flags.watch ?? false
  const flagsThesisBroken = flags.thesis_broken ?? false

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
              <span className="font-mono text-2xl font-bold text-white">{holding?.ticker ?? 'Watchlist'}</span>
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
            {holding?.name && (
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

          {/* ── My Position (only for owned holdings) ── */}
          {holding && (
            <section className="px-5 py-4 border-b border-gray-800">
              <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3">
                {rsuContext ? 'RSU Grant' : 'My Position'}
              </h3>
              {rsuContext ? (
                <div className="space-y-2 text-sm">
                  <p className="text-gray-300">
                    Held via RSU grant — {rsuContext.quantity.toLocaleString()} shares vesting{' '}
                    {new Date(rsuContext.vestDate).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}
                  </p>
                  <p className="text-xs text-gray-500">
                    View full grant details in the RSU tab
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-y-3 gap-x-4">
                  <Stat label="Quantity"   value={holding.quantity != null ? Number(holding.quantity).toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—'} />
                  <Stat label="Buy Price"  value={buyPrice != null ? `${ccySym}${fmtNum(buyPrice)}` : '—'} />
                  <Stat label="P&L"        value={fmtPct(pnl)} />
                  <Stat label="Currency"   value={holding.currency ?? '—'} />
                  <Stat label="Category"   value={holding.category ?? '—'} />
                </div>
              )}
            </section>
          )}

          {/* Error state */}
          {error && (
            <div className="px-5 py-6 text-center">
              <p className="text-red-400 text-sm mb-3">{error}</p>
              <button
                onClick={() => loadResearch(false)}
                className="px-4 py-2 rounded-lg bg-gray-800 text-gray-200 text-sm hover:bg-gray-700 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {/* ── Analyst Sentiment ── (fast; show even if news/ai still loading) */}
          <section className="px-5 py-4 border-b border-gray-800">
            <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3">Analyst Sentiment</h3>
            {!research ? (
              <SectionSkeleton />
            ) : research.analyst_buy == null && research.analyst_hold == null ? (
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
                    <div className="text-sm text-gray-300 mt-3 space-y-1.5">
                      <p>
                        Analyst target: {ccySym}{fmtNum(research.target_price_mean)}
                        {(research.target_price_low != null || research.target_price_high != null) && (
                          <span className="text-gray-500 text-xs ml-1">
                            (
                            {research.target_price_low != null && research.target_price_high != null ? (
                              <>
                                low {ccySym}{fmtNum(research.target_price_low)} · high {ccySym}{fmtNum(research.target_price_high)}
                                {research.target_price_median != null && (
                                  <>, median {ccySym}{fmtNum(research.target_price_median)}</>
                                )}
                              </>
                            ) : research.target_price_low != null ? (
                              <>low {ccySym}{fmtNum(research.target_price_low)}</>
                            ) : (
                              <>high {ccySym}{fmtNum(research.target_price_high)}</>
                            )}
                            )
                          </span>
                        )}
                      </p>
                      {curPrice != null && (
                        <p className="text-xs text-gray-400">
                          Current: {ccySym}{fmtNum(curPrice)}
                          {' — '}
                          <span className={curPrice < research.target_price_mean ? 'text-green-400' : 'text-red-400'}>
                            upside {(((research.target_price_mean - curPrice) / curPrice) * 100).toFixed(1)}%
                          </span>
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )
            })()}
          </section>

          {/* ── Technical Indicators ── (fast) */}
          <section className="px-5 py-4 border-b border-gray-800">
            <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3">Technical Indicators</h3>
            {!research ? (
              <SectionSkeleton />
            ) : (
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

                {/* Valuation: PE, Beta, EPS */}
                <div className="grid grid-cols-3 gap-2 text-xs">
                  {research.pe_ratio != null && (
                    <div>
                      <span className="text-gray-500">PE</span>
                      <p className="font-medium text-gray-200">{research.pe_ratio.toFixed(1)}</p>
                    </div>
                  )}
                  {research.beta != null && (
                    <div>
                      <span className="text-gray-500">Beta</span>
                      <p className="font-medium text-gray-200">{research.beta.toFixed(2)}</p>
                    </div>
                  )}
                  {research.eps != null && (
                    <div>
                      <span className="text-gray-500">EPS (TTM)</span>
                      <p className="font-medium text-gray-200">{research.eps.toFixed(2)}</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* ── Recent News ── (slower; skeleton while loading) */}
          <section className="px-5 py-4 border-b border-gray-800">
            <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3">Recent News</h3>
            {!research ? (
              <SectionSkeleton />
            ) : research.news.length === 0 ? (
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

          {/* ── Flags ── */}
          <section className="px-5 py-4 border-b border-gray-800">
            <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3">Flags</h3>
            <div className="space-y-3">
              {/* Toggle buttons */}
              <div className="flex gap-2">
                <button
                  onClick={handleToggleWatch}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    flagsWatch
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:text-gray-300'
                  }`}
                >
                  🚩 Watch {flagsWatch ? '✓' : ''}
                </button>
                <button
                  onClick={handleToggleThesisBroken}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    flagsThesisBroken
                      ? 'bg-red-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:text-gray-300'
                  }`}
                >
                  ❌ Thesis Broken {flagsThesisBroken ? '✓' : ''}
                </button>
              </div>

              {/* Note input */}
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-wider mb-2">
                  Note ({flagsNote.length}/280)
                </label>
                <textarea
                  value={flagsNote}
                  onChange={(e) => handleNoteChange(e.target.value.slice(0, 280))}
                  placeholder="Why you're watching this (optional)"
                  maxLength={280}
                  rows={3}
                  className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500 resize-none"
                />
              </div>
            </div>
          </section>

          {/* ── AI Summary ── (now non-blocking; fetches after research loads) */}
          <section className="px-5 py-4 border-b border-gray-800">
            <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3">AI Summary</h3>
            {aiSummaryLoading ? (
              <div className="text-sm text-gray-400 italic">
                ✨ Generating summary…
              </div>
            ) : aiSummary ? (
              <div>
                <p
                  dir={getDirection(language)}
                  className={`text-sm text-gray-300 leading-relaxed mb-3 text-${getTextAlign(language)}`}
                >
                  {aiSummary}
                </p>
                {aiSummaryAt && (
                  <p className="text-xs text-gray-600 mb-3">Generated {fmtDateTime(aiSummaryAt)}</p>
                )}
                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-gray-600">Language:</span>
                  <select
                    value={selectedLanguage ?? profile?.ai_response_language ?? 'en'}
                    onChange={(e) => setSelectedLanguage(e.target.value)}
                    className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300"
                  >
                    {Object.entries(LANG_NAMES).map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      const ticker = holding?.ticker ?? watchlistTicker
                      if (!ticker) return
                      setAiSummary(null)
                      setAiSummaryAt(null)
                      setAiSummaryLoading(true)
                      // Fetch fresh summary by calling endpoint directly
                      supabase.functions
                        .invoke('fetch-ai-summary', {
                          body: { ticker, language },
                        })
                        .then(({ data, error }) => {
                          if (error) {
                            console.error('[DrillDownPanel] Refresh failed:', error)
                          } else {
                            setAiSummary(data?.summary ?? null)
                            setAiSummaryAt(data?.summary_at ?? null)
                          }
                        })
                        .finally(() => {
                          setAiSummaryLoading(false)
                        })
                    }}
                    className="text-xs text-gray-500 hover:text-white transition-colors ml-auto"
                  >
                    Refresh summary ↻
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-600">AI summary not available</p>
            )}
          </section>

        </div>
      </div>
    </>
  )
}
