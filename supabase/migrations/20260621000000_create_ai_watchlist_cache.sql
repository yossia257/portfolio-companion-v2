-- Create ai_watchlist_cache table for daily personalized investment ideas
CREATE TABLE ai_watchlist_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  generated_on DATE NOT NULL,
  ideas JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, generated_on)
);

-- Create index for faster lookups by user and date
CREATE INDEX idx_ai_watchlist_cache_user_date ON ai_watchlist_cache(user_id, generated_on);

-- Enable RLS
ALTER TABLE ai_watchlist_cache ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only read their own cache
CREATE POLICY ai_watchlist_cache_select
  ON ai_watchlist_cache FOR SELECT
  USING (auth.uid() = user_id);

-- Policy: Service role can insert/update for any user (via Edge Function)
CREATE POLICY ai_watchlist_cache_insert
  ON ai_watchlist_cache FOR INSERT
  WITH CHECK (true);

CREATE POLICY ai_watchlist_cache_update
  ON ai_watchlist_cache FOR UPDATE
  USING (true)
  WITH CHECK (true);
