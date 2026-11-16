-- =====================================================================
-- 0000 AUTH: our own replacement for Supabase Auth.
-- The rest of the schema references auth.users and auth.uid(), so we keep
-- those names. auth.uid() reads the user id the API sets per transaction:
--   select set_config('app.user_id', '<uuid>', true);
-- =====================================================================
create extension if not exists pgcrypto;
create schema if not exists auth;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  phone text,
  encrypted_password text,              -- bcrypt; null until the user sets one (invites)
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  banned_until timestamptz,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_email_unique on auth.users (lower(email)) where email is not null;

-- Opaque, revocable sessions. Only a SHA-256 hash of the token is stored.
create table auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  persistent boolean not null default true,  -- "remember me"
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  user_agent text,
  ip text,
  created_at timestamptz not null default now()
);
create index sessions_user_idx on auth.sessions (user_id);
create index sessions_expires_idx on auth.sessions (expires_at);

-- Single-use email link tokens (invitations, password recovery).
create table auth.one_time_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_type text not null check (token_type in ('invite', 'recovery')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index one_time_tokens_user_idx on auth.one_time_tokens (user_id);

-- Current API user for this transaction (null for system/background work).
create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;
