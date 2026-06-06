/**
 * Israeli RSU tax estimation library
 * Based on Chapter 102 rules: 50% tax on income portion, 30% on capital gains
 */

export interface Grant {
  quantity: number
  grant_price: number
  grant_currency: 'USD' | 'NIS' | 'EUR' | 'GBP'
}

export interface FxRates {
  USD_NIS: number
  USD_EUR?: number
  USD_GBP?: number
  [key: string]: number | undefined
}

export interface TaxEstimate {
  // In grant currency
  incomePortion: number
  capGainPortion: number
  taxOnIncome: number
  taxOnCapGain: number
  estimatedTax: number
  grossValue: number
  netValue: number

  // In USD
  incomePortion_USD: number
  capGainPortion_USD: number
  taxOnIncome_USD: number
  taxOnCapGain_USD: number
  estimatedTax_USD: number
  grossValue_USD: number
  netValue_USD: number

  // In NIS
  incomePortion_NIS: number
  capGainPortion_NIS: number
  taxOnIncome_NIS: number
  taxOnCapGain_NIS: number
  estimatedTax_NIS: number
  grossValue_NIS: number
  netValue_NIS: number
}

/**
 * Get exchange rate from one currency to another.
 * All rates are relative to USD (fx object contains USD_NIS, USD_EUR, etc).
 */
function getExchangeRate(fromCcy: string, toCcy: string, fx: FxRates): number {
  if (fromCcy === toCcy) return 1

  const toUSD = getToUSD(fromCcy, fx)
  const fromUSD = getFromUSD(toCcy, fx)

  return toUSD * fromUSD
}

/**
 * Get rate to convert from given currency to USD.
 */
function getToUSD(ccy: string, fx: FxRates): number {
  if (ccy === 'USD') return 1
  const key = `USD_${ccy}`
  const rate = fx[key]
  return rate ? 1 / rate : 1
}

/**
 * Get rate to convert from USD to given currency.
 */
function getFromUSD(ccy: string, fx: FxRates): number {
  if (ccy === 'USD') return 1
  const key = `USD_${ccy}`
  return fx[key] ?? 1
}

/**
 * Estimate Israeli Chapter 102 tax on RSU grant.
 *
 * @param grant - Grant details (qty, price at grant, currency)
 * @param currentPrice - Current price in same currency as grant
 * @param fx - Exchange rates (USD_NIS, USD_EUR, etc)
 * @returns Tax estimate with values in grant currency, USD, and NIS
 */
export function estimateTaxIL(
  grant: Grant,
  currentPrice: number,
  fx: FxRates
): TaxEstimate {
  const { quantity, grant_price, grant_currency } = grant

  // Calculate in grant currency
  const incomePortion = quantity * grant_price
  const capGainPortion = Math.max(0, quantity * (currentPrice - grant_price))
  const taxOnIncome = incomePortion * 0.50
  const taxOnCapGain = capGainPortion * 0.30
  const estimatedTax = taxOnIncome + taxOnCapGain
  const grossValue = quantity * currentPrice
  const netValue = grossValue - estimatedTax

  // Convert to USD
  const rateToUSD = getToUSD(grant_currency, fx)
  const incomePortion_USD = incomePortion * rateToUSD
  const capGainPortion_USD = capGainPortion * rateToUSD
  const taxOnIncome_USD = taxOnIncome * rateToUSD
  const taxOnCapGain_USD = taxOnCapGain * rateToUSD
  const estimatedTax_USD = estimatedTax * rateToUSD
  const grossValue_USD = grossValue * rateToUSD
  const netValue_USD = netValue * rateToUSD

  // Convert to NIS
  const rateToNIS = getExchangeRate(grant_currency, 'NIS', fx)
  const incomePortion_NIS = incomePortion * rateToNIS
  const capGainPortion_NIS = capGainPortion * rateToNIS
  const taxOnIncome_NIS = taxOnIncome * rateToNIS
  const taxOnCapGain_NIS = taxOnCapGain * rateToNIS
  const estimatedTax_NIS = estimatedTax * rateToNIS
  const grossValue_NIS = grossValue * rateToNIS
  const netValue_NIS = netValue * rateToNIS

  return {
    incomePortion,
    capGainPortion,
    taxOnIncome,
    taxOnCapGain,
    estimatedTax,
    grossValue,
    netValue,
    incomePortion_USD,
    capGainPortion_USD,
    taxOnIncome_USD,
    taxOnCapGain_USD,
    estimatedTax_USD,
    grossValue_USD,
    netValue_USD,
    incomePortion_NIS,
    capGainPortion_NIS,
    taxOnIncome_NIS,
    taxOnCapGain_NIS,
    estimatedTax_NIS,
    grossValue_NIS,
    netValue_NIS,
  }
}
