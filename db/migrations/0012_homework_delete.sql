-- =====================================================================
-- 0012 Allow the API to delete homework (and its check records).
-- The API restricts this to admins and teachers of the homework's batch.
-- =====================================================================
grant delete on public.homework, public.homework_submissions to app_api;
