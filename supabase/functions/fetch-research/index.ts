import '@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from '@supabase/supabase-js'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const CACHE_TTL_MS  = 24 * 60 * 60 * 1000
const YAHOO_UA      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
)

const FINNHUB_KEY   = Deno.env.get('FINNHUB_API_KEY')   ?? ''
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

// ── Technical indicator helpers ────────────────────────────────────────────

function computeMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null
  const slice = closes.slice(-period)
  return slice.reduce((s, c) => s + c, 0) / period
}

// Simple (non-smoothed) 14-period RSI using arithmetic average of gains/losses.
function computeRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null
  const relevant = closes.slice(-(period + 1))
  const changes  = relevant.slice(1).map((c, i) => c - relevant[i])
  const avgGain  = changes.reduce((s, c) => s + (c > 0 ? c : 0), 0) / period
  const avgLoss  = changes.reduce((s, c) => s + (c < 0 ? -c : 0), 0) / period
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

// ── Utilities ──────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

function yyyymmdd(d: Date): string {
  return d.toISOString().split('T')[0]
}

// ── Handler ────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  try {
    // ── Parse body ──────────────────────────────────────────────────────────
    let body: unknown = null
    try { body = await req.json() } catch (e) {
      console.error('[fetch-research] req.json() failed:', e)
    }
    console.error('[fetch-research] body:', JSON.stringify(body))

    const ticker: string | null =
      typeof (body as any)?.ticker === 'string' && (body as any).ticker.trim().length > 0
        ? (body as any).ticker.trim().toUpperCase()
        : null

    if (!ticker) return json({ error: 'ticker is required' }, 400)
    if (!FINNHUB_KEY) return json({ error: 'FINNHUB_API_KEY not set' }, 500)

    const force = (body as any)?.force === true
    console.error(`[fetch-research] processing: ${ticker} force=${force}`)

    // ── Cache check ─────────────────────────────────────────────────────────
    const { data: cached } = await supabase
      .from('ticker_research_cache')
      .select('*')
      .eq('ticker', ticker)
      .maybeSingle()

    if (!force && cached) {
      const ageMs = Date.now() - new Date(cached.fetched_at).getTime()
      if (ageMs < CACHE_TTL_MS && cached.ai_summary != null) {
        console.error(`[fetch-research] cache hit for ${ticker} (${Math.round(ageMs / 60000)} min old)`)
        return json({ research: cached })
      }
      console.error(`[fetch-research] cache miss — stale or no ai_summary`)
    }

    // ── Fetch all external data in parallel ─────────────────────────────────
    // Four sources run concurrently; Promise.allSettled means no single failure
    // kills the rest.
    const today = yyyymmdd(new Date())
    const from  = yyyymmdd(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000))

    const [newsOut, analystOut, metricsOut, candleOut, profileOut] = await Promise.allSettled([
      // 1. Finnhub: company news (last 14 days)
      fetch(
        `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${today}&token=${FINNHUB_KEY}`
      ).then(r => { console.error(`[fetch-research] Finnhub news ${r.status}`); return r.json() }),

      // 2. Finnhub: analyst recommendations
      fetch(
        `https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`
      ).then(r => { console.error(`[fetch-research] Finnhub analyst ${r.status}`); return r.json() }),

      // 3. Finnhub: key metrics
      fetch(
        `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${FINNHUB_KEY}`
      ).then(r => { console.error(`[fetch-research] Finnhub metrics ${r.status}`); return r.json() }),

      // 4. Yahoo Finance: 60-day daily candles (works for USD and .TA tickers)
      fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=60d`,
        { headers: { 'User-Agent': YAHOO_UA } }
      ).then(r => { console.error(`[fetch-research] Yahoo candle ${r.status}`); return r.json() }),

      // 5. Finnhub: company profile (description, industry, sector)
      fetch(
        `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`
      ).then(r => { console.error(`[fetch-research] Finnhub profile ${r.status}`); return r.json() }),
    ])

    // ── Extract: news ───────────────────────────────────────────────────────
    let news: unknown[] = []
    if (newsOut.status === 'fulfilled' && Array.isArray(newsOut.value)) {
      news = [...newsOut.value]
        .sort((a: any, b: any) => (b.datetime ?? 0) - (a.datetime ?? 0))
        .slice(0, 5)
        .map((item: any) => ({
          headline: item.headline ?? null,
          summary:  typeof item.summary === 'string' ? item.summary.slice(0, 140) : null,
          source:   item.source   ?? null,
          datetime: item.datetime ?? null,
          url:      item.url      ?? null,
        }))
      console.error(`[fetch-research] news: ${news.length} items`)
    } else {
      console.error('[fetch-research] news failed:', newsOut.status === 'rejected' ? newsOut.reason : 'not array')
    }

    // ── Extract: analyst ────────────────────────────────────────────────────
    let analyst_buy:  number | null = null
    let analyst_hold: number | null = null
    let analyst_sell: number | null = null
    if (analystOut.status === 'fulfilled' && Array.isArray(analystOut.value) && analystOut.value.length > 0) {
      const rec = analystOut.value[0]
      analyst_buy  = rec.buy  ?? null
      analyst_hold = rec.hold ?? null
      analyst_sell = rec.sell ?? null
      console.error(`[fetch-research] analyst: B${analyst_buy} H${analyst_hold} S${analyst_sell}`)
    } else {
      console.error('[fetch-research] analyst failed:', analystOut.status === 'rejected' ? analystOut.reason : 'empty')
    }

    // ── Extract: key metrics ────────────────────────────────────────────────
    let pe_ratio:    number | null = null
    let beta:        number | null = null
    let eps:         number | null = null
    let week52_high: number | null = null
    let week52_low:  number | null = null
    let companyName: string        = ticker
    if (metricsOut.status === 'fulfilled' && metricsOut.value?.metric) {
      const m   = metricsOut.value.metric
      pe_ratio    = m.peBasicExclExtraTTM       ?? null
      beta        = m.beta                      ?? null
      eps         = m.epsBasicExclExtraItemsTTM ?? null
      week52_high = m['52WeekHigh']             ?? null
      week52_low  = m['52WeekLow']              ?? null
      companyName = metricsOut.value.series?.annual?.currentRatioAnnual?.[0]?.value
                    ? ticker   // series present but no name field — fall back
                    : (metricsOut.value.metric.name ?? ticker)
      console.error(`[fetch-research] metrics: pe=${pe_ratio} beta=${beta} 52w=${week52_low}-${week52_high}`)
    } else {
      console.error('[fetch-research] metrics failed:', metricsOut.status === 'rejected' ? metricsOut.reason : 'no metric')
    }

    // ── Extract: candle closes → technicals ────────────────────────────────
    let ma_20:  number | null = null
    let ma_50:  number | null = null
    let rsi_14: number | null = null
    if (candleOut.status === 'fulfilled') {
      const raw: unknown = candleOut.value?.chart?.result?.[0]?.indicators?.quote?.[0]?.close
      if (Array.isArray(raw)) {
        let closes = raw.filter((c: unknown): c is number => typeof c === 'number' && !isNaN(c))
        // .TA prices from Yahoo are in Agorot — convert to NIS so MA values are meaningful
        if (ticker.endsWith('.TA')) closes = closes.map(c => c / 100)
        console.error(`[fetch-research] candles: ${closes.length} closes, last=${closes.at(-1)?.toFixed(2)}`)
        ma_20  = computeMA(closes, 20)
        ma_50  = computeMA(closes, 50)
        rsi_14 = computeRSI(closes)
        console.error(`[fetch-research] MA20=${ma_20?.toFixed(2)} MA50=${ma_50?.toFixed(2)} RSI=${rsi_14?.toFixed(1)}`)
      }
    } else {
      console.error('[fetch-research] candle fetch failed:', candleOut.reason)
    }

    // ── Extract: company profile ────────────────────────────────────────────
    let description: string | null = null
    let industry:    string | null = null
    let sector:      string | null = null
    if (profileOut.status === 'fulfilled' && profileOut.value && typeof profileOut.value === 'object') {
      const p = profileOut.value as any
      // Trim description to ~200 chars (roughly 2 lines) to keep the cache lean
      const rawDesc = p.description ?? p.longDescription ?? null
      description = typeof rawDesc === 'string' && rawDesc.length > 0
        ? rawDesc.slice(0, 200).trimEnd() + (rawDesc.length > 200 ? '…' : '')
        : null
      // Finnhub uses finnhubIndustry; gicsSector is an alternative grouping
      industry = p.finnhubIndustry ?? p.gicsSector ?? null
      sector   = p.gicsSector ?? p.finnhubIndustry ?? null
      // Avoid storing identical values in both columns
      if (sector === industry) sector = null
      console.error(`[fetch-research] profile: industry=${industry} sector=${sector} desc=${description?.slice(0, 50)}`)
    } else {
      console.error('[fetch-research] profile failed:', profileOut.status === 'rejected' ? profileOut.reason : 'empty/null')
    }

    // Price targets: FMP deprecated this endpoint Aug 2025.
    const target_price_mean: null = null
    const target_price_high: null = null
    const target_price_low:  null = null

    // ── AI summary ──────────────────────────────────────────────────────────
    let ai_summary:    string | null = null
    let ai_summary_at: string | null = null

    if (ANTHROPIC_KEY) {
      try {
        const newsLines = (news as any[])
          .slice(0, 3)
          .map((n: any) => `  - ${n.headline}`)
          .join('\n') || '  (none available)'

        const context = [
          `Ticker: ${ticker}${companyName !== ticker ? ` (${companyName})` : ''}`,
          week52_high != null && week52_low != null
            ? `52-week range: ${week52_low} – ${week52_high}` : null,
          pe_ratio != null ? `PE (TTM): ${pe_ratio.toFixed(1)}` : null,
          eps      != null ? `EPS (TTM): ${eps.toFixed(2)}`     : null,
          beta     != null ? `Beta: ${beta.toFixed(2)}`         : null,
          analyst_buy != null
            ? `Analyst ratings: ${analyst_buy} Buy / ${analyst_hold} Hold / ${analyst_sell} Sell` : null,
          ma_20 != null || ma_50 != null
            ? `Moving averages: ${[
                ma_20 != null ? `MA20 ${ma_20.toFixed(2)}` : null,
                ma_50 != null ? `MA50 ${ma_50.toFixed(2)}` : null,
              ].filter(Boolean).join(', ')}` : null,
          rsi_14 != null ? `RSI(14): ${rsi_14.toFixed(1)}` : null,
          `Recent headlines:\n${newsLines}`,
        ].filter(Boolean).join('\n')

        const prompt =
          `You are summarizing the investment picture for ${ticker} for a sophisticated individual investor.\n\n` +
          `Write 4–6 sentences. No bullet points. No explicit buy/sell verdict. ` +
          `Synthesize: where the story stands now, what analysts and the chart agree or disagree on, ` +
          `and what is the single most important thing a current holder should watch.\n\n` +
          `Current data:\n${context}`

        console.error(`[fetch-research] calling Anthropic for ${ticker}`)
        const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key':         ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type':      'application/json',
          },
          body: JSON.stringify({
            model:      'claude-sonnet-4-6',
            max_tokens: 400,
            messages:   [{ role: 'user', content: prompt }],
          }),
        })

        console.error(`[fetch-research] Anthropic HTTP ${anthropicRes.status}`)
        if (anthropicRes.ok) {
          const anthropicData = await anthropicRes.json()
          ai_summary    = anthropicData.content?.[0]?.text ?? null
          ai_summary_at = new Date().toISOString()
          console.error(`[fetch-research] AI summary: ${ai_summary?.slice(0, 80)}…`)
        } else {
          const errBody = await anthropicRes.text()
          console.error(`[fetch-research] Anthropic error: ${errBody.slice(0, 300)}`)
        }
      } catch (e) {
        console.error('[fetch-research] Anthropic fetch threw:', e)
      }
    } else {
      console.error('[fetch-research] ANTHROPIC_API_KEY not set — skipping AI summary')
    }

    // ── Build row and upsert ────────────────────────────────────────────────
    const row = {
      ticker,
      description,
      industry,
      sector,
      news,
      analyst_buy,
      analyst_hold,
      analyst_sell,
      pe_ratio,
      beta,
      eps,
      week52_high,
      week52_low,
      target_price_mean,
      target_price_high,
      target_price_low,
      ma_20,
      ma_50,
      rsi_14,
      ai_summary,
      ai_summary_at,
      fetched_at: new Date().toISOString(),
    }

    const { error: upsertErr } = await supabase
      .from('ticker_research_cache')
      .upsert(row, { onConflict: 'ticker' })
    if (upsertErr) console.error('[fetch-research] upsert error:', upsertErr.message)

    return json({ research: row })
  } catch (err) {
    const msg   = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack   : undefined
    console.error('[fetch-research] unhandled error:', msg, stack)
    return json({ error: msg, stack }, 500)
  }
})
