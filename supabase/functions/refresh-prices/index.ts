import '@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from '@supabase/supabase-js'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes
const MARKET_TICKERS = ['SPY', 'QQQ', 'PANW'] as const

// Module-level clients — created once per cold start, reused across invocations.
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
)

const FINNHUB_KEY = Deno.env.get('FINNHUB_API_KEY') ?? ''

// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  try {
    // Parse body — log the raw text first so a JSON parse failure is visible
    let body: unknown = null
    try {
      body = await req.json()
    } catch (parseErr) {
      console.error('[refresh-prices] req.json() failed:', parseErr)
    }
    console.error('[refresh-prices] body:', JSON.stringify(body))

    const tickers: string[] = Array.isArray((body as any)?.tickers)
      ? (body as any).tickers.filter((t: unknown) => typeof t === 'string' && (t as string).trim().length > 0)
      : []

    console.error('[refresh-prices] parsed tickers:', JSON.stringify(tickers))

    if (!FINNHUB_KEY) {
      return json({ error: 'FINNHUB_API_KEY secret is not set' }, 500)
    }

    // ── Partition incoming tickers by type ───────────────────────────────────
    // IL-XXXXXXX  → pseudo-tickers (funds without a Yahoo symbol); no live data
    // *.TA        → Israeli stocks; delegate to yahoo-proxy
    // everything else → USD; Finnhub (existing logic)
    const ilPseudoTickers = tickers.filter((t) => t.startsWith('IL-'))
    const ilTickers = tickers.filter(
      (t) => t.toUpperCase().endsWith('.TA') && !t.startsWith('IL-')
    )
    const usdClientTickers = tickers.filter(
      (t) => !t.toUpperCase().endsWith('.TA') && !t.startsWith('IL-')
    )

    console.error('[refresh-prices] usd:', JSON.stringify(usdClientTickers), 'il:', JSON.stringify(ilTickers), 'pseudo:', JSON.stringify(ilPseudoTickers))

    // MARKET_TICKERS are always fetched; merge with USD client tickers.
    const allUsdTickers = [...new Set([...usdClientTickers, ...MARKET_TICKERS])]

    // Fire yahoo-proxy now so it runs in parallel with the Finnhub flow below.
    // supabase.functions.invoke uses the service-role key already on this client,
    // so yahoo-proxy receives a valid Authorization header with no extra setup.
    const yahooProxyFn = ilTickers.length > 0
      ? (() => {
          console.error('[refresh-prices] calling yahoo-proxy with:', JSON.stringify(ilTickers))
          return supabase.functions.invoke('yahoo-proxy', { body: { tickers: ilTickers } })
        })()
      : Promise.resolve({ data: { prices: {} }, error: null })
    const yahooProxyPromise = yahooProxyFn

    // ── Step 1: Read cache — one query for all USD tickers ───────────────────
    const { data: cachedRows } = await supabase
      .from('price_cache')
      .select('ticker, price, daily_change_pct, fetched_at')
      .in('ticker', allUsdTickers)

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

    // ── Step 2: Identify stale/missing USD tickers ───────────────────────────
    const stale = allUsdTickers.filter((t) => !freshCache.has(t))

    // ── Step 3: Fetch stale tickers from Finnhub in parallel ────────────────
    console.error('[refresh-prices] stale USD tickers to fetch:', JSON.stringify(stale))
    if (stale.length > 0) {
      const outcomes = await Promise.allSettled(
        stale.map(async (ticker) => {
          const url =
            `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`
          const res = await fetch(url)
          console.error(`[refresh-prices] Finnhub ${ticker}: HTTP ${res.status}`)
          if (!res.ok) throw new Error(`Finnhub HTTP ${res.status} for ${ticker}`)

          const data = await res.json()
          console.error(`[refresh-prices] Finnhub ${ticker}: c=${data.c} dp=${data.dp}`)
          // Finnhub returns c=0 for unknown or untraded symbols
          if (!data.c || data.c === 0) throw new Error(`No price data for ${ticker}`)

          return {
            ticker,
            price: data.c as number,
            daily_change_pct: (data.dp as number) ?? 0,
            fetched_at: new Date().toISOString(),
          }
        })
      )

      // ── Step 4: Batch-upsert all successfully fetched rows ─────────────────
      type CacheRow = { ticker: string; price: number; daily_change_pct: number; fetched_at: string }
      const upsertRows: CacheRow[] = []

      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled') {
          const { ticker, price, daily_change_pct, fetched_at } = outcome.value
          upsertRows.push({ ticker, price, daily_change_pct, fetched_at })
          freshCache.set(ticker, { price, daily_change_pct })
        } else {
          // Log but don't fail the whole request for one bad ticker
          console.error('Finnhub fetch failed:', outcome.reason)
        }
      }

      if (upsertRows.length > 0) {
        const { error } = await supabase
          .from('price_cache')
          .upsert(upsertRows, { onConflict: 'ticker' })
        if (error) console.error('price_cache upsert error:', error.message)
      }
    }

    // ── Step 5: Await yahoo-proxy and build merged response ──────────────────
    const { data: yahooData, error: yahooInvokeError } = await yahooProxyPromise
    console.error('[refresh-prices] yahoo-proxy result:', JSON.stringify(yahooData), 'error:', yahooInvokeError)
    const ilResults: Record<string, unknown> = yahooData?.prices ?? {}

    // prices: all client-requested tickers with a currency field.
    // market: SPY / QQQ / PANW — no currency field (UI treats these separately).
    const prices: Record<string, unknown> = {}

    // IL pseudo-tickers — no live price source exists for these
    for (const ticker of ilPseudoTickers) {
      prices[ticker] = { error: 'no live data available' }
    }

    // IL tickers from yahoo-proxy (already carry currency: "NIS")
    for (const ticker of ilTickers) {
      prices[ticker] = ilResults[ticker] ?? { error: 'not found' }
    }

    // USD client tickers from Finnhub cache — add currency field
    for (const ticker of usdClientTickers) {
      const entry = freshCache.get(ticker)
      if (entry) prices[ticker] = { ...entry, currency: 'USD' }
    }

    // Market strip — PANW may also be in usdClientTickers; that's intentional
    const market: Record<string, { price: number; daily_change_pct: number }> = {}
    for (const ticker of MARKET_TICKERS) {
      const entry = freshCache.get(ticker)
      if (entry) market[ticker] = entry
    }

    return json({ prices, market })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[refresh-prices] unhandled error:', msg)
    return json({ error: msg, stack: err instanceof Error ? err.stack : undefined }, 500)
  }
})
