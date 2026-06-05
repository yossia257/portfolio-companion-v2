import '@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from '@supabase/supabase-js'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// SPY / QQQ / PANW are always included regardless of what the client sent.
const MARKET_TICKERS = ['SPY', 'QQQ', 'PANW'] as const

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  try {
    // ── Parse body ───────────────────────────────────────────────────────────
    let body: unknown = null
    try {
      body = await req.json()
    } catch (e) {
      console.error('[refresh-prices] req.json() failed:', e)
    }
    console.error('[refresh-prices] body:', JSON.stringify(body))

    const tickers: string[] = Array.isArray((body as any)?.tickers)
      ? (body as any).tickers.filter(
          (t: unknown) => typeof t === 'string' && (t as string).trim().length > 0
        )
      : []

    console.error('[refresh-prices] parsed tickers:', JSON.stringify(tickers))

    // ── Partition tickers ────────────────────────────────────────────────────
    // IL-*       → funds without a Yahoo symbol; return error immediately
    // everything else (USD + .TA) → delegate to yahoo-proxy, which now handles both
    const ilPseudoTickers = tickers.filter((t) => t.startsWith('IL-'))
    const realTickers     = tickers.filter((t) => !t.startsWith('IL-'))

    // Always include market strip; deduplicate with client tickers.
    const allRealTickers = [...new Set([...realTickers, ...MARKET_TICKERS])]

    console.error('[refresh-prices] real:', JSON.stringify(allRealTickers), 'pseudo:', JSON.stringify(ilPseudoTickers))

    // ── Delegate to yahoo-proxy ──────────────────────────────────────────────
    // yahoo-proxy handles USD and .TA tickers, caching, Agorot conversion,
    // and pre-market enrichment — all in one call.
    const { data: yahooData, error: yahooErr } = await supabase.functions.invoke(
      'yahoo-proxy',
      { body: { tickers: allRealTickers } }
    )

    if (yahooErr) console.error('[refresh-prices] yahoo-proxy error:', yahooErr)
    console.error('[refresh-prices] yahoo-proxy returned keys:', Object.keys(yahooData?.prices ?? {}))

    const yahooResults: Record<string, unknown> = yahooData?.prices ?? {}

    // ── Build response ───────────────────────────────────────────────────────
    const prices: Record<string, unknown> = {}

    // IL pseudo-tickers: no Yahoo symbol, no live price
    for (const ticker of ilPseudoTickers) {
      prices[ticker] = { error: 'no live data available' }
    }

    // Real tickers: pass through yahoo-proxy result as-is
    // (each entry already carries currency, pre_market_*, market_state)
    for (const ticker of realTickers) {
      prices[ticker] = yahooResults[ticker] ?? { error: 'not found' }
    }

    // Market strip: extract SPY / QQQ / PANW from the yahoo-proxy result
    const market: Record<string, unknown> = {}
    for (const ticker of MARKET_TICKERS) {
      const entry = yahooResults[ticker]
      if (entry && typeof entry === 'object' && !('error' in (entry as object))) {
        market[ticker] = entry
      }
    }

    return json({ prices, market })
  } catch (err) {
    const msg   = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack   : undefined
    console.error('[refresh-prices] unhandled error:', msg)
    return json({ error: msg, stack }, 500)
  }
})
