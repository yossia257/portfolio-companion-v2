-- Add analyst target price column to ticker_research_cache
-- This column stores the mean analyst target price from Alpha Vantage OVERVIEW endpoint

ALTER TABLE ticker_research_cache
ADD COLUMN IF NOT EXISTS target_price_mean DECIMAL(10, 2);

-- Create an index for efficient queries on this column if needed later
CREATE INDEX IF NOT EXISTS idx_ticker_research_cache_target_price
  ON ticker_research_cache(target_price_mean)
  WHERE target_price_mean IS NOT NULL;
