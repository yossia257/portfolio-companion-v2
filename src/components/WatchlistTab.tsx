import { useState, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { supabase } from '../lib/supabase'
import { getDirection, getTextAlign } from '../lib/rtl'
import { useUserProfile } from '../lib/useUserProfile'
import type { PriceMap } from '../lib/prices'
import DrillDownPanel from './DrillDownPanel'
import type { PriceEntry } from '../lib/prices'

interface WatchlistItem {
  id: string
  ticker: string
  note: string | null
  added_from_ai: boolean
  created_at: string
}

interface AIIdea {
  ticker: string
  name: string
  asset_class: string
  rationale: string
  risk: string
  sizing: string
  tax_considerations?: string
}

interface Props {
  prices: PriceMap
  pricesLoading: boolean
  onRefreshPrices?: (tickers: string[]) => Promise<void>
}

export default function WatchlistTab({ prices, pricesLoading, onRefreshPrices }: Props) {
  const { profile } = useUserProfile()
  const userLanguage = profile?.ai_response_language ?? 'en'

  const [formTicker, setFormTicker] = useState('')
  const [formNote, setFormNote] = useState('')
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingNote, setEditingNote] = useState('')

  const [ideas, setIdeas] = useState<AIIdea[]>([])
  const [ideasLoading, setIdeasLoading] = useState(false)
  const [ideasError, setIdeasError] = useState<string | null>(null)
  const [hasHoldings, setHasHoldings] = useState(true)
  const [regenButtonLoading, setRegenButtonLoading] = useState(false)

  // Fetch watchlist items and AI ideas on mount
  useEffect(() => {
    fetchWatchlist()
    fetchAIIdeas()
  }, [])

  // Fetch prices when watchlist changes
  useEffect(() => {
    if (watchlistItems.length > 0 && onRefreshPrices) {
      const tickers = watchlistItems.map((item) => item.ticker)
      onRefreshPrices(tickers)
    }
  }, [watchlistItems, onRefreshPrices])

  async function fetchWatchlist() {
    setLoading(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data, error } = await supabase
        .from('watchlist_items')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })

      if (error) {
        console.error('Error fetching watchlist:', error)
        return
      }

      setWatchlistItems(data ?? [])

      // Check if user has holdings
      const { data: portfolioData } = await supabase
        .from('portfolios')
        .select('id')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .maybeSingle()

      if (portfolioData) {
        const { data: holdingsData } = await supabase
          .from('holdings')
          .select('id')
          .eq('portfolio_id', portfolioData.id)
          .is('deleted_at', null)

        setHasHoldings((holdingsData?.length ?? 0) > 0)
      } else {
        setHasHoldings(false)
      }
    } finally {
      setLoading(false)
    }
  }

  async function fetchAIIdeas(force = false) {
    if (!hasHoldings) {
      setIdeas([])
      return
    }

    setIdeasLoading(true)
    setIdeasError(null)
    try {
      const body = force ? { force: true } : {}
      const { data, error } = await supabase.functions.invoke('generate-watchlist-ideas', {
        body,
      })

      if (error) throw error

      setIdeas(data?.ideas ?? [])
    } catch (e) {
      console.error('Error fetching AI ideas:', e)
      setIdeasError(e instanceof Error ? e.message : 'Failed to load AI ideas')
    } finally {
      setIdeasLoading(false)
    }
  }

  async function handleAddIdeaToWatchlist(idea: AIIdea) {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { error } = await supabase
        .from('watchlist_items')
        .insert({
          user_id: user.id,
          ticker: idea.ticker.toUpperCase(),
          note: null,
          added_from_ai: true,
        })

      if (error) {
        if (error.code === '23505') {
          showToast('Already in your watchlist', 'amber')
        } else {
          console.error('Error adding idea to watchlist:', error)
          showToast('Failed to add to watchlist', 'amber')
        }
        return
      }

      showToast(`Added ${idea.ticker} ✓`, 'green')
      await fetchWatchlist()
      if (onRefreshPrices) {
        await onRefreshPrices([idea.ticker])
      }
    } catch (e) {
      console.error('Error:', e)
    }
  }

  async function handleAddTicker() {
    if (!formTicker.trim()) return

    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { error } = await supabase
        .from('watchlist_items')
        .insert({
          user_id: user.id,
          ticker: formTicker.toUpperCase(),
          note: formNote || null,
          added_from_ai: false,
        })

      if (error) {
        if (error.code === '23505') { // Unique constraint violation
          showToast('Already in your watchlist', 'amber')
        } else {
          console.error('Error adding to watchlist:', error)
        }
        return
      }

      setFormTicker('')
      setFormNote('')
      showToast(`Added ✓`, 'green')
      await fetchWatchlist()
    } catch (e) {
      console.error('Error:', e)
    }
  }

  const deleteTimerRef = useRef<{ [id: string]: NodeJS.Timeout }>({})

  async function handleDeleteItem(id: string) {
    const item = watchlistItems.find((i) => i.id === id)
    if (!item) return

    // Optimistically remove from local state
    const backup = watchlistItems
    setWatchlistItems(watchlistItems.filter((i) => i.id !== id))

    // Show toast with undo action
    toast(`Removed ${item.ticker}`, {
      action: {
        label: 'Undo',
        onClick: () => {
          // Cancel the pending delete
          if (deleteTimerRef.current[id]) {
            clearTimeout(deleteTimerRef.current[id])
            delete deleteTimerRef.current[id]
          }
          // Restore the item
          setWatchlistItems(backup)
        },
      },
      duration: 8000,
    })

    // Set timer for actual deletion
    deleteTimerRef.current[id] = setTimeout(async () => {
      try {
        const { error } = await supabase
          .from('watchlist_items')
          .delete()
          .eq('id', id)

        if (error) {
          console.error('Error deleting from watchlist:', error)
          // Restore on failure
          setWatchlistItems(backup)
        }
      } catch (e) {
        console.error('Error:', e)
        setWatchlistItems(backup)
      } finally {
        delete deleteTimerRef.current[id]
      }
    }, 8000)
  }

  async function handleSaveNote(id: string, newNote: string) {
    try {
      const { error } = await supabase
        .from('watchlist_items')
        .update({ note: newNote || null })
        .eq('id', id)

      if (error) {
        console.error('Error updating note:', error)
        return
      }

      setEditingId(null)
      await fetchWatchlist()
      showToast('Saved ✓', 'green')
    } catch (e) {
      console.error('Error:', e)
    }
  }

  function showToast(message: string, color: 'green' | 'amber') {
    const toastDiv = document.createElement('div')
    const bgColor = color === 'green' ? 'bg-green-600/20 border-green-600/50 text-green-300' : 'bg-amber-600/20 border-amber-600/50 text-amber-300'
    toastDiv.className = `fixed bottom-4 right-4 px-4 py-2 rounded-lg ${bgColor} border text-sm animate-fade-out`
    toastDiv.textContent = message
    document.body.appendChild(toastDiv)
    setTimeout(() => toastDiv.remove(), 2000)
  }

  function formatRelativeTime(dateString: string): string {
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffDays === 0) {
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
      if (diffHours === 0) {
        const diffMins = Math.floor(diffMs / (1000 * 60))
        return diffMins <= 1 ? 'just now' : `${diffMins}m ago`
      }
      return diffHours === 1 ? '1 hour ago' : `${diffHours}h ago`
    }
    return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`
  }

  return (
    <>
      <div className="px-6 py-8 max-w-7xl w-full mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-xl font-semibold text-white mb-4">Watchlist — ideas you're tracking</h1>
          <p className="text-sm text-gray-400">Add tickers manually or accept AI suggestions below. Click any ticker for full research.</p>
        </div>

        {/* Add Ticker Form */}
        <div className="mb-8 bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-6">
          <h2 className="text-lg font-semibold text-gray-200 mb-4">Add Ticker</h2>
          <div className="flex flex-col gap-3 sm:flex-row sm:gap-4 sm:items-end">
            <input
              type="text"
              value={formTicker}
              onChange={(e) => setFormTicker(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddTicker()
              }}
              placeholder="Ticker"
              maxLength={12}
              className="w-full sm:w-32 px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
            />
            <div className="w-full sm:flex-1">
              <input
                type="text"
                value={formNote}
                onChange={(e) => setFormNote(e.target.value.slice(0, 280))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddTicker()
                }}
                placeholder="Why watching? (optional)"
                maxLength={280}
                className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
              />
              <p className="text-xs text-gray-600 mt-1">{formNote.length}/280</p>
            </div>
            <button
              onClick={handleAddTicker}
              disabled={!formTicker.trim()}
              className="w-full sm:w-auto px-6 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-500 transition-colors disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>

        {/* Watchlist Table */}
        {loading ? (
          <div className="text-center py-16 text-gray-500">Loading watchlist…</div>
        ) : watchlistItems.length === 0 ? (
          <div className="text-center py-16 text-gray-500">
            <p className="text-lg">Your watchlist is empty.</p>
            <p className="text-sm">Add a ticker above, or scroll down for AI suggestions (coming soon).</p>
          </div>
        ) : (
          <div className="overflow-x-auto border border-gray-800 rounded-xl">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Ticker</th>
                  <th className="px-4 py-3 text-right font-medium">Current Price</th>
                  <th className="px-4 py-3 text-right font-medium">Daily %</th>
                  <th className="px-4 py-3 text-left font-medium">Note</th>
                  <th className="px-4 py-3 text-left font-medium">Added</th>
                  <th className="px-4 py-3 text-left font-medium">Source</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {watchlistItems.map((item) => {
                  const entry = prices[item.ticker]
                  const hasPrice = entry && !('error' in entry)
                  const priceData = hasPrice ? (entry as PriceEntry) : null

                  return (
                    <tr
                      key={item.id}
                      className="border-t border-gray-800 hover:bg-gray-900/50 transition-colors"
                    >
                      {/* Ticker */}
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setSelectedTicker(item.ticker)}
                          className="font-mono font-semibold text-white cursor-pointer hover:underline underline-offset-2 decoration-gray-500"
                        >
                          {item.ticker}
                        </button>
                      </td>

                      {/* Current Price */}
                      <td className="px-4 py-3 text-right text-gray-200 tabular-nums">
                        {pricesLoading ? (
                          <div className="h-4 w-20 rounded bg-gray-800 animate-pulse inline-block" />
                        ) : priceData ? (
                          <span>${priceData.price.toFixed(2)}</span>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                      </td>

                      {/* Daily % */}
                      <td className="px-4 py-3 text-right text-gray-200 tabular-nums">
                        {pricesLoading ? (
                          <div className="h-4 w-16 rounded bg-gray-800 animate-pulse inline-block" />
                        ) : priceData ? (
                          <span className={priceData.daily_change_pct >= 0 ? 'text-green-400' : 'text-red-400'}>
                            {priceData.daily_change_pct >= 0 ? '+' : ''}{priceData.daily_change_pct.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                      </td>

                      {/* Note */}
                      <td className="px-4 py-3 text-gray-300 max-w-xs">
                        {editingId === item.id ? (
                          <input
                            type="text"
                            value={editingNote}
                            onChange={(e) => setEditingNote(e.target.value.slice(0, 280))}
                            onBlur={() => handleSaveNote(item.id, editingNote)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveNote(item.id, editingNote)
                              if (e.key === 'Escape') setEditingId(null)
                            }}
                            autoFocus
                            maxLength={280}
                            className="w-full px-2 py-1 rounded bg-gray-800 border border-blue-500 text-white text-sm focus:outline-none"
                          />
                        ) : (
                          <div
                            onClick={() => {
                              setEditingId(item.id)
                              setEditingNote(item.note || '')
                            }}
                            className="cursor-pointer hover:text-blue-400 transition-colors py-1"
                          >
                            {item.note || <span className="text-gray-600">—</span>}
                          </div>
                        )}
                      </td>

                      {/* Added */}
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {formatRelativeTime(item.created_at)}
                      </td>

                      {/* Source */}
                      <td className="px-4 py-3">
                        <span className={`text-xs font-semibold px-2 py-1 rounded ${
                          item.added_from_ai
                            ? 'bg-purple-600/20 text-purple-300'
                            : 'bg-gray-700 text-gray-300'
                        }`}>
                          {item.added_from_ai ? '🪄 AI' : 'Manual'}
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleDeleteItem(item.id)}
                          className="text-gray-500 hover:text-red-400 transition-colors"
                          title="Remove from watchlist"
                        >
                          🗑️
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Section Divider */}
        {watchlistItems.length > 0 && (
          <div className="my-12 border-t border-gray-800" />
        )}

        {/* AI Ideas Section */}
        {!hasHoldings ? (
          <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-8 text-center">
            <p className="text-gray-400">Add holdings to your portfolio to get personalized AI ideas. Once you have at least 3 holdings, we'll generate suggestions tailored to your situation.</p>
          </div>
        ) : (
          <div>
            {/* Header with Regenerate button */}
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold text-gray-200 flex items-center gap-2">🪄 AI suggestions for you today</h2>
              <button
                onClick={() => {
                  setRegenButtonLoading(true)
                  fetchAIIdeas(true).finally(() => setRegenButtonLoading(false))
                }}
                disabled={regenButtonLoading}
                className="px-4 py-2 rounded-lg bg-gray-800 text-gray-200 text-sm hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                {regenButtonLoading ? 'Regenerating...' : 'Regenerate'}
              </button>
            </div>

            {/* Loading state */}
            {ideasLoading && ideas.length === 0 && (
              <div className="space-y-4">
                <p className="text-center text-gray-400 text-sm">✨ Generating today's ideas...</p>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3"
                  >
                    <div className="h-4 w-32 rounded bg-gray-800 animate-pulse" />
                    <div className="h-3 w-24 rounded bg-gray-800 animate-pulse" />
                    <div className="space-y-2">
                      <div className="h-3 w-full rounded bg-gray-800 animate-pulse" />
                      <div className="h-3 w-5/6 rounded bg-gray-800 animate-pulse" />
                    </div>
                    <div className="h-8 w-full rounded bg-gray-800 animate-pulse" />
                  </div>
                ))}
                </div>
              </div>
            )}

            {/* Error state */}
            {ideasError && (
              <div className="bg-red-900/20 border border-red-800 rounded-xl p-4 text-red-300 text-sm mb-6">
                {ideasError}
              </div>
            )}

            {/* Ideas grid */}
            {!ideasLoading && ideas.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
                {ideas.map((idea) => {
                  const isOnWatchlist = watchlistItems.some((item) => item.ticker === idea.ticker)
                  return (
                    <div
                      key={idea.ticker}
                      className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3 hover:border-gray-700 transition-colors"
                    >
                      {/* Ticker + Name */}
                      <div>
                        <button
                          onClick={() => setSelectedTicker(idea.ticker)}
                          className="font-mono font-semibold text-lg text-white hover:text-blue-400 transition-colors cursor-pointer"
                        >
                          {idea.ticker}
                        </button>
                        <p className="text-sm text-gray-400 mt-0.5">{idea.name}</p>
                      </div>

                      {/* Asset class badge */}
                      <div>
                        <span className="inline-block px-2.5 py-1 rounded-full bg-blue-600/20 border border-blue-600/50 text-blue-300 text-xs font-medium">
                          {idea.asset_class}
                        </span>
                      </div>

                      {/* Rationale */}
                      <p
                        dir={getDirection(userLanguage)}
                        className={`text-sm text-gray-300 leading-relaxed text-${getTextAlign(userLanguage)}`}
                      >
                        {idea.rationale}
                      </p>

                      {/* Risk */}
                      <p
                        dir={getDirection(userLanguage)}
                        className={`text-xs text-gray-500 text-${getTextAlign(userLanguage)}`}
                      >
                        <span className="font-medium">Risk:</span> {idea.risk}
                      </p>

                      {/* Sizing */}
                      <p
                        dir={getDirection(userLanguage)}
                        className={`text-xs text-gray-500 text-${getTextAlign(userLanguage)}`}
                      >
                        <span className="font-medium">Sizing:</span> {idea.sizing}
                      </p>

                      {/* Tax considerations if present */}
                      {idea.tax_considerations && (
                        <p
                          dir={getDirection(userLanguage)}
                          className={`text-xs text-yellow-600/80 bg-yellow-900/20 rounded p-2 text-${getTextAlign(userLanguage)}`}
                        >
                          {idea.tax_considerations}
                        </p>
                      )}

                      {/* Add to Watchlist button */}
                      <button
                        onClick={() => handleAddIdeaToWatchlist(idea)}
                        disabled={isOnWatchlist}
                        className={`w-full py-2 rounded-lg font-medium text-sm transition-colors ${
                          isOnWatchlist
                            ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
                            : 'bg-blue-600 text-white hover:bg-blue-500'
                        }`}
                      >
                        {isOnWatchlist ? '✓ Added' : '+ Add to Watchlist'}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Empty state for ideas */}
            {!ideasLoading && ideas.length === 0 && !ideasError && (
              <div className="text-center py-8 text-gray-500">
                <p className="text-sm">Click Regenerate to get today's ideas</p>
              </div>
            )}

            {/* Disclaimer */}
            <p className="text-xs text-gray-600 text-center mt-6">
              These are ideas for research, not financial advice.
            </p>
          </div>
        )}
      </div>

      {/* DrillDownPanel */}
      {selectedTicker && (
        <DrillDownPanel
          holding={null}
          watchlistTicker={selectedTicker}
          priceEntry={prices[selectedTicker]}
          onClose={() => setSelectedTicker(null)}
        />
      )}
    </>
  )
}
