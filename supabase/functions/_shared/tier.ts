// Premium tier helper for Edge Functions

export async function isUserPremium(supabaseClient: any, userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('tier')
      .eq('id', userId)
      .single()

    if (error) {
      console.error('[isUserPremium] Fetch error:', error)
      return false
    }

    return data?.tier === 'premium'
  } catch (err) {
    console.error('[isUserPremium] Unexpected error:', err)
    return false
  }
}
