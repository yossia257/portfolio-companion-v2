-- Add analyst target price columns to ticker_research_cache
-- Refactored to use Yahoo quoteSummary as primary source with Alpha Vantage fallback

-- Add columns for full range of target prices
ALTER TABLE ticker_research_cache
ADD COLUMN IF NOT EXISTS target_price_mean DECIMAL(10, 2),
ADD COLUMN IF NOT EXISTS target_price_low DECIMAL(10, 2),
ADD COLUMN IF NOT EXISTS target_price_high DECIMAL(10, 2),
ADD COLUMN IF NOT EXISTS target_price_median DECIMAL(10, 2),
ADD COLUMN IF NOT EXISTS target_skip_reason TEXT CHECK (target_skip_reason IN ('ETF', 'no_coverage', NULL));

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_ticker_research_cache_target_price
  ON ticker_research_cache(target_price_mean)
  WHERE target_price_mean IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ticker_research_cache_skip_reason
  ON ticker_research_cache(target_skip_reason)
  WHERE target_skip_reason IS NOT NULL;
