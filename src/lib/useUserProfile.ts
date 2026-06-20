import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export interface UserProfile {
  id: string
  display_name: string | null
  display_currency: 'USD' | 'NIS' | 'EUR' | 'GBP'
  ai_response_language: 'en' | 'he' | 'es' | 'de' | 'fr'
  tax_jurisdiction?: 'IL' | 'US' | 'UK' | 'EU' | 'OTHER'
  email?: string
}

export function useUserProfile() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchProfile() {
      setLoading(true)
      setError(null)

      try {
        const { data: sessionData } = await supabase.auth.getSession()
        if (!sessionData?.session?.user) {
          setError('Not authenticated')
          setLoading(false)
          return
        }

        const userId = sessionData.session.user.id
        const userEmail = sessionData.session.user.email

        const { data: profileData, error: fetchError } = await supabase
          .from('profiles')
          .select('id, display_name, display_currency, ai_response_language, tax_jurisdiction, investment_horizon, risk_tolerance, portfolio_style, themes_interest, themes_avoid, tax_sensitivity')
          .eq('id', userId)
          .single()

        if (fetchError) {
          setError(fetchError.message)
          return
        }

        setProfile({
          ...profileData,
          email: userEmail,
        })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    fetchProfile()
  }, [])

  async function updateProfile(updates: Partial<Omit<UserProfile, 'email'>>) {
    if (!profile) return

    try {
      const { error } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', profile.id)

      if (error) {
        setError(error.message)
        return false
      }

      // Update local state
      setProfile({ ...profile, ...updates })
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      return false
    }
  }

  return { profile, updateProfile, loading, error }
}
