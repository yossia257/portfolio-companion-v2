import { useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { PriceMap } from '../lib/prices'
import DrillDownPanel from './DrillDownPanel'

type SortCol =
  | 'ticker' | 'name' | 'qty' | 'buy_price'
  | 'cur_price' | 'daily_pct' | 'pre_price' | 'pre_pct'
  | 'total_nis' | 'pnl_pct'
type SortDir = 'asc' | 'desc'

interface Holding {
  id: string
  ticker: string
  name: string | null
  quantity: number | string | null
  currency: string | null
  buy_price: number | string | null
  category: string | null
}

// ── Editable Cell Component ────────────────────────────────────────────────

interface EditableCellProps {
  value: string | number | null
  type: 'quantity' | 'buyPrice' | 'category'
  holdingId: string
  onSave: (value: any) => void
  format?: (v: any) => string
  prefix?: string
}

function EditableCell({ value, type, holdingId, onSave, format, prefix }: EditableCellProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(String(value ?? ''))
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const escapePressedRef = useRef(false)

  const displayValue = format ? format(value) : value ?? '—'

  async function handleSave(val: string) {
    setError(null)

    let parsedValue: any = val
    let fieldName: string = type

    if (type === 'quantity') {
      parsedValue = Number(val)
      if (parsedValue <= 0 || isNaN(parsedValue)) {
        setError('Quantity must be > 0')
        return
      }
      fieldName = 'quantity'
    } else if (type === 'buyPrice') {
      parsedValue = Number(val)
      if (parsedValue < 0 || isNaN(parsedValue)) {
        setError('Buy price must be ≥ 0')
        return
      }
      fieldName = 'buy_price'
    } else if (type === 'category') {
      if (val.length > 50) {
        setError('Max 50 characters')
        return
      }
      parsedValue = val || null
      fieldName = 'category'
    }

    try {
      await supabase
        .from('holdings')
        .update({ [fieldName]: parsedValue })
        .eq('id', holdingId)

      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
      setIsEditing(false)
      onSave(parsedValue)
    } catch (e) {
      setError('Failed to save')
      console.error(e)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      escapePressedRef.current = true
      setIsEditing(false)
      setEditValue(String(value ?? ''))
      setError(null)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      handleSave(editValue)
    }
  }

  function handleBlur() {
    if (!escapePressedRef.current && editValue !== String(value ?? '')) {
      handleSave(editValue)
    } else if (escapePressedRef.current) {
      setEditValue(String(value ?? ''))
    }
    escapePressedRef.current = false
    setIsEditing(false)
  }

  if (!isEditing) {
    return (
      <div
        className="cursor-pointer hover:text-blue-400 transition-colors py-1 relative group"
        onClick={() => setIsEditing(true)}
      >
        <span>{prefix}{displayValue}</span>
        <span className="absolute -right-4 opacity-0 group-hover:opacity-100 transition-opacity text-gray-500">✎</span>
        {saved && <span className="text-green-400 text-xs ml-1">✓</span>}
      </div>
    )
  }

  return (
    <div className="relative">
      <input
        autoFocus
        type={type === 'category' ? 'text' : 'number'}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        step={type === 'buyPrice' ? '0.01' : undefined}
        min={type === 'quantity' ? '0.0001' : type === 'buyPrice' ? '0' : undefined}
        className={`px-2 py-1 w-full rounded bg-gray-800 border text-white text-sm focus:outline-none ${
          error ? 'border-red-500' : 'border-blue-500'
        }`}
      />
      {error && <div className="text-red-400 text-xs mt-1 absolute">{error}</div>}
    </div>
  )
}

interface Profile {
  display_name: string | null
  display_currency: string
}

interface PriceEntry {
  price: number
  daily_change_pct: number
  currency: 'USD' | 'NIS'
  pre_market_price: number | null
  pre_market_change_pct: number | null
  market_state: string | null
}

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
  return '₪ ' + Math.round(v).toLocaleString()
}

function pnlColor(v: number | null): string {
  if (v == null) return 'text-gray-500'
  if (v > 0) return 'text-green-400'
  if (v < 0) return 'text-red-400'
  return 'text-gray-400'
}

function Pulse() {
  return <span className="inline-block w-14 h-3 rounded bg-gray-800 animate-pulse align-middle" />
}

