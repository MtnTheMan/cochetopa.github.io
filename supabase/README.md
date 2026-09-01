# Course backend activation

The public Jekyll course works without this backend and stores progress locally. Activate cloud features only after creating a Supabase project and a Cloudflare Turnstile widget.

1. Create the Supabase project, set the Auth Site URL to `https://cochetopa.co/course/`, and allow the exact production and local callback URLs.
2. In Supabase Auth, enable email passwordless sign-in and Cloudflare Turnstile CAPTCHA protection. Configure the Turnstile secret in the dashboard; never place it in this repository.
3. Apply `migrations/202608310001_course_schema.sql` followed by `migrations/202609010002_nonvisual_grading.sql`, then inspect all row-level-security policies.
4. Configure a production SMTP provider and customize the magic-link/OTP email. Supabase's default sender is for development and is rate-limited.
5. Set the Edge Function secrets listed in `.env.example`. The service-role key and media-token secret are server-only.
6. Run both private seed builders from the course-authoring workspace. Apply the ignored outputs `deployment/private_supabase_seed.sql` and `deployment/private_nonvisual_seed.sql` privately. Together they insert 558 examination assets, 352 nonvisual items, all form targets, and 32 gradebook definitions into the `private` schema.
7. Deploy the formal assessment/media Edge Functions, set `COURSE_REVIEWER_EMAILS` to the instructor account(s), then run authorization and answer-leakage integration tests. Exact nomenclature is normalized and scored automatically. Visual reasoning, silvics, and regional reasoning enter the protected `/course/#/review` criterion queue. Recording the final rubric score causes the server to finalize the form, normalized attempts, species mastery, Error Ledger entries, and gradebook row.
8. Verify `cochetopa.co` in Resend, store `RESEND_API_KEY`, deploy `send-course-reminders`, and schedule the example through Supabase Cron/Vault. Reminders are sent only for an explicit `opted_in=true` preference and use an idempotency key.
9. Put only the Supabase URL, publishable key, and public Turnstile site key in `assets/course/data/runtime-config.json`, then set `cloudFeaturesEnabled` to `true`.

Do not commit a private seed, service-role key, Turnstile secret, formal allocation, examination source URL, accepted answer key, or server media token.
