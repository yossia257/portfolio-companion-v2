import '@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from '@supabase/supabase-js'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

const LANG_INSTRUCTIONS: Record<string, string> = {
  en: 'Respond in English.',
  he: 'Respond in Hebrew (עברית).',
  es: 'Respond in Spanish.',
  de: 'Respond in German.',
  fr: 'Respond in French.',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

function trimToLastSentence(text: string): string {
  const sentenceEnders = /[.!?。][\s"']*$/
  if (sentenceEnders.test(text)) return text

  const lastPeriod = Math.max(
    text.lastIndexOf('. '),
    text.lastIndexOf('! '),
    text.lastIndexOf('? '),
    text.lastIndexOf('.\n'),
    text.lastIndexOf('!\n'),
    text.lastIndexOf('?\n'),
    text.lastIndexOf('。'),
    text.lastIndexOf('！'),
    text.lastIndexOf('？')
  )

  if (lastPeriod === -1) return text + '…'
  return text.substring(0, lastPeriod + 1)
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  try {
    const t0 = Date.now()
    const log = (label: string) => console.error(`[fetch-ai-summary] ${label}`, Date.now() - t0, 'ms')
    log('START')

    let body: unknown = null
    try { body = await req.json() } catch (e) {
      console.error('[fetch-ai-summary] req.json() failed:', e)
    }

    const ticker: string | null = typeof (body as any)?.ticker === 'string' && (body as any).ticker.trim().length > 0
      ? (body as any).ticker.trim().toUpperCase()
      : null

    const language: string = typeof (body as any)?.language === 'string' ? (body as any).language : 'en'

    if (!ticker) return json({ error: 'ticker is required' }, 400)
    if (!ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500)

    log(`FETCHING_CACHED_RESEARCH`)

    // Read existing cached research (news, analyst, technicals already cached by fetch-research)
    const { data: cached, error: cacheErr } = await supabase
      .from('ticker_research_cache')
      .select('*')
      .eq('ticker', ticker)
      .single()

    if (cacheErr || !cached) {
      log(`NO_CACHED_RESEARCH`)
      return json({ error: 'No cached research for ticker. Call fetch-research first.' }, 404)
    }

    log(`CACHED_RESEARCH_LOADED`)

    // Check if fresh summary already exists for this language
    const langEntry = (cached.ai_summaries as Record<string, any>)?.[language]
    if (langEntry?.text) {
      const age = langEntry.at
        ? (Date.now() - new Date(langEntry.at).getTime()) / 1000 / 60 / 60
        : 999
      if (age < 24) {
        log(`SUMMARY_ALREADY_FRESH`)
        return json({ summary: langEntry.text, summary_at: langEntry.at, cached: true })
      }
    }

    log(`GENERATING_SUMMARY`)

    // Build AI prompt from cached research
    const newsLines = (cached.news as any[])
      .slice(0, 3)
      .map((n: any) => `  - ${n.headline}`)
      .join('\n') || '  (none available)'

    const context = [
      `Ticker: ${ticker}${cached.companyName && cached.companyName !== ticker ? ` (${cached.companyName})` : ''}`,
      cached.week52_high != null && cached.week52_low != null
        ? `52-week range: ${cached.week52_low} – ${cached.week52_high}` : null,
      cached.pe_ratio != null ? `PE (TTM): ${cached.pe_ratio.toFixed(1)}` : null,
      cached.eps != null ? `EPS (TTM): ${cached.eps.toFixed(2)}` : null,
      cached.beta != null ? `Beta: ${cached.beta.toFixed(2)}` : null,
      cached.analyst_buy != null
        ? `Analyst ratings: ${cached.analyst_buy} Buy / ${cached.analyst_hold} Hold / ${cached.analyst_sell} Sell` : null,
      cached.ma_20 != null || cached.ma_50 != null
        ? `Moving averages: ${[
            cached.ma_20 != null ? `MA20 ${cached.ma_20.toFixed(2)}` : null,
            cached.ma_50 != null ? `MA50 ${cached.ma_50.toFixed(2)}` : null,
          ].filter(Boolean).join(', ')}` : null,
      cached.rsi_14 != null ? `RSI(14): ${cached.rsi_14.toFixed(1)}` : null,
      `Recent headlines:\n${newsLines}`,
    ].filter(Boolean).join('\n')

    const langInstruction = LANG_INSTRUCTIONS[language] ?? LANG_INSTRUCTIONS.en

    const prompt =
      `You are summarizing the investment picture for ${ticker} for a sophisticated individual investor.\n\n` +
      `Write 4–6 sentences. No bullet points. No explicit buy/sell verdict. ` +
      `Synthesize: where the story stands now, what analysts and the chart agree or disagree on, ` +
      `and what is the single most important thing a current holder should watch.\n\n` +
      `IMPORTANT: End your response at a complete sentence with proper punctuation. Do not leave any sentence unfinished. ` +
      `If you're approaching the token limit, wrap up your current thought cleanly rather than starting a new one.\n\n` +
      `${langInstruction}\n\n` +
      `Current data:\n${context}`

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5',
        max_tokens: 800,
        messages:   [{ role: 'user', content: prompt }],
      }),
    })

    console.error(`[fetch-ai-summary] Anthropic HTTP ${anthropicRes.status}`)

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text()
      console.error(`[fetch-ai-summary] Anthropic error: ${errBody.slice(0, 300)}`)
      return json({ error: 'Failed to generate summary' }, 500)
    }

    const anthropicData = await anthropicRes.json()
    let summaryText = anthropicData.content?.[0]?.text ?? null

    if (!summaryText) {
      log(`NO_SUMMARY_TEXT`)
      return json({ error: 'No summary generated' }, 500)
    }

    summaryText = trimToLastSentence(summaryText)
    const summaryAt = new Date().toISOString()

    log(`SUMMARY_GENERATED`)

    // Update cache with new summary for this language
    const existingAiSummaries = (cached.ai_summaries as Record<string, any>) ?? {}
    const updatedAiSummaries = {
      ...existingAiSummaries,
      [language]: { text: summaryText, at: summaryAt },
    }

    const { error: updateErr } = await supabase
      .from('ticker_research_cache')
      .update({ ai_summaries: updatedAiSummaries })
      .eq('ticker', ticker)

    if (updateErr) {
      console.error('[fetch-ai-summary] UPDATE_FAILED:', updateErr)
      log(`UPDATE_FAILED`)
      // Still return the summary even if cache update failed — it's generated
    } else {
      log(`CACHE_UPDATED`)
    }

    log(`RETURNING`)
    return json({ summary: summaryText, summary_at: summaryAt, cached: false })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    console.error('[fetch-ai-summary] unhandled error:', msg, stack)
    return json({ error: msg }, 500)
  }
})
