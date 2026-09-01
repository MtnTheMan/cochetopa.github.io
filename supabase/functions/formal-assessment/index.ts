import { createClient } from "npm:@supabase/supabase-js@2";
import { cors, json } from "../_shared/http.ts";
import { signMediaToken } from "../_shared/token.ts";

Deno.serve(async (request) => {
  const headers = cors(request.headers.get("Origin"));
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, headers);
  try {
    const authHeader = request.headers.get("Authorization") || "";
    const url = Deno.env.get("SUPABASE_URL")!;
    const publishable = Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(url, publishable, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "authentication_required" }, 401, headers);
    const admin = createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
    const body = await request.json();
    if (body.action === "create_or_resume") {
      const courseId = Deno.env.get("COURSE_ID")!;
      const version = Deno.env.get("COURSE_ALLOCATION_VERSION") || "2.0.0";
      const { data, error } = await admin.rpc("course_create_or_resume_form", {
        p_user_id: userData.user.id,
        p_course_id: courseId,
        p_assessment_id: String(body.assessmentId || ""),
        p_allocation_version: version,
        p_seed: crypto.randomUUID(),
      });
      if (error) throw error;
      const stations = await Promise.all(data.stations.map(async (station: Record<string, unknown>) => ({
        stationNumber: station.stationNumber,
        presentationId: station.presentationId,
        modality: station.modality,
        submitted: station.submitted,
        attribution: station.attribution,
        licenseCode: station.licenseCode,
        mediaToken: await signMediaToken({
          uid: userData.user.id,
          fid: data.formId,
          did: station.deliveryAssetId,
          exp: Date.now() + 5 * 60 * 1000,
        }),
      })));
      return json({
        formId: data.formId,
        assessmentId: data.assessmentId,
        status: data.status,
        formKind: data.formKind,
        stations,
        items: data.items || [],
      }, 200, headers);
    }
    if (body.action === "submit_station") {
      const { data, error } = await admin.rpc("course_submit_assessment_item", {
        p_user_id: userData.user.id,
        p_form_id: body.formId,
        p_part: String(body.part || "visual"),
        p_item_ordinal: Number(body.itemNumber || body.stationNumber),
        p_response: body.response || {},
      });
      if (error) throw error;
      return json(data, 200, headers);
    }
    if (body.action === "grade_summary") {
      const { data, error } = await admin.rpc("course_grade_summary", {
        p_user_id: userData.user.id,
        p_course_id: Deno.env.get("COURSE_ID")!,
      });
      if (error) throw error;
      return json(data || { runningGrade: null, earnedWeight: 0, categories: [] }, 200, headers);
    }
    if (body.action === "review_queue" || body.action === "review_item") {
      const reviewers = (Deno.env.get("COURSE_REVIEWER_EMAILS") || "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean);
      if (!userData.user.email || !reviewers.includes(userData.user.email.toLowerCase())) {
        return json({ error: "reviewer_authorization_required" }, 403, headers);
      }
      if (body.action === "review_queue") {
        const { data, error } = await admin.rpc("course_review_queue");
        if (error) throw error;
        const queue = (data || []).map((item: Record<string, unknown>) => ({
          formId: item.form_id,
          assessmentId: item.assessment_id,
          part: item.part,
          itemNumber: item.item_number,
          submittedAt: item.submitted_at,
          response: item.response,
          score: item.score,
          maximumPoints: item.maximum_points,
          privateRubric: item.private_rubric,
          attribution: item.attribution,
          licenseCode: item.license_code,
          mediaUrl: item.source_image_url || null,
        }));
        return json({ queue }, 200, headers);
      }
      const { data, error } = await admin.rpc("course_review_assessment_item", {
        p_form_id: body.formId,
        p_part: body.part,
        p_item_ordinal: Number(body.itemNumber),
        p_awarded_points: Number(body.awardedPoints),
        p_review_notes: String(body.reviewNotes || ""),
        p_reviewer: userData.user.email,
      });
      if (error) throw error;
      return json(data, 200, headers);
    }
    return json({ error: "unknown_action" }, 400, headers);
  } catch (error) {
    console.error(error);
    return json({ error: "formal_assessment_request_failed" }, 400, headers);
  }
});
