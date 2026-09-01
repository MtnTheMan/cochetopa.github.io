-- Northern Hardwoods & Mixedwoods course persistence and private form store.
-- Apply with Supabase migrations after creating the project. Never place the
-- private seed data or service-role key in the public repository.

create extension if not exists pgcrypto;
create schema if not exists private;

create table if not exists public.learner_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  course_id text not null,
  enrolled_at timestamptz not null default now(),
  pace_preference text not null default 'self_paced' check (pace_preference in ('leisurely','self_paced','serious')),
  current_week smallint not null default 1 check (current_week between 1 and 10),
  last_active_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.course_state_snapshots (
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  course_version text not null,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, course_id)
);

create table if not exists public.route_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  route_id text not null,
  status text not null check (status in ('not_started','in_progress','completed','remediation_due')),
  completion_percent numeric(5,2) not null default 0 check (completion_percent between 0 and 100),
  last_position jsonb not null default '{}'::jsonb,
  first_started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, course_id, route_id)
);

create table if not exists public.species_mastery (
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  taxon_id text not null,
  introduced_on date,
  mastery_state text not null default 'New' check (mastery_state in ('New','Learning','Recognized','Multi-organ Mastery','Certified')),
  foliage_attempts integer not null default 0,
  foliage_correct integer not null default 0,
  bark_attempts integer not null default 0,
  bark_correct integer not null default 0,
  reproductive_attempts integer not null default 0,
  reproductive_correct integer not null default 0,
  dormant_attempts integer not null default 0,
  dormant_correct integer not null default 0,
  whole_tree_attempts integer not null default 0,
  whole_tree_correct integer not null default 0,
  condition_attempts integer not null default 0,
  condition_correct integer not null default 0,
  scientific_name_attempts integer not null default 0,
  scientific_name_correct integer not null default 0,
  silvics_attempts integer not null default 0,
  silvics_correct integer not null default 0,
  confuser_attempts integer not null default 0,
  confuser_correct integer not null default 0,
  consecutive_correct integer not null default 0,
  confidence_calibration numeric(5,2),
  last_tested_at timestamptz,
  next_due_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, course_id, taxon_id),
  check (foliage_correct <= foliage_attempts and bark_correct <= bark_attempts and reproductive_correct <= reproductive_attempts),
  check (dormant_correct <= dormant_attempts and whole_tree_correct <= whole_tree_attempts and condition_correct <= condition_attempts),
  check (scientific_name_correct <= scientific_name_attempts and silvics_correct <= silvics_attempts and confuser_correct <= confuser_attempts)
);

create table if not exists public.learning_attempts (
  event_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  assessment_id text,
  route_id text,
  item_id text not null,
  taxon_id text,
  modality text,
  response jsonb not null,
  score numeric(8,3) not null default 0,
  maximum_score numeric(8,3) not null default 0,
  confidence text check (confidence is null or confidence in ('low','medium','high')),
  submitted_at timestamptz not null default now()
);

create table if not exists public.error_ledger (
  error_id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.learning_attempts(event_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  taxon_id text,
  modality text,
  error_type text not null check (error_type in ('knowledge','discrimination','nomenclature','overconfidence','silvics')),
  incorrect_answer text,
  correct_answer text,
  likely_reason text,
  confuser_involved text,
  diagnostic_trait_missed text,
  expressed_confidence text,
  created_at timestamptz not null default now()
);

create table if not exists public.gradebook (
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  assessment_id text not null,
  category_id text not null,
  points_earned numeric(10,3) not null,
  points_possible numeric(10,3) not null check (points_possible > 0),
  category_weight numeric(6,5) not null check (category_weight between 0 and 1),
  attempt_number integer not null default 1 check (attempt_number >= 1),
  submitted_at timestamptz not null,
  locked_at timestamptz,
  grading_audit jsonb not null default '{}'::jsonb,
  primary key (user_id, course_id, assessment_id, attempt_number)
);

create table if not exists public.reminder_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  opted_in boolean not null default false,
  cadence text not null default 'weekly' check (cadence in ('off','weekly','twice_weekly','due_only')),
  timezone text not null default 'America/New_York',
  quiet_hours_start time,
  quiet_hours_end time,
  last_sent_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, course_id)
);

create table if not exists public.formal_forms (
  form_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  assessment_id text not null,
  allocation_version text not null,
  seed text not null,
  status text not null default 'assembled' check (status in ('assembled','in_progress','submitted','locked','voided')),
  current_station integer not null default 1,
  assembled_at timestamptz not null default now(),
  submitted_at timestamptz,
  unique (user_id, course_id, assessment_id, allocation_version)
);

