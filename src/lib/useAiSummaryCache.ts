import { useCallback, useRef } from 'react'
import { supabase } from './supabase'

interface AiSummaryEntry {
  summary: string
  summary_at: string
  cached: boolean
  fetchedAt: number
}

const TTL_MS = 5 * 60 * 1000 // 5 minutes

// Module-level maps for session persistence across component mounts
const sessionCache = new Map<string, AiSummaryEntry>()
const inflightRequests = new Map<string, Promise<AiSummaryEntry | null>>()

export function useAiSummaryCache() {
  const cacheRef = useRef(sessionCache)
  const inflightRef = useRef(inflightRequests)

  const get = useCallback(
    (ticker: string, language: string): AiSummaryEntry | null => {
      const key = `${ticker}:${language}`
      const entry = cacheRef.current.get(key)
      if (!entry) return null

      const ageMs = Date.now() - entry.fetchedAt
      if (ageMs > TTL_MS) {
        cacheRef.current.delete(key)
        return null
      }

      return entry
    },
    []
  )

  const set = useCallback((ticker: string, language: string, data: AiSummaryEntry) => {
    const key = `${ticker}:${language}`
    cacheRef.current.set(key, { ...data, fetchedAt: Date.now() })
  }, [])

  const clear = useCallback((ticker?: string, language?: string) => {
    if (ticker && language) {
      const key = `${ticker}:${language}`
      cacheRef.current.delete(key)
      inflightRef.current.delete(key)
    } else {
      cacheRef.current.clear()
      inflightRef.current.clear()
    }
  }, [])

  // Fetch AI summary with request deduplication
  const fetch = useCallback(
    async (ticker: string, language: string): Promise<AiSummaryEntry | null> => {
      const key = `${ticker}:${language}`

      // Check in-memory session cache first
      const cached = get(ticker, language)
      if (cached) return cached

      // Check if request is already in-flight
      if (inflightRef.current.has(key)) {
        return inflightRef.current.get(key)!
      }

      // Start new request
      const promise = supabase.functions
        .invoke('fetch-ai-summary', {
          body: { ticker, language },
        })
        .then(({ data, error }) => {
          if (error) {
            console.error(`[useAiSummaryCache] fetch error for ${key}:`, error)
            throw error
          }
          const summaryEntry: AiSummaryEntry = {
            summary: data?.summary ?? '',
            summary_at: data?.summary_at ?? '',
            cached: data?.cached ?? false,
            fetchedAt: Date.now(),
          }
          if (summaryEntry.summary) {
            set(ticker, language, summaryEntry)
          }
          return summaryEntry || null
        })
        .finally(() => {
          inflightRef.current.delete(key)
        })

      inflightRef.current.set(key, promise)
      return promise
    },
    [get, set]
  )

  return { get, set, clear, fetch }
}
