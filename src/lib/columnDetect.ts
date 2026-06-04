export type FieldKey = 'name' | 'ticker' | 'quantity' | 'currency' | 'buy_price' | 'category'

export const ALL_FIELDS: FieldKey[] = [
  'name',
  'ticker',
  'quantity',
  'currency',
  'buy_price',
  'category',
]

export const FIELD_LABELS: Record<FieldKey, string> = {
  name: 'Name',
  ticker: 'Ticker',
  quantity: 'Quantity',
  currency: 'Currency',
  buy_price: 'Buy Price',
  category: 'Category',
}

const ALIASES: Record<FieldKey, string[]> = {
  name:      ['name', 'company', 'stock'],
  ticker:    ['ticker', 'symbol'],
  quantity:  ['qty', 'quantity', 'shares', 'units'],
  currency:  ['currency', 'ccy'],
  buy_price: ['buy', 'cost', 'purchase', 'buyprice', 'buy price'],
  category:  ['category', 'sector', 'comments'],
}

export function detectColumns(headers: string[]): Record<FieldKey, number> {
  const normalized = headers.map(h => h.toLowerCase().trim())
  return Object.fromEntries(
    ALL_FIELDS.map(field => [
      field,
      normalized.findIndex(h => ALIASES[field].includes(h)),
    ])
  ) as Record<FieldKey, number>
}
