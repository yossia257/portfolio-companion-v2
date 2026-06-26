import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

export function useTickerHistory(tickers: string[]) {
  const [histories, setHistories] = useState<Record<string, number[]>>({})
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!tickers.length) {
      setHistories({})
      return
    }

    setLoading(true)
    supabase.functions
      .invoke('fetch-ticker-history', { body: { tickers } })
      .then(({ data }) => {
        if (data?.histories) {
          setHistories(data.histories)
        }
      })
      .catch((err) => {
        console.error('[useTickerHistory] fetch failed:', err)
      })
      .finally(() => setLoading(false))
  }, [tickers.join(',')])

  return { histories, loading }
}
