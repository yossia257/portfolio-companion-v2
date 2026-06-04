import '@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from '@supabase/supabase-js'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes

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
    // Validate request body
    const body = await req.json().catch(() => null)
    const tickers: string[] = Array.isArray(body?.tickers)
      ? body.tickers.filter((t: unknown) => typeof t === 'string' && t.trim().length > 0)
      : []

    if (tickers.length === 0) {
      return json({ error: 'tickers must be a non-empty array of strings' }, 400)
    }

    if (!FINNHUB_KEY) {
      return json({ error: 'FINNHUB_API_KEY secret is not set' }, 500)
    }

    // ── Step 1: Read cache — one query for all requested tickers ────────────
    const { data: cachedRows } = await supabase
      .from('price_cache')
      .select('ticker, price, daily_change_pct, fetched_at')
      .in('ticker', tickers)

    const now = Date.now()
    // Map of ticker → fresh cached value
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

    // ── Step 3: Fetch stale tickers from Finnhub in parallel ────────────────
    if (stale.length > 0) {
      const outcomes = await Promise.allSettled(
        stale.map(async (ticker) => {
          const url =
            `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`
          const res = await fetch(url)
          if (!res.ok) throw new Error(`Finnhub HTTP ${res.status} for ${ticker}`)

          const data = await res.json()
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

    // ── Step 5: Build and return response ───────────────────────────────────
    const prices: Record<string, { price: number; daily_change_pct: number }> = {}
    for (const [ticker, data] of freshCache) {
      prices[ticker] = data
    }
    // Tickers that failed both cache and Finnhub are simply absent from the response.

    return json({ prices })
  } catch (err) {
    console.error('refresh-prices unhandled error:', err)
    return json({ error: String(err) }, 500)
  }
})
