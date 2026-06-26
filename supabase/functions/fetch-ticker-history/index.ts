import '@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from '@supabase/supabase-js'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

const YAHOO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

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
      return json({ histories: {} })
    }

    // ── Step 1: Read cache ───────────────────────────────────────────────────
    const { data: cachedRows } = await supabase
      .from('ticker_history_cache')
      .select('ticker, closes, fetched_at')
      .in('ticker', tickers)

    const now = Date.now()
    const freshCache = new Map<string, number[]>()

    for (const row of cachedRows ?? []) {
      const ageMs = now - new Date(row.fetched_at).getTime()
      if (ageMs < CACHE_TTL_MS && Array.isArray(row.closes)) {
        freshCache.set(row.ticker, row.closes)
      }
    }

    // ── Step 2: Identify stale/missing tickers ───────────────────────────────
    const stale = tickers.filter((t) => !freshCache.has(t))

    // ── Step 3: Fetch stale tickers from Yahoo Finance in parallel ───────────
    if (stale.length > 0) {
      const outcomes = await Promise.allSettled(
        stale.map(async (ticker) => {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1mo`
          const res = await fetch(url, { headers: { 'User-Agent': YAHOO_UA } })

          if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} for ${ticker}`)

          const data = await res.json()

          if (data.chart?.error || !data.chart?.result?.[0]) {
            throw new Error(data.chart?.error?.description ?? `No chart data for ${ticker}`)
          }

          const result = data.chart.result[0]
          const closes: number[] = (result.indicators?.quote?.[0]?.close ?? []).filter((c: unknown) => c != null)

          if (closes.length === 0) {
            throw new Error(`No close data for ${ticker}`)
          }

          return { ticker, closes, fetched_at: new Date().toISOString() }
        })
      )

      // ── Step 4: Batch-upsert successes ─────────────────────────────────────
      const upsertRows: Array<{ ticker: string; closes: number[]; fetched_at: string }> = []

      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i]
        const ticker = stale[i]

        if (outcome.status === 'fulfilled') {
          upsertRows.push(outcome.value)
          freshCache.set(ticker, outcome.value.closes)
          console.error(`[fetch-ticker-history] ${ticker}: fetched ${outcome.value.closes.length} closes`)
        } else {
          const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
          console.error(`[fetch-ticker-history] fetch failed [${ticker}]:`, msg)
        }
      }

      if (upsertRows.length > 0) {
        const { error } = await supabase
          .from('ticker_history_cache')
          .upsert(upsertRows, { onConflict: 'ticker' })
        if (error) console.error('[fetch-ticker-history] upsert error:', error.message)
      }
    }

    // ── Step 5: Build response ───────────────────────────────────────────────
    const histories: Record<string, number[]> = {}

    for (const ticker of tickers) {
      const closes = freshCache.get(ticker)
      if (closes) {
        histories[ticker] = closes
      }
    }

    return json({ histories })
  } catch (err) {
    console.error('[fetch-ticker-history] unhandled error:', err)
    return json({ error: String(err) }, 500)
  }
})
