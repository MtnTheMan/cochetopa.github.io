-- Private nonvisual delivery, auditable review, gradebook finalization, and
-- normalized course-grade reporting. Apply after 202608310001_course_schema.sql.

create table if not exists private.nonvisual_items (
  item_id text primary key,
  prompt text not null,
  response_schema jsonb not null,
  private_scoring jsonb not null,
  payload jsonb not null default '{}'::jsonb
);

create table if not exists private.nonvisual_form_targets (
  allocation_version text not null,
  assessment_id text not null,
  item_ordinal integer not null,
  item_id text not null references private.nonvisual_items(item_id),
  item_instance_id text not null,
  primary key (allocation_version, assessment_id, item_ordinal),
  unique (allocation_version, item_instance_id)
);

create table if not exists private.nonvisual_form_stations (
  form_id uuid not null references public.formal_forms(form_id) on delete cascade,
  item_ordinal integer not null,
  item_id text not null references private.nonvisual_items(item_id),
  item_instance_id text not null,
  response jsonb,
  score jsonb,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  primary key (form_id, item_ordinal),
  unique (form_id, item_id)
);

create table if not exists private.assessment_definitions (
  allocation_version text not null,
  assessment_id text not null,
  category_id text not null,
  category_weight numeric(6,5) not null check (category_weight between 0 and 1),
  points_possible numeric(10,3) not null check (points_possible > 0),
  payload jsonb not null default '{}'::jsonb,
  primary key (allocation_version, assessment_id)
);

create table if not exists private.recorded_form_items (
  form_id uuid not null references public.formal_forms(form_id) on delete cascade,
  part text not null check (part in ('visual','nonvisual')),
  item_ordinal integer not null,
  event_id uuid not null unique,
  primary key (form_id, part, item_ordinal)
);

alter table public.formal_forms drop constraint if exists formal_forms_status_check;
alter table public.formal_forms add constraint formal_forms_status_check
  check (status in ('assembled','in_progress','awaiting_review','completed','locked','voided'));

