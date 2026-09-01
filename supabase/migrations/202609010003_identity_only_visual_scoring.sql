-- Make secure visual assessments quick-identification exercises.
-- A correct common or scientific name receives the full station score.
-- Confidence and field-reasoning fields remain optional learning metadata.

update private.form_stations
set score = jsonb_build_object(
  'awardedPoints', case when coalesce((score->>'identityAccepted')::boolean, false) then 10 else 0 end,
  'maximumPoints', 10,
  'identityAccepted', coalesce((score->>'identityAccepted')::boolean, false),
  'reviewStatus', 'complete',
  'reviewNotes', 'Identity-only scoring'
)
where score->>'reviewStatus' = 'pending';

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
    if v_identity = '' then raise exception 'A common or scientific name is required'; end if;
    select exists(select 1 from jsonb_array_elements_text(v_asset.accepted_answer_keys) a where lower(regexp_replace(a,'[^[:alnum:]]+','','g'))=v_identity) into v_correct;
    v_score := jsonb_build_object(
      'awardedPoints',case when v_correct then 10 else 0 end,
      'maximumPoints',10,
      'identityAccepted',v_correct,
      'reviewStatus','complete',
      'reviewNotes','Identity-only scoring'
    );
    update private.form_stations set response=p_response,score=v_score,submitted_at=now() where form_id=p_form_id and station_ordinal=p_item_ordinal;
  elsif p_part='nonvisual' then
    select i.* into v_item from private.nonvisual_form_stations s join private.nonvisual_items i on i.item_id=s.item_id
    where s.form_id=p_form_id and s.item_ordinal=p_item_ordinal and s.submitted_at is null;
    if not found then raise exception 'Nonvisual item is absent or already submitted'; end if;
    v_max := (v_item.private_scoring->>'max_points')::numeric;
    if nullif(trim(p_response->>'answer'),'') is null then raise exception 'An answer is required'; end if;
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

-- Re-evaluate any already-submitted pilot forms under the new identity-only rule.
do $$
declare v_form_id uuid;
begin
  for v_form_id in
    select distinct f.form_id
    from public.formal_forms f
    join private.form_stations s on s.form_id=f.form_id
    where f.status='awaiting_review' and s.score->>'reviewNotes'='Identity-only scoring'
  loop
    perform private.course_refresh_form(v_form_id);
  end loop;
end;
$$;

revoke all on function public.course_submit_assessment_item(uuid,uuid,text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.course_submit_assessment_item(uuid,uuid,text,integer,jsonb) to service_role;
