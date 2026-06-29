// Supabase Edge Function: slack-ingest
// Slack calls this on each new #moments message. We verify the signature, and
// for image messages: download the photo from Slack, re-upload it to the
// Supabase `photos` bucket, and upsert a `posts` row (idempotent on slack_key).
// Secrets live ONLY in the function env — never in the public front-end.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifySlack } from "./verify.ts";
import { imageFiles, toMomentDraft, type MomentDraft, type SlackEvent } from "./map.ts";

type Env = Record<string, string>;
type VerifyFn = (raw: string, h: Headers, secret: string) => Promise<boolean>;

export async function handle(
  req: Request,
  env: Env,
  verifyFn: VerifyFn = verifySlack,
): Promise<Response> {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const raw = await req.text();
  let payload: { type?: string; challenge?: string; event?: SlackEvent & { channel?: string } };
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // 1) Slack endpoint verification handshake
  if (payload.type === "url_verification") {
    return new Response(payload.challenge ?? "", { status: 200, headers: { "content-type": "text/plain" } });
  }

  // 2) Authenticate every other request
  if (!(await verifyFn(raw, req.headers, env.SLACK_SIGNING_SECRET))) {
    return new Response("unauthorized", { status: 401 });
  }

  // 3) Only handle new channel messages in the Moments channel
  if (payload.type !== "event_callback" || !payload.event) {
    return new Response("", { status: 200 });
  }
  const ev = payload.event;
  if (ev.channel && env.MOMENTS_CHANNEL_ID && ev.channel !== env.MOMENTS_CHANNEL_ID) {
    return new Response("", { status: 200 });
  }

  const userMap = JSON.parse(env.SLACK_USER_MAP || "{}");
  const draft = toMomentDraft(ev, userMap);
  if (!draft) return new Response("", { status: 200 }); // not a photo post — ack and ignore

  // Ack fast (Slack needs <3s); do the heavy lifting after responding.
  queueMicrotask(() => ingest(ev, draft, env).catch((e) => console.error("ingest failed", e)));
  return new Response("", { status: 200 });
}

async function ingest(ev: SlackEvent, draft: MomentDraft, env: Env): Promise<void> {
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const urls: string[] = [];
  for (const f of imageFiles(ev)) {
    const resp = await fetch(f.url_private_download, {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    if (!resp.ok) {
      console.error("slack download failed", resp.status);
      continue;
    }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const path = `slack/${f.id}.${f.filetype || "jpg"}`;
    const up = await sb.storage.from("photos").upload(path, bytes, {
      contentType: f.mimetype,
      upsert: true,
    });
    if (up.error) {
      console.error("upload failed", up.error);
      continue;
    }
    urls.push(sb.storage.from("photos").getPublicUrl(path).data.publicUrl);
  }
  if (urls.length === 0) return;

  const { error } = await sb.from("posts").upsert(
    {
      author: draft.author,
      post_date: draft.post_date,
      caption: draft.caption,
      stickers: draft.stickers,
      border: draft.border,
      photos: urls,
      slack_key: draft.dedupe_key,
    },
    { onConflict: "slack_key" },
  );
  if (error) console.error("insert failed", error);
}

// Entry point (skipped during unit tests, which import `handle` directly).
if (import.meta.main) {
  Deno.serve((req) => handle(req, Deno.env.toObject()));
}