create or replace function private.course_update_species_mastery(
  p_user_id uuid,p_course_id text,p_taxon_id text,p_modality text,p_correct boolean,p_confidence text
) returns void
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare v_organ_modalities integer; v_correct_total integer; v_consecutive integer;
begin
  if p_taxon_id is null then return; end if;
  insert into public.species_mastery(user_id,course_id,taxon_id,introduced_on)
  values (p_user_id,p_course_id,p_taxon_id,current_date)
  on conflict (user_id,course_id,taxon_id) do nothing;
  update public.species_mastery set
    foliage_attempts=foliage_attempts+(case when p_modality='foliage' then 1 else 0 end),
    foliage_correct=foliage_correct+(case when p_modality='foliage' and p_correct then 1 else 0 end),
    bark_attempts=bark_attempts+(case when p_modality='bark' then 1 else 0 end),
    bark_correct=bark_correct+(case when p_modality='bark' and p_correct then 1 else 0 end),
    reproductive_attempts=reproductive_attempts+(case when p_modality='reproductive' then 1 else 0 end),
    reproductive_correct=reproductive_correct+(case when p_modality='reproductive' and p_correct then 1 else 0 end),
    dormant_attempts=dormant_attempts+(case when p_modality='dormant' then 1 else 0 end),
    dormant_correct=dormant_correct+(case when p_modality='dormant' and p_correct then 1 else 0 end),
    whole_tree_attempts=whole_tree_attempts+(case when p_modality in ('whole_tree','whole_tree_context') then 1 else 0 end),
    whole_tree_correct=whole_tree_correct+(case when p_modality in ('whole_tree','whole_tree_context') and p_correct then 1 else 0 end),
    condition_attempts=condition_attempts+(case when p_modality='condition' then 1 else 0 end),
    condition_correct=condition_correct+(case when p_modality='condition' and p_correct then 1 else 0 end),
    scientific_name_attempts=scientific_name_attempts+(case when p_modality='scientific_name' then 1 else 0 end),
    scientific_name_correct=scientific_name_correct+(case when p_modality='scientific_name' and p_correct then 1 else 0 end),
    silvics_attempts=silvics_attempts+(case when p_modality in ('silvics','forest_association') then 1 else 0 end),
    silvics_correct=silvics_correct+(case when p_modality in ('silvics','forest_association') and p_correct then 1 else 0 end),
    confuser_attempts=confuser_attempts+(case when p_modality='confuser_reasoning' then 1 else 0 end),
    confuser_correct=confuser_correct+(case when p_modality='confuser_reasoning' and p_correct then 1 else 0 end),
    consecutive_correct=case when p_correct then consecutive_correct+1 else 0 end,
    confidence_calibration=case
      when p_confidence is null then confidence_calibration
      else coalesce(confidence_calibration,0)*0.8 + (case when (p_confidence='high')=p_correct then 100 else 0 end)*0.2 end,
    last_tested_at=now(),
    next_due_at=now()+(case when p_correct then interval '7 days' else interval '1 day' end),
    updated_at=now()
  where user_id=p_user_id and course_id=p_course_id and taxon_id=p_taxon_id;

  select
    (case when foliage_attempts>0 and foliage_correct::numeric/foliage_attempts>=0.8 then 1 else 0 end)+
    (case when bark_attempts>0 and bark_correct::numeric/bark_attempts>=0.8 then 1 else 0 end)+
    (case when reproductive_attempts>0 and reproductive_correct::numeric/reproductive_attempts>=0.8 then 1 else 0 end)+
    (case when dormant_attempts>0 and dormant_correct::numeric/dormant_attempts>=0.8 then 1 else 0 end)+
    (case when whole_tree_attempts>0 and whole_tree_correct::numeric/whole_tree_attempts>=0.8 then 1 else 0 end)+
    (case when condition_attempts>0 and condition_correct::numeric/condition_attempts>=0.8 then 1 else 0 end),
    foliage_correct+bark_correct+reproductive_correct+dormant_correct+whole_tree_correct+condition_correct+scientific_name_correct+silvics_correct+confuser_correct,
    consecutive_correct
  into v_organ_modalities,v_correct_total,v_consecutive
  from public.species_mastery where user_id=p_user_id and course_id=p_course_id and taxon_id=p_taxon_id;

  update public.species_mastery set mastery_state=case
    when v_organ_modalities>=3 and scientific_name_correct>=2 and silvics_correct>=2 and v_consecutive>=3 then 'Certified'
    when v_organ_modalities>=2 then 'Multi-organ Mastery'
    when v_correct_total>=2 then 'Recognized'
    else 'Learning' end
  where user_id=p_user_id and course_id=p_course_id and taxon_id=p_taxon_id;
end;
$$;

