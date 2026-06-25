import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { isUserPremium } from '../_shared/tier.ts'

const RATE_LIMIT_MS = 1000
const YAHOO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
const ETF_TYPES = new Set(['ETP', 'ETN', 'ETF', 'Mutual Fund'])
const ETF_TICKERS = new Set(['TQQQ', 'IBIT', 'GBTC', 'SHLD', 'URA', 'SLV', 'RSP', 'QQQ', 'SSO'])

interface TargetPrice {
  mean?: number | null
  low?: number | null
  high?: number | null
  median?: number | null
  source?: string
  error?: string
}

// Fetch analyst targets from Yahoo quoteSummary endpoint
async function fetchYahooTargets(ticker: string): Promise<TargetPrice> {
  try {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData`
    const res = await fetch(url, {
      headers: { 'User-Agent': YAHOO_UA },
    })

    if (!res.ok) {
      console.log(`[fetch-analyst-targets] Yahoo HTTP ${res.status} for ${ticker}`)
      return { error: `HTTP ${res.status}` }
    }

    const text = await res.text()

    // AMZN-specific diagnostic logging
    if (ticker === 'AMZN') {
      console.error('[fetch-analyst-targets] AMZN RAW Yahoo response (first 2000 chars):', text.substring(0, 2000))
    }

    const data = JSON.parse(text)
    const fd = data.quoteSummary?.result?.[0]?.financialData

    if (!fd) {
      console.log(`[fetch-analyst-targets] Yahoo no financialData for ${ticker}`)
      return { error: 'no_data' }
    }

    if (ticker === 'AMZN') {
      console.error('[fetch-analyst-targets] AMZN financialData keys:', Object.keys(fd))
      console.error('[fetch-analyst-targets] AMZN extracted values:', {
        mean: fd?.targetMeanPrice?.raw,
        high: fd?.targetHighPrice?.raw,
        low: fd?.targetLowPrice?.raw,
        median: fd?.targetMedianPrice?.raw,
      })
    }

    console.error(`[fetch-analyst-targets] financialData keys for ${ticker}:`, fd ? Object.keys(fd) : 'null')
    console.error(`[fetch-analyst-targets] Yahoo extracted for ${ticker}: mean=${fd?.targetMeanPrice?.raw} high=${fd?.targetHighPrice?.raw} low=${fd?.targetLowPrice?.raw}`)

    return {
      mean: fd.targetMeanPrice?.raw ?? null,
      low: fd.targetLowPrice?.raw ?? null,
      high: fd.targetHighPrice?.raw ?? null,
      median: fd.targetMedianPrice?.raw ?? null,
      source: 'yahoo',
    }
  } catch (err) {
    console.warn(`[fetch-analyst-targets] Yahoo error on ${ticker}:`, err)
    return { error: String(err) }
  }
}

// Fetch analyst target from Alpha Vantage OVERVIEW
async function fetchAlphaVantageTarget(ticker: string): Promise<TargetPrice> {
  const alphaApiKey = Deno.env.get('ALPHA_VANTAGE_API_KEY')
  if (!alphaApiKey) {
    return { error: 'no_api_key' }
  }

  try {
    const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${ticker}&apikey=${alphaApiKey}`
    const res = await fetch(url)
    const data = await res.json()

    if (data.Information) {
      if (data.Information.includes('rate limit') || data.Information.includes('premium')) {
        console.log(`[fetch-analyst-targets] Alpha Vantage rate limit on ${ticker}`)
        return { error: 'rate_limit' }
      }
    }

    const targetPrice = data.AnalystTargetPrice ? parseFloat(data.AnalystTargetPrice) : null

    if (targetPrice === null) {
      console.log(`[fetch-analyst-targets] Alpha Vantage no target for ${ticker}`)
      return { error: 'no_data' }
    }

    return {
      mean: targetPrice,
      source: 'alpha_vantage',
    }
  } catch (err) {
    console.warn(`[fetch-analyst-targets] Alpha Vantage error on ${ticker}:`, err)
    return { error: String(err) }
  }
}

