-- Auto-create default portfolio for new users on signup
-- This ensures every user always has an active portfolio for adding holdings

-- Replace the existing handle_new_user function to also create a default portfolio
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  -- Create default portfolio for new user
  insert into public.portfolios (user_id, name, is_active)
  values (new.id, 'My Portfolio', true);

  return new;
end;
$$;

-- Backfill: create portfolios for any existing users who don't have one
insert into public.portfolios (user_id, name, is_active)
select id, 'My Portfolio', true
from public.profiles
where id not in (select user_id from public.portfolios)
on conflict (user_id) do nothing;
