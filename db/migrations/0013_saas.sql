-- =====================================================================
-- 0013 SAAS: many institutes on one platform, sold on subscription.
--
--  * institutes get a unique login CODE and a platform status.
--  * memberships: one login (auth.users) can belong to many institutes;
--    account status is per institute.
--  * a session is bound to ONE institute (auth.sessions.institute_id).
--    The API sets app.institute_id per transaction; auth_institute_id()
--    returns it only when the caller is an active member.
--  * plans + subscriptions (manual billing, no payment gateway yet) with
--    limits enforced by triggers.
--  * platform_admins: staff who run the platform (separate from tenants).
--  * Row Level Security on every tenant table for the app_api role:
--    a missed WHERE in the API can no longer leak another institute's data.
-- =====================================================================

-- ---------- Institutes: code + platform status ----------
alter table public.institutes
  add column code text,
  add column status text not null default 'active' check (status in ('active', 'suspended', 'closed'));

-- Readable code from the name's initials + digits, e.g. "Shree Classes" -> "SC4821".
create or replace function public.suggest_institute_code(p_name text)
returns text language plpgsql volatile set search_path = public as $$
declare v_base text; v_code text; i integer := 0;
begin
  v_base := upper(left(regexp_replace(coalesce(
              (select string_agg(left(w, 1), '') from regexp_split_to_table(trim(p_name), '\s+') w where w ~ '[A-Za-z0-9]'), ''),
            '[^A-Za-z0-9]', '', 'g'), 4));
  if length(v_base) < 2 then v_base := 'TC'; end if;
  loop
    v_code := v_base || lpad((floor(random() * 10000))::int::text, 4, '0');
    exit when not exists (select 1 from public.institutes where upper(code) = v_code);
    i := i + 1;
    if i > 50 then v_base := v_base || chr(65 + floor(random() * 26)::int); i := 0; end if;
  end loop;
  return v_code;
end $$;

update public.institutes set code = public.suggest_institute_code(name) where code is null;
alter table public.institutes alter column code set not null;
alter table public.institutes add constraint institutes_code_format check (code ~ '^[A-Z0-9]{4,12}$');
create unique index institutes_code_unique on public.institutes (code);

create or replace function public.default_institute_code()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.code is null or trim(new.code) = '' then new.code := public.suggest_institute_code(new.name); end if;
  new.code := upper(trim(new.code));
  return new;
end $$;
create trigger trg_institutes_code before insert on public.institutes for each row execute function public.default_institute_code();

-- ---------- Memberships (user <-> institute, status per institute) ----------
create table public.memberships (
  user_id uuid not null references public.profiles(id) on delete cascade,
  institute_id uuid not null references public.institutes(id) on delete cascade,
  status public.account_status not null default 'active',
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, institute_id)
);
create index memberships_institute_idx on public.memberships (institute_id, status);
create trigger trg_memberships_updated before update on public.memberships for each row execute function public.set_updated_at();

insert into public.memberships (user_id, institute_id, status, last_login_at)
select p.id, p.institute_id, p.status, p.last_login_at from public.profiles p where p.institute_id is not null
on conflict do nothing;
insert into public.memberships (user_id, institute_id, status)
select distinct r.user_id, r.institute_id, 'active'::public.account_status from public.user_roles r
on conflict do nothing;

-- Granting a role always creates the membership (status copied from the profile when it is for that institute).
create or replace function public.ensure_membership()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.memberships (user_id, institute_id, status)
  select new.user_id, new.institute_id,
         coalesce((select p.status from public.profiles p where p.id = new.user_id and p.institute_id = new.institute_id), 'active')
  on conflict (user_id, institute_id) do nothing;
  return new;
end $$;
create trigger trg_user_roles_membership after insert on public.user_roles
  for each row execute function public.ensure_membership();

-- A person may now be a teacher/student/parent in several institutes with ONE login.
do $$
declare r record;
begin
  for r in
    select con.conname, rel.relname from pg_constraint con join pg_class rel on rel.oid = con.conrelid
     where con.contype = 'u' and rel.relnamespace = 'public'::regnamespace
       and rel.relname in ('teachers', 'students', 'guardians')
       and (select array_agg(att.attname::text) from pg_attribute att where att.attrelid = con.conrelid and att.attnum = any(con.conkey)) = array['profile_id']
  loop
    execute format('alter table public.%I drop constraint %I', r.relname, r.conname);
  end loop;
end $$;
create unique index teachers_profile_unique on public.teachers (institute_id, profile_id) where profile_id is not null;
create unique index students_profile_unique on public.students (institute_id, profile_id) where profile_id is not null;
create unique index guardians_profile_unique on public.guardians (institute_id, profile_id) where profile_id is not null;
create index teachers_profile_idx on public.teachers (profile_id) where profile_id is not null;
create index students_profile_idx on public.students (profile_id) where profile_id is not null;
create index guardians_profile_idx on public.guardians (profile_id) where profile_id is not null;

