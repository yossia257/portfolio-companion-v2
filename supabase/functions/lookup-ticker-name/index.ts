import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'

const FINNHUB_KEY = Deno.env.get('FINNHUB_API_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders, status: 204 })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders })
  }

  try {
    const { ticker } = await req.json()

    console.log('[lookup-ticker-name] Request:', { ticker, hasKey: !!FINNHUB_KEY })

    if (!ticker) {
      return new Response(JSON.stringify({ name: null }), { status: 200, headers: corsHeaders })
    }

    // Don't try to fetch for .TA tickers (Israeli)
    if (ticker.includes('.TA')) {
      console.log('[lookup-ticker-name] Skipping .TA ticker')
      return new Response(JSON.stringify({ name: null }), { status: 200, headers: corsHeaders })
    }

    if (!FINNHUB_KEY) {
      console.log('[lookup-ticker-name] No FINNHUB_API_KEY set')
      return new Response(JSON.stringify({ name: null, error: 'No API key' }), { status: 200, headers: corsHeaders })
    }

    const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker.toUpperCase())}&token=${FINNHUB_KEY}`
    console.log('[lookup-ticker-name] Fetching from Finnhub:', ticker)
    const res = await fetch(url)
    const data = await res.json()

    console.log('[lookup-ticker-name] Response:', { ticker, status: res.status, name: data.name })
    return new Response(JSON.stringify({ name: data.name ?? null }), { status: 200, headers: corsHeaders })
  } catch (error) {
    console.error('[lookup-ticker-name] Error:', error)
    return new Response(JSON.stringify({ name: null, error: String(error) }), { status: 200, headers: corsHeaders })
  }
})
