import { supabase } from './supabase'

export type PriceMap = Record<string, { price: number; daily_change_pct: number }>

export async function refreshPrices(tickers: string[]): Promise<PriceMap> {
  const { data, error } = await supabase.functions.invoke('refresh-prices', {
    body: { tickers },
  })
  if (error) throw error
  return (data?.prices ?? {}) as PriceMap
}

export async function fetchUsdToNis(): Promise<number> {
  const res = await fetch('https://open.er-api.com/v6/latest/USD')
  if (!res.ok) throw new Error(`FX API HTTP ${res.status}`)
  const data = await res.json()
  const rate = data?.rates?.ILS
  if (typeof rate !== 'number') throw new Error('ILS rate missing from FX response')
  return rate
}