-- Replace the visual-only assembler with a mixed-form assembler. It returns
-- answer-free prompts and opaque media delivery ids only.
create or replace function public.course_create_or_resume_form(
  p_user_id uuid,
  p_course_id text,
  p_assessment_id text,
  p_allocation_version text,
  p_seed text
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_form public.formal_forms;
  v_visual_count integer;
  v_nonvisual_count integer;
begin
  if not exists (
    select 1 from private.assessment_definitions
    where allocation_version=p_allocation_version and assessment_id=p_assessment_id
  ) then raise exception 'Unknown or unseeded assessment'; end if;

  insert into public.formal_forms(user_id, course_id, assessment_id, allocation_version, seed)
  values (p_user_id, p_course_id, p_assessment_id, p_allocation_version, p_seed)
  on conflict (user_id, course_id, assessment_id, allocation_version) do nothing;

  select * into v_form from public.formal_forms
  where user_id=p_user_id and course_id=p_course_id and assessment_id=p_assessment_id
    and allocation_version=p_allocation_version;

  insert into private.form_stations(form_id, station_ordinal, station_id, asset_id)
  select v_form.form_id, target.station_ordinal, target.station_id, target.reserved_asset_id
  from private.formal_station_targets target
  where target.allocation_version=p_allocation_version and target.assessment_id=p_assessment_id
  on conflict (form_id, station_ordinal) do nothing;

  insert into private.nonvisual_form_stations(form_id,item_ordinal,item_id,item_instance_id)
  select v_form.form_id,target.item_ordinal,target.item_id,target.item_instance_id
  from private.nonvisual_form_targets target
  where target.allocation_version=p_allocation_version and target.assessment_id=p_assessment_id
  on conflict (form_id,item_ordinal) do nothing;

  select count(*) into v_visual_count from private.form_stations where form_id=v_form.form_id;
  select count(*) into v_nonvisual_count from private.nonvisual_form_stations where form_id=v_form.form_id;
  if v_visual_count + v_nonvisual_count = 0 then raise exception 'No private items exist for the requested assessment'; end if;

  return jsonb_build_object(
    'formId',v_form.form_id,
    'assessmentId',v_form.assessment_id,
    'status',v_form.status,
    'formKind',case when v_visual_count>0 and v_nonvisual_count>0 then 'mixed' when v_visual_count>0 then 'visual' else 'nonvisual' end,
    'stations',coalesce((
      select jsonb_agg(jsonb_build_object(
        'stationNumber',station.station_ordinal,
        'presentationId',v_form.form_id::text || ':v:' || station.station_ordinal::text,
        'modality',asset.modality,
        'deliveryAssetId',asset.delivery_asset_id,
        'attribution',asset.attribution,
        'licenseCode',asset.license_code,
        'submitted',station.submitted_at is not null
      ) order by station.station_ordinal)
      from private.form_stations station join private.media_assets asset on asset.asset_id=station.asset_id
      where station.form_id=v_form.form_id
    ),'[]'::jsonb),
    'items',coalesce((
      select jsonb_agg(jsonb_build_object(
        'itemNumber',station.item_ordinal,
        'itemInstanceId',station.item_instance_id,
        'prompt',item.prompt,
        'responseSchema',item.response_schema,
        'pointValue',(item.private_scoring->>'max_points')::numeric,
        'submitted',station.submitted_at is not null
      ) order by station.item_ordinal)
      from private.nonvisual_form_stations station join private.nonvisual_items item on item.item_id=station.item_id
      where station.form_id=v_form.form_id
    ),'[]'::jsonb)
  );
end;
$$;

create or replace function private.course_refresh_form(p_form_id uuid) returns text
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_form public.formal_forms;
  v_total integer;
  v_submitted integer;
  v_pending integer;
  v_earned numeric;
  v_definition private.assessment_definitions;
  v_event_id uuid;
  v_row record;
begin
  select * into v_form from public.formal_forms where form_id=p_form_id;
  if not found then raise exception 'Unknown form'; end if;
  select
    (select count(*) from private.form_stations where form_id=p_form_id) +
    (select count(*) from private.nonvisual_form_stations where form_id=p_form_id),
    (select count(*) from private.form_stations where form_id=p_form_id and submitted_at is not null) +
    (select count(*) from private.nonvisual_form_stations where form_id=p_form_id and submitted_at is not null),
    (select count(*) from private.form_stations where form_id=p_form_id and score->>'reviewStatus'='pending') +
    (select count(*) from private.nonvisual_form_stations where form_id=p_form_id and score->>'reviewStatus'='pending')
  into v_total,v_submitted,v_pending;
  if v_submitted < v_total then
    update public.formal_forms set status='in_progress' where form_id=p_form_id;
    return 'in_progress';
  end if;
  if v_pending > 0 then
    update public.formal_forms set status='awaiting_review',submitted_at=coalesce(submitted_at,now()) where form_id=p_form_id;
    return 'awaiting_review';
  end if;

  select * into v_definition from private.assessment_definitions
  where allocation_version=v_form.allocation_version and assessment_id=v_form.assessment_id;
  select coalesce(sum(points),0) into v_earned from (
    select (score->>'awardedPoints')::numeric as points from private.form_stations where form_id=p_form_id
    union all
    select (score->>'awardedPoints')::numeric from private.nonvisual_form_stations where form_id=p_form_id
  ) scored;

  insert into public.gradebook(user_id,course_id,assessment_id,category_id,points_earned,points_possible,category_weight,attempt_number,submitted_at,locked_at,grading_audit)
  values (v_form.user_id,v_form.course_id,v_form.assessment_id,v_definition.category_id,v_earned,v_definition.points_possible,v_definition.category_weight,1,coalesce(v_form.submitted_at,now()),now(),jsonb_build_object('formId',p_form_id,'allocationVersion',v_form.allocation_version,'finalizedAt',now()))
  on conflict (user_id,course_id,assessment_id,attempt_number) do update set
    points_earned=excluded.points_earned,points_possible=excluded.points_possible,locked_at=excluded.locked_at,grading_audit=excluded.grading_audit;

  -- Persist one normalized attempt per graded item exactly once.
  for v_row in
    select 'visual'::text part,s.station_ordinal ordinal,s.station_id item_id,a.taxon_id,a.modality,s.response,s.score,a.accepted_answer_keys,a.payload
    from private.form_stations s join private.media_assets a on a.asset_id=s.asset_id where s.form_id=p_form_id
    union all
    select 'nonvisual',s.item_ordinal,s.item_instance_id,coalesce(i.payload->'taxonIds'->>0,null),
      case when i.payload->>'family'='nomenclature' then 'scientific_name' else i.payload->>'family' end,
      s.response,s.score,coalesce(i.private_scoring->'accepted_answers','[]'::jsonb),i.payload
    from private.nonvisual_form_stations s join private.nonvisual_items i on i.item_id=s.item_id where s.form_id=p_form_id
  loop
    if not exists(select 1 from private.recorded_form_items where form_id=p_form_id and part=v_row.part and item_ordinal=v_row.ordinal) then
      v_event_id := gen_random_uuid();
      insert into private.recorded_form_items(form_id,part,item_ordinal,event_id) values (p_form_id,v_row.part,v_row.ordinal,v_event_id);
      insert into public.learning_attempts(event_id,user_id,course_id,assessment_id,item_id,taxon_id,modality,response,score,maximum_score,confidence)
      values (v_event_id,v_form.user_id,v_form.course_id,v_form.assessment_id,v_row.item_id,v_row.taxon_id,v_row.modality,v_row.response,(v_row.score->>'awardedPoints')::numeric,(v_row.score->>'maximumPoints')::numeric,v_row.response->>'confidence');
      perform private.course_update_species_mastery(
        v_form.user_id,v_form.course_id,v_row.taxon_id,v_row.modality,
        (v_row.score->>'awardedPoints')::numeric/(v_row.score->>'maximumPoints')::numeric>=0.8,
        v_row.response->>'confidence'
      );
      if (v_row.score->>'awardedPoints')::numeric < (v_row.score->>'maximumPoints')::numeric then
        insert into public.error_ledger(event_id,user_id,course_id,taxon_id,modality,error_type,incorrect_answer,correct_answer,likely_reason,confuser_involved,diagnostic_trait_missed,expressed_confidence)
        values (v_event_id,v_form.user_id,v_form.course_id,v_row.taxon_id,v_row.modality,
          case when v_row.modality='scientific_name' then 'nomenclature' when v_row.modality='silvics' then 'silvics' when v_row.part='visual' then 'discrimination' else 'knowledge' end,
          coalesce(v_row.response->>'identity',v_row.response->>'answer'),v_row.accepted_answer_keys->>0,
          v_row.score->>'reviewNotes',v_row.response->>'nearestAlternative',v_row.payload->>'visibleIdentityEvidence',v_row.response->>'confidence');
      end if;
    end if;
  end loop;
  update public.formal_forms set status='completed',submitted_at=coalesce(submitted_at,now()) where form_id=p_form_id;
  return 'completed';
end;
$$;

create or replace function public.course_submit_assessment_item(
  p_user_id uuid,p_form_id uuid,p_part text,p_item_ordinal integer,p_response jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_asset private.media_assets;
  v_item private.nonvisual_items;
  v_identity text;
  v_correct boolean;
  v_max numeric;
  v_score jsonb;
  v_status text;
begin
  if not exists(select 1 from public.formal_forms where form_id=p_form_id and user_id=p_user_id and status in ('assembled','in_progress')) then
    raise exception 'Form is unavailable or not owned by this learner';
  end if;
  if p_part='visual' then
    select a.* into v_asset from private.form_stations s join private.media_assets a on a.asset_id=s.asset_id
    where s.form_id=p_form_id and s.station_ordinal=p_item_ordinal and s.submitted_at is null;
    if not found then raise exception 'Visual station is absent or already submitted'; end if;
    v_identity := lower(regexp_replace(coalesce(p_response->>'identity',''),'[^[:alnum:]]+','','g'));
    select exists(select 1 from jsonb_array_elements_text(v_asset.accepted_answer_keys) a where lower(regexp_replace(a,'[^[:alnum:]]+','','g'))=v_identity) into v_correct;
    v_score := jsonb_build_object('awardedPoints',case when v_correct then 4 else 0 end,'maximumPoints',10,'identityAccepted',v_correct,'reviewStatus','pending');
    update private.form_stations set response=p_response,score=v_score,submitted_at=now() where form_id=p_form_id and station_ordinal=p_item_ordinal;
  elsif p_part='nonvisual' then
    select i.* into v_item from private.nonvisual_form_stations s join private.nonvisual_items i on i.item_id=s.item_id
    where s.form_id=p_form_id and s.item_ordinal=p_item_ordinal and s.submitted_at is null;
    if not found then raise exception 'Nonvisual item is absent or already submitted'; end if;
    v_max := (v_item.private_scoring->>'max_points')::numeric;
    if v_item.private_scoring->>'mode'='normalized_exact_match' then
      v_identity := lower(regexp_replace(coalesce(p_response->>'answer',''),'[^[:alnum:]]+','','g'));
      select exists(select 1 from jsonb_array_elements_text(v_item.private_scoring->'accepted_answers') a where lower(regexp_replace(a,'[^[:alnum:]]+','','g'))=v_identity) into v_correct;
      v_score := jsonb_build_object('awardedPoints',case when v_correct then v_max else 0 end,'maximumPoints',v_max,'answerAccepted',v_correct,'reviewStatus','complete');
    else
      v_score := jsonb_build_object('awardedPoints',0,'maximumPoints',v_max,'reviewStatus','pending');
    end if;
    update private.nonvisual_form_stations set response=p_response,score=v_score,submitted_at=now() where form_id=p_form_id and item_ordinal=p_item_ordinal;
  else raise exception 'Unknown assessment part'; end if;
  v_status := private.course_refresh_form(p_form_id);
  return jsonb_build_object('accepted',true,'part',p_part,'itemNumber',p_item_ordinal,'formStatus',v_status);
end;
$$;

create or replace function public.course_review_assessment_item(
  p_form_id uuid,p_part text,p_item_ordinal integer,p_awarded_points numeric,p_review_notes text,p_reviewer text
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare v_max numeric; v_status text;
begin
  if p_part='visual' then
    select (score->>'maximumPoints')::numeric into v_max from private.form_stations where form_id=p_form_id and station_ordinal=p_item_ordinal and submitted_at is not null;
    if v_max is null then raise exception 'Submitted visual station not found'; end if;
    update private.form_stations set score=score || jsonb_build_object('awardedPoints',p_awarded_points,'reviewStatus','complete','reviewNotes',p_review_notes,'reviewer',p_reviewer,'reviewedAt',now()) where form_id=p_form_id and station_ordinal=p_item_ordinal;
  elsif p_part='nonvisual' then
    select (score->>'maximumPoints')::numeric into v_max from private.nonvisual_form_stations where form_id=p_form_id and item_ordinal=p_item_ordinal and submitted_at is not null;
    if v_max is null then raise exception 'Submitted nonvisual item not found'; end if;
    update private.nonvisual_form_stations set score=score || jsonb_build_object('awardedPoints',p_awarded_points,'reviewStatus','complete','reviewNotes',p_review_notes,'reviewer',p_reviewer,'reviewedAt',now()),reviewed_at=now() where form_id=p_form_id and item_ordinal=p_item_ordinal;
  else raise exception 'Unknown assessment part'; end if;
  if p_awarded_points < 0 or p_awarded_points > v_max then raise exception 'Awarded points outside rubric bounds'; end if;
  v_status := private.course_refresh_form(p_form_id);
  return jsonb_build_object('reviewed',true,'formStatus',v_status);
end;
$$;

create or replace function public.course_grade_summary(p_user_id uuid,p_course_id text) returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  with scores as (
    select category_id,category_weight,points_earned/points_possible as pct from public.gradebook
    where user_id=p_user_id and course_id=p_course_id and locked_at is not null
  ), categories as (
    select category_id,max(category_weight) weight,
      case when category_id='weekly_identification_practicals'
        then (sum(pct)-0.5*min(pct))/nullif(count(*)-0.5,0)
        else avg(pct) end as category_pct,
      count(*) assessment_count
    from scores group by category_id
  )
  select jsonb_build_object(
    'runningGrade',round(100*sum(weight*category_pct)/nullif(sum(weight),0),2),
    'earnedWeight',sum(weight),
    'categories',coalesce(jsonb_agg(jsonb_build_object('categoryId',category_id,'weight',weight,'percentage',round(100*category_pct,2),'assessmentCount',assessment_count) order by category_id),'[]'::jsonb)
  ) from categories;
$$;

create or replace function public.course_review_queue() returns jsonb
language sql
security definer
set search_path = public, private, pg_temp
as $$
  select coalesce(jsonb_agg(to_jsonb(queue_row) order by queue_row.submitted_at,queue_row.form_id,queue_row.item_number),'[]'::jsonb)
  from (
    select f.form_id,f.assessment_id,'visual'::text part,s.station_ordinal item_number,s.submitted_at,
      s.response,s.score,(s.score->>'maximumPoints')::numeric maximum_points,
      jsonb_build_object('acceptedAnswers',a.accepted_answer_keys,'rubric',a.payload) private_rubric,
      a.source_image_url,a.attribution,a.license_code
    from public.formal_forms f
    join private.form_stations s on s.form_id=f.form_id
    join private.media_assets a on a.asset_id=s.asset_id
    where s.score->>'reviewStatus'='pending'
    union all
    select f.form_id,f.assessment_id,'nonvisual',s.item_ordinal,s.submitted_at,
      s.response,s.score,(s.score->>'maximumPoints')::numeric,
      i.private_scoring,null::text,null::text,null::text
    from public.formal_forms f
    join private.nonvisual_form_stations s on s.form_id=f.form_id
    join private.nonvisual_items i on i.item_id=s.item_id
    where s.score->>'reviewStatus'='pending'
  ) queue_row;
$$;

revoke all on function public.course_submit_assessment_item(uuid,uuid,text,integer,jsonb) from public,anon,authenticated;
revoke all on function public.course_review_assessment_item(uuid,text,integer,numeric,text,text) from public,anon,authenticated;
revoke all on function public.course_grade_summary(uuid,text) from public,anon,authenticated;
revoke all on function public.course_review_queue() from public,anon,authenticated;
grant execute on function public.course_submit_assessment_item(uuid,uuid,text,integer,jsonb) to service_role;
grant execute on function public.course_review_assessment_item(uuid,text,integer,numeric,text,text) to service_role;
grant execute on function public.course_grade_summary(uuid,text) to service_role;
grant execute on function public.course_review_queue() to service_role;

revoke all on all tables in schema private from public,anon,authenticated;
grant usage on schema private to service_role;
grant all on all tables in schema private to service_role;
grant execute on function private.course_refresh_form(uuid) to service_role;