-- profiles.institute_id now means "last used institute" only; phone uniqueness lives in memberships/people tables.
drop index if exists public.profiles_phone_unique;
create index profiles_phone_idx on public.profiles (phone) where phone is not null;

-- ---------- Sessions and email links are bound to an institute ----------
alter table auth.sessions
  add column institute_id uuid references public.institutes(id) on delete cascade,
  add column platform boolean not null default false;
update auth.sessions s set institute_id = p.institute_id from public.profiles p where p.id = s.user_id and s.institute_id is null;
alter table auth.one_time_tokens add column institute_id uuid references public.institutes(id) on delete cascade;

-- ---------- Caller's institute (validated) ----------
-- The API sets app.institute_id for every request. Falls back to the
-- profile's last-used institute for trusted scripts that only set app.user_id.
create or replace function public.auth_institute_id()
returns uuid language sql stable security definer set search_path = public as $$
  select m.institute_id
    from public.memberships m
    join public.institutes i on i.id = m.institute_id and i.status = 'active'
   where m.user_id = auth.uid()
     and m.status = 'active'
     and m.institute_id = coalesce(
           nullif(current_setting('app.institute_id', true), '')::uuid,
           (select p.institute_id from public.profiles p where p.id = auth.uid()))
$$;

create or replace function public.has_role(p_role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles r
     where r.user_id = auth.uid() and r.role = p_role and r.institute_id = public.auth_institute_id()
  )
$$;

-- Users may not change their own institute/status (status now lives in memberships, written by the API owner role).
create or replace function public.guard_profile_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.institute_id is distinct from old.institute_id
       or new.status is distinct from old.status
       or new.id is distinct from old.id then
      raise exception 'You are not allowed to change these profile fields';
    end if;
  end if;
  return new;
end $$;

