-- =====================================================================
-- 0014 SINGLE PLAN: one plan for every institute.
-- Keeps "pro" (unlimited students/teachers/batches, all features) and makes it
-- the trial default. Starter and Growth are removed; any institute still on
-- them is moved to Pro first.
-- =====================================================================

update public.subscriptions
   set plan_id = (select id from public.plans where code = 'pro')
 where plan_id in (select id from public.plans where code <> 'pro');

update public.plans set is_trial_default = false where code <> 'pro';
update public.plans
   set is_trial_default = true,
       is_public = true,
       is_active = true,
       features = '{exams,homework,materials}',
       description = 'Everything included: unlimited students, teachers and batches.',
       sort_order = 1
 where code = 'pro';

delete from public.plans where code <> 'pro';
