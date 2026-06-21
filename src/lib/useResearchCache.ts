import { useCallback, useRef } from 'react'
import { supabase } from './supabase'
import type { ResearchCacheRow } from './signals'

// Frontend session cache: in-memory store for research data fetched during this browser session
// Keyed by ticker, with 5-minute TTL per entry. Reduces redundant network calls when user
// flips between stocks, while respecting server-side cache logic (24h TTL on backend).

interface CacheEntry {
  data: ResearchCacheRow
  fetchedAt: number
}

const TTL_MS = 5 * 60 * 1000 // 5 minutes

// Module-level map persists across component mounts within same session
const sessionCache = new Map<string, CacheEntry>()

// Module-level in-flight request deduplication:
// If two components request the same ticker simultaneously, they share a single promise.
// Eliminates duplicate network calls when opening the same ticker twice in quick succession.
const inflightRequests = new Map<string, Promise<ResearchCacheRow | null>>()

export function useResearchCache() {
  const cacheRef = useRef(sessionCache)
  const inflightRef = useRef(inflightRequests)

  const get = useCallback((ticker: string): ResearchCacheRow | null => {
    const entry = cacheRef.current.get(ticker)
    if (!entry) return null

    const ageMs = Date.now() - entry.fetchedAt
    if (ageMs > TTL_MS) {
      // Expired; remove and treat as cache miss
      cacheRef.current.delete(ticker)
      return null
    }

    return entry.data
  }, [])

  const set = useCallback((ticker: string, data: ResearchCacheRow) => {
    cacheRef.current.set(ticker, {
      data,
      fetchedAt: Date.now(),
    })
  }, [])

  const clear = useCallback((ticker?: string) => {
    if (ticker) {
      cacheRef.current.delete(ticker)
      inflightRef.current.delete(ticker)
    } else {
      cacheRef.current.clear()
      inflightRef.current.clear()
    }
  }, [])

  // Fetch research with request deduplication:
  // If the same ticker is requested twice simultaneously, both calls share a single promise
  const fetch = useCallback(async (ticker: string): Promise<ResearchCacheRow | null> => {
    // Check in-memory session cache first
    const cached = get(ticker)
    if (cached) return cached

    // Check if request is already in-flight
    if (inflightRef.current.has(ticker)) {
      return inflightRef.current.get(ticker)!
    }

    // Start new request
    const promise = supabase.functions.invoke('fetch-research', {
      body: { ticker },
    })
      .then(({ data, error }) => {
        if (error) {
          console.error(`[useResearchCache] fetch error for ${ticker}:`, error)
          throw error
        }
        const researchData = data?.research
        if (researchData) {
          set(ticker, researchData)
        }
        return researchData || null
      })
      .finally(() => {
        inflightRef.current.delete(ticker)
      })

    inflightRef.current.set(ticker, promise)
    return promise
  }, [get, set])

  return { get, set, clear, fetch }
}

// Why a frontend in-memory cache *complements* (not replaces) server-side cache:
//
// SERVER-SIDE CACHE (24h TTL, ticker_research_cache table):
//   Purpose: Amortize expensive external API costs (Finnhub, Yahoo, Anthropic) across all users
//   Scale: Persistent across user sessions, browser instances, devices
//   Cost: Storage, CPU to manage expiry, API cost if missed
//   Trade-off: 24h is relatively stale for an active trader checking intraday news
//
// FRONTEND SESSION CACHE (5m TTL, in-memory Map):
//   Purpose: Eliminate redundant fetches when *one user* flips back/forth between tickers
//   Scale: Only for current browser tab, cleared on page reload
//   Cost: Zero (just RAM in a single tab)
//   Trade-off: Misses on new browser instance, doesn't help other users
//
// USE CASE: Yossi opens Portfolio → clicks AAPL → reads 2 min → clicks META → reads 3 min → clicks AAPL again
//   → First AAPL: server cache hit (or fetch + cache for 24h)
//   → META: server cache hit (or fetch)
//   → Second AAPL: frontend cache hit! No network call. Instant. Smooth UX.
//
// Without frontend cache:
//   → Second AAPL: fetch from server again (even though 5 min old)
//   → Network roundtrip, spinner, latency feels worse
//
// Why not just rely on server cache for everything?
//   1. Latency: Even a cache hit requires a network roundtrip (50-200ms). Frontend cache is <1ms.
//   2. Redundant cost: If user flips back/forth 10 times, server sees 10 identical requests.
//   3. Real-time feel: Fast response = perceived correctness, even if data is 5 min old.
//
// Why 5 minutes and not longer?
//   → Balances "user won't refresh page in 5 min" with "prices/news do move intraday"
//   → If AI summary or RSI is crucial, user can hit refresh or wait for next browser session
//
// What if server cache expires before frontend cache?
//   → Frontend still has stale data, but that's fine:
//   → User can manually refresh (button in UI)
//   → Next browser session resets frontend cache, server cache is fresh
//   → Not a problem in practice; server TTL (24h) >> frontend TTL (5m)
