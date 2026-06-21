-- Create ai_usage table for tracking Claude API usage and costs
CREATE TABLE ai_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost_usd NUMERIC(10, 6) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for daily usage lookups
CREATE INDEX idx_ai_usage_user_date ON ai_usage(user_id, created_at);

-- Create index for cost tracking
CREATE INDEX idx_ai_usage_endpoint ON ai_usage(endpoint);

-- Enable RLS
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only read their own usage
CREATE POLICY ai_usage_select
  ON ai_usage FOR SELECT
  USING (auth.uid() = user_id);

-- Policy: Service role can insert (via Edge Function)
CREATE POLICY ai_usage_insert
  ON ai_usage FOR INSERT
  WITH CHECK (true);
