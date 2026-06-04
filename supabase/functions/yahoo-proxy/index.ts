import '@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from '@supabase/supabase-js'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const CACHE_TTL_MS = 15 * 60 * 1000

// Without this header Yahoo Finance returns 401/403 to server-side clients.
// It presents the request as a normal browser visit to a Mac running Safari.
const YAHOO_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
)

// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// ---------------------------------------------------------------------------

type CacheRow = {
  ticker: string
  price: number
  daily_change_pct: number
  fetched_at: string
}

type PriceEntry = { price: number; daily_change_pct: number; currency: 'NIS' }
type ErrorEntry = { error: string }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  try {
    const body = await req.json().catch(() => null)
    const rawTickers: string[] = Array.isArray(body?.tickers)
      ? body.tickers.filter((t: unknown) => typeof t === 'string' && (t as string).trim().length > 0)
      : []

    // Enforce .TA-only: silently drop anything else so the caller can't
    // mix .TA and USD tickers (which would incorrectly get ÷100 applied).
    const tickers = rawTickers.filter((t) => t.toUpperCase().endsWith('.TA'))

    if (tickers.length === 0) {
      return json({ prices: {} })
    }

    // ── Step 1: Read cache for all requested tickers ─────────────────────────
    const { data: cachedRows } = await supabase
      .from('price_cache')
      .select('ticker, price, daily_change_pct, fetched_at')
      .in('ticker', tickers)

    const now = Date.now()
    const freshCache = new Map<string, { price: number; daily_change_pct: number }>()

    for (const row of cachedRows ?? []) {
      const ageMs = now - new Date(row.fetched_at).getTime()
      if (ageMs < CACHE_TTL_MS) {
        freshCache.set(row.ticker, {
          price: Number(row.price),
          daily_change_pct: Number(row.daily_change_pct),
        })
      }
    }

    // ── Step 2: Identify stale/missing tickers ───────────────────────────────
    const stale = tickers.filter((t) => !freshCache.has(t))

    // ── Step 3: Fetch stale tickers from Yahoo Finance in parallel ───────────
    const fetchErrors = new Map<string, string>()

    if (stale.length > 0) {
      const outcomes = await Promise.allSettled(
        stale.map(async (ticker) => {
          const url =
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`

          const res = await fetch(url, {
            headers: { 'User-Agent': YAHOO_UA },
          })

          if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} for ${ticker}`)

          const data = await res.json()

          // Yahoo surfaces errors inside the JSON even on HTTP 200
          if (data.chart?.error || !data.chart?.result?.[0]) {
            throw new Error(
              data.chart?.error?.description ?? `No chart data for ${ticker}`
            )
          }

          const meta = data.chart.result[0].meta
          const rawCurrent: number = meta.regularMarketPrice
          // Yahoo uses either field depending on the symbol and timing
          const rawPrevious: number | undefined =
            meta.previousClose ?? meta.chartPreviousClose

          if (!rawCurrent) throw new Error(`regularMarketPrice missing for ${ticker}`)

          // .TA prices from Yahoo are in Agorot (1/100 NIS) — convert to NIS.
          // The % change is the same whether calculated in Agorot or NIS,
          // but we store the NIS price so callers never see raw Agorot values.
          const price = rawCurrent / 100
          const daily_change_pct = rawPrevious
            ? ((rawCurrent - rawPrevious) / rawPrevious) * 100
            : 0

          return {
            ticker,
            price,
            daily_change_pct,
            fetched_at: new Date().toISOString(),
          } satisfies CacheRow
        })
      )

      // ── Step 4: Batch-upsert successes, collect per-ticker errors ──────────
      const upsertRows: CacheRow[] = []

      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i]
        const ticker = stale[i]

        if (outcome.status === 'fulfilled') {
          upsertRows.push(outcome.value)
          freshCache.set(ticker, {
            price: outcome.value.price,
            daily_change_pct: outcome.value.daily_change_pct,
          })
        } else {
          const msg = outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason)
          console.error(`Yahoo fetch failed [${ticker}]:`, msg)
          fetchErrors.set(ticker, msg)
        }
      }

      if (upsertRows.length > 0) {
        const { error } = await supabase
          .from('price_cache')
          .upsert(upsertRows, { onConflict: 'ticker' })
        if (error) console.error('price_cache upsert error:', error.message)
      }
    }

    // ── Step 5: Build response ───────────────────────────────────────────────
    const prices: Record<string, PriceEntry | ErrorEntry> = {}

    for (const ticker of tickers) {
      const entry = freshCache.get(ticker)
      if (entry) {
        prices[ticker] = { ...entry, currency: 'NIS' }
      } else {
        prices[ticker] = { error: fetchErrors.get(ticker) ?? 'not found' }
      }
    }

    return json({ prices })
  } catch (err) {
    console.error('yahoo-proxy unhandled error:', err)
    return json({ error: String(err) }, 500)
  }
})
