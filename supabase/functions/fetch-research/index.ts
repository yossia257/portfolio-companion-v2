import '@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from '@supabase/supabase-js'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const YAHOO_UA     = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'

// Service-role client — used for all DB writes and for auth.getUser(jwt) verification.
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
)

const FINNHUB_KEY   = Deno.env.get('FINNHUB_API_KEY')   ?? ''
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

// Language code → Claude instruction appended to the prompt
const LANG_INSTRUCTIONS: Record<string, string> = {
  en: 'Respond in English.',
  he: 'Respond in Hebrew (עברית).',
  es: 'Respond in Spanish.',
  de: 'Respond in German.',
  fr: 'Respond in French.',
}

// ── Technical indicator helpers ────────────────────────────────────────────

function computeMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null
  const slice = closes.slice(-period)
  return slice.reduce((s, c) => s + c, 0) / period
}

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

function trimToLastSentence(text: string): string {
  // Check if text already ends with sentence-ending punctuation
  const sentenceEnders = /[.!?。][\s"']*$/
  if (sentenceEnders.test(text)) return text

  // Find the last sentence-ending punctuation
  const lastPeriod = Math.max(
    text.lastIndexOf('. '),
    text.lastIndexOf('! '),
    text.lastIndexOf('? '),
    text.lastIndexOf('.\n'),
    text.lastIndexOf('!\n'),
    text.lastIndexOf('?\n'),
    text.lastIndexOf('。'), // Chinese/Japanese period
    text.lastIndexOf('！'), // Chinese/Japanese exclamation
    text.lastIndexOf('？')  // Chinese/Japanese question mark
  )

  if (lastPeriod === -1) return text + '…'
  return text.substring(0, lastPeriod + 1)
}

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

  const t0 = Date.now()
  const log = (label: string) => console.error(`[fetch-research] ${label}`, Date.now() - t0, 'ms')

  try {
    log('START')

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

    // ── Resolve user's preferred language from their profile ─────────────────
    let language = 'en'
    try {
      const jwt = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim() ?? ''
      if (jwt) {
        const { data: { user }, error: userErr } = await supabase.auth.getUser(jwt)
        if (userErr) {
          console.error('[fetch-research] getUser error:', userErr.message)
        } else if (user) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('ai_response_language')
            .eq('id', user.id)
            .single()
          language = profile?.ai_response_language ?? 'en'
        }
      }
    } catch (e) {
      console.error('[fetch-research] language resolution failed:', e)
    }
    log(`LANGUAGE_RESOLVED (${language})`)
    console.error(`[fetch-research] processing: ${ticker}  language=${language}  force=${force}`)

    // ── CACHE-FIRST: Read cache ─────────────────────────────────────────────
    const { data: cached } = await supabase
      .from('ticker_research_cache')
      .select('*')
      .eq('ticker', ticker)
      .maybeSingle()
    log('CACHE_READ')

    // ── Check freshness of each component separately ──────────────────────────
    const cacheAge = cached?.fetched_at
      ? (Date.now() - new Date(cached.fetched_at).getTime()) / 1000 / 60 / 60
      : 999 // hours

    const hasFreshNews = cached?.news && cacheAge < 24
    const hasFreshAnalyst = cached?.analyst_buy != null && cacheAge < 24
    const hasFreshTechnicals = cached?.ma_20 != null && cacheAge < 24

    const langEntry = (cached?.ai_summaries as Record<string, any>)?.[language]
    const summaryAge = langEntry?.at
      ? (Date.now() - new Date(langEntry.at).getTime()) / 1000 / 60 / 60
      : 999
    const hasFreshAISummary = langEntry?.text && summaryAge < 24
    log(`AI_SUMMARY_FRESHNESS (${language}: age=${summaryAge.toFixed(1)}h fresh=${hasFreshAISummary})`)

    log(`FRESHNESS_CHECK (news=${hasFreshNews} analyst=${hasFreshAnalyst} technicals=${hasFreshTechnicals} summary=${hasFreshAISummary} cacheAge=${cacheAge.toFixed(1)}h)`)

    // ── FULL CACHE HIT: if everything is fresh, return immediately ──────────
    if (!force && hasFreshNews && hasFreshAnalyst && hasFreshTechnicals && hasFreshAISummary) {
      log('FULL_CACHE_HIT_RETURNING')
      return json({
        research: {
          ...cached,
          ai_summary:    langEntry.text,
          ai_summary_at: langEntry.at,
        },
        language,
      })
    }

    log(`PARTIAL_OR_MISS (fetching: news=${!hasFreshNews} analyst=${!hasFreshAnalyst} tech=${!hasFreshTechnicals} summary=${!hasFreshAISummary})`)

    // ── PARTIAL CACHE: only fetch what's stale, in parallel ──────────────────
    const today = yyyymmdd(new Date())
    const from  = yyyymmdd(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000))

    const fetches: Promise<any>[] = []
    const fetchKeys: string[] = []

    if (!hasFreshNews) {
      fetches.push(
        fetch(
          `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${today}&token=${FINNHUB_KEY}`
        ).then(r => { console.error(`[fetch-research] Finnhub news ${r.status}`); return r.json() })
      )
      fetchKeys.push('news')
    }

    if (!hasFreshAnalyst) {
      fetches.push(
        fetch(
          `https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`
        ).then(r => { console.error(`[fetch-research] Finnhub analyst ${r.status}`); return r.json() })
      )
      fetchKeys.push('analyst')
    }

    if (!hasFreshTechnicals) {
      fetches.push(
        fetch(
          `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${FINNHUB_KEY}`
        ).then(r => { console.error(`[fetch-research] Finnhub metrics ${r.status}`); return r.json() })
      )
      fetchKeys.push('metrics')
      fetches.push(
        fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=60d`,
          { headers: { 'User-Agent': YAHOO_UA } }
        ).then(r => { console.error(`[fetch-research] Yahoo candle ${r.status}`); return r.json() })
      )
      fetchKeys.push('candle')
      fetches.push(
        fetch(
          `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`
        ).then(r => { console.error(`[fetch-research] Finnhub profile ${r.status}`); return r.json() })
      )
      fetchKeys.push('profile')
    }

    log(`PARALLEL_FETCH_START (${fetchKeys.join(',')})`)
    const fetchResults = await Promise.allSettled(fetches)
    log(`PARALLEL_FETCH_DONE`)

    // Build response by merging cached + fetched data
    let newsOut = { status: 'skipped' as const }
    let analystOut = { status: 'skipped' as const }
    let metricsOut = { status: 'skipped' as const }
    let candleOut = { status: 'skipped' as const }
    let profileOut = { status: 'skipped' as const }

    let resultIdx = 0
    if (!hasFreshNews) newsOut = fetchResults[resultIdx++] as any
    if (!hasFreshAnalyst) analystOut = fetchResults[resultIdx++] as any
    if (!hasFreshTechnicals) {
      metricsOut = fetchResults[resultIdx++] as any
      candleOut = fetchResults[resultIdx++] as any
      profileOut = fetchResults[resultIdx++] as any
    }

    // ── Extract: news ───────────────────────────────────────────────────────
    let news: unknown[] = hasFreshNews && cached?.news ? cached.news : []
    if (!hasFreshNews) {
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
        console.error(`[fetch-research] news: fetched ${news.length} items`)
      } else {
        console.error('[fetch-research] news fetch failed:', newsOut.status === 'rejected' ? newsOut.reason : 'not array')
        if (cached?.news) {
          news = cached.news
          console.error('[fetch-research] news: using cache fallback')
        }
      }
    } else {
      console.error(`[fetch-research] news: using cache (${news.length} items)`)
    }

    // ── Extract: analyst ────────────────────────────────────────────────────
    let analyst_buy:  number | null = cached?.analyst_buy ?? null
    let analyst_hold: number | null = cached?.analyst_hold ?? null
    let analyst_sell: number | null = cached?.analyst_sell ?? null
    if (!hasFreshAnalyst) {
      if (analystOut.status === 'fulfilled' && Array.isArray(analystOut.value) && analystOut.value.length > 0) {
        const rec = analystOut.value[0]
        analyst_buy  = rec.buy  ?? null
        analyst_hold = rec.hold ?? null
        analyst_sell = rec.sell ?? null
        console.error(`[fetch-research] analyst: fetched B${analyst_buy} H${analyst_hold} S${analyst_sell}`)
      } else {
        console.error('[fetch-research] analyst fetch failed:', analystOut.status === 'rejected' ? analystOut.reason : 'empty')
      }
    } else {
      console.error(`[fetch-research] analyst: using cache B${analyst_buy} H${analyst_hold} S${analyst_sell}`)
    }

    // ── Extract: key metrics ────────────────────────────────────────────────
    let pe_ratio:    number | null = cached?.pe_ratio ?? null
    let beta:        number | null = cached?.beta ?? null
    let eps:         number | null = cached?.eps ?? null
    let week52_high: number | null = cached?.week52_high ?? null
    let week52_low:  number | null = cached?.week52_low ?? null
    let companyName: string        = cached?.companyName ?? ticker

    if (!hasFreshTechnicals) {
      if (metricsOut.status === 'fulfilled' && metricsOut.value?.metric) {
        const m   = metricsOut.value.metric
        pe_ratio    = m.peBasicExclExtraTTM       ?? null
        beta        = m.beta                      ?? null
        eps         = m.epsBasicExclExtraItemsTTM ?? null
        week52_high = m['52WeekHigh']             ?? null
        week52_low  = m['52WeekLow']              ?? null
        companyName = metricsOut.value.series?.annual?.currentRatioAnnual?.[0]?.value
                      ? ticker
                      : (metricsOut.value.metric.name ?? ticker)
        console.error(`[fetch-research] metrics: fetched pe=${pe_ratio} beta=${beta} 52w=${week52_low}-${week52_high}`)
      } else {
        console.error('[fetch-research] metrics fetch failed:', metricsOut.status === 'rejected' ? metricsOut.reason : 'no metric')
      }
    } else {
      console.error(`[fetch-research] metrics: using cache pe=${pe_ratio} beta=${beta} 52w=${week52_low}-${week52_high}`)
    }

    // ── Extract: candle closes → technicals ────────────────────────────────
    let ma_20:  number | null = cached?.ma_20 ?? null
    let ma_50:  number | null = cached?.ma_50 ?? null
    let rsi_14: number | null = cached?.rsi_14 ?? null
    if (!hasFreshTechnicals) {
      if (candleOut.status === 'fulfilled') {
        const raw: unknown = candleOut.value?.chart?.result?.[0]?.indicators?.quote?.[0]?.close
        if (Array.isArray(raw)) {
          let closes = raw.filter((c: unknown): c is number => typeof c === 'number' && !isNaN(c))
          if (ticker.endsWith('.TA')) closes = closes.map(c => c / 100)
          console.error(`[fetch-research] candles: fetched ${closes.length} closes, last=${closes.at(-1)?.toFixed(2)}`)
          ma_20  = computeMA(closes, 20)
          ma_50  = computeMA(closes, 50)
          rsi_14 = computeRSI(closes)
          console.error(`[fetch-research] MA20=${ma_20?.toFixed(2)} MA50=${ma_50?.toFixed(2)} RSI=${rsi_14?.toFixed(1)}`)
        }
      } else {
        console.error('[fetch-research] candle fetch failed:', candleOut.reason)
      }
    } else {
      console.error(`[fetch-research] technicals: using cache MA20=${ma_20?.toFixed(2)} MA50=${ma_50?.toFixed(2)} RSI=${rsi_14?.toFixed(1)}`)
    }

    // ── Extract: company profile ────────────────────────────────────────────
    let description: string | null = cached?.description ?? null
    let industry:    string | null = cached?.industry ?? null
    let sector:      string | null = cached?.sector ?? null
    if (!hasFreshTechnicals) {
      if (profileOut.status === 'fulfilled' && profileOut.value && typeof profileOut.value === 'object') {
        const p = profileOut.value as any
        const rawDesc = p.description ?? p.longDescription ?? null
        description = typeof rawDesc === 'string' && rawDesc.length > 0
          ? rawDesc.slice(0, 200).trimEnd() + (rawDesc.length > 200 ? '…' : '')
          : null
        industry = p.finnhubIndustry ?? p.gicsSector ?? null
        sector   = p.gicsSector ?? p.finnhubIndustry ?? null
        if (sector === industry) sector = null
        console.error(`[fetch-research] profile: fetched industry=${industry} sector=${sector} desc=${description?.slice(0, 50)}`)
      } else {
        console.error('[fetch-research] profile fetch failed:', profileOut.status === 'rejected' ? profileOut.reason : 'empty/null')
      }
    } else {
      console.error(`[fetch-research] profile: using cache industry=${industry} sector=${sector}`)
    }

    // Price targets: FMP deprecated this endpoint Aug 2025.
    const target_price_mean: null = null
    const target_price_high: null = null
    const target_price_low:  null = null

    // ── AI summary: No longer generated here; delegated to fetch-ai-summary endpoint
    // Preserve existing cached summaries (all languages) to include in response
    const existingAiSummaries = (cached?.ai_summaries as Record<string, any>) ?? {}
    log(`AI_SUMMARY_SKIPPED_DELEGATED_TO_FETCH_AI_SUMMARY`)

    // ── Build row and upsert ────────────────────────────────────────────────
    // ONLY write columns that exist in ticker_research_cache:
    // - NO ai_summary (singular) or ai_summary_at — use ai_summaries (JSONB) instead
    // - target_price_* columns: preserve from cache (don't overwrite with stale data from fetch-research)
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
      ma_20,
      ma_50,
      rsi_14,
      target_price_mean: cached?.target_price_mean ?? null,
      target_price_low: cached?.target_price_low ?? null,
      target_price_high: cached?.target_price_high ?? null,
      target_price_median: cached?.target_price_median ?? null,
      target_skip_reason: cached?.target_skip_reason ?? null,
      ai_summaries: existingAiSummaries,  // Preserve existing summaries; AI summary delegated to fetch-ai-summary
      fetched_at: new Date().toISOString(),
    }

    log(`CACHE_UPDATE_START`)
    const { data: upsertResult, error: upsertErr } = await supabase
      .from('ticker_research_cache')
      .upsert(row, { onConflict: 'ticker' })
      .select()

    if (upsertErr) {
      console.error('[fetch-research] UPSERT_FAILED:', upsertErr)
      log(`UPSERT_FAILED (${upsertErr.message})`)
    } else {
      console.error('[fetch-research] UPSERT_OK ticker=' + ticker)
      log(`UPSERT_OK`)
    }
    log(`CACHE_UPDATE_DONE`)

    log(`RETURNING`)
    return json({ research: row, language })
  } catch (err) {
    const msg   = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack   : undefined
    console.error('[fetch-research] unhandled error:', msg, stack)
    return json({ error: msg, stack }, 500)
  }
})
