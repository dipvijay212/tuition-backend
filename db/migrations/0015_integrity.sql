-- =====================================================================
-- 0015 INTEGRITY
--  * Cross-institute references are rejected. Foreign keys only check that a
--    row exists; RLS only checks the row's own institute_id. Without this, an
--    admin could point their batch/student/exam at another institute's class,
--    subject, teacher, etc. by id. One generic trigger per table checks every
--    tenant-to-tenant reference (generated from the catalog, so new FKs added
--    before this migration are all covered).
--  * students.subject_ids / teachers.subject_ids (uuid[]) get the same check.
--  * Attendance cannot be recorded for a session on a future date (also for admins:
--    future "absent" marks would send false alerts to parents).
-- =====================================================================

create or replace function public.enforce_same_institute()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  i integer := 0;
  v_col text;
  v_ref text;
  v_new text;
  v_ok boolean;
  v_newj jsonb := to_jsonb(new);
  v_oldj jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
begin
  while i < tg_nargs loop
    v_col := tg_argv[i];
    v_ref := tg_argv[i + 1];
    i := i + 2;
    v_new := v_newj ->> v_col;
    continue when v_new is null;
    -- Unchanged reference on an unchanged institute: nothing to check (keeps bulk updates cheap).
    continue when tg_op = 'UPDATE' and v_new is not distinct from (v_oldj ->> v_col)
                  and (v_newj ->> 'institute_id') is not distinct from (v_oldj ->> 'institute_id');
    execute format('select exists (select 1 from public.%I where id = $1 and institute_id = $2)', v_ref)
      into v_ok using v_new::uuid, (v_newj ->> 'institute_id')::uuid;
    if not v_ok then
      raise exception 'The selected % does not belong to this institute.',
        replace(regexp_replace(v_ref, '(es|s)$', ''), '_', ' ')
        using errcode = 'P0001';
    end if;
  end loop;
  return new;
end $$;

do $$
declare r record;
begin
  for r in
    select src.relname as tbl,
           array_agg(a.attname::text order by a.attname) as cols,
           array_agg(ref.relname::text order by a.attname) as refs
      from pg_constraint con
      join pg_class src on src.oid = con.conrelid and src.relnamespace = 'public'::regnamespace
      join pg_class ref on ref.oid = con.confrelid and ref.relnamespace = 'public'::regnamespace
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.contype = 'f' and array_length(con.conkey, 1) = 1
       and a.attname <> 'institute_id'
       and ref.relname not in ('profiles', 'institutes')   -- profiles are global (one login, many institutes)
       and exists (select 1 from pg_attribute x where x.attrelid = src.oid and x.attname = 'institute_id' and not x.attisdropped)
       and exists (select 1 from pg_attribute x where x.attrelid = ref.oid and x.attname = 'institute_id' and not x.attisdropped)
     group by src.relname
  loop
    execute format('drop trigger if exists trg_same_institute on public.%I', r.tbl);
    execute format(
      'create trigger trg_same_institute before insert or update on public.%I for each row execute function public.enforce_same_institute(%s)',
      r.tbl,
      (select string_agg(quote_literal(c) || ', ' || quote_literal(f), ', ') from unnest(r.cols, r.refs) as x(c, f)));
  end loop;
end $$;

-- subject_ids arrays on students/teachers.
create or replace function public.enforce_subject_ids_institute()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.subject_ids is null or cardinality(new.subject_ids) = 0 then return new; end if;
  if tg_op = 'UPDATE' and new.subject_ids is not distinct from old.subject_ids and new.institute_id = old.institute_id then return new; end if;
  if exists (select 1 from unnest(new.subject_ids) s
              where not exists (select 1 from public.subjects x where x.id = s and x.institute_id = new.institute_id)) then
    raise exception 'The selected subject does not belong to this institute.' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger trg_students_subject_ids before insert or update of subject_ids, institute_id on public.students
  for each row execute function public.enforce_subject_ids_institute();
create trigger trg_teachers_subject_ids before insert or update of subject_ids, institute_id on public.teachers
  for each row execute function public.enforce_subject_ids_institute();

-- No attendance for future dates (in the institute's timezone).
create or replace function public.block_future_attendance()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_date date; v_tz text;
begin
  select s.session_date, coalesce(st.timezone, 'Asia/Kolkata') into v_date, v_tz
    from public.class_sessions s left join public.institute_settings st on st.institute_id = s.institute_id
   where s.id = new.session_id;
  if v_date > (now() at time zone v_tz)::date then
    raise exception 'Attendance cannot be marked for a future date.' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger trg_attendance_not_future before insert or update of status on public.attendance
  for each row execute function public.block_future_attendance();
