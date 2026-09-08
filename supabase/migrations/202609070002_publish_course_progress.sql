-- Return formal-form progress alongside category grades so the course shell can
-- reconcile completion across devices without exposing answers or private assets.
create or replace function public.course_grade_summary(
  p_user_id uuid,
  p_course_id text
) returns jsonb
language sql
security definer
set search_path = public, private, pg_temp
as $$
  with scores as (
    select category_id,category_weight,points_earned/points_possible as pct
    from public.gradebook
    where user_id=p_user_id and course_id=p_course_id and locked_at is not null
  ), categories as (
    select category_id,max(category_weight) weight,
      case when category_id='weekly_identification_practicals'
        then (sum(pct)-0.5*min(pct))/nullif(count(*)-0.5,0)
        else avg(pct) end as category_pct,
      count(*) assessment_count
    from scores
    group by category_id
  ), form_progress as (
    select
      form.assessment_id,
      form.status,
      (
        select count(*) from private.form_stations visual
        where visual.form_id=form.form_id
      ) + (
        select count(*) from private.nonvisual_form_stations nonvisual
        where nonvisual.form_id=form.form_id
      ) as total_items,
      (
        select count(*) from private.form_stations visual
        where visual.form_id=form.form_id and visual.submitted_at is not null
      ) + (
        select count(*) from private.nonvisual_form_stations nonvisual
        where nonvisual.form_id=form.form_id and nonvisual.submitted_at is not null
      ) as submitted_items
    from public.formal_forms form
    where form.user_id=p_user_id
      and form.course_id=p_course_id
      and form.status <> 'voided'
  )
  select jsonb_build_object(
    'runningGrade',(
      select round(100*sum(weight*category_pct)/nullif(sum(weight),0),2)
      from categories
    ),
    'earnedWeight',coalesce((select sum(weight) from categories),0),
    'categories',coalesce((
      select jsonb_agg(jsonb_build_object(
        'categoryId',category_id,
        'weight',weight,
        'percentage',round(100*category_pct,2),
        'assessmentCount',assessment_count
      ) order by category_id)
      from categories
    ),'[]'::jsonb),
    'assessments',coalesce((
      select jsonb_agg(jsonb_build_object(
        'assessmentId',assessment_id,
        'status',status,
        'totalItems',total_items,
        'submittedItems',submitted_items
      ) order by assessment_id)
      from form_progress
    ),'[]'::jsonb)
  );
$$;

revoke all on function public.course_grade_summary(uuid,text) from public,anon,authenticated;
grant execute on function public.course_grade_summary(uuid,text) to service_role;