// Detect if ticker is ETF using cached industry and Finnhub type
async function isEtf(
  ticker: string,
  supabaseAdmin: any,
  cachedRow: any
): Promise<{ skip: boolean; reason?: string }> {
  // Check hardcoded ETF list first
  if (ETF_TICKERS.has(ticker)) {
    return { skip: true, reason: 'hardcoded_etf' }
  }

  // Check if industry is cached (populated by fetch-research)
  if (cachedRow?.industry === null || cachedRow?.industry === undefined) {
    console.log(`[fetch-analyst-targets] ${ticker}: no cached industry, fetching Finnhub profile2`)

    // Fetch Finnhub profile to detect ETF
    const finnhubKey = Deno.env.get('FINNHUB_API_KEY')
    if (!finnhubKey) {
      console.log(`[fetch-analyst-targets] ${ticker}: no FINNHUB_API_KEY, skipping ETF check`)
      return { skip: false }
    }

    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${finnhubKey}`
      )
      const profile = await res.json()

      if (ETF_TYPES.has(profile.type)) {
        console.log(`[fetch-analyst-targets] ${ticker}: detected ETF type=${profile.type}`)
        return { skip: true, reason: 'ETF' }
      }

      // Cache the type in industry field if available
      if (profile.industry) {
        await supabaseAdmin
          .from('ticker_research_cache')
          .upsert(
            { ticker, industry: profile.industry, fetched_at: new Date().toISOString() },
            { onConflict: 'ticker' }
          )
          .catch((err: any) =>
            console.warn(`[fetch-analyst-targets] Failed to cache industry for ${ticker}:`, err)
          )
      }

      return { skip: false }
    } catch (err) {
      console.warn(`[fetch-analyst-targets] Finnhub profile2 error on ${ticker}:`, err)
      // Unknown — assume not ETF to try fetching
      return { skip: false }
    }
  }

  return { skip: false }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }

  try {
    // 1. Authenticate caller
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    )

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser()

    if (authError || !user) {
      console.error('[fetch-analyst-targets] Auth failed:', authError)
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    // Check Premium tier
    const isPremium = await isUserPremium(supabaseClient, user.id)
    if (!isPremium) {
      console.warn(`[fetch-analyst-targets] Free user attempted: ${user.id}`)
      return new Response(JSON.stringify({ error: 'Premium tier required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // 2. Find all Premium users
    console.log('[fetch-analyst-targets] Finding Premium users...')
    const { data: premiumUsers, error: usersError } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('tier', 'premium')

    if (usersError) {
      throw new Error(`Failed to fetch premium users: ${usersError.message}`)
    }

    const premiumUserIds = premiumUsers?.map((u: any) => u.id) ?? []
    console.log(`[fetch-analyst-targets] Found ${premiumUserIds.length} premium users`)

    if (premiumUserIds.length === 0) {
      return new Response(
        JSON.stringify({
          fetched: 0,
          skipped_etf: 0,
          skipped_cached: 0,
          errored: 0,
          tickers_updated: [],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      )
    }

    // 3. Find portfolios for Premium users
    const { data: portfolios, error: portfoliosError } = await supabaseAdmin
      .from('portfolios')
      .select('id')
      .in('user_id', premiumUserIds)

    if (portfoliosError) {
      throw new Error(`Failed to fetch portfolios: ${portfoliosError.message}`)
    }

    const portfolioIds = portfolios?.map((p: any) => p.id) ?? []
    if (portfolioIds.length === 0) {
      return new Response(
        JSON.stringify({
          fetched: 0,
          skipped_etf: 0,
          skipped_cached: 0,
          errored: 0,
          tickers_updated: [],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      )
    }

    // 4. Fetch tickers from holdings, watchlist, and RSU grants in parallel
    const [holdingsRes, watchlistRes, rsuRes] = await Promise.all([
      supabaseAdmin
        .from('holdings')
        .select('ticker')
        .in('portfolio_id', portfolioIds)
        .eq('currency', 'USD')
        .is('deleted_at', null),
      supabaseAdmin
        .from('watchlist_items')
        .select('ticker')
        .in('user_id', premiumUserIds),
      supabaseAdmin
        .from('rsu_grants')
        .select('ticker')
        .in('user_id', premiumUserIds)
        .is('deleted_at', null),
    ])

    if (holdingsRes.error) {
      throw new Error(`Failed to fetch holdings: ${holdingsRes.error.message}`)
    }
    if (watchlistRes.error) {
      throw new Error(`Failed to fetch watchlist: ${watchlistRes.error.message}`)
    }
    if (rsuRes.error) {
      throw new Error(`Failed to fetch RSU grants: ${rsuRes.error.message}`)
    }

    // Deduplicate across all three sources, filter to USD-only
    const allTickers = new Set([
      ...(holdingsRes.data ?? []).map((h: any) => h.ticker),
      ...(watchlistRes.data ?? []).map((w: any) => w.ticker),
      ...(rsuRes.data ?? []).map((r: any) => r.ticker),
    ])

    const tickers = [...allTickers]
      .filter((t) => !t.endsWith('.TA') && !t.startsWith('IL-'))

    console.error('[fetch-analyst-targets] Collected', tickers.length, 'USD tickers from:',
      `${holdingsRes.data?.length ?? 0} holdings,`,
      `${watchlistRes.data?.length ?? 0} watchlist,`,
      `${rsuRes.data?.length ?? 0} RSU grants`
    )

    if (tickers.length === 0) {
      return new Response(
        JSON.stringify({
          fetched: 0,
          skipped_etf: 0,
          skipped_cached: 0,
          errored: 0,
          tickers_updated: [],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      )
    }

    // 5. Load current cache and identify retryable tickers
    const { data: cacheRows, error: cacheError } = await supabaseAdmin
      .from('ticker_research_cache')
      .select('ticker, target_price_mean, target_skip_reason, fetched_at')
      .in('ticker', tickers)

    if (cacheError) {
      console.warn(`[fetch-analyst-targets] Cache load error: ${cacheError.message}`)
    }

    const cacheMap = new Map(
      cacheRows?.map((c: any) => [c.ticker, c]) ?? []
    )

    let skippedEtf = 0
    let skippedCached = 0
    let fetched = 0
    let errored = 0
    const tickersUpdated: string[] = []
    const sourceLog: Record<string, string> = {}

    // 6. Fetch analyst targets for each ticker
    for (const ticker of tickers) {
      const cached = cacheMap.get(ticker)

      // Skip if permanently marked (ETF or no coverage)
      if (cached?.target_skip_reason) {
        console.log(`[fetch-analyst-targets] Skipped ${ticker}: target_skip_reason=${cached.target_skip_reason}`)
        skippedEtf++
        continue
      }

      // Skip if target_price_mean exists and is fresh (7 days)
      if (
        cached?.target_price_mean !== null &&
        cached?.fetched_at &&
        new Date(cached.fetched_at).getTime() > Date.now() - 7 * 24 * 60 * 60 * 1000
      ) {
        console.log(`[fetch-analyst-targets] Skipped ${ticker}: fresh cache`)
        skippedCached++
        continue
      }

      // Detect if ETF
      const { skip, reason } = await isEtf(ticker, supabaseAdmin, cached)
      if (skip) {
        console.log(`[fetch-analyst-targets] Skipped ${ticker}: ${reason}`)
        // Mark permanently to avoid retrying
        await supabaseAdmin
          .from('ticker_research_cache')
          .upsert(
            {
              ticker,
              target_skip_reason: 'ETF',
              fetched_at: new Date().toISOString(),
            },
            { onConflict: 'ticker' }
          )
          .catch((err: any) =>
            console.warn(`[fetch-analyst-targets] Failed to mark ETF for ${ticker}:`, err)
          )
        skippedEtf++
        continue
      }

      // Try Yahoo first
      let targets = await fetchYahooTargets(ticker)

      // Fall back to Alpha Vantage if Yahoo failed and ticker is not ETF
      if (targets.error && !targets.source) {
        console.log(
          `[fetch-analyst-targets] Yahoo failed for ${ticker} (${targets.error}), trying Alpha Vantage`
        )
        targets = await fetchAlphaVantageTarget(ticker)
      }

      // Skip rate-limited calls
      if (targets.error === 'rate_limit') {
        console.log(`[fetch-analyst-targets] Rate limited on ${ticker}, skipping`)
        errored++
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS))
        continue
      }

      // Upsert into cache
      if (targets.mean !== null || targets.low !== null || targets.high !== null) {
        try {
          await supabaseAdmin
            .from('ticker_research_cache')
            .upsert(
              {
                ticker,
                target_price_mean: targets.mean ?? null,
                target_price_low: targets.low ?? null,
                target_price_high: targets.high ?? null,
                fetched_at: new Date().toISOString(),
              },
              { onConflict: 'ticker' }
            )

          fetched++
          tickersUpdated.push(ticker)
          sourceLog[ticker] = targets.source ?? 'unknown'
          console.log(
            `[fetch-analyst-targets] Updated ${ticker}: source=${targets.source} mean=$${targets.mean} low=$${targets.low} high=$${targets.high}`
          )
        } catch (err) {
          console.error(`[fetch-analyst-targets] Upsert error for ${ticker}:`, err)
          errored++
        }
      } else {
        console.log(`[fetch-analyst-targets] No target data for ${ticker} from ${targets.source}`)
        errored++
      }

      // Respect rate limit between calls
      if (ticker !== tickers[tickers.length - 1]) {
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS))
      }
    }

    const result = {
      fetched,
      skipped_etf: skippedEtf,
      skipped_cached: skippedCached,
      errored,
      tickers_updated: tickersUpdated,
      sources: sourceLog,
    }

    console.log('[fetch-analyst-targets] Batch complete:', result)

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  } catch (err) {
    console.error('[fetch-analyst-targets] CRASHED:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }
})
