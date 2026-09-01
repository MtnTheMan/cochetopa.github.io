import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyMediaToken } from "../_shared/token.ts";

Deno.serve(async (request) => {
  try {
    const token = new URL(request.url).searchParams.get("token") || "";
    const payload = await verifyMediaToken(token);
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await admin.rpc("course_form_media_source", {
      p_user_id: payload.uid,
      p_form_id: payload.fid,
      p_delivery_asset_id: payload.did,
    });
    if (error || !data?.sourceImageUrl) return new Response("Not found", { status: 404 });
    const source = await fetch(data.sourceImageUrl, { redirect: "follow" });
    if (!source.ok || !source.body) return new Response("Not found", { status: 404 });
    return new Response(source.body, {
      status: 200,
      headers: {
        "Content-Type": source.headers.get("Content-Type") || "image/jpeg",
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
        "X-Course-Media-License": data.licenseCode,
        "X-Course-Media-Attribution": encodeURIComponent(data.attribution),
      },
    });
  } catch (error) {
    console.error(error);
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
});
