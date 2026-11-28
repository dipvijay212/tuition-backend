-- Multi-institute (SaaS) tests: RLS isolation, memberships, plan limits. Everything rolls back.
begin;
create or replace function pg_temp.as_user(p uuid, inst uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'app_api', true);
  perform set_config('app.user_id', p::text, true);
  perform set_config('app.institute_id', coalesce(inst::text, ''), true);
end $$;
create or replace function pg_temp.as_postgres() returns void language plpgsql as $$
begin perform set_config('role', 'none', true); perform set_config('app.user_id', '', true); perform set_config('app.institute_id', '', true); end $$;
create or replace function pg_temp.check(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond then raise notice 'PASS  %', label; else raise exception 'FAIL  %', label; end if;
end $$;
create or replace function pg_temp.expect_error(sql text, pattern text, label text) returns void language plpgsql as $$
declare v_msg text;
begin
  begin
    execute sql;
  exception when others then
    v_msg := sqlerrm;
  end;
  if v_msg is null then raise exception 'FAIL  % (no error raised)', label; end if;
  if v_msg ~* pattern then raise notice 'PASS  % -> %', label, v_msg;
  else raise exception 'FAIL  % (unexpected error: %)', label, v_msg; end if;
end $$;

-- ---------- Fixtures: two institutes, one person in both ----------
insert into plans (id, code, name, max_students, max_teachers, max_batches, features)
values ('d0000000-0000-0000-0000-000000000001', 'test_tiny', 'Tiny', 1, 1, 1, '{}');
insert into institutes (id, name, code) values
 ('aaaaaaaa-0000-0000-0000-000000000001', 'Alpha Classes', 'ALPHA1'),
 ('bbbbbbbb-0000-0000-0000-000000000002', 'Beta Academy', 'BETA22'),
 ('cccccccc-0000-0000-0000-000000000003', 'Gamma Tutors', null);
select seed_institute_defaults('aaaaaaaa-0000-0000-0000-000000000001');
select seed_institute_defaults('bbbbbbbb-0000-0000-0000-000000000002');
insert into subscriptions (institute_id, plan_id, status, current_period_end) values
 ('aaaaaaaa-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'active', current_date + 30),
 ('bbbbbbbb-0000-0000-0000-000000000002', (select id from plans where code = 'pro'), 'trialing', null);

select pg_temp.check((select code from institutes where id = 'cccccccc-0000-0000-0000-000000000003') ~ '^GT[0-9]{4}$', 'institute code generated from the name');

insert into auth.users (id, email) values
 ('e0000000-0000-0000-0000-000000000001', 'both@test.in'),
 ('e0000000-0000-0000-0000-000000000002', 'betaadmin@test.in');
update profiles set status = 'active', institute_id = 'aaaaaaaa-0000-0000-0000-000000000001' where id = 'e0000000-0000-0000-0000-000000000001';
update profiles set status = 'active', institute_id = 'bbbbbbbb-0000-0000-0000-000000000002' where id = 'e0000000-0000-0000-0000-000000000002';
insert into user_roles (user_id, institute_id, role) values
 ('e0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'admin'),
 ('e0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'parent'),
 ('e0000000-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'admin');

select pg_temp.check((select count(*) from memberships where user_id = 'e0000000-0000-0000-0000-000000000001') = 2, 'granting roles created one membership per institute');

insert into classes (id, institute_id, name) values
 ('c1000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Alpha Std 10'),
 ('c2000000-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'Beta Std 10');
insert into students (id, institute_id, admission_no, full_name) values
 ('51000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'A-1', 'Alpha Kid');
insert into guardians (id, institute_id, full_name, phone, profile_id) values
 ('61000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Same Person', '9000000099', null),
 ('62000000-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'Same Person', '9000000099', 'e0000000-0000-0000-0000-000000000001');
-- The same login may now be linked in two institutes.
update guardians set profile_id = 'e0000000-0000-0000-0000-000000000001' where id = '61000000-0000-0000-0000-000000000001';
select pg_temp.check(true, 'one login linked to guardian records in two institutes');

-- ---------- RLS: the session institute decides what is visible ----------
select pg_temp.as_user('e0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001');
select pg_temp.check(public.auth_institute_id() = 'aaaaaaaa-0000-0000-0000-000000000001', 'session institute = Alpha');
select pg_temp.check(public.is_admin(), 'admin in Alpha');
select pg_temp.check((select count(*) from classes) = 1 and (select name from classes) = 'Alpha Std 10', 'Alpha session sees only Alpha classes');
select pg_temp.check((select count(*) from classes where institute_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 0, 'explicit filter on Beta still returns nothing');
select pg_temp.check((select count(*) from institutes) = 1, 'sees only its own institute row');
select pg_temp.check((select count(*) from memberships) = 1, 'sees only Alpha memberships');
select pg_temp.expect_error($$insert into classes (institute_id, name) values ('bbbbbbbb-0000-0000-0000-000000000002', 'Injected')$$, 'row-level security', 'cannot insert rows into another institute');
select pg_temp.expect_error($$update institutes set code = 'HACKED' where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 'permission denied', 'admin cannot change the institute code');
select pg_temp.expect_error($$update institutes set status = 'active' where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 'permission denied', 'admin cannot change platform status');
select pg_temp.expect_error($$update subscriptions set current_period_end = '2099-01-01'$$, 'permission denied', 'admin cannot extend their own subscription');
select pg_temp.expect_error($$insert into memberships (user_id, institute_id) values ('e0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001')$$, 'permission denied', 'api cannot write memberships directly');
update institutes set name = 'Alpha Classes Pvt' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.check((select name from institutes) = 'Alpha Classes Pvt', 'admin can still edit the institute profile');
select pg_temp.check((select count(*) from profiles) = 1, 'profiles: only members of Alpha visible');

-- ---------- Plan limits ----------
select pg_temp.expect_error($$insert into students (institute_id, admission_no, full_name) values ('aaaaaaaa-0000-0000-0000-000000000001', 'A-2', 'Second Kid')$$,
  'plan allows up to 1 active students', 'student limit enforced');
select pg_temp.expect_error($$insert into batches (institute_id, class_id, name) values ('aaaaaaaa-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'B1'), ('aaaaaaaa-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'B2')$$,
  'plan allows up to 1 active batches', 'batch limit enforced');
insert into students (institute_id, admission_no, full_name, status) values ('aaaaaaaa-0000-0000-0000-000000000001', 'A-3', 'Old Kid', 'completed');
select pg_temp.check(true, 'inactive students do not count against the limit');
select pg_temp.expect_error($$update students set status = 'active' where admission_no = 'A-3'$$, 'plan allows', 'reactivating over the limit is blocked');

-- ---------- Same login, other institute ----------
select pg_temp.as_user('e0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002');
select pg_temp.check(public.auth_institute_id() = 'bbbbbbbb-0000-0000-0000-000000000002', 'session institute = Beta');
select pg_temp.check(not public.is_admin() and public.has_role('parent'), 'only parent in Beta (roles are per institute)');
select pg_temp.check((select count(*) from classes) = 1 and (select name from classes) = 'Beta Std 10', 'Beta session sees only Beta classes');
select pg_temp.check((select count(*) from students) = 0, 'Beta session cannot see Alpha students');

-- Not a member -> nothing.
select pg_temp.as_user('e0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001');
select pg_temp.check(public.auth_institute_id() is null, 'non-member gets no institute');
select pg_temp.check((select count(*) from classes) = 0 and (select count(*) from students) = 0, 'non-member sees no rows');

-- Suspended in one institute only.
select pg_temp.as_postgres();
update memberships set status = 'suspended' where user_id = 'e0000000-0000-0000-0000-000000000001' and institute_id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.as_user('e0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001');
select pg_temp.check(public.auth_institute_id() is null and (select count(*) from classes) = 0, 'suspended membership: no access to Alpha');
select pg_temp.as_user('e0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002');
select pg_temp.check(public.auth_institute_id() = 'bbbbbbbb-0000-0000-0000-000000000002', 'still active in Beta');

-- Platform-suspended institute.
select pg_temp.as_postgres();
update institutes set status = 'suspended' where id = 'bbbbbbbb-0000-0000-0000-000000000002';
select pg_temp.as_user('e0000000-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002');
select pg_temp.check(public.auth_institute_id() is null and (select count(*) from classes) = 0, 'suspended institute: no data access');

-- ---------- Subscription access ----------
select pg_temp.as_postgres();
update institutes set status = 'active' where id = 'bbbbbbbb-0000-0000-0000-000000000002';
select pg_temp.check((select access from institute_access where institute_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 'active', 'paid period -> active');
select pg_temp.check((select access from institute_access where institute_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 'trial', 'trial without end -> trial');
update subscriptions set current_period_end = current_date - 3, grace_days = 7 where institute_id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.check((select access from institute_access where institute_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 'grace', 'ended 3 days ago, 7 grace days -> grace');
update subscriptions set current_period_end = current_date - 10 where institute_id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.check((select access from institute_access where institute_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 'expired', 'past grace -> expired');
update subscriptions set trial_ends_at = now() - interval '1 hour' where institute_id = 'bbbbbbbb-0000-0000-0000-000000000002';
select pg_temp.check((select access from institute_access where institute_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 'expired', 'trial over -> expired');
select pg_temp.check((select access from institute_access where institute_id = 'cccccccc-0000-0000-0000-000000000003') = 'expired', 'no subscription -> expired');

-- ---------- Notifications land in the right institute ----------
update memberships set status = 'active' where user_id = 'e0000000-0000-0000-0000-000000000001';
select pg_temp.as_user('e0000000-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002');
insert into announcements (institute_id, title, body, audience, created_by)
values ('bbbbbbbb-0000-0000-0000-000000000002', 'Beta holiday', 'Closed on Friday', 'all', 'e0000000-0000-0000-0000-000000000002');
select pg_temp.as_postgres();
select pg_temp.check((select count(*) from notifications where user_id = 'e0000000-0000-0000-0000-000000000001' and institute_id = 'bbbbbbbb-0000-0000-0000-000000000002' and title = 'Beta holiday') = 1,
  'announcement reached the shared user inside Beta');
select pg_temp.check((select count(*) from notifications where title = 'Beta holiday' and institute_id <> 'bbbbbbbb-0000-0000-0000-000000000002') = 0, 'and never inside another institute');

rollback;
