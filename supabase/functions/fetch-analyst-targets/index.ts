import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { isUserPremium } from '../_shared/tier.ts'

const RATE_LIMIT_MS = 1000

Deno.serve(async (req) => {
  // Handle CORS preflight
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
    console.log('[fetch-analyst-targets] Fetching portfolios...')
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

    // 4. Find USD holdings (skip .TA and IL-*)
    console.log('[fetch-analyst-targets] Fetching holdings...')
    const { data: holdings, error: holdingsError } = await supabaseAdmin
      .from('holdings')
      .select('ticker')
      .in('portfolio_id', portfolioIds)
      .is('deleted_at', null)
      .eq('currency', 'USD')

    if (holdingsError) {
      throw new Error(`Failed to fetch holdings: ${holdingsError.message}`)
    }

    let tickers = [...new Set(holdings?.map((h: any) => h.ticker) ?? [])]
      .filter((t) => !t.endsWith('.TA') && !t.startsWith('IL-'))

    console.log(`[fetch-analyst-targets] Found ${tickers.length} unique USD tickers`)

    // 5. Filter out recently cached (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const { data: cachedRows, error: cacheError } = await supabaseAdmin
      .from('ticker_research_cache')
      .select('ticker, fetched_at')
      .in('ticker', tickers)
      .gte('fetched_at', sevenDaysAgo)

    if (cacheError) {
      console.warn(`[fetch-analyst-targets] Cache check error: ${cacheError.message}`)
    } else {
      const recentlyFetched = new Set(cachedRows?.map((c: any) => c.ticker) ?? [])
      tickers = tickers.filter((t) => !recentlyFetched.has(t))
    }

    const skippedCached = (cachedRows?.length ?? 0)
    console.log(`[fetch-analyst-targets] ${tickers.length} tickers need fresh fetch, ${skippedCached} recently cached`)

    // 6. Fetch analyst targets from Alpha Vantage
    const alphaApiKey = Deno.env.get('ALPHA_VANTAGE_API_KEY')
    if (!alphaApiKey) {
      throw new Error('ALPHA_VANTAGE_API_KEY not configured')
    }

    let fetched = 0
    let errored = 0
    const tickersUpdated: string[] = []

    for (const ticker of tickers) {
      try {
        const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${ticker}&apikey=${alphaApiKey}`
        const res = await fetch(url)
        const data = await res.json()

        // Check for rate limit response
        if (data.Information) {
          if (data.Information.includes('rate limit') || data.Information.includes('premium')) {
            console.warn(`[fetch-analyst-targets] Rate limited on ${ticker}: ${data.Information}`)
            errored++
            // Don't update cache — stay stale and retry tomorrow
            await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS))
            continue
          }
        }

        // Extract analyst target price (mean only, no high/low from free tier)
        const targetPrice = data.AnalystTargetPrice ? parseFloat(data.AnalystTargetPrice) : null

        // Upsert into cache
        const { error: upsertError } = await supabaseAdmin
          .from('ticker_research_cache')
          .upsert(
            {
              ticker,
              target_price_mean: targetPrice,
              fetched_at: new Date().toISOString(),
            },
            {
              onConflict: 'ticker',
            }
          )

        if (upsertError) {
          console.error(`[fetch-analyst-targets] Upsert error for ${ticker}: ${upsertError.message}`)
          errored++
        } else {
          fetched++
          tickersUpdated.push(ticker)
          console.log(`[fetch-analyst-targets] Updated ${ticker}: target=$${targetPrice}`)
        }
      } catch (err) {
        console.error(`[fetch-analyst-targets] Network error on ${ticker}:`, err)
        errored++
      }

      // Respect rate limit (1 second between calls)
      if (ticker !== tickers[tickers.length - 1]) {
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS))
      }
    }

    const result = {
      fetched,
      skipped_cached: skippedCached,
      errored,
      tickers_updated: tickersUpdated,
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