-- ---------- Notifications go to the right institute ----------
create or replace function public.notify_user_in(p_inst uuid, p_user uuid, p_type text, p_title text, p_body text, p_link text, p_dedupe text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null or p_inst is null then return; end if;
  if not public.is_essential_notification(p_type) and exists (
    select 1 from public.notification_preferences where user_id = p_user and type = p_type and not in_app) then
    return;
  end if;
  insert into public.notifications (institute_id, user_id, type, title, body, link, dedupe_key)
  values (p_inst, p_user, p_type, p_title, p_body, p_link, p_dedupe)
  on conflict (user_id, dedupe_key) do nothing;
end $$;
revoke execute on function public.notify_user_in(uuid, uuid, text, text, text, text, text) from public;

create or replace function public.notify_user(p_user uuid, p_type text, p_title text, p_body text, p_link text, p_dedupe text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.notify_user_in(
    coalesce(public.auth_institute_id(), (select institute_id from public.profiles where id = p_user)),
    p_user, p_type, p_title, p_body, p_link, p_dedupe);
end $$;

create or replace function public.notify_student_and_parents(p_student uuid, p_type text, p_title text, p_body text, p_link text, p_dedupe text)
returns void language plpgsql security definer set search_path = public as $$
declare u uuid; v_inst uuid;
begin
  select institute_id into v_inst from public.students where id = p_student;
  for u in
    select s.profile_id from public.students s where s.id = p_student and s.profile_id is not null
    union
    select g.profile_id from public.parent_students ps join public.guardians g on g.id = ps.guardian_id
     where ps.student_id = p_student and g.profile_id is not null
  loop
    perform public.notify_user_in(v_inst, u, p_type, p_title, p_body, p_link, p_dedupe);
  end loop;
end $$;

create or replace function public.fanout_announcement()
returns trigger language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  for u in
    select m.user_id from public.memberships m
     where m.institute_id = new.institute_id and m.status = 'active'
       and m.user_id <> coalesce(new.created_by, '00000000-0000-0000-0000-000000000000'::uuid)
       and (
         new.audience = 'all'
         or (new.audience = 'staff' and exists (select 1 from public.user_roles r where r.user_id = m.user_id and r.institute_id = new.institute_id and r.role in ('admin', 'teacher')))
         or (new.audience = 'students_parents' and exists (select 1 from public.user_roles r where r.user_id = m.user_id and r.institute_id = new.institute_id and r.role in ('student', 'parent')))
         or (new.audience = 'batch' and (
               m.user_id in (select s.profile_id from public.student_batches sb join public.students s on s.id = sb.student_id
                              where sb.batch_id = new.batch_id and sb.status = 'active')
            or m.user_id in (select g.profile_id from public.student_batches sb
                               join public.parent_students ps on ps.student_id = sb.student_id
                               join public.guardians g on g.id = ps.guardian_id
                              where sb.batch_id = new.batch_id and sb.status = 'active')
            or m.user_id in (select t.profile_id from public.teacher_batches tb join public.teachers t on t.id = tb.teacher_id
                              where tb.batch_id = new.batch_id and tb.is_active)))
       )
  loop
    perform public.notify_user_in(new.institute_id, u, 'general_announcement', new.title, left(new.body, 280), '/notifications', 'ann:' || new.id);
  end loop;
  return new;
end $$;

-- ---------- Platform staff ----------
create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------- Plans ----------
create table public.plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9_-]{2,30}$'),
  name text not null check (length(trim(name)) > 0),
  description text,
  price_monthly numeric(12,2) not null default 0 check (price_monthly >= 0),
  price_yearly numeric(12,2) not null default 0 check (price_yearly >= 0),
  -- null = unlimited
  max_students integer check (max_students is null or max_students >= 0),
  max_teachers integer check (max_teachers is null or max_teachers >= 0),
  max_batches integer check (max_batches is null or max_batches >= 0),
  storage_mb integer check (storage_mb is null or storage_mb >= 0),
  features text[] not null default '{}',
  trial_days integer not null default 14 check (trial_days between 0 and 365),
  is_trial_default boolean not null default false,
  is_public boolean not null default true,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index plans_one_trial_default on public.plans ((true)) where is_trial_default;
create trigger trg_plans_updated before update on public.plans for each row execute function public.set_updated_at();

insert into public.plans (code, name, description, price_monthly, price_yearly, max_students, max_teachers, max_batches, storage_mb, features, is_trial_default, sort_order) values
 ('starter', 'Starter', 'For small tuitions getting started.', 799, 7990, 100, 5, 10, 2048, '{homework,materials}', false, 1),
 ('growth', 'Growth', 'For growing institutes with exams and results.', 1999, 19990, 500, 25, 50, 10240, '{exams,homework,materials}', true, 2),
 ('pro', 'Pro', 'Unlimited students, teachers and batches.', 3999, 39990, null, null, null, 51200, '{exams,homework,materials}', false, 3);

-- ---------- Subscriptions (one current subscription per institute) ----------
create table public.subscriptions (
  institute_id uuid primary key references public.institutes(id) on delete cascade,
  plan_id uuid not null references public.plans(id),
  status text not null default 'trialing' check (status in ('trialing', 'active', 'cancelled')),
  billing_cycle text not null default 'monthly' check (billing_cycle in ('monthly', 'yearly')),
  trial_ends_at timestamptz,
  current_period_end date,          -- null = no end date (e.g. lifetime / internal)
  grace_days integer not null default 7 check (grace_days between 0 and 60),
  notes text,
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subscriptions_plan_idx on public.subscriptions (plan_id);
create trigger trg_subscriptions_updated before update on public.subscriptions for each row execute function public.set_updated_at();

-- History of plan changes and manually recorded payments.
create table public.subscription_events (
  id uuid primary key default gen_random_uuid(),
  institute_id uuid not null references public.institutes(id) on delete cascade,
  event text not null,              -- created, plan_changed, renewed, payment_recorded, status_changed, suspended, reactivated
  amount numeric(12,2),
  details jsonb not null default '{}'::jsonb,
  actor_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index subscription_events_inst_idx on public.subscription_events (institute_id, created_at desc);

-- Existing institutes keep working: Pro, active, no end date.
insert into public.subscriptions (institute_id, plan_id, status, current_period_end)
select i.id, (select id from public.plans where code = 'pro'), 'active', null from public.institutes i
on conflict do nothing;
insert into public.subscription_events (institute_id, event, details)
select i.id, 'created', jsonb_build_object('plan', 'pro', 'note', 'Existing institute migrated to SaaS') from public.institutes i;

-- Storage used per institute (kept up to date by the API's storage module).
create table public.institute_usage (
  institute_id uuid primary key references public.institutes(id) on delete cascade,
  storage_bytes bigint not null default 0,
  computed_at timestamptz not null default now()
);

-- Effective access for an institute. Used by the API on every request (one join), so keep it cheap.
create or replace view public.institute_access as
select i.id as institute_id, i.code, i.status as institute_status,
       s.status as sub_status, s.billing_cycle, s.trial_ends_at, s.current_period_end, s.grace_days,
       pl.id as plan_id, pl.code as plan_code, pl.name as plan_name, pl.features,
       pl.max_students, pl.max_teachers, pl.max_batches, pl.storage_mb,
       case
         when i.status <> 'active' then 'suspended'
         when s.institute_id is null then 'expired'
         when s.status = 'cancelled' then 'expired'
         when s.status = 'trialing' then case when s.trial_ends_at is null or s.trial_ends_at > now() then 'trial' else 'expired' end
         when s.current_period_end is null or s.current_period_end >= current_date then 'active'
         when s.current_period_end + s.grace_days >= current_date then 'grace'
         else 'expired'
       end as access,
       case
         when s.status = 'trialing' then s.trial_ends_at
         when s.current_period_end is not null then (s.current_period_end + 1)::timestamptz
       end as ends_at
  from public.institutes i
  left join public.subscriptions s on s.institute_id = i.id
  left join public.plans pl on pl.id = s.plan_id;

-- ---------- Plan limits (enforced in the database, so no API path can bypass them) ----------
create or replace function public.enforce_plan_limits()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_limit integer; v_count integer; v_label text;
begin
  if tg_table_name = 'students' then
    if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then return new; end if;
    select pl.max_students into v_limit from public.subscriptions s join public.plans pl on pl.id = s.plan_id
     where s.institute_id = new.institute_id for update of s;
    if v_limit is null then return new; end if;
    select count(*) into v_count from public.students where institute_id = new.institute_id and status = 'active' and id <> new.id;
    v_label := 'active students';
  elsif tg_table_name = 'teachers' then
    if new.employment_status not in ('active', 'on_leave') or (tg_op = 'UPDATE' and old.employment_status in ('active', 'on_leave')) then return new; end if;
    select pl.max_teachers into v_limit from public.subscriptions s join public.plans pl on pl.id = s.plan_id
     where s.institute_id = new.institute_id for update of s;
    if v_limit is null then return new; end if;
    select count(*) into v_count from public.teachers where institute_id = new.institute_id and employment_status in ('active', 'on_leave') and id <> new.id;
    v_label := 'teachers';
  elsif tg_table_name = 'batches' then
    if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then return new; end if;
    select pl.max_batches into v_limit from public.subscriptions s join public.plans pl on pl.id = s.plan_id
     where s.institute_id = new.institute_id for update of s;
    if v_limit is null then return new; end if;
    select count(*) into v_count from public.batches where institute_id = new.institute_id and status = 'active' and id <> new.id;
    v_label := 'active batches';
  else
    return new;
  end if;
  if v_count >= v_limit then
    raise exception 'Your plan allows up to % %. Please upgrade your plan to add more.', v_limit, v_label;
  end if;
  return new;
end $$;
create trigger trg_students_plan_limit before insert or update of status on public.students
  for each row execute function public.enforce_plan_limits();
create trigger trg_teachers_plan_limit before insert or update of employment_status on public.teachers
  for each row execute function public.enforce_plan_limits();
create trigger trg_batches_plan_limit before insert or update of status on public.batches
  for each row execute function public.enforce_plan_limits();

create index if not exists teachers_institute_status_idx on public.teachers (institute_id, employment_status);
create index if not exists batches_institute_status_idx on public.batches (institute_id, status);

-- ---------- Privileges for the API role on the new objects ----------
-- Tenants may read their own subscription/plan, never change them.
revoke all on public.plans, public.subscriptions, public.subscription_events, public.institute_usage,
  public.platform_admins, public.institute_access from app_api;
grant select on public.plans, public.subscriptions to app_api;
grant select on public.memberships to app_api;
revoke insert, update, delete on public.memberships from app_api;
-- Admins edit their institute profile, but never its code or platform status.
revoke update on public.institutes from app_api;
grant update (name, logo_path, address, phone, email, website) on public.institutes to app_api;
revoke execute on function public.suggest_institute_code(text) from public;

-- ---------- Row Level Security for app_api (owner/system work bypasses it) ----------
-- (select ...) makes Postgres evaluate the caller's institute once per statement, not per row.
do $$
declare t record;
begin
  for t in
    select c.relname from pg_class c
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'institute_id' and not a.attisdropped
     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
       and c.relname not in ('profiles', 'subscription_events', 'institute_usage')
  loop
    execute format('alter table public.%I enable row level security', t.relname);
    execute format('drop policy if exists tenant_isolation on public.%I', t.relname);
    execute format(
      'create policy tenant_isolation on public.%I for all to app_api using (institute_id = (select public.auth_institute_id())) with check (institute_id = (select public.auth_institute_id()))',
      t.relname);
  end loop;
end $$;

alter table public.institutes enable row level security;
create policy tenant_isolation on public.institutes for all to app_api
  using (id = (select public.auth_institute_id())) with check (id = (select public.auth_institute_id()));

alter table public.profiles enable row level security;
create policy tenant_isolation on public.profiles for all to app_api
  using (id = auth.uid() or id in (select m.user_id from public.memberships m where m.institute_id = (select public.auth_institute_id())))
  with check (id = auth.uid() or id in (select m.user_id from public.memberships m where m.institute_id = (select public.auth_institute_id())));

alter table public.notification_preferences enable row level security;
create policy own_rows on public.notification_preferences for all to app_api
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.plans enable row level security;
create policy read_all on public.plans for select to app_api using (true);