create table if not exists private.media_assets (
  asset_id text primary key,
  specimen_id text not null unique,
  delivery_asset_id text not null unique,
  taxon_id text not null,
  modality text not null,
  maximum_defensible_rank text not null,
  accepted_answer_keys jsonb not null,
  source_image_url text not null,
  attribution text not null,
  license_code text not null,
  payload jsonb not null default '{}'::jsonb
);

create table if not exists private.formal_station_targets (
  allocation_version text not null,
  assessment_id text not null,
  station_ordinal integer not null,
  station_id text not null,
  reserved_asset_id text not null references private.media_assets(asset_id),
  taxon_id text not null,
  modality text not null,
  answer_class text not null,
  rubric jsonb not null default '{}'::jsonb,
  primary key (allocation_version, assessment_id, station_ordinal),
  unique (allocation_version, station_id)
);

create table if not exists private.form_stations (
  form_id uuid not null references public.formal_forms(form_id) on delete cascade,
  station_ordinal integer not null,
  station_id text not null,
  asset_id text not null references private.media_assets(asset_id),
  response jsonb,
  score jsonb,
  presented_at timestamptz,
  submitted_at timestamptz,
  primary key (form_id, station_ordinal),
  unique (form_id, asset_id)
);

create index if not exists idx_learning_attempts_user_course_taxon_time on public.learning_attempts(user_id, course_id, taxon_id, submitted_at desc);
create index if not exists idx_error_ledger_user_course_taxon_time on public.error_ledger(user_id, course_id, taxon_id, created_at desc);
create index if not exists idx_mastery_user_course_due on public.species_mastery(user_id, course_id, next_due_at);
create index if not exists idx_gradebook_user_course_category on public.gradebook(user_id, course_id, category_id);
create index if not exists idx_formal_forms_user_course_status on public.formal_forms(user_id, course_id, status);
create index if not exists idx_form_stations_form_submission on private.form_stations(form_id, submitted_at);

alter table public.learner_profiles enable row level security;
alter table public.course_state_snapshots enable row level security;
alter table public.route_progress enable row level security;
alter table public.species_mastery enable row level security;
alter table public.learning_attempts enable row level security;
alter table public.error_ledger enable row level security;
alter table public.gradebook enable row level security;
alter table public.reminder_preferences enable row level security;
alter table public.formal_forms enable row level security;

create policy "own learner profile" on public.learner_profiles for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own course snapshot" on public.course_state_snapshots for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own route progress" on public.route_progress for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own species mastery" on public.species_mastery for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own learning attempts" on public.learning_attempts for select to authenticated using ((select auth.uid()) = user_id);
create policy "insert own learning attempts" on public.learning_attempts for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own error ledger" on public.error_ledger for select to authenticated using ((select auth.uid()) = user_id);
create policy "insert own error ledger" on public.error_ledger for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own gradebook" on public.gradebook for select to authenticated using ((select auth.uid()) = user_id);
create policy "own reminder preferences" on public.reminder_preferences for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own formal form metadata" on public.formal_forms for select to authenticated using ((select auth.uid()) = user_id);

revoke all on schema private from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;
grant usage on schema public to authenticated;
grant select, insert, update on public.learner_profiles, public.course_state_snapshots, public.route_progress, public.species_mastery, public.reminder_preferences to authenticated;
grant select, insert on public.learning_attempts, public.error_ledger to authenticated;
grant select on public.gradebook, public.formal_forms to authenticated;

-- Idempotent, atomic event capture. Server scoring supplies a stable UUID and
-- may include an error row; duplicate retries return without double counting.
create or replace function public.record_learning_event(
  p_event_id uuid,
  p_course_id text,
  p_attempt jsonb,
  p_error jsonb default null
) returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  inserted_count integer;
begin
  insert into public.learning_attempts(
    event_id, user_id, course_id, assessment_id, route_id, item_id, taxon_id,
    modality, response, score, maximum_score, confidence, submitted_at
  ) values (
    p_event_id, (select auth.uid()), p_course_id,
    p_attempt->>'assessment_id', p_attempt->>'route_id', p_attempt->>'item_id',
    p_attempt->>'taxon_id', p_attempt->>'modality', coalesce(p_attempt->'response', '{}'::jsonb),
    coalesce((p_attempt->>'score')::numeric, 0), coalesce((p_attempt->>'maximum_score')::numeric, 0),
    p_attempt->>'confidence', coalesce((p_attempt->>'submitted_at')::timestamptz, now())
  ) on conflict (event_id) do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then return false; end if;
  if p_error is not null then
    insert into public.error_ledger(
      event_id, user_id, course_id, taxon_id, modality, error_type,
      incorrect_answer, correct_answer, likely_reason, confuser_involved,
      diagnostic_trait_missed, expressed_confidence
    ) values (
      p_event_id, (select auth.uid()), p_course_id, p_attempt->>'taxon_id', p_attempt->>'modality',
      p_error->>'error_type', p_error->>'incorrect_answer', p_error->>'correct_answer',
      p_error->>'likely_reason', p_error->>'confuser_involved',
      p_error->>'diagnostic_trait_missed', p_attempt->>'confidence'
    );
  end if;
  return true;
