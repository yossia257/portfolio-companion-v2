import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.0'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface Idea {
  ticker: string
  name: string
  asset_class: string
  rationale: string
  risk: string
  sizing: string
  tax_considerations?: string
}

async function handler(req: Request): Promise<Response> {
  try {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      })
    }

    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    // Extract JWT from Authorization header
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      console.error('[generate-watchlist-ideas] Missing or invalid Authorization header')
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const jwt = authHeader.slice(7)

    // Create Supabase client with user JWT
    const supabaseUser = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!)
    const { data: { user }, error: authError } = await supabaseUser.auth.getUser(jwt)

    if (authError || !user) {
      console.error('[generate-watchlist-ideas] Auth error:', authError)
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const userId = user.id
    console.log(`[generate-watchlist-ideas] User: ${userId}`)

    // Get today's date in YYYY-MM-DD format
    const today = new Date().toISOString().split('T')[0]

    // Check cache first
    const supabaseAdmin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!)
    const { data: cacheData, error: cacheError } = await supabaseAdmin
      .from('ai_watchlist_cache')
      .select('ideas')
      .eq('user_id', userId)
      .eq('generated_on', today)
      .maybeSingle()

    if (cacheError) {
      console.error('[generate-watchlist-ideas] Cache query error:', cacheError)
    } else if (cacheData) {
      console.log(`[generate-watchlist-ideas] Cache hit for ${userId} on ${today}`)
      return new Response(JSON.stringify({ ideas: cacheData.ideas }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    console.log(`[generate-watchlist-ideas] Cache miss for ${userId}, generating ideas...`)

    // Fetch user profile
    const { data: profileData, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select(
        'display_name, display_currency, ai_response_language, tax_jurisdiction, investment_horizon, risk_tolerance, portfolio_style, themes_of_interest, themes_to_avoid, tax_sensitivity'
      )
      .eq('id', userId)
      .single()

    if (profileError) {
      console.error('[generate-watchlist-ideas] Profile query error:', profileError)
      return new Response(JSON.stringify({ error: 'Failed to fetch profile' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const profile = profileData as any

    // Fetch user's active portfolio
    const { data: portfolioData, error: portfolioError } = await supabaseAdmin
      .from('portfolios')
      .select('id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle()

    if (portfolioError) {
      console.error('[generate-watchlist-ideas] Portfolio query error:', portfolioError)
      return new Response(JSON.stringify({ error: 'Failed to fetch portfolio' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    let holdings: any[] = []
    if (portfolioData) {
      const { data: holdingsData, error: holdingsError } = await supabaseAdmin
        .from('holdings')
        .select('ticker, name, quantity, currency, buy_price, category')
        .eq('portfolio_id', portfolioData.id)
        .is('deleted_at', null)

      if (holdingsError) {
        console.error('[generate-watchlist-ideas] Holdings query error:', holdingsError)
      } else {
        holdings = holdingsData || []
      }
    }

    // Fetch watchlist items to avoid suggesting duplicates
    const { data: watchlistData, error: watchlistError } = await supabaseAdmin
      .from('watchlist_items')
      .select('ticker')
      .eq('user_id', userId)

    if (watchlistError) {
      console.error('[generate-watchlist-ideas] Watchlist query error:', watchlistError)
    }

    const watchlistTickers = (watchlistData || []).map((item: any) => item.ticker)
    const ownedTickers = holdings.map((h: any) => h.ticker.toUpperCase())
    const excludedTickers = new Set([...ownedTickers, ...watchlistTickers.map((t: string) => t.toUpperCase())])

    // Build portfolio summary
    const holdingsSummary = holdings
      .map((h: any) => {
        const qty = Number(h.quantity) || 0
        const buyPrice = Number(h.buy_price) || 0
        const totalCost = qty * buyPrice
        return `- ${h.ticker} (${h.name || 'N/A'}): ${qty} shares @ ${h.currency} ${buyPrice.toFixed(2)} = ${totalCost.toFixed(2)} ${h.currency} [Category: ${h.category || 'uncategorized'}]`
      })
      .join('\n')

    // Build sector breakdown (simple count-based)
    const categoryCounts: Record<string, number> = {}
    holdings.forEach((h: any) => {
      const cat = h.category || 'uncategorized'
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1
    })
    const sectorBreakdown = Object.entries(categoryCounts)
      .map(([cat, count]) => `${cat}: ${count} holdings`)
      .join(', ')

    // Build investment profile summary
    const investmentProfile = `
Investment Horizon: ${profile.investment_horizon || 'not specified'}
Risk Tolerance: ${profile.risk_tolerance || 'not specified'}
Portfolio Style: ${profile.portfolio_style || 'not specified'}
Themes of Interest: ${profile.themes_of_interest || 'not specified'}
Themes to AVOID: ${profile.themes_to_avoid || 'none specified'}
Tax Sensitivity: ${profile.tax_sensitivity || 'not specified'}
Tax Jurisdiction: ${profile.tax_jurisdiction || 'Israel'}
`

    // Build user message
    const userMessage = `
User: ${profile.display_name || 'User'}
Currency: ${profile.display_currency || 'USD'}

CURRENT HOLDINGS (${holdings.length} positions):
${holdingsSummary || '(None)'}

SECTOR BREAKDOWN: ${sectorBreakdown || 'None'}

CURRENT WATCHLIST: ${watchlistTickers.length > 0 ? watchlistTickers.join(', ') : '(None)'}

TASK: Generate EXACTLY 5 investment ideas that would complement or diversify this portfolio, given the investment profile above. You MUST return exactly 5 ideas. Do not return fewer than 5.
`

    // Build system prompt
    const systemPrompt = `You are a personalized investment advisor suggesting ideas for ${profile.display_name || 'a user'} based on their portfolio and stated investment profile.

INVESTMENT PROFILE:
${investmentProfile}

STRICT RULES:
1. Do NOT suggest tickers they already own or watch.
2. Do NOT suggest anything matching their themes-to-avoid list.
3. Honor their risk tolerance: low-risk → avoid leveraged ETFs, crypto, biotech. High-risk → these are fair game.
4. Honor their investment horizon: short → suggest liquid, lower-volatility ideas. Long → growth bets OK.
5. Honor their portfolio style: focused → 1-2 high-conviction ideas. Diversified → suggest spread.
6. For each idea, include: ticker, name, asset class, 2-3 sentence rationale grounded in their portfolio, key risk, and suggested sizing range.
7. If they are tax-aware (tax_sensitivity = tax_aware): when suggesting position changes (sell X to buy Y), explicitly compute the tax cost at their jurisdiction's capital gains rate.
8. YOU MUST RETURN EXACTLY 5 IDEAS. Never fewer than 5. Your response MUST be a JSON array with exactly 5 objects.
9. Respond ONLY with valid JSON array (no preamble, no markdown, no explanations), in ${profile.ai_response_language || 'English'}.

RESPONSE FORMAT (valid JSON — EXACTLY 5 ITEMS):
[
  {
    "ticker": "SYMBOL",
    "name": "Full Name",
    "asset_class": "Stock/ETF/Crypto/Commodity",
    "rationale": "Why this complements their portfolio, grounded in their profile.",
    "risk": "Key risk factors",
    "sizing": "X-Y% of portfolio",
    "tax_considerations": "If applicable; optional"
  },
  { ... repeat 4 more times with different ideas ... }
]

After the JSON array, append on a new line: "These are ideas for research, not financial advice."
`

    console.log('[generate-watchlist-ideas] Calling Anthropic Claude API...')

    // Call Anthropic API
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2500,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: userMessage,
          },
        ],
      }),
    })

    if (!anthropicRes.ok) {
      const errorText = await anthropicRes.text()
      console.error('[generate-watchlist-ideas] Anthropic API error:', anthropicRes.status, errorText)
      return new Response(JSON.stringify({ error: 'Failed to generate ideas' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const anthropicData = await anthropicRes.json()
    const responseText = anthropicData.content?.[0]?.text || ''

    console.log('[generate-watchlist-ideas] Claude response received, parsing JSON...')

    // Extract JSON from response (may have preamble/disclaimer)
    let ideas: Idea[] = []
    try {
      // Try to parse directly as JSON array
      const jsonMatch = responseText.match(/\[\s*\{[\s\S]*\}\s*\]/)
      if (jsonMatch) {
        const jsonStr = jsonMatch[0]
        ideas = JSON.parse(jsonStr)
      } else {
        throw new Error('No JSON array found in response')
      }
    } catch (parseError) {
      console.error('[generate-watchlist-ideas] JSON parse error:', parseError)
      console.error('[generate-watchlist-ideas] Raw response:', responseText)
      return new Response(JSON.stringify({ error: 'Failed to parse ideas from AI response' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    // Validate structure
    if (!Array.isArray(ideas) || ideas.length === 0) {
      console.error('[generate-watchlist-ideas] Invalid ideas structure:', ideas)
      return new Response(JSON.stringify({ error: 'No valid ideas generated' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    console.log(`[generate-watchlist-ideas] Generated ${ideas.length} ideas, caching...`)

    // UPSERT into cache
    const { error: upsertError } = await supabaseAdmin
      .from('ai_watchlist_cache')
      .upsert(
        {
          user_id: userId,
          generated_on: today,
          ideas: ideas,
        },
        { onConflict: 'user_id,generated_on' }
      )

    if (upsertError) {
      console.error('[generate-watchlist-ideas] Cache upsert error:', upsertError)
      // Don't fail the request if cache write fails; still return the ideas
    } else {
      console.log(`[generate-watchlist-ideas] Ideas cached for ${userId}`)
    }

    return new Response(JSON.stringify({ ideas }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  } catch (error) {
    console.error('[generate-watchlist-ideas] Unhandled error:', error)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }
}

Deno.serve(handler)
