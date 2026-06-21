import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.0'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
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
      console.error('[ask-claude] Missing or invalid Authorization header')
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const jwt = authHeader.slice(7)

    // Get user
    const supabaseUser = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!)
    const { data: { user }, error: authError } = await supabaseUser.auth.getUser(jwt)

    if (authError || !user) {
      console.error('[ask-claude] Auth error:', authError)
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const userId = user.id
    console.log(`[ask-claude] User: ${userId}`)

    // Parse request body
    let body: any = {}
    try {
      body = await req.json()
    } catch (e) {
      console.error('[ask-claude] Failed to parse request body:', e)
      return new Response(JSON.stringify({ error: 'Invalid request body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const messages: ConversationMessage[] = body.messages || []
    if (!Array.isArray(messages) || messages.length === 0) {
      console.error('[ask-claude] No messages in request')
      return new Response(JSON.stringify({ error: 'Messages array required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    // Simple rate limiting: check daily usage
    const supabaseAdmin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!)
    const today = new Date().toISOString().split('T')[0]
    const { data: todayUsage, error: usageError } = await supabaseAdmin
      .from('ai_usage')
      .select('count(*)', { count: 'exact' })
      .eq('user_id', userId)
      .eq('endpoint', 'ask-claude')
      .gte('created_at', `${today}T00:00:00Z`)

    if (usageError) {
      console.error('[ask-claude] Usage check error:', usageError)
    } else if (todayUsage && todayUsage.length > 0 && todayUsage[0].count >= 30) {
      console.warn(`[ask-claude] Rate limit hit for user ${userId}`)
      return new Response(JSON.stringify({ error: 'Daily limit reached. Resets at midnight UTC.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    // Fetch user profile and context
    const { data: profileData, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select(
        'display_name, display_currency, ai_response_language, tax_jurisdiction, investment_horizon, risk_tolerance, portfolio_style, themes_of_interest, themes_to_avoid, tax_sensitivity'
      )
      .eq('id', userId)
      .single()

    if (profileError) {
      console.error('[ask-claude] Profile fetch error:', profileError)
      return new Response(JSON.stringify({ error: 'Failed to fetch profile' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const profile = profileData as any

    // Fetch holdings + watchlist + RSU vests + market context
    const portfolio = await getPortfolioContext(supabaseAdmin, userId)

    // Build system prompt with context
    const systemPrompt = buildSystemPrompt(profile, portfolio)

    console.log(`[ask-claude] Starting stream for user ${userId}`)

    // Call Anthropic API with streaming
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: systemPrompt,
        messages,
        stream: true,
      }),
    })

    if (!anthropicRes.ok) {
      const errorText = await anthropicRes.text()
      console.error('[ask-claude] Anthropic API error:', anthropicRes.status, errorText)
      return new Response(JSON.stringify({ error: 'Failed to get response from Claude' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    // Stream the response back to client as SSE
    return streamResponse(anthropicRes, userId)
  } catch (error) {
    console.error('[ask-claude] Unhandled error:', error)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }
}

// Fetch portfolio context: holdings, watchlist, RSU vests, market data
async function getPortfolioContext(supabase: any, userId: string) {
  const context: any = {
    holdings: [],
    watchlist: [],
    rsuVests: [],
    fxRate: null,
  }

  try {
    // Get active portfolio
    const { data: portfolioData } = await supabase
      .from('portfolios')
      .select('id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle()

    if (portfolioData) {
      // Get holdings
      const { data: holdingsData } = await supabase
        .from('holdings')
        .select('ticker, name, quantity, currency, buy_price')
        .eq('portfolio_id', portfolioData.id)
        .is('deleted_at', null)

      context.holdings = holdingsData || []
    }

    // Get watchlist
    const { data: watchlistData } = await supabase
      .from('watchlist_items')
      .select('ticker')
      .eq('user_id', userId)

    context.watchlist = (watchlistData || []).map((w: any) => w.ticker)

    // Get RSU vests (simplified: fetch all, client can filter)
    const { data: rsusData } = await supabase
      .from('rsu_grants')
      .select('ticker, quantity, vesting_date')
      .eq('user_id', userId)
      .gte('vesting_date', new Date().toISOString())
      .order('vesting_date', { ascending: true })
      .limit(10)

    context.rsuVests = rsusData || []
  } catch (e) {
    console.error('[ask-claude] Error fetching portfolio context:', e)
  }

  return context
}

// Build comprehensive system prompt with user context
function buildSystemPrompt(profile: any, portfolio: any): string {
  const taxInfo = {
    'Israel': '25% on long-term gains',
    'US': '0-20% depending on holding period',
    'UK': '20% on gains over annual exempt amount',
  } as any

  const taxRate = taxInfo[profile.tax_jurisdiction] || 'varies by jurisdiction'

  // Build holdings table
  let holdingsTable = ''
  if (portfolio.holdings.length > 0) {
    holdingsTable = '| Ticker | Qty | Currency | Buy Price | Value |\n'
    holdingsTable += '|--------|-----|----------|-----------|-------|\n'
    portfolio.holdings.forEach((h: any) => {
      const qty = Number(h.quantity) || 0
      const buyPrice = Number(h.buy_price) || 0
      const value = (qty * buyPrice).toFixed(2)
      holdingsTable += `| ${h.ticker} | ${qty} | ${h.currency || 'USD'} | ${buyPrice.toFixed(2)} | ${value} |\n`
    })
  } else {
    holdingsTable = '(No holdings yet)'
  }

  // Build watchlist
  const watchlistStr = portfolio.watchlist.length > 0 ? portfolio.watchlist.join(', ') : '(None)'

  // Build RSU vests
  let rsusStr = ''
  if (portfolio.rsuVests.length > 0) {
    rsusStr = portfolio.rsuVests
      .map((r: any) => {
        const date = new Date(r.vesting_date).toLocaleDateString()
        const qty = r.quantity || 0
        return `- ${date}: ${qty} shares of ${r.ticker}`
      })
      .join('\n')
  } else {
    rsusStr = '(None in next 12 months)'
  }

  return `You are an AI assistant helping ${profile.display_name || 'the user'} make sense of their personal investment portfolio.

USER PROFILE:

- Display currency: ${profile.display_currency || 'USD'} | Tax jurisdiction: ${profile.tax_jurisdiction || 'not specified'} (${taxRate})
- Investment horizon: ${profile.investment_horizon || 'not specified'}
- Risk tolerance: ${profile.risk_tolerance || 'not specified'}
- Portfolio style: ${profile.portfolio_style || 'not specified'}
- Themes of interest: ${profile.themes_of_interest || 'not specified'}
- Themes to AVOID (honor strictly): ${profile.themes_to_avoid || 'none'}
- Tax sensitivity: ${profile.tax_sensitivity || 'not specified'}

CURRENT HOLDINGS (${portfolio.holdings.length} positions):

${holdingsTable}

WATCHLIST (${portfolio.watchlist.length} ideas being tracked):

${watchlistStr}

UPCOMING RSU VESTS (next 12 months):

${rsusStr}

NON-NEGOTIABLE RULES:

1. You give context, education, and analysis — NEVER personalized buy/sell recommendations.
2. If asked "should I buy/sell X", reframe as "here's how to think about X" with pros and cons.
3. Honor tax_jurisdiction when discussing transaction costs — for ${profile.tax_jurisdiction || 'their jurisdiction'} users, mention capital gains tax explicitly when relevant (${taxRate}).
4. Respond in ${profile.ai_response_language || 'English'}.
5. Be concise. ${profile.display_name || 'The user'} is sophisticated.
6. If asked about something outside your knowledge (e.g., today's specific news), say so rather than guessing.`
}

// Stream response back to client as Server-Sent Events
async function streamResponse(anthropicRes: Response, userId: string): Promise<Response> {
  let inputTokens = 0
  let outputTokens = 0
  const supabaseAdmin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!)

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()

  // Process the stream in the background
  const processStream = async () => {
    try {
      const reader = anthropicRes.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue

          const data = line.slice(6)
          if (data === '[DONE]') continue

          try {
            const event = JSON.parse(data)

            // Capture token counts from message_stop event
            if (event.type === 'message_stop') {
              inputTokens = event.message?.usage?.input_tokens || 0
              outputTokens = event.message?.usage?.output_tokens || 0
            }

            // Forward content_block_delta events (the actual text)
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
              const token = event.delta.text || ''
              await writer.write(new TextEncoder().encode(`data: ${token}\n\n`))
            }
          } catch (e) {
            console.warn('[ask-claude] Failed to parse event:', e)
          }
        }
      }

      // Send final marker
      await writer.write(new TextEncoder().encode('data: [DONE]\n\n'))

      // Log usage
      if (inputTokens > 0 || outputTokens > 0) {
        const costUsd = (inputTokens * 0.003 + outputTokens * 0.009) / 1000 // Sonnet 4.6 pricing
        const { error: logError } = await supabaseAdmin
          .from('ai_usage')
          .insert({
            user_id: userId,
            endpoint: 'ask-claude',
            tokens_in: inputTokens,
            tokens_out: outputTokens,
            cost_usd: costUsd,
            created_at: new Date().toISOString(),
          })

        if (logError) {
          console.error('[ask-claude] Failed to log usage:', logError)
        } else {
          console.log(`[ask-claude] Logged usage for ${userId}: ${inputTokens} in, ${outputTokens} out, $${costUsd.toFixed(4)}`)
        }
      }

      await writer.close()
    } catch (error) {
      console.error('[ask-claude] Stream processing error:', error)
      try {
        await writer.write(new TextEncoder().encode(`data: [ERROR]\n\n`))
        await writer.close()
      } catch {
        // Already closed
      }
    }
  }

  // Start background processing without awaiting
  processStream().catch((e) => console.error('[ask-claude] Background processing failed:', e))

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...corsHeaders,
    },
  })
}

Deno.serve(handler)
