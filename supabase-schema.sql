-- Swiss 4000ers app – database setup (run once in the Supabase SQL editor)

-- 1. One profile per user (name + peaks ticked as done)
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  done jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "own profile read" on public.profiles;
drop policy if exists "own profile update" on public.profiles;
drop policy if exists "own profile insert" on public.profiles;
create policy "own profile read"   on public.profiles for select to authenticated using (user_id = auth.uid());
create policy "own profile update" on public.profiles for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own profile insert" on public.profiles for insert to authenticated with check (user_id = auth.uid());

-- create the profile automatically when the admin creates a user
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- 2. Tour log: one row per entry, private to its owner
create table if not exists public.logs (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  entry jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
alter table public.logs enable row level security;
drop policy if exists "own logs" on public.logs;
create policy "own logs" on public.logs for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.logs, public.profiles to authenticated;
revoke all on public.logs, public.profiles from anon;

-- 3. Private storage bucket for the route data (only logged-in users can read it)
insert into storage.buckets (id, name, public) values ('appdata', 'appdata', false) on conflict (id) do nothing;
drop policy if exists "logged-in users read app data" on storage.objects;
create policy "logged-in users read app data" on storage.objects for select to authenticated using (bucket_id = 'appdata');

-- profiles for users that already exist (e.g. the admin)
insert into public.profiles (user_id, email, display_name)
select id, email, split_part(email, '@', 1) from auth.users on conflict (user_id) do nothing;
