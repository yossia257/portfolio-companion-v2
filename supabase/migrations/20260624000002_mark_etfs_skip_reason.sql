-- Mark existing ETFs to never retry
UPDATE ticker_research_cache
SET target_skip_reason = 'ETF'
WHERE ticker IN ('TQQQ', 'IBIT', 'GBTC', 'SHLD', 'URA', 'SLV', 'RSP', 'QQQ', 'SSO')
  AND target_skip_reason IS NULL;
