-- =====================================================================
-- 0011 API ROLE
-- Every user request runs inside a transaction with:
--   set local role app_api;  select set_config('app.user_id', <uuid>, true);
-- Row-level authorization (who sees which rows) is done by the API.
-- This role adds a database-level safety net: money/history tables can only
-- be written by the SECURITY DEFINER business functions (which run as the
-- owner), never by direct statements from the API.
-- =====================================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_api') then
    create role app_api nologin;
  end if;
end $$;
grant app_api to current_user;

grant usage on schema public to app_api;
grant usage on schema auth to app_api;
grant execute on function auth.uid() to app_api;

grant select, insert, update on all tables in schema public to app_api;
grant usage, select on all sequences in schema public to app_api;
alter default privileges in schema public grant select, insert, update on tables to app_api;
alter default privileges in schema public grant usage, select on sequences to app_api;

-- Read-only for the API: written only by business functions.
revoke insert, update on
  public.student_fee_assignments, public.payments, public.payment_allocations, public.payment_reversals,
  public.receipts, public.published_results, public.student_status_history, public.audit_logs,
  public.notification_delivery_logs, public.number_sequences
from app_api;

-- Deletes only for configuration/link rows (never history or money).
grant delete on
  public.batch_subjects, public.grading_rules, public.examination_subjects, public.discounts,
  public.student_documents, public.notification_preferences
to app_api;

-- Internal helpers are not callable directly by the API role.
revoke execute on function public.next_sequence_value(uuid, text) from public;
revoke execute on function public.notify_user(uuid, text, text, text, text, text) from public;
revoke execute on function public.notify_student_and_parents(uuid, text, text, text, text, text) from public;
revoke execute on function public.queue_absence_notification(uuid, uuid) from public;
revoke execute on function public.seed_institute_defaults(uuid) from public;
revoke execute on function public.send_fee_reminders() from public;

-- Guards on obligation money now key off the API role.
create or replace function public.is_api_user()
returns boolean language sql stable as $$
  select current_user = 'app_api'
$$;
