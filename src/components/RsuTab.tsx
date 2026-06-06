import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { estimateTaxIL } from '../lib/tax'
import { useUserProfile } from '../lib/useUserProfile'
import DrillDownPanel from './DrillDownPanel'
import type { PriceMap, PriceEntry, ErrorEntry } from '../lib/prices'
import type { Holding } from '../pages/MainPage'

// ── Types ──────────────────────────────────────────────────────────────────

interface RsuGrant {
  id: string
  user_id: string
  ticker: string
  company_name: string | null
  grant_date: string // ISO date
  vest_date: string // ISO date
  quantity: number
  grant_price: number
  grant_currency: 'USD' | 'NIS' | 'EUR' | 'GBP'
  tax_jurisdiction: 'IL' | 'US' | 'OTHER'
  notes: string | null
  created_at: string
}

interface RsuGrantForm {
  ticker: string
  company_name: string
  grant_date: string
  vest_date: string
  quantity: number
  grant_price: number
  grant_currency: 'USD' | 'NIS' | 'EUR' | 'GBP'
  tax_jurisdiction: 'IL' | 'US' | 'OTHER'
  notes: string
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDate(isoString: string): string {
  const d = new Date(isoString)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatCurrency(value: number, currency: string): string {
  const symbol = currency === 'USD' ? '$' : currency === 'NIS' ? '₪' : currency
  return `${symbol}${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function daysUntil(isoString: string): number {
  const vestDate = new Date(isoString)
  const today = new Date()
  const ms = vestDate.getTime() - today.getTime()
  return Math.ceil(ms / (1000 * 60 * 60 * 24))
}

function getVestStatus(isoString: string): 'vested' | 'soon' | 'future' {
  const days = daysUntil(isoString)
  if (days < 0) return 'vested'
  if (days <= 90) return 'soon'
  return 'future'
}

const emptyForm: RsuGrantForm = {
  ticker: '',
  company_name: '',
  grant_date: new Date().toISOString().split('T')[0],
  vest_date: new Date().toISOString().split('T')[0],
  quantity: 0,
  grant_price: 0,
  grant_currency: 'USD',
  tax_jurisdiction: 'IL',
  notes: '',
}

// ── Component ──────────────────────────────────────────────────────────────

interface RsuTabProps {
  prices?: PriceMap
  onFetchPrices?: (tickers: string[]) => Promise<void>
}

export default function RsuTab({ prices = {}, onFetchPrices }: RsuTabProps) {
  const { profile } = useUserProfile()
  // ── Data state ──
  const [grants, setGrants] = useState<RsuGrant[]>([])
  const [loading, setLoading] = useState(true)
  const [userId, setUserId] = useState<string | null>(null)
  const [fxRates, setFxRates] = useState<{ USD_NIS: number; [key: string]: number }>({ USD_NIS: 3.75 })

  // ── Modal state ──
  // Modal pattern: editingGrant = null → Add mode; editingGrant = grant → Edit mode
  const [modalOpen, setModalOpen] = useState(false)
  const [editingGrant, setEditingGrant] = useState<RsuGrant | null>(null)
  const [formData, setFormData] = useState<RsuGrantForm>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [formSaving, setFormSaving] = useState(false)

  // ── Delete confirmation ──
  const [deleteGrant, setDeleteGrant] = useState<RsuGrant | null>(null)

  // ── Expanded rows ──
  const [expandedGrantId, setExpandedGrantId] = useState<string | null>(null)

  // ── DrillDownPanel ──
  const [selectedGrant, setSelectedGrant] = useState<RsuGrant | null>(null)

  // ── Fetch user + grants on mount ──
  useEffect(() => {
    async function init() {
      setLoading(true)
      const { data: sessionData } = await supabase.auth.getSession()
      if (sessionData?.session?.user) {
        setUserId(sessionData.session.user.id)
        await fetchGrants(sessionData.session.user.id)
      }
      setLoading(false)

      // Fetch FX rates
      try {
        const res = await fetch('https://open.er-api.com/v6/latest/USD')
        const data = await res.json()
        if (data.rates) {
          setFxRates({
            USD_NIS: data.rates.ILS ?? 3.75,
            USD_EUR: data.rates.EUR,
            USD_GBP: data.rates.GBP,
          })
        }
      } catch (e) {
        console.error('FX fetch failed:', e)
      }
    }
    init()
  }, [])

  // ── Fetch prices for RSU tickers when grants load ──
  useEffect(() => {
    if (grants.length === 0 || !onFetchPrices) return

    // Collect tickers from grants that aren't in prices cache
    const missingTickers = grants
      .map((g) => g.ticker)
      .filter((ticker) => !prices[ticker])

    if (missingTickers.length === 0) return

    console.log('Fetching missing prices for:', missingTickers)
    onFetchPrices(missingTickers)
  }, [grants, prices, onFetchPrices])

  async function fetchGrants(uid: string) {
    const { data, error } = await supabase
      .from('rsu_grants')
      .select('*')
      .eq('user_id', uid)
      .is('deleted_at', null) // Only fetch non-deleted grants
      .order('vest_date', { ascending: false })

    if (error) {
      console.error('Fetch grants error:', error)
      return
    }

    setGrants(data ?? [])
  }

  // ── Modal handlers ──
  function openAddModal() {
    setEditingGrant(null)
    setFormData(emptyForm)
    setFormError(null)
    setModalOpen(true)
  }

  function openEditModal(grant: RsuGrant) {
    setEditingGrant(grant)
    setFormData({
      ticker: grant.ticker,
      company_name: grant.company_name ?? '',
      grant_date: grant.grant_date,
      vest_date: grant.vest_date,
      quantity: grant.quantity,
      grant_price: grant.grant_price,
      grant_currency: grant.grant_currency,
      tax_jurisdiction: grant.tax_jurisdiction,
      notes: grant.notes ?? '',
    })
    setFormError(null)
    setModalOpen(true)
  }

  function closeModal() {
    setModalOpen(false)
    setEditingGrant(null)
    setFormData(emptyForm)
    setFormError(null)
  }

  async function handleSaveGrant() {
    // Validate with detailed messages
    const errors: string[] = []
    if (!formData.ticker) errors.push('Ticker')
    if (!formData.grant_date) errors.push('Grant Date')
    if (!formData.vest_date) errors.push('Vest Date')
    if (formData.quantity <= 0) errors.push('Quantity (must be > 0)')
    if (formData.grant_price < 0) errors.push('Grant Price (cannot be negative)')

    if (errors.length > 0) {
      setFormError(`Missing or invalid: ${errors.join(', ')}`)
      console.error('Form validation failed:', { formData, errors })
      return
    }

    setFormSaving(true)
    try {
      if (editingGrant) {
        // UPDATE
        const { error } = await supabase
          .from('rsu_grants')
          .update({
            ticker: formData.ticker,
            company_name: formData.company_name || null,
            grant_date: formData.grant_date,
            vest_date: formData.vest_date,
            quantity: formData.quantity,
            grant_price: formData.grant_price,
            grant_currency: formData.grant_currency,
            tax_jurisdiction: formData.tax_jurisdiction,
            notes: formData.notes || null,
          })
          .eq('id', editingGrant.id)

        if (error) {
          setFormError(error.message)
          return
        }
      } else {
        // INSERT
        if (!userId) {
          setFormError('User not authenticated')
          return
        }

        const { error } = await supabase.from('rsu_grants').insert([
          {
            user_id: userId,
            ticker: formData.ticker,
            company_name: formData.company_name || null,
            grant_date: formData.grant_date,
            vest_date: formData.vest_date,
            quantity: formData.quantity,
            grant_price: formData.grant_price,
            grant_currency: formData.grant_currency,
            tax_jurisdiction: formData.tax_jurisdiction,
            notes: formData.notes || null,
          },
        ])

        if (error) {
          setFormError(error.message)
          return
        }
      }

      // Success: close and refresh
      closeModal()
      if (userId) await fetchGrants(userId)
    } finally {
      setFormSaving(false)
    }
  }

  async function handleDeleteGrant(grant: RsuGrant) {
    try {
      console.log('Attempting to delete grant:', grant.id)

      const { error, data } = await supabase
        .from('rsu_grants')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', grant.id)
        .select()

      console.log('Delete response:', { error, data })

      if (error) {
        console.error('Delete error:', error)
        alert(`Delete failed: ${error.message}`)
        return
      }

      console.log('Delete succeeded, refreshing grants')
      setDeleteGrant(null)
      if (userId) {
        await fetchGrants(userId)
      }
    } catch (e) {
      console.error('Delete exception:', e)
      alert(`Delete failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
  }

  // ── KPI Calculations ──
  const displayCcy = profile?.display_currency ?? 'NIS'
  const unvestGrants = grants.filter((g) => daysUntil(g.vest_date) >= 0)
  const vestedGrants = grants.filter((g) => daysUntil(g.vest_date) < 0)

  // Total vested gross value: sum of (qty × current_price) for all vested grants
  const totalVestedGross = vestedGrants.reduce(
    (acc, g) => {
      const currentPrice = (prices[g.ticker] as any)?.price ?? g.grant_price
      const grossUSD = g.quantity * currentPrice
      const grossNIS = grossUSD * (fxRates.USD_NIS || 3.75)
      return {
        display: acc.display + grossNIS,
        original: acc.original + grossUSD,
      }
    },
    { display: 0, original: 0 }
  )

  // Total vested net value: sum of (qty × current_price - tax) for all vested grants
  const totalVestedNet = vestedGrants.reduce(
    (acc, g) => {
      const currentPrice = (prices[g.ticker] as any)?.price ?? g.grant_price
      const tax = estimateTaxIL(
        { quantity: g.quantity, grant_price: g.grant_price, grant_currency: g.grant_currency },
        currentPrice,
        fxRates
      )
      // net = current value - tax paid at vest
      const grossUSD = g.quantity * currentPrice
      const taxUSD = tax.estimatedTax
      const netUSD = grossUSD - taxUSD
      const netNIS = netUSD * (fxRates.USD_NIS || 3.75)
      return {
        display: acc.display + netNIS,
        original: acc.original + netUSD,
      }
    },
    { display: 0, original: 0 }
  )

  // Total unvested net value: sum of (qty × current_price - tax) for all unvested grants
  const totalUnvestedNet = unvestGrants.reduce(
    (acc, g) => {
      const currentPrice = (prices[g.ticker] as any)?.price ?? g.grant_price
      const tax = estimateTaxIL(
        { quantity: g.quantity, grant_price: g.grant_price, grant_currency: g.grant_currency },
        currentPrice,
        fxRates
      )
      // net = gross - tax (already calculated in tax estimate)
      return {
        display: acc.display + (tax.grossValue_NIS - tax.taxOnIncome_NIS - tax.taxOnCapGain_NIS),
        original: acc.original + (tax.grossValue - tax.taxOnIncome - tax.taxOnCapGain),
      }
    },
    { display: 0, original: 0 }
  )

  const ccySymbol = displayCcy === 'NIS' ? '₪' : displayCcy === 'USD' ? '$' : displayCcy

  if (loading) {
    return (
      <div className="px-6 py-8 max-w-7xl w-full mx-auto">
        <div className="flex items-center justify-center h-64 text-gray-500">Loading RSU data…</div>
      </div>
    )
  }

  return (
    <div className="px-6 py-8 max-w-7xl w-full mx-auto">
      {/* Disclaimer */}
      <div className="mb-6 p-3 rounded-lg bg-blue-900/20 border border-blue-700/30 text-xs text-blue-300">
        💡 Values shown in your display currency ({ccySymbol}) using current FX rate. Tax estimates use simplified IL rules (50% income / 30% cap gain). Not tax advice. Consult your accountant.
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        {/* Total Vested Gross */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Total Vested (Gross)</p>
          <p className="text-xl font-bold">
            {ccySymbol}
            {totalVestedGross.display.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </p>
          <p className="text-xs text-gray-500 mt-2">≈ ${totalVestedGross.original.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
          <p className="text-xs text-gray-600 mt-1">All grants that have vested</p>
        </div>

        {/* Total Vested Net */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Total Vested (Net)</p>
          <p className="text-xl font-bold text-green-300">
            {ccySymbol}
            {totalVestedNet.display.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </p>
          <p className="text-xs text-gray-500 mt-2">≈ ${totalVestedNet.original.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
          <p className="text-xs text-gray-600 mt-1">After taxes on vested grants</p>
        </div>

        {/* Total Unvested Net */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Total Unvested (Net)</p>
          <p className="text-xl font-bold text-amber-300">
            {ccySymbol}
            {totalUnvestedNet.display.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </p>
          <p className="text-xs text-gray-500 mt-2">≈ ${totalUnvestedNet.original.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
          <p className="text-xs text-gray-600 mt-1">At current price, after taxes</p>
        </div>
      </div>

      {/* Add Grant Button */}
      <div className="flex justify-end mb-6">
        <button
          onClick={openAddModal}
          className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 transition-colors"
        >
          + Add Grant
        </button>
      </div>

      {/* Grants Table */}
      {grants.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p className="mb-4">No RSU grants yet. Start tracking your equity grants.</p>
          <button
            onClick={openAddModal}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 transition-colors"
          >
            Add First Grant
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Ticker</th>
                <th className="px-4 py-3 text-left font-medium">Grant Date</th>
                <th className="px-4 py-3 text-left font-medium">Vest Date</th>
                <th className="px-4 py-3 text-right font-medium">Qty</th>
                <th className="px-4 py-3 text-right font-medium">Grant Price</th>
                <th className="px-4 py-3 text-right font-medium">Current Price</th>
                <th className="px-4 py-3 text-right font-medium">Gross Value</th>
                <th className="px-4 py-3 text-right font-medium">Est Tax</th>
                <th className="px-4 py-3 text-right font-medium">Net Value</th>
                <th className="px-4 py-3 text-right font-medium">Days to Vest</th>
                <th className="px-4 py-3 text-center font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {grants.map((grant, i) => {
                const currentPrice = (prices[grant.ticker] as any)?.price ?? grant.grant_price
                const grossValue = grant.quantity * currentPrice
                const taxEst = estimateTaxIL(
                  {
                    quantity: grant.quantity,
                    grant_price: grant.grant_price,
                    grant_currency: grant.grant_currency,
                  },
                  currentPrice,
                  { USD_NIS: 3.75 }
                )
                const netValue = grossValue - taxEst.estimatedTax
                const daysRemaining = daysUntil(grant.vest_date)
                const status = getVestStatus(grant.vest_date)

                const statusColor =
                  status === 'vested'
                    ? 'bg-gray-900/20 border-l-2 border-gray-700'
                    : status === 'soon'
                      ? 'bg-amber-900/10 border-l-2 border-amber-500'
                      : 'border-l-2 border-gray-800'

                const isExpanded = expandedGrantId === grant.id

                return (
                  <tr key={grant.id} className={`border-t border-gray-800 transition-colors ${statusColor} ${i % 2 === 0 ? '' : 'bg-gray-900/20'}`}>
                    <td
                      className="px-4 py-3 whitespace-nowrap font-mono font-semibold cursor-pointer hover:text-blue-400 transition-colors"
                      onClick={() => setSelectedGrant(grant)}
                    >
                      {grant.ticker}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-gray-300">{formatDate(grant.grant_date)}</td>
                    <td
                      className="px-4 py-3 whitespace-nowrap cursor-pointer hover:text-white transition-colors"
                      onClick={() => setExpandedGrantId(isExpanded ? null : grant.id)}
                    >
                      {formatDate(grant.vest_date)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{grant.quantity}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCurrency(grant.grant_price, grant.grant_currency)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-white">
                      {formatCurrency(currentPrice, grant.grant_currency)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">${grossValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-orange-300">${taxEst.estimatedTax.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium text-green-300">${netValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-400">
                      {daysRemaining < 0 ? 'Vested' : `${daysRemaining}d`}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex gap-2 justify-center">
                        <button
                          onClick={() => openEditModal(grant)}
                          className="text-xs text-gray-400 hover:text-white transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => setDeleteGrant(grant)}
                          className="text-xs text-red-400 hover:text-red-300 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}

              {/* Expanded detail rows */}
              {grants.map((grant) => {
                if (expandedGrantId !== grant.id) return null

                const currentPrice = (prices[grant.ticker] as any)?.price ?? grant.grant_price
                const taxEst = estimateTaxIL(
                  {
                    quantity: grant.quantity,
                    grant_price: grant.grant_price,
                    grant_currency: grant.grant_currency,
                  },
                  currentPrice,
                  { USD_NIS: 3.75 }
                )

                return (
                  <tr key={`${grant.id}-expanded`} className="border-t border-gray-800 bg-gray-900/30">
                    <td colSpan={11} className="px-4 py-4">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-sm">
                        <div>
                          <p className="text-xs text-gray-500 uppercase mb-2">Income Portion</p>
                          <p className="font-semibold">
                            ${taxEst.incomePortion.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </p>
                          <p className="text-xs text-gray-500 mt-1">
                            Taxed at 50% = ${taxEst.taxOnIncome.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-500 uppercase mb-2">Capital Gain Portion</p>
                          <p className="font-semibold">
                            ${taxEst.capGainPortion.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </p>
                          <p className="text-xs text-gray-500 mt-1">
                            Taxed at 30% = ${taxEst.taxOnCapGain.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-500 uppercase mb-2">Notes</p>
                          <p className="text-gray-300">{grant.notes || '—'}</p>
                          {grant.company_name && <p className="text-xs text-gray-500 mt-1">{grant.company_name}</p>}
                        </div>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 12-Month Forecast Panel */}
      {grants.length > 0 && (
        <div className="mt-8 p-4 rounded-lg bg-blue-950/30 border border-blue-800/40">
          <h3 className="text-sm font-semibold mb-2">12-Month Vest Forecast</h3>
          <p className="text-xs text-gray-500 mb-4">
            Forecast assumes current price holds at vest. Actual values will differ based on market movements.
          </p>

          {(() => {
            const today = new Date()
            const in12Months = new Date(today.getTime() + 365 * 24 * 60 * 60 * 1000)

            const upcomingGrants = grants
              .filter((g) => {
                const vestDate = new Date(g.vest_date)
                return vestDate > today && vestDate <= in12Months
              })
              .sort((a, b) => new Date(a.vest_date).getTime() - new Date(b.vest_date).getTime())

            if (upcomingGrants.length === 0) {
              return (
                <p className="text-xs text-gray-500 italic">No vests scheduled in the next 12 months</p>
              )
            }

            const forecastTotal = upcomingGrants.reduce((sum, g) => {
              const currentPrice = (prices[g.ticker] as any)?.price ?? g.grant_price
              const tax = estimateTaxIL(
                { quantity: g.quantity, grant_price: g.grant_price, grant_currency: g.grant_currency },
                currentPrice,
                fxRates
              )
              const grossUSD = g.quantity * currentPrice
              const netUSD = grossUSD - tax.estimatedTax
              const netNIS = netUSD * (fxRates.USD_NIS || 3.75)
              return sum + netNIS
            }, 0)

            return (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-blue-800/40 text-gray-400">
                      <th className="px-3 py-2 text-left font-medium">Vest Date</th>
                      <th className="px-3 py-2 text-left font-medium">Ticker</th>
                      <th className="px-3 py-2 text-right font-medium">Qty</th>
                      <th className="px-3 py-2 text-right font-medium">Est. Net Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {upcomingGrants.map((g) => {
                      const currentPrice = (prices[g.ticker] as any)?.price ?? g.grant_price
                      const tax = estimateTaxIL(
                        { quantity: g.quantity, grant_price: g.grant_price, grant_currency: g.grant_currency },
                        currentPrice,
                        fxRates
                      )
                      const grossUSD = g.quantity * currentPrice
                      const netUSD = grossUSD - tax.estimatedTax
                      const netNIS = netUSD * (fxRates.USD_NIS || 3.75)

                      return (
                        <tr key={g.id} className="border-b border-blue-800/20 text-gray-300">
                          <td className="px-3 py-2 whitespace-nowrap">{formatDate(g.vest_date)}</td>
                          <td className="px-3 py-2 whitespace-nowrap font-mono font-semibold">{g.ticker}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{g.quantity.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-blue-300">
                            {ccySymbol}
                            {netNIS.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-blue-700/40 font-semibold text-gray-200">
                      <td colSpan={3} className="px-3 py-3 text-right">12-Month Total:</td>
                      <td className="px-3 py-3 text-right tabular-nums text-blue-300">
                        {ccySymbol}
                        {forecastTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )
          })()}
        </div>
      )}

      {/* Add/Edit Modal */}
      {modalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-900 rounded-lg border border-gray-800 w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
            <h2 className="text-lg font-semibold mb-4">{editingGrant ? 'Edit Grant' : 'Add RSU Grant'}</h2>

            {formError && <div className="mb-4 p-3 rounded bg-red-900/20 border border-red-700 text-sm text-red-300">{formError}</div>}

            <div className="space-y-4">
              {/* Ticker */}
              <div>
                <label className="block text-xs text-gray-500 uppercase mb-1">Ticker *</label>
                <input
                  type="text"
                  value={formData.ticker}
                  onChange={(e) => setFormData({ ...formData, ticker: e.target.value.toUpperCase() })}
                  placeholder="AAPL"
                  className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* Company Name */}
              <div>
                <label className="block text-xs text-gray-500 uppercase mb-1">Company Name</label>
                <input
                  type="text"
                  value={formData.company_name}
                  onChange={(e) => setFormData({ ...formData, company_name: e.target.value })}
                  placeholder="Apple Inc."
                  className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* Grant Date */}
              <div>
                <label className="block text-xs text-gray-500 uppercase mb-1">Grant Date *</label>
                <input
                  type="date"
                  value={formData.grant_date}
                  onChange={(e) => {
                    setFormData({ ...formData, grant_date: e.target.value })
                    setTimeout(() => e.currentTarget.blur(), 0)
                  }}
                  className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* Vest Date */}
              <div>
                <label className="block text-xs text-gray-500 uppercase mb-1">Vest Date *</label>
                <input
                  type="date"
                  value={formData.vest_date}
                  onChange={(e) => {
                    setFormData({ ...formData, vest_date: e.target.value })
                    setTimeout(() => e.currentTarget.blur(), 0)
                  }}
                  className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* Quantity */}
              <div>
                <label className="block text-xs text-gray-500 uppercase mb-1">Quantity *</label>
                <input
                  type="number"
                  value={formData.quantity}
                  onChange={(e) => setFormData({ ...formData, quantity: Number(e.target.value) })}
                  onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
                  placeholder="100"
                  className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* Grant Price */}
              <div>
                <label className="block text-xs text-gray-500 uppercase mb-1">Grant Price *</label>
                <input
                  type="number"
                  value={formData.grant_price}
                  onChange={(e) => setFormData({ ...formData, grant_price: Number(e.target.value) })}
                  onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
                  placeholder="150.00"
                  step="0.01"
                  min="0"
                  className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* Grant Currency */}
              <div>
                <label className="block text-xs text-gray-500 uppercase mb-1">Currency</label>
                <select
                  value={formData.grant_currency}
                  onChange={(e) => setFormData({ ...formData, grant_currency: e.target.value as any })}
                  className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500 appearance-none"
                >
                  <option value="USD">USD (US Dollar)</option>
                  <option value="NIS">NIS (Israeli Shekel)</option>
                  <option value="EUR">EUR (Euro)</option>
                  <option value="GBP">GBP (British Pound)</option>
                </select>
              </div>

              {/* Tax Jurisdiction */}
              <div>
                <label className="block text-xs text-gray-500 uppercase mb-1">Tax Jurisdiction</label>
                <select
                  value={formData.tax_jurisdiction}
                  onChange={(e) => setFormData({ ...formData, tax_jurisdiction: e.target.value as any })}
                  className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
                >
                  <option value="IL">Israel (IL)</option>
                  <option value="US">USA (US)</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>

              {/* Notes */}
              <div>
                <label className="block text-xs text-gray-500 uppercase mb-1">Notes</label>
                <textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  placeholder="Vesting schedule: 4-year vest, 1-year cliff..."
                  rows={3}
                  className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500 resize-none"
                />
              </div>
            </div>

            {/* Buttons */}
            <div className="flex gap-3 mt-6">
              <button
                onClick={closeModal}
                className="flex-1 px-4 py-2 rounded-lg border border-gray-700 text-gray-300 text-sm hover:border-gray-500 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveGrant}
                disabled={formSaving}
                className="flex-1 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 disabled:opacity-50 transition-colors"
              >
                {formSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteGrant && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-900 rounded-lg border border-gray-800 w-full max-w-sm p-6">
            <h2 className="text-lg font-semibold mb-4">Delete Grant?</h2>
            <p className="text-sm text-gray-400 mb-6">
              Delete "{deleteGrant.ticker}" grant from {formatDate(deleteGrant.grant_date)}? It can be undone for 30 days.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteGrant(null)}
                className="flex-1 px-4 py-2 rounded-lg border border-gray-700 text-gray-300 text-sm hover:border-gray-500 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteGrant && handleDeleteGrant(deleteGrant)}
                className="flex-1 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-500 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DrillDownPanel for selected grant */}
      {selectedGrant && (
        <DrillDownPanel
          holding={{
            id: selectedGrant.id,
            ticker: selectedGrant.ticker,
            name: selectedGrant.company_name,
            quantity: selectedGrant.quantity,
            currency: selectedGrant.grant_currency,
            buy_price: selectedGrant.grant_price,
            category: null,
          }}
          priceEntry={prices[selectedGrant.ticker] as (PriceEntry | ErrorEntry | undefined)}
          rsuContext={{
            quantity: selectedGrant.quantity,
            vestDate: selectedGrant.vest_date,
          }}
          onClose={() => setSelectedGrant(null)}
        />
      )}
    </div>
  )
}
