-- Add post-market price tracking columns to price_cache table
alter table public.price_cache
  add column if not exists post_market_price numeric,
  add column if not exists post_market_change_pct numeric;

-- Add comment documenting the new columns
comment on column public.price_cache.post_market_price is 'Post-market trading price (e.g., after-hours close)';
comment on column public.price_cache.post_market_change_pct is 'Post-market percentage change vs today''s regular close';
