-- =====================================================================
-- 0007 APP HELPERS (formerly RLS + storage).
-- Row Level Security is no longer used: the Express API authorizes every
-- request. These helpers/guards are kept because the API and triggers use them.
-- =====================================================================

-- Non-private teacher directory (names only) for timetables etc.
create view public.staff_directory as
  select t.id, t.institute_id, t.full_name, t.specialization
    from public.teachers t
   where t.institute_id = public.auth_institute_id() and t.employment_status in ('active', 'on_leave');

-- Submission guard: students can't grade themselves; late/deadline rules.
create or replace function public.guard_homework_submission()
returns trigger language plpgsql security definer set search_path = public as $$
declare h public.homework; v_is_student boolean; v_allow_late boolean;
begin
  select * into h from public.homework where id = new.homework_id;
  v_is_student := exists (select 1 from public.students s where s.id = new.student_id and s.profile_id = auth.uid());
  if v_is_student and not public.is_admin() then
    if not h.submission_enabled then raise exception 'Online submission is not enabled for this homework'; end if;
    if tg_op = 'UPDATE' then
      if old.status not in ('resubmission_required', 'submitted', 'late') then
        raise exception 'This submission has already been reviewed';
      end if;
      new.marks := old.marks; new.feedback := old.feedback; new.reviewed_by := old.reviewed_by; new.reviewed_at := old.reviewed_at;
      new.attempt := old.attempt + case when old.status = 'resubmission_required' then 1 else 0 end;
    else
      new.marks := null; new.feedback := null; new.reviewed_by := null; new.reviewed_at := null; new.attempt := 1;
    end if;
    select allow_late_submission into v_allow_late from public.institute_settings where institute_id = h.institute_id;
    if now() > h.due_at and not v_allow_late then raise exception 'The submission deadline has passed'; end if;
    new.submitted_at := now();
    new.status := case when now() > h.due_at then 'late' else 'submitted' end;
    new.institute_id := h.institute_id;
  else
    -- Staff review
    if new.marks is not null and h.max_marks is not null and new.marks > h.max_marks then
      raise exception 'Marks cannot exceed %', h.max_marks;
    end if;
    if new.status in ('reviewed', 'resubmission_required') then
      new.reviewed_by := auth.uid(); new.reviewed_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger trg_homework_submission_guard before insert or update on public.homework_submissions
  for each row execute function public.guard_homework_submission();

-- Only read_at may change on a notification.
create or replace function public.guard_notification_update()
returns trigger language plpgsql as $$
begin
  if new.title <> old.title or new.body is distinct from old.body or new.user_id <> old.user_id or new.type <> old.type then
    raise exception 'Notifications are read-only';
  end if;
  return new;
end $$;
create trigger trg_notifications_guard before update on public.notifications for each row execute function public.guard_notification_update();

-- File access checks (called by the API before serving or accepting a file).
-- Central read check for private files.
create or replace function public.can_read_file(p_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare parts text[] := string_to_array(p_name, '/');
begin
  if parts[1] is distinct from public.auth_institute_id()::text then return false; end if;
  if public.is_admin() then return true; end if;
  case parts[2]
    when 'materials' then
      return exists (select 1 from public.study_materials m where m.file_path = p_name); -- RLS of caller applies? no: definer
    when 'homework' then
      return exists (select 1 from public.homework h where p_name = any(h.attachment_paths)
                      and (h.batch_id in (select public.my_batch_ids()) or (h.is_published and h.batch_id in (select public.my_student_batch_ids()))));
    when 'submissions' then
      return parts[4]::uuid in (select public.my_student_ids())
          or exists (select 1 from public.homework h where h.id = parts[3]::uuid and h.batch_id in (select public.my_batch_ids()));
    when 'students' then
      return parts[3]::uuid in (select public.my_student_ids())
          or (public.has_role('teacher') and public.teacher_can_access_student(parts[3]::uuid));
    when 'teachers' then
      return exists (select 1 from public.teachers t where t.id = parts[3]::uuid and t.profile_id = auth.uid());
    else
      return false;
  end case;
exception when invalid_text_representation then
  return false;
end $$;

-- Materials need the same visibility rules as the table.
create or replace function public.can_read_material_file(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.study_materials m
     where m.file_path = p_name and m.institute_id = public.auth_institute_id()
       and (
         public.is_admin()
         or (public.has_role('teacher') and (m.uploaded_by = auth.uid() or m.batch_id in (select public.my_batch_ids()) or m.visibility in ('class', 'staff')))
         or (m.is_active and m.visibility <> 'staff' and (
               m.batch_id in (select public.my_student_batch_ids())
               or (m.visibility = 'class' and m.batch_id is null and m.class_id in (
                     select s.class_id from public.students s where s.id in (select public.my_student_ids())))))
       ))
$$;

create or replace function public.can_write_file(p_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare parts text[] := string_to_array(p_name, '/');
begin
  if parts[1] is distinct from public.auth_institute_id()::text then return false; end if;
  if public.is_admin() then return true; end if;
  if parts[2] in ('materials', 'homework') then return public.has_role('teacher'); end if;
  if parts[2] = 'submissions' then
    return exists (select 1 from public.students s where s.id = parts[4]::uuid and s.profile_id = auth.uid())
       and exists (select 1 from public.homework h where h.id = parts[3]::uuid and h.is_published
                    and h.batch_id in (select public.my_student_batch_ids()));
  end if;
  return false;
exception when invalid_text_representation then
  return false;
end $$;
