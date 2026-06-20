import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'

const FINNHUB_KEY = Deno.env.get('FINNHUB_API_KEY') ?? ''

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  try {
    const { ticker } = await req.json()

    if (!ticker || !FINNHUB_KEY) {
      return new Response(JSON.stringify({ name: null }), { status: 200 })
    }

    // Don't try to fetch for .TA tickers (Israeli)
    if (ticker.includes('.TA')) {
      return new Response(JSON.stringify({ name: null }), { status: 200 })
    }

    const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker.toUpperCase())}&token=${FINNHUB_KEY}`
    const res = await fetch(url)
    const data = await res.json()

    return new Response(JSON.stringify({ name: data.name ?? null }), { status: 200 })
  } catch (error) {
    console.error('Error:', error)
    return new Response(JSON.stringify({ name: null }), { status: 200 })
  }
})
