import { supabase } from './supabase'

export interface HoldingInput {
  ticker: string
  name?: string
  quantity?: number
  currency?: string
  buy_price?: number
  category?: string
}

export async function importPortfolio(holdings: HoldingInput[]): Promise<void> {
  const { error } = await supabase.rpc('import_portfolio', {
    p_holdings: holdings,
  })
  if (error) throw new Error(error.message)
}