interface PortfolioTabProps {
  profile: Profile | null
  holdings: Holding[] | null
  prices: PriceMap
  usdNis: number | null
  pricesLoading: boolean
  sortedHoldings: Holding[]
  sortState: { column: SortCol; direction: SortDir }
  onSortClick: (col: SortCol) => void
  onUpload: () => void
}

export default function PortfolioTab({
  profile,
  holdings,
  prices,
  usdNis,
  pricesLoading,
  sortedHoldings,
  sortState,
  onSortClick,
  onUpload,
}: PortfolioTabProps) {
  const [selectedHolding, setSelectedHolding] = useState<Holding | null>(null)

  const list = holdings ?? []

  // Calculate KPIs from raw holdings (unsorted, for aggregate values)
  let totalNis: number | null = null
  const performers: { ticker: string; pnl: number }[] = []

  function nisValue(h: Holding): number | null {
    const qty = h.quantity != null ? Number(h.quantity) : null
    if (qty == null || isNaN(qty)) return null

    const entry = prices[h.ticker]
    const live = entry != null && !('error' in entry) ? entry.price : null
    const ccy = h.currency?.toUpperCase()

    if (ccy === 'USD') {
      if (live == null || usdNis == null) return null
      return qty * live * usdNis
    }
    if (ccy === 'NIS') {
      if (live != null) return qty * live
      const bp = h.buy_price != null ? Number(h.buy_price) : null
      if (bp == null || isNaN(bp)) return null
      return qty * bp
    }
    return null
  }

  function pnlPct(h: Holding): number | null {
    const buy = h.buy_price != null ? Number(h.buy_price) : null
    if (buy == null || buy === 0 || isNaN(buy)) return null
    const entry = prices[h.ticker]
    const live = entry != null && !('error' in entry) ? entry.price : null
    if (live == null) return null
    return ((live - buy) / buy) * 100
  }

  for (const h of list) {
    const v = nisValue(h)
    if (v != null) totalNis = (totalNis ?? 0) + v
    const pnl = pnlPct(h)
    if (pnl != null) performers.push({ ticker: h.ticker, pnl })
  }

  performers.sort((a, b) => a.pnl - b.pnl)
  const worst = performers[0] ?? null
  const best = performers[performers.length - 1] ?? null

  const showPreMarket = list.some((h) => {
    const e = prices[h.ticker]
    return e != null && !('error' in e) && (e as PriceEntry).pre_market_price != null
  })

  return (
    <>
      {/* KPI row */}
      <div className="px-6 py-8 max-w-7xl w-full mx-auto">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {/* Total Value */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">
              Total Value ({profile?.display_currency ?? 'NIS'})
            </p>
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
              onClick={onUpload}
              className="px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 transition-colors"
            >
              Upload a file
            </button>
          </div>
        )}

        {/* Holdings table */}
        {list.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-gray-800">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400">
                <tr>
                  <th
                    className="px-4 py-3 text-left font-medium cursor-pointer hover:text-white transition-colors"
                    onClick={() => onSortClick('ticker')}
                  >
                    Ticker {sortState.column === 'ticker' && (sortState.direction === 'asc' ? '▲' : '▼')}
                  </th>
                  <th
                    className="px-4 py-3 text-left font-medium cursor-pointer hover:text-white transition-colors"
                    onClick={() => onSortClick('name')}
                  >
                    Name {sortState.column === 'name' && (sortState.direction === 'asc' ? '▲' : '▼')}
                  </th>
                  <th
                    className="px-4 py-3 text-right font-medium cursor-pointer hover:text-white transition-colors"
                    onClick={() => onSortClick('qty')}
                  >
                    Qty {sortState.column === 'qty' && (sortState.direction === 'asc' ? '▲' : '▼')}
                  </th>
                  <th
                    className="px-4 py-3 text-right font-medium cursor-pointer hover:text-white transition-colors"
                    onClick={() => onSortClick('buy_price')}
                  >
                    Buy Price {sortState.column === 'buy_price' && (sortState.direction === 'asc' ? '▲' : '▼')}
                  </th>
                  <th
                    className="px-4 py-3 text-right font-medium cursor-pointer hover:text-white transition-colors"
                    onClick={() => onSortClick('cur_price')}
                  >
                    Current Price {sortState.column === 'cur_price' && (sortState.direction === 'asc' ? '▲' : '▼')}
                  </th>
                  <th
                    className="px-4 py-3 text-right font-medium cursor-pointer hover:text-white transition-colors"
                    onClick={() => onSortClick('daily_pct')}
                  >
                    Daily % {sortState.column === 'daily_pct' && (sortState.direction === 'asc' ? '▲' : '▼')}
                  </th>
                  {showPreMarket && (
                    <th
                      className="px-4 py-3 text-right font-medium cursor-pointer hover:text-white transition-colors"
                      onClick={() => onSortClick('pre_price')}
                    >
                      Pre-Market {sortState.column === 'pre_price' && (sortState.direction === 'asc' ? '▲' : '▼')}
                    </th>
                  )}
                  {showPreMarket && (
                    <th
                      className="px-4 py-3 text-right font-medium cursor-pointer hover:text-white transition-colors"
                      onClick={() => onSortClick('pre_pct')}
                    >
                      Pre-Mkt % {sortState.column === 'pre_pct' && (sortState.direction === 'asc' ? '▲' : '▼')}
                    </th>
                  )}
                  <th
                    className="px-4 py-3 text-right font-medium cursor-pointer hover:text-white transition-colors"
                    onClick={() => onSortClick('total_nis')}
                  >
                    Total ({profile?.display_currency ?? 'NIS'}) {sortState.column === 'total_nis' && (sortState.direction === 'asc' ? '▲' : '▼')}
                  </th>
                  <th
                    className="px-4 py-3 text-right font-medium cursor-pointer hover:text-white transition-colors"
                    onClick={() => onSortClick('pnl_pct')}
                  >
                    P&amp;L % {sortState.column === 'pnl_pct' && (sortState.direction === 'asc' ? '▲' : '▼')}
                  </th>
                  <th
                    className="px-4 py-3 text-left font-medium text-gray-400"
                  >
                    Category
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedHoldings.map((h, i) => {
                  const isUsd = h.currency?.toUpperCase() === 'USD'
                  const isNis = h.currency?.toUpperCase() === 'NIS'
                  const ccySym = isUsd ? '$' : isNis ? '₪' : ''
                  const entry = prices[h.ticker]
                  const hasLive = entry != null && !('error' in entry)
                  const isNoData = entry != null && 'error' in entry
                  const cur = hasLive ? (entry as PriceEntry).price : null
                  const daily = hasLive ? (entry as PriceEntry).daily_change_pct : null
                  const prePrice = hasLive ? ((entry as PriceEntry).pre_market_price ?? null) : null
                  const preChangePct = hasLive ? ((entry as PriceEntry).pre_market_change_pct ?? null) : null
                  const total = nisValue(h)
                  const pnl = pnlPct(h)
                  const waiting = pricesLoading && entry == null

                  return (
                    <tr
                      key={h.id}
                      className={`border-t border-gray-800 hover:bg-gray-900/50 transition-colors ${
                        i % 2 === 0 ? '' : 'bg-gray-900/20'
                      }`}
                    >
                      {/* Ticker */}
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
                        <EditableCell
                          value={h.quantity}
                          type="quantity"
                          holdingId={h.id}
                          onSave={() => {}}
                          format={fmtQty}
                        />
                      </td>

                      {/* Buy Price */}
                      <td className="px-4 py-3 text-right text-gray-200 tabular-nums">
                        <EditableCell
                          value={h.buy_price}
                          type="buyPrice"
                          holdingId={h.id}
                          onSave={() => {}}
                          format={(v) => v != null ? fmtPrice(v) : ''}
                          prefix={h.buy_price != null ? ccySym : ''}
                        />
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

                      {/* Pre-Market Price */}
                      {showPreMarket && (
                        <td className="px-4 py-3 text-right tabular-nums">
                          {prePrice != null ? (
                            <span className="text-amber-300">{ccySym}{fmtPrice(prePrice)}</span>
                          ) : (
                            <span className="text-gray-700">—</span>
                          )}
                        </td>
                      )}

                      {/* Pre-Market % */}
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

                      {/* Category */}
                      <td className="px-4 py-3 text-left text-gray-300">
                        <EditableCell
                          value={h.category}
                          type="category"
                          holdingId={h.id}
                          onSave={() => {}}
                        />
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
      </div>

      {selectedHolding && (
        <DrillDownPanel
          holding={selectedHolding}
          priceEntry={prices[selectedHolding.ticker]}
          onClose={() => setSelectedHolding(null)}
        />
      )}
    </>
  )
}
