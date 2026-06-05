import '@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from '@supabase/supabase-js'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const CACHE_TTL_MS = 15 * 60 * 1000

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
  ticker:                string
  price:                 number
  daily_change_pct:      number
  pre_market_price:      number | null
  pre_market_change_pct: number | null
  market_state:          string | null
  fetched_at:            string
}

type PriceEntry = {
  price:                 number
  daily_change_pct:      number
  currency:              'USD' | 'NIS'
  pre_market_price:      number | null
  pre_market_change_pct: number | null
  market_state:          string | null
}

type ErrorEntry = { error: string }

// Fields we keep in-memory from a cache hit (currency derived at response time)
type CachedEntry = Omit<PriceEntry, 'currency'>

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  try {
    const body = await req.json().catch(() => null)
    const tickers: string[] = Array.isArray(body?.tickers)
      ? body.tickers.filter((t: unknown) => typeof t === 'string' && (t as string).trim().length > 0)
      : []

    if (tickers.length === 0) {
      return json({ prices: {} })
    }

    // ── Step 1: Read cache ───────────────────────────────────────────────────
    const { data: cachedRows } = await supabase
      .from('price_cache')
      .select('ticker, price, daily_change_pct, pre_market_price, pre_market_change_pct, market_state, fetched_at')
      .in('ticker', tickers)

    const now = Date.now()
    const freshCache = new Map<string, CachedEntry>()

    for (const row of cachedRows ?? []) {
      const ageMs = now - new Date(row.fetched_at).getTime()
      if (ageMs < CACHE_TTL_MS) {
        freshCache.set(row.ticker, {
          price:                 Number(row.price),
          daily_change_pct:      Number(row.daily_change_pct),
          pre_market_price:      row.pre_market_price      != null ? Number(row.pre_market_price)      : null,
          pre_market_change_pct: row.pre_market_change_pct != null ? Number(row.pre_market_change_pct) : null,
          market_state:          row.market_state          ?? null,
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
          const isTA = ticker.toUpperCase().endsWith('.TA')
          // interval=1d&range=5d gives us meta.preMarketPrice alongside regular market data
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`

          const res = await fetch(url, { headers: { 'User-Agent': YAHOO_UA } })

          if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} for ${ticker}`)

          const data = await res.json()

          if (data.chart?.error || !data.chart?.result?.[0]) {
            throw new Error(data.chart?.error?.description ?? `No chart data for ${ticker}`)
          }

          const meta = data.chart.result[0].meta

          const rawCurrent: number  = meta.regularMarketPrice
          const rawPrevious: number = meta.previousClose ?? meta.chartPreviousClose ?? 0

          if (!rawCurrent) throw new Error(`regularMarketPrice missing for ${ticker}`)

          // .TA prices are in Agorot (1/100 NIS); USD prices are already in dollars.
          const divisor = isTA ? 100 : 1
          const price          = rawCurrent  / divisor
          const daily_change_pct = rawPrevious
            ? ((rawCurrent - rawPrevious) / rawPrevious) * 100
            : 0

          // Pre-market enrichment — present when marketState === 'PRE'.
          // preMarketPrice for .TA would also need Agorot conversion, but
          // TASE doesn't have US-style pre-market sessions, so this is
          // effectively USD-only in practice.
          const rawPreMarket: number | undefined = meta.preMarketPrice
          const pre_market_price = rawPreMarket != null
            ? rawPreMarket / divisor
            : null

          // Compute pct change relative to previous close for consistency.
          const pre_market_change_pct =
            rawPreMarket != null && rawPrevious !== 0
              ? ((rawPreMarket - rawPrevious) / rawPrevious) * 100
              : null

          const market_state: string | null = meta.marketState ?? null

          console.error(
            `[yahoo-proxy] ${ticker}: price=${price.toFixed(2)} daily=${daily_change_pct.toFixed(2)}%` +
            ` preMarket=${pre_market_price?.toFixed(2) ?? 'n/a'} state=${market_state}`
          )

          return {
            ticker,
            price,
            daily_change_pct,
            pre_market_price,
            pre_market_change_pct,
            market_state,
            fetched_at: new Date().toISOString(),
          } satisfies CacheRow
        })
      )

      // ── Step 4: Batch-upsert successes ─────────────────────────────────────
      const upsertRows: CacheRow[] = []

      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i]
        const ticker  = stale[i]

        if (outcome.status === 'fulfilled') {
          upsertRows.push(outcome.value)
          freshCache.set(ticker, {
            price:                 outcome.value.price,
            daily_change_pct:      outcome.value.daily_change_pct,
            pre_market_price:      outcome.value.pre_market_price,
            pre_market_change_pct: outcome.value.pre_market_change_pct,
            market_state:          outcome.value.market_state,
          })
        } else {
          const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
          console.error(`[yahoo-proxy] fetch failed [${ticker}]:`, msg)
          fetchErrors.set(ticker, msg)
        }
      }

      if (upsertRows.length > 0) {
        const { error } = await supabase
          .from('price_cache')
          .upsert(upsertRows, { onConflict: 'ticker' })
        if (error) console.error('[yahoo-proxy] upsert error:', error.message)
      }
    }

    // ── Step 5: Build response ───────────────────────────────────────────────
    const prices: Record<string, PriceEntry | ErrorEntry> = {}

    for (const ticker of tickers) {
      const entry = freshCache.get(ticker)
      const isTA  = ticker.toUpperCase().endsWith('.TA')
      if (entry) {
        prices[ticker] = { ...entry, currency: isTA ? 'NIS' : 'USD' }
      } else {
        prices[ticker] = { error: fetchErrors.get(ticker) ?? 'not found' }
      }
    }

    return json({ prices })
  } catch (err) {
    console.error('[yahoo-proxy] unhandled error:', err)
    return json({ error: String(err) }, 500)
  }
})
