# slack-ingest

Supabase Edge Function that turns Slack `#moments` photo posts into Moments wall entries.

## What it does
Slack calls this function on each new channel message. It verifies the Slack signature,
and for image messages it downloads the photo, uploads it to the Supabase `photos` bucket,
and upserts a row into `posts` (idempotent on `slack_key`). Supabase Realtime then pushes
it live to the wall. **No secrets live in the front-end** — only here, as function env.

## Test (no secrets needed)
```bash
deno test supabase/functions/slack-ingest/ --allow-net --allow-env --no-check
```

## Deploy + wire up (needs your Supabase + Slack admin)

1. **DB migration** — apply `supabase/migrations/0001_posts_slack_dedupe.sql`
   (`supabase db push`, or paste into the Supabase SQL editor).

2. **Create a Slack app** at api.slack.com/apps → From scratch.
   - Bot Token Scopes: `channels:history`, `files:read`, `users:read`
   - Install to workspace → copy the **Bot Token** (`xoxb-…`) and the **Signing Secret**.

3. **Deploy + secrets**
   ```bash
   supabase functions deploy slack-ingest --no-verify-jwt
   supabase secrets set \
     SLACK_SIGNING_SECRET="<signing secret>" \
     SLACK_BOT_TOKEN="xoxb-..." \
     MOMENTS_CHANNEL_ID="<#moments channel id>" \
     SLACK_USER_MAP='{"U_SLACKID_PAOLO":"paolo","U_SLACKID_KASH":"kashish"}'
   ```
   (`--no-verify-jwt` lets Slack reach it; the Slack signature is our auth. `SUPABASE_URL`
   and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.)

4. **Event subscription** — Slack app → Event Subscriptions → Enable →
   Request URL = `https://<project-ref>.functions.supabase.co/slack-ingest`
   (verifies via the `url_verification` handshake) → subscribe to bot event
   `message.channels` → reinstall if prompted.

5. **Go live** — `/invite @Moments` into `#moments`, post a photo. It should appear on the
   wall within seconds, on today's date, as the mapped person. Reposting the same image
   (Slack retry) won't double-post.

## Files
- `verify.ts` — Slack HMAC signature check (+ 5-min replay window)
- `map.ts` — pure Slack-event → post-draft mapping
- `index.ts` — HTTP handler: verify → map → download → upload → upsert
- `*_test.ts` — Deno unit tests (15, all passing)
