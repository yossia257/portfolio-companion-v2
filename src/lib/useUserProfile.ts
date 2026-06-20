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
        console.log('[useUserProfile] Session data:', sessionData)

        if (!sessionData?.session?.user) {
          console.error('[useUserProfile] No session user found')
          setError('Not authenticated')
          setLoading(false)
          return
        }

        const userId = sessionData.session.user.id
        const userEmail = sessionData.session.user.email

        // Fetch all profile fields including investment profile
        const { data: profileData, error: fetchError } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .single()

        if (fetchError) {
          console.error('[useUserProfile] Profile select failed:', fetchError)
          setError(fetchError.message)
          return
        }

        console.log('[useUserProfile] Profile data loaded:', profileData)
        setProfile({
          ...profileData,
          email: userEmail,
        } as UserProfile)
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : 'Unknown error'
        console.error('[useUserProfile] Catch error:', errorMsg, e)
        setError(errorMsg)
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
