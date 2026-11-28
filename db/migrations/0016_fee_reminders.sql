-- =====================================================================
-- 0016 FEE REMINDERS
-- Daily reminders for unpaid fees, driven by each institute's settings:
--   fee_reminder_days_before (e.g. {7,3}), fee_reminder_on_due, fee_reminder_days_after (e.g. {3,7}).
-- claim_fee_reminders() returns the reminders that are due now and records them in
-- fee_reminder_log in the same statement, so each fee gets each reminder AT MOST ONCE,
-- even if the job runs every few minutes or on several servers at the same time.
-- The API sends the emails (one per student, listing all of that student's due fees).
-- Only institutes with access (trial / active / grace) are reminded; suspended or expired are skipped.
-- =====================================================================

create table public.fee_reminder_log (
  obligation_id uuid not null references public.fee_obligations(id) on delete cascade,
  kind text not null check (kind in ('before', 'due', 'after')),
  reminder_date date not null,
  institute_id uuid not null references public.institutes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (obligation_id, kind, reminder_date)
);
create index fee_reminder_log_inst_idx on public.fee_reminder_log (institute_id, reminder_date desc);
-- System table: the API role never touches it directly.
alter table public.fee_reminder_log enable row level security;
revoke all on public.fee_reminder_log from app_api;

-- Speeds up the daily scan (only open fees).
create index if not exists fee_obligations_open_due_idx on public.fee_obligations (due_date)
  where status in ('unpaid', 'partially_paid');

create or replace function public.claim_fee_reminders(p_send_hour integer default 9)
returns table (
  institute_id uuid, student_id uuid, obligation_id uuid, kind text,
  description text, due_date date, balance numeric, reminder_date date
)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare r record;
begin
  for r in
    with due as (
      select o.id, o.institute_id, o.student_id, o.description, o.due_date,
             (o.net_amount - o.amount_paid) as balance,
             (now() at time zone st.timezone)::date as today,
             case
               when (o.due_date - (now() at time zone st.timezone)::date) = any(st.fee_reminder_days_before) then 'before'
               when o.due_date = (now() at time zone st.timezone)::date and st.fee_reminder_on_due then 'due'
               when ((now() at time zone st.timezone)::date - o.due_date) = any(st.fee_reminder_days_after) then 'after'
             end as kind
        from public.fee_obligations o
        join public.institute_settings st on st.institute_id = o.institute_id
        join public.students s on s.id = o.student_id and s.status = 'active'
        join public.institute_access a on a.institute_id = o.institute_id and a.access in ('trial', 'active', 'grace')
       where o.status in ('unpaid', 'partially_paid')
         and o.net_amount > o.amount_paid
         -- window of possible reminder dates (keeps the scan small)
         and o.due_date between current_date - 400 and current_date + 400
         and extract(hour from now() at time zone st.timezone) >= p_send_hour
    ), claimed as (
      insert into public.fee_reminder_log (obligation_id, kind, reminder_date, institute_id)
      select d.id, d.kind, d.today, d.institute_id from due d where d.kind is not null
      on conflict do nothing
      returning fee_reminder_log.obligation_id, fee_reminder_log.kind
    )
    select d.* from due d join claimed c on c.obligation_id = d.id and c.kind = d.kind
  loop
    -- In-app notification for the student and linked parents (respects their in-app preference).
    perform public.notify_student_and_parents(r.student_id, 'fee_reminder',
      case r.kind when 'after' then 'Fee overdue' when 'due' then 'Fee due today' else 'Fee reminder' end,
      r.description || ': ₹' || to_char(r.balance, 'FM99,99,99,990.00') || ' due on ' || to_char(r.due_date, 'DD Mon YYYY'),
      '/fees', 'fee:' || r.id || ':' || r.kind || ':' || r.today);
    institute_id := r.institute_id; student_id := r.student_id; obligation_id := r.id; kind := r.kind;
    description := r.description; due_date := r.due_date; balance := r.balance; reminder_date := r.today;
    return next;
  end loop;
end $$;
revoke execute on function public.claim_fee_reminders(integer) from public;
revoke execute on function public.claim_fee_reminders(integer) from app_api;
revoke execute on function public.apply_late_fees(uuid) from app_api;
