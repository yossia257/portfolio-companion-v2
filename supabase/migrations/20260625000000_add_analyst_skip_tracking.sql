-- Add columns to track when to skip fetching analyst targets
alter table public.ticker_research_cache
  add column if not exists target_skip_reason text,
  add column if not exists target_skip_until timestamptz;

-- Add constraint to validate skip_reason values
alter table public.ticker_research_cache
  add constraint target_skip_reason_check
    check (target_skip_reason in ('ETF', 'rate_limited', 'no_analyst_coverage', null));
