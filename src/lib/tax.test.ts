/**
 * Unit tests for estimateTaxIL
 * These examples show expected inputs and outputs for reference.
 * Run with a test runner (e.g., Vitest, Jest) once set up.
 */

import { estimateTaxIL, type Grant, type FxRates } from './tax'

/**
 * Case 1: USD grant, $100 strike, $150 current
 * 10 shares × $100 = $1,000 income
 * 10 shares × ($150 - $100) = $500 capital gain
 * Tax: $500 (on income) + $150 (on cap gain) = $650
 * Gross: $1,500 | Net: $850
 */
{
  const grant: Grant = { quantity: 10, grant_price: 100, grant_currency: 'USD' }
  const currentPrice = 150
  const fx: FxRates = { USD_NIS: 3.75 }

  const result = estimateTaxIL(grant, currentPrice, fx)

  // In USD
  console.assert(result.incomePortion === 1000, 'Case 1: income portion')
  console.assert(result.capGainPortion === 500, 'Case 1: cap gain portion')
  console.assert(result.taxOnIncome === 500, 'Case 1: tax on income')
  console.assert(result.taxOnCapGain === 150, 'Case 1: tax on cap gain')
  console.assert(result.estimatedTax === 650, 'Case 1: total tax')
  console.assert(result.grossValue_USD === 1500, 'Case 1: gross value USD')
  console.assert(result.netValue_USD === 850, 'Case 1: net value USD')

  // In NIS (multiply by 3.75)
  console.assert(result.grossValue_NIS === 5625, 'Case 1: gross value NIS')
  console.assert(result.estimatedTax_NIS === 2437.5, 'Case 1: tax NIS')
  console.assert(result.netValue_NIS === 3187.5, 'Case 1: net value NIS')
}

/**
 * Case 2: NIS grant, ₪500 strike, ₪700 current
 * 5 shares × ₪500 = ₪2,500 income
 * 5 shares × (₪700 - ₪500) = ₪1,000 capital gain
 * Tax: ₪1,250 (on income) + ₪300 (on cap gain) = ₪1,550
 * Gross: ₪3,500 | Net: ₪1,950
 */
{
  const grant: Grant = { quantity: 5, grant_price: 500, grant_currency: 'NIS' }
  const currentPrice = 700
  const fx: FxRates = { USD_NIS: 3.75 }

  const result = estimateTaxIL(grant, currentPrice, fx)

  // In NIS
  console.assert(result.incomePortion === 2500, 'Case 2: income portion NIS')
  console.assert(result.capGainPortion === 1000, 'Case 2: cap gain portion NIS')
  console.assert(result.estimatedTax === 1550, 'Case 2: tax NIS')
  console.assert(result.netValue === 1950, 'Case 2: net value NIS')

  // In USD (divide by 3.75)
  console.assert(
    Math.abs(result.grossValue_USD - 3500 / 3.75) < 0.01,
    'Case 2: gross value USD'
  )
  console.assert(
    Math.abs(result.estimatedTax_USD - 1550 / 3.75) < 0.01,
    'Case 2: tax USD'
  )
}

/**
 * Case 3: USD grant, strike < current with capital loss (no cap gain tax)
 * 20 shares × $50 = $1,000 income
 * 20 shares × ($45 - $50) = -$100 (capped at 0, no capital loss)
 * Tax: $500 (on income only)
 * Gross: $900 | Net: $400
 */
{
  const grant: Grant = { quantity: 20, grant_price: 50, grant_currency: 'USD' }
  const currentPrice = 45
  const fx: FxRates = { USD_NIS: 3.75 }

  const result = estimateTaxIL(grant, currentPrice, fx)

  console.assert(result.incomePortion === 1000, 'Case 3: income portion')
  console.assert(result.capGainPortion === 0, 'Case 3: no capital loss recognized')
  console.assert(result.taxOnCapGain === 0, 'Case 3: no tax on negative cap gain')
  console.assert(result.estimatedTax === 500, 'Case 3: tax on income only')
  console.assert(result.grossValue_USD === 900, 'Case 3: gross value')
  console.assert(result.netValue_USD === 400, 'Case 3: net value')
}

/**
 * Case 4: Large grant with multi-currency conversion
 * 100 shares × $150 = $15,000 income
 * 100 shares × ($200 - $150) = $5,000 capital gain
 * Tax: $7,500 + $1,500 = $9,000
 * Gross: $20,000 | Net: $11,000
 * Convert to NIS at 3.75, EUR at 1.10
 */
{
  const grant: Grant = { quantity: 100, grant_price: 150, grant_currency: 'USD' }
  const currentPrice = 200
  const fx: FxRates = { USD_NIS: 3.75, USD_EUR: 1.1 }

  const result = estimateTaxIL(grant, currentPrice, fx)

  console.assert(result.estimatedTax === 9000, 'Case 4: tax USD')
  console.assert(
    Math.abs(result.estimatedTax_NIS - 33750) < 0.01,
    'Case 4: tax NIS'
  )
  // EUR rate: USD to EUR is 1/1.1 ≈ 0.909
  console.assert(
    Math.abs(result.estimatedTax - 9000) < 0.01,
    'Case 4: consistency check'
  )
}

console.log('✓ All tax estimation test cases passed')
