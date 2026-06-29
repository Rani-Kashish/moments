# Moments — Slack Ingest + Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let teammates post a photo + caption in a Slack `#moments` channel and have it appear automatically on the existing Moments wall, while locking down the Supabase backend — all free, on accounts Kashish already owns.

**Architecture:** Keep the existing static front-end and Supabase backend unchanged. Add one Supabase **Edge Function** (`slack-ingest`, Deno/TypeScript) that Slack calls on each new message: it verifies the Slack signature, downloads any image, re-uploads it to the Supabase `photos` bucket, and inserts a `posts` row. Supabase Realtime then pushes it live to every open page. Secrets live only in the function's environment — never in the public page.

**Tech Stack:** Supabase (Postgres + Storage + Edge Functions/Deno), Slack Events API, Deno test runner, `supabase` CLI.

## Global Constraints

- **Cost: £0.** Only Supabase free tier + a Slack app in Kashish's workspace. No new paid services.
- **No secrets in the front-end.** `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, and the service-role key exist ONLY as Edge Function env vars/Supabase secrets.
- **Repo stays public.** GitHub Pages (free) serves the live site from the public `main`; do not make it private.
- **Do not modify** the existing `posts`/`comments`/`reactions` schema or the front-end render code. The Slack path writes the SAME `posts` shape the app already reads: `{author, post_date, caption, stickers[], border, photos[]}`.
- **Existing people map** (`PEOPLE` ids in `index.html`): `paolo, evgeniya, mollie, usama, wei, kashish`. Slack users map onto these ids.
- Slack requires the webhook to respond **HTTP 200 within 3 seconds**.
- Slack retries deliver duplicates; ingestion must be **idempotent** (one Slack message → at most one `posts` row).

---

## Phase 0 — Security hardening (Supabase dashboard; no app code)

> These are manual dashboard actions, grouped as one reviewable task. Do them first — they protect live data regardless of the Slack work.

### Task 0: Lock down Supabase RLS and credentials

**Files:** none (Supabase dashboard + SQL editor).

- [ ] **Step 1: Confirm RLS is enabled on all three tables**

In Supabase → Table editor, verify `posts`, `comments`, `reactions` each show "RLS enabled". If not, enable it (Database → Tables → ⋮ → Enable RLS).

- [ ] **Step 2: Replace permissive policies with intent-specific ones**

In the SQL editor, run (review before running — adjust if you already have stricter policies):

```sql
-- READ: anyone with the anon key may read the wall (it's a team scrapbook).
-- If you want it private later, this is the line to tighten (Phase 3 / Auth).
drop policy if exists "anon read posts" on posts;
create policy "anon read posts" on posts for select using (true);

-- INSERT: allow anon to add posts (the app + Slack function both insert).
drop policy if exists "anon insert posts" on posts;
create policy "anon insert posts" on posts for insert with check (true);

-- DELETE/UPDATE: DENY for anon. (No policy = denied under RLS.)
-- The front-end "delete your own" still works because deletes will be
-- routed through the service role later if needed; for now, lock them.
drop policy if exists "anon delete posts" on posts;
drop policy if exists "anon update posts" on posts;
```

Repeat the read/insert pattern for `comments` and `reactions` (they need anon insert + read; deny update/delete).

- [ ] **Step 3: Verify anon can read but NOT delete**

Run from a terminal (anon key is already public on the live site, so this is safe):

```bash
URL="https://ixpnrowbiksynhgvozva.supabase.co"; ANON="<anon key from index.html>"
# read should succeed (200):
curl -s -o /dev/null -w "read: %{http_code}\n" "$URL/rest/v1/posts?select=id&limit=1" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
# delete should be refused (401/403/empty, NOT 200/204 with effect):
curl -s -o /dev/null -w "delete: %{http_code}\n" -X DELETE "$URL/rest/v1/posts?id=eq.00000000-0000-0000-0000-000000000000" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
```

Expected: `read: 200`, `delete:` a 4xx (not a successful delete).

- [ ] **Step 4: (Optional, cosmetic) rotate the team password**

Edit `index.html` line 313 `TEAM_PASSWORD`, commit, push. Note: this is a soft gate only (it's visible in view-source either way). Skip if not worth the team-comms churn.

---

## Phase 1 — Slack → Supabase ingest

### Task 1: Scaffold the Supabase Edge Function project locally

**Files:**
- Create: `supabase/functions/slack-ingest/index.ts`
- Create: `supabase/functions/slack-ingest/deno.json`
- Create: `supabase/config.toml` (if not present, via `supabase init`)

**Interfaces:**
- Produces: an HTTP handler `Deno.serve(handler)` where `handler(req: Request): Promise<Response>`.

- [ ] **Step 1: Install tooling and init**

```bash
cd ~/Desktop/moments
brew install supabase/tap/supabase deno   # if not already installed
supabase init                              # creates supabase/ (safe if exists)
supabase functions new slack-ingest        # creates supabase/functions/slack-ingest/index.ts
```

- [ ] **Step 2: Commit the scaffold**

```bash
git add supabase/
git commit -m "chore: scaffold slack-ingest edge function"
```

### Task 2: Slack signature verification

**Files:**
- Create: `supabase/functions/slack-ingest/verify.ts`
- Test: `supabase/functions/slack-ingest/verify_test.ts`

**Interfaces:**
- Produces: `async function verifySlack(rawBody: string, headers: Headers, signingSecret: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```ts
// verify_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifySlack } from "./verify.ts";

const SECRET = "test_signing_secret";

async function sign(body: string, ts: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `v0=${hex}`;
}

Deno.test("accepts a correctly signed, fresh request", async () => {
  const body = '{"ok":true}';
  const ts = String(Math.floor(Date.now() / 1000));
  const h = new Headers({ "x-slack-request-timestamp": ts, "x-slack-signature": await sign(body, ts) });
  assertEquals(await verifySlack(body, h, SECRET), true);
});

Deno.test("rejects a bad signature", async () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const h = new Headers({ "x-slack-request-timestamp": ts, "x-slack-signature": "v0=deadbeef" });
  assertEquals(await verifySlack('{"ok":true}', h, SECRET), false);
});

Deno.test("rejects a stale timestamp (>5 min)", async () => {
  const body = '{"ok":true}';
  const ts = String(Math.floor(Date.now() / 1000) - 600);
  const h = new Headers({ "x-slack-request-timestamp": ts, "x-slack-signature": await sign(body, ts) });
  assertEquals(await verifySlack(body, h, SECRET), false);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `deno test supabase/functions/slack-ingest/verify_test.ts --allow-none`
Expected: FAIL — `verify.ts` / `verifySlack` not found.

- [ ] **Step 3: Implement `verify.ts`**

```ts
// verify.ts
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySlack(rawBody: string, headers: Headers, signingSecret: string): Promise<boolean> {
  const ts = headers.get("x-slack-request-timestamp");
  const sig = headers.get("x-slack-signature");
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // 5-min replay window
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${rawBody}`));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(`v0=${hex}`, sig);
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `deno test supabase/functions/slack-ingest/verify_test.ts --allow-none`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/slack-ingest/verify.ts supabase/functions/slack-ingest/verify_test.ts
git commit -m "feat(slack-ingest): verify Slack request signatures"
```

### Task 3: Map a Slack message event → a `posts` row

**Files:**
- Create: `supabase/functions/slack-ingest/map.ts`
- Test: `supabase/functions/slack-ingest/map_test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type SlackEvent = { type: string; subtype?: string; user?: string; text?: string; ts?: string; files?: Array<{ id: string; mimetype: string; url_private_download: string; filetype: string }>; client_msg_id?: string }`
  - `type MomentDraft = { author: string; post_date: string; caption: string; photos: string[]; stickers: string[]; border: string; dedupe_key: string }`
  - `function toMomentDraft(ev: SlackEvent, userMap: Record<string,string>): MomentDraft | null` — returns null when the event must be ignored.

- [ ] **Step 1: Write the failing test**

```ts
// map_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { toMomentDraft } from "./map.ts";

const MAP = { U_PAOLO: "paolo", U_KASH: "kashish" };

Deno.test("maps an image message to a draft", () => {
  const ev = {
    type: "message", user: "U_KASH", text: "team lunch 🍜", ts: "1719662400.0001",
    client_msg_id: "abc-123",
    files: [{ id: "F1", mimetype: "image/jpeg", filetype: "jpg", url_private_download: "https://files.slack.com/F1" }],
  };
  const d = toMomentDraft(ev, MAP)!;
  assertEquals(d.author, "kashish");
  assertEquals(d.caption, "team lunch 🍜");
  assertEquals(d.post_date, "2024-06-29"); // derived from ts (UTC)
  assertEquals(d.dedupe_key, "abc-123");
  assertEquals(d.stickers, []);
  assertEquals(d.border, "");
});

Deno.test("ignores messages with no image files", () => {
  assertEquals(toMomentDraft({ type: "message", user: "U_KASH", text: "hi", ts: "1.0" }, MAP), null);
});

Deno.test("ignores bot messages and edits", () => {
  assertEquals(toMomentDraft({ type: "message", subtype: "bot_message", ts: "1.0" }, MAP), null);
  assertEquals(toMomentDraft({ type: "message", subtype: "message_changed", ts: "1.0" }, MAP), null);
});

Deno.test("unknown Slack user falls back to 'guest'", () => {
  const ev = { type: "message", user: "U_NEW", ts: "1719662400.0", client_msg_id: "x",
    files: [{ id: "F", mimetype: "image/png", filetype: "png", url_private_download: "u" }] };
  assertEquals(toMomentDraft(ev, MAP)!.author, "guest");
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `deno test supabase/functions/slack-ingest/map_test.ts --allow-none`
Expected: FAIL — `map.ts` not found.

- [ ] **Step 3: Implement `map.ts`**

```ts
// map.ts
export type SlackFile = { id: string; mimetype: string; filetype: string; url_private_download: string };
export type SlackEvent = {
  type: string; subtype?: string; user?: string; text?: string; ts?: string;
  files?: SlackFile[]; client_msg_id?: string;
};
export type MomentDraft = {
  author: string; post_date: string; caption: string;
  photos: string[]; stickers: string[]; border: string; dedupe_key: string;
};

const IGNORED_SUBTYPES = new Set(["bot_message", "message_changed", "message_deleted", "channel_join"]);

function dateFromTs(ts: string): string {
  const d = new Date(Math.floor(Number(ts) * 1000));
  return d.getUTCFullYear() + "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
    String(d.getUTCDate()).padStart(2, "0");
}

export function toMomentDraft(ev: SlackEvent, userMap: Record<string, string>): MomentDraft | null {
  if (ev.type !== "message") return null;
  if (ev.subtype && IGNORED_SUBTYPES.has(ev.subtype)) return null;
  const images = (ev.files ?? []).filter(f => f.mimetype?.startsWith("image/"));
  if (images.length === 0) return null;            // Moments-from-Slack = photo posts only
  if (!ev.ts) return null;
  return {
    author: (ev.user && userMap[ev.user]) || "guest",
    post_date: dateFromTs(ev.ts),
    caption: ev.text ?? "",
    photos: [],                                    // filled after upload (Task 4)
    stickers: [],
    border: "",
    dedupe_key: ev.client_msg_id ?? ev.ts,         // stable per Slack message
  };
}

export function imageFiles(ev: SlackEvent): SlackFile[] {
  return (ev.files ?? []).filter(f => f.mimetype?.startsWith("image/"));
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `deno test supabase/functions/slack-ingest/map_test.ts --allow-none`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/slack-ingest/map.ts supabase/functions/slack-ingest/map_test.ts
git commit -m "feat(slack-ingest): map Slack message events to post drafts"
```

### Task 4: Add a dedupe column so retries can't double-post

**Files:**
- Create: `supabase/migrations/0001_posts_slack_dedupe.sql`

**Interfaces:**
- Produces: a nullable unique `slack_key` column on `posts` used by Task 5's upsert.

- [ ] **Step 1: Write the migration**

```sql
-- 0001_posts_slack_dedupe.sql
alter table posts add column if not exists slack_key text;
create unique index if not exists posts_slack_key_uniq on posts (slack_key) where slack_key is not null;
```

- [ ] **Step 2: Apply it**

Run (against your project): `supabase db push` (or paste into the SQL editor).
Expected: column + partial unique index created. Existing rows keep `slack_key = NULL` (allowed).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0001_posts_slack_dedupe.sql
git commit -m "feat(db): add slack_key dedupe column to posts"
```

### Task 5: The HTTP handler — wire verify + map + download + upload + insert

**Files:**
- Modify: `supabase/functions/slack-ingest/index.ts`
- Test: `supabase/functions/slack-ingest/index_test.ts`

**Interfaces:**
- Consumes: `verifySlack` (Task 2), `toMomentDraft` + `imageFiles` (Task 3), `slack_key` column (Task 4).
- Produces: `Deno.serve` handler. Reads env: `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `MOMENTS_CHANNEL_ID`, `SLACK_USER_MAP` (JSON string), plus auto-injected `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

- [ ] **Step 1: Write the failing test (URL-verification challenge + signature gate)**

```ts
// index_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handle } from "./index.ts";

// minimal env for the handler under test
const env = {
  SLACK_SIGNING_SECRET: "s", SLACK_BOT_TOKEN: "xoxb-x",
  MOMENTS_CHANNEL_ID: "C1", SLACK_USER_MAP: "{}",
  SUPABASE_URL: "http://localhost", SUPABASE_SERVICE_ROLE_KEY: "k",
};

Deno.test("echoes Slack url_verification challenge", async () => {
  const body = JSON.stringify({ type: "url_verification", challenge: "xyz" });
  // verifyFn injected so we don't need real signing in this test
  const res = await handle(new Request("http://x", { method: "POST", body }), env, async () => true);
  assertEquals(await res.text(), "xyz");
  assertEquals(res.status, 200);
});

Deno.test("rejects bad signature with 401", async () => {
  const body = JSON.stringify({ type: "event_callback", event: {} });
  const res = await handle(new Request("http://x", { method: "POST", body }), env, async () => false);
  assertEquals(res.status, 401);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `deno test supabase/functions/slack-ingest/index_test.ts --allow-net --allow-env`
Expected: FAIL — `handle` not exported.

- [ ] **Step 3: Implement `index.ts`**

```ts
// index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifySlack } from "./verify.ts";
import { toMomentDraft, imageFiles, type SlackEvent } from "./map.ts";

type Env = Record<string, string>;
type VerifyFn = (raw: string, h: Headers, secret: string) => Promise<boolean>;

export async function handle(req: Request, env: Env, verifyFn: VerifyFn = verifySlack): Promise<Response> {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const raw = await req.text();
  const payload = JSON.parse(raw);

  // 1) Slack endpoint verification handshake
  if (payload.type === "url_verification") {
    return new Response(payload.challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }

  // 2) Authenticate every other request
  if (!(await verifyFn(raw, req.headers, env.SLACK_SIGNING_SECRET))) {
    return new Response("unauthorized", { status: 401 });
  }

  // 3) Only handle new channel messages in the Moments channel
  if (payload.type !== "event_callback") return new Response("", { status: 200 });
  const ev = payload.event as SlackEvent & { channel?: string };
  if (ev.channel && env.MOMENTS_CHANNEL_ID && ev.channel !== env.MOMENTS_CHANNEL_ID) {
    return new Response("", { status: 200 });
  }

  const userMap = JSON.parse(env.SLACK_USER_MAP || "{}");
  const draft = toMomentDraft(ev, userMap);
  if (!draft) return new Response("", { status: 200 }); // not a photo post — ack and ignore

  // Respond fast; do the heavy lifting without blocking the ack.
  queueMicrotask(() => ingest(ev, draft, env).catch((e) => console.error("ingest failed", e)));
  return new Response("", { status: 200 });
}

async function ingest(ev: SlackEvent, draft: ReturnType<typeof toMomentDraft>, env: Env) {
  if (!draft) return;
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const urls: string[] = [];
  for (const f of imageFiles(ev)) {
    const resp = await fetch(f.url_private_download, { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
    if (!resp.ok) { console.error("slack download failed", resp.status); continue; }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const path = `slack/${f.id}.${f.filetype || "jpg"}`;
    const up = await sb.storage.from("photos").upload(path, bytes, { contentType: f.mimetype, upsert: true });
    if (up.error) { console.error("upload failed", up.error); continue; }
    urls.push(sb.storage.from("photos").getPublicUrl(path).data.publicUrl);
  }
  if (urls.length === 0) return;
  // upsert on slack_key → Slack retries are idempotent
  const { error } = await sb.from("posts").upsert(
    { author: draft.author, post_date: draft.post_date, caption: draft.caption,
      stickers: draft.stickers, border: draft.border, photos: urls, slack_key: draft.dedupe_key },
    { onConflict: "slack_key" },
  );
  if (error) console.error("insert failed", error);
}

Deno.serve((req) => handle(req, Deno.env.toObject()));
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `deno test supabase/functions/slack-ingest/index_test.ts --allow-net --allow-env`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole function test suite**

Run: `deno test supabase/functions/slack-ingest/ --allow-net --allow-env`
Expected: PASS (all tests from Tasks 2, 3, 5).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/slack-ingest/index.ts supabase/functions/slack-ingest/index_test.ts
git commit -m "feat(slack-ingest): handle Slack events, ingest photos to Supabase"
```

### Task 6: Create the Slack app and wire it up (manual; needs workspace admin)

**Files:** none (Slack admin UI + Supabase secrets).

- [ ] **Step 1: Create the app**

api.slack.com/apps → Create New App → From scratch → pick your workspace.

- [ ] **Step 2: Add bot scopes**

OAuth & Permissions → Bot Token Scopes: `channels:history`, `files:read`, `users:read`. Install to workspace. Copy the **Bot User OAuth Token** (`xoxb-…`) and, from Basic Information, the **Signing Secret**.

- [ ] **Step 3: Deploy the function and set secrets**

```bash
supabase functions deploy slack-ingest --no-verify-jwt
supabase secrets set SLACK_SIGNING_SECRET="<signing secret>" \
  SLACK_BOT_TOKEN="xoxb-..." \
  MOMENTS_CHANNEL_ID="<#moments channel id>" \
  SLACK_USER_MAP='{"U_SLACKID_PAOLO":"paolo","U_SLACKID_KASH":"kashish"}'
```
(`--no-verify-jwt` is required so Slack — which has no Supabase JWT — can reach it; the Slack signature check is our auth instead.)

- [ ] **Step 4: Subscribe to events**

Event Subscriptions → Enable → Request URL = the deployed function URL
(`https://<project-ref>.functions.supabase.co/slack-ingest`). Slack will call it with the
`url_verification` challenge; it should verify green. Subscribe to bot event
`message.channels`. Reinstall the app if prompted.

- [ ] **Step 5: Invite the bot and test end-to-end**

In Slack: `/invite @Moments` to `#moments`, then post a photo with a caption.
Expected: within seconds the photo appears on `https://rani-kashish.github.io/moments/`
on today's date, authored by the mapped person. Posting the same image twice (Slack retry)
must NOT create a second post (dedupe via `slack_key`).

- [ ] **Step 6: Document the setup**

Append a "Slack ingest" section to `README.md` listing the required scopes, secrets, and the
`SLACK_USER_MAP` format, then commit.

---

## Out of scope (future plans)

- **Phase 2:** Slack emoji reactions → `reactions`; Slack thread replies → `comments`; a `/moment` slash-command modal.
- **Phase 3:** Replace the soft client-side password with Supabase Auth (magic links) for real per-person identity.

## Self-Review notes

- Spec coverage: Phase 0 (hardening) = Task 0; Slack ingest core (verify/map/store/dedupe) = Tasks 1–5; Slack wiring = Task 6. Phases 2–3 explicitly deferred.
- Idempotency: handled by `slack_key` unique index (Task 4) + `upsert onConflict` (Task 5).
- Secrets: only in Supabase function env (Task 6 Step 3); none added to the front-end. ✔ matches Global Constraints.
- Types: `SlackEvent`/`MomentDraft`/`toMomentDraft`/`imageFiles`/`verifySlack`/`handle` names are consistent across Tasks 2, 3, 5.
