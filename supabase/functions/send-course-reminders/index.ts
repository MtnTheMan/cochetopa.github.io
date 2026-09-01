import { createClient } from "npm:@supabase/supabase-js@2";

function dueForCadence(cadence: string, lastSent: string | null) {
  if (!lastSent) return true;
  const elapsedDays = (Date.now() - new Date(lastSent).getTime()) / 86400000;
  if (cadence === "twice_weekly") return elapsedDays >= 3;
  if (cadence === "weekly" || cadence === "due_only") return elapsedDays >= 7;
  return false;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const expected = Deno.env.get("COURSE_CRON_SECRET");
  if (!expected || request.headers.get("x-course-cron-secret") !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendKey = Deno.env.get("RESEND_API_KEY")!;
  const from = Deno.env.get("COURSE_EMAIL_FROM")!;
  const courseId = Deno.env.get("COURSE_ID")!;
  const admin = createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: preferences, error } = await admin
    .from("reminder_preferences")
    .select("user_id,cadence,last_sent_at")
    .eq("course_id", courseId)
    .eq("opted_in", true)
    .neq("cadence", "off");
  if (error) throw error;
  let sent = 0;
  let skipped = 0;
  for (const preference of preferences || []) {
    if (!dueForCadence(preference.cadence, preference.last_sent_at)) { skipped += 1; continue; }
    const [{ data: profile }, { count: dueCount }, { data: userResult }] = await Promise.all([
      admin.from("learner_profiles").select("current_week,last_active_at").eq("user_id", preference.user_id).eq("course_id", courseId).maybeSingle(),
      admin.from("species_mastery").select("taxon_id", { count: "exact", head: true }).eq("user_id", preference.user_id).eq("course_id", courseId).lte("next_due_at", new Date().toISOString()),
      admin.auth.admin.getUserById(preference.user_id),
    ]);
    const email = userResult?.user?.email;
    if (!email) { skipped += 1; continue; }
    if (preference.cadence === "due_only" && !dueCount) { skipped += 1; continue; }
    const week = profile?.current_week || 1;
    const subject = dueCount
      ? `${dueCount} tree ${dueCount === 1 ? "species is" : "species are"} due for retrieval`
      : `Your Week ${week} northern-hardwoods field session is ready`;
    const text = [
      `Your Cochetopa Northern Hardwoods & Mixedwoods course is waiting at Week ${week}.`,
      dueCount ? `${dueCount} species are due in your spaced-retrieval queue.` : "A short return session will keep organ-specific recognition durable.",
      "Resume: https://cochetopa.co/course/",
      "You opted in to these reminders. Change or turn them off from your course account.",
    ].join("\n\n");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `course-reminder-${preference.user_id}-${new Date().toISOString().slice(0,10)}`,
      },
      body: JSON.stringify({ from, to: [email], subject, text }),
    });
    if (!response.ok) { console.error(await response.text()); skipped += 1; continue; }
    await admin.from("reminder_preferences").update({ last_sent_at: new Date().toISOString() }).eq("user_id", preference.user_id).eq("course_id", courseId);
    sent += 1;
  }
  return Response.json({ sent, skipped }, { headers: { "Cache-Control": "no-store" } });
});
