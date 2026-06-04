import { supabase } from './supabase'

export type PriceMap   = Record<string, { price: number; daily_change_pct: number }>
export type MarketData = Record<string, { price: number; daily_change_pct: number }>

export interface PriceResponse {
  prices: PriceMap
  market: MarketData
}

export async function refreshPrices(tickers: string[]): Promise<PriceResponse> {
  const { data, error } = await supabase.functions.invoke('refresh-prices', {
    body: { tickers },
  })
  if (error) throw error
  return {
    prices: (data?.prices ?? {}) as PriceMap,
    market: (data?.market ?? {}) as MarketData,
  }
}

export async function fetchUsdToNis(): Promise<number> {
  const res = await fetch('https://open.er-api.com/v6/latest/USD')
  if (!res.ok) throw new Error(`FX API HTTP ${res.status}`)
  const data = await res.json()
  const rate = data?.rates?.ILS
  if (typeof rate !== 'number') throw new Error('ILS rate missing from FX response')
  return rate
}