end;
$$;

grant execute on function public.record_learning_event(uuid, text, jsonb, jsonb) to authenticated;

-- Service-role-only formal delivery functions. The browser never receives a
-- taxon id, source URL, accepted answer key, or private asset identifier.
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
  v_station_count integer;
begin
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

  select count(*) into v_station_count from private.form_stations where form_id=v_form.form_id;
  if v_station_count = 0 then raise exception 'No private stations exist for the requested assessment'; end if;

  return jsonb_build_object(
    'formId', v_form.form_id,
    'assessmentId', v_form.assessment_id,
    'status', v_form.status,
    'currentStation', v_form.current_station,
    'stations', (
      select jsonb_agg(jsonb_build_object(
        'stationNumber', station.station_ordinal,
        'presentationId', v_form.form_id::text || ':' || station.station_ordinal::text,
        'modality', asset.modality,
        'deliveryAssetId', asset.delivery_asset_id,
        'attribution', asset.attribution,
        'licenseCode', asset.license_code,
        'submitted', station.submitted_at is not null
      ) order by station.station_ordinal)
      from private.form_stations station
      join private.media_assets asset on asset.asset_id=station.asset_id
      where station.form_id=v_form.form_id
    )
  );
end;
$$;

create or replace function public.course_submit_form_station(
  p_user_id uuid,
  p_form_id uuid,
  p_station_ordinal integer,
  p_response jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_asset private.media_assets;
  v_identity text;
  v_identity_accepted boolean;
  v_result jsonb;
begin
  if not exists(select 1 from public.formal_forms where form_id=p_form_id and user_id=p_user_id and status in ('assembled','in_progress')) then
    raise exception 'Form is unavailable or not owned by this learner';
  end if;
  select asset.* into v_asset
  from private.form_stations station join private.media_assets asset on asset.asset_id=station.asset_id
  where station.form_id=p_form_id and station.station_ordinal=p_station_ordinal and station.submitted_at is null;
  if not found then raise exception 'Station is absent or already submitted'; end if;
  v_identity := lower(regexp_replace(coalesce(p_response->>'identity',''), '[^[:alnum:]]+', '', 'g'));
  select exists(
    select 1 from jsonb_array_elements_text(v_asset.accepted_answer_keys) accepted
    where lower(regexp_replace(accepted, '[^[:alnum:]]+', '', 'g')) = v_identity
  ) into v_identity_accepted;
  v_result := jsonb_build_object(
    'identityAccepted', v_identity_accepted,
    'identityPoints', case when v_identity_accepted then 4 else 0 end,
    'maximumIdentityPoints', 4,
    'reasoningReviewStatus', 'pending_server_or_instructor_rubric'
  );
  update private.form_stations set response=p_response, score=v_result, submitted_at=now()
  where form_id=p_form_id and station_ordinal=p_station_ordinal;
  update public.formal_forms set status='in_progress', current_station=p_station_ordinal+1
  where form_id=p_form_id and user_id=p_user_id;
  return jsonb_build_object('accepted', true, 'stationNumber', p_station_ordinal);
end;
$$;

create or replace function public.course_form_media_source(
  p_user_id uuid,
  p_form_id uuid,
  p_delivery_asset_id text
) returns jsonb
language sql
security definer
set search_path = public, private, pg_temp
as $$
  select jsonb_build_object(
    'sourceImageUrl', asset.source_image_url,
    'attribution', asset.attribution,
    'licenseCode', asset.license_code
  )
  from public.formal_forms form
  join private.form_stations station on station.form_id=form.form_id
  join private.media_assets asset on asset.asset_id=station.asset_id
  where form.form_id=p_form_id and form.user_id=p_user_id
    and asset.delivery_asset_id=p_delivery_asset_id
    and form.status in ('assembled','in_progress');
$$;

revoke all on function public.course_create_or_resume_form(uuid,text,text,text,text) from public, anon, authenticated;
revoke all on function public.course_submit_form_station(uuid,uuid,integer,jsonb) from public, anon, authenticated;
revoke all on function public.course_form_media_source(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.course_create_or_resume_form(uuid,text,text,text,text) to service_role;
grant execute on function public.course_submit_form_station(uuid,uuid,integer,jsonb) to service_role;
grant execute on function public.course_form_media_source(uuid,uuid,text) to service_role;

select pg_catalog.set_config('search_path', 'public', false);
analyze;
