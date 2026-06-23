// Canonical CORS headers for all Edge Functions
// Centralized configuration to prevent CORS bugs
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
}

// Handle CORS preflight requests
export function handleCorsPreFlight(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('OK', { headers: corsHeaders })
  }
  return null
}
