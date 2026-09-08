-- Give every newly assembled secure form a learner-specific, resumable order.
-- Existing in-progress forms keep their stored ordinals and are never reshuffled.
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
  select
    v_form.form_id,
    (row_number() over (
      order by md5(v_form.seed || ':visual:' || target.station_id), target.station_ordinal
    ))::integer,
    target.station_id,
    target.reserved_asset_id
  from private.formal_station_targets target
  where target.allocation_version=p_allocation_version and target.assessment_id=p_assessment_id
  on conflict (form_id, station_ordinal) do nothing;

  insert into private.nonvisual_form_stations(form_id,item_ordinal,item_id,item_instance_id)
  select
    v_form.form_id,
    (row_number() over (
      order by md5(v_form.seed || ':nonvisual:' || target.item_instance_id), target.item_ordinal
    ))::integer,
    target.item_id,
    target.item_instance_id
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
