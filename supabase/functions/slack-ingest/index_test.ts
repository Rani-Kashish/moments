import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handle } from "./index.ts";

const env = {
  SLACK_SIGNING_SECRET: "s",
  SLACK_BOT_TOKEN: "xoxb-x",
  MOMENTS_CHANNEL_ID: "C1",
  SLACK_USER_MAP: "{}",
  SUPABASE_URL: "http://localhost",
  SUPABASE_SERVICE_ROLE_KEY: "k",
};

function post(body: string): Request {
  return new Request("http://x", { method: "POST", body });
}

Deno.test("echoes Slack url_verification challenge", async () => {
  const res = await handle(
    post(JSON.stringify({ type: "url_verification", challenge: "xyz" })),
    env,
    async () => true,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "xyz");
});

Deno.test("rejects bad signature with 401", async () => {
  const res = await handle(
    post(JSON.stringify({ type: "event_callback", event: { type: "message" } })),
    env,
    async () => false,
  );
  assertEquals(res.status, 401);
});

Deno.test("acks (200) and ignores a non-photo message", async () => {
  const res = await handle(
    post(JSON.stringify({ type: "event_callback", event: { type: "message", channel: "C1", text: "hi", ts: "1.0" } })),
    env,
    async () => true,
  );
  assertEquals(res.status, 200);
});

Deno.test("ignores messages from other channels", async () => {
  const res = await handle(
    post(JSON.stringify({
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_OTHER",
        ts: "1.0",
        files: [{ id: "F", mimetype: "image/png", filetype: "png", url_private_download: "u" }],
      },
    })),
    env,
    async () => true,
  );
  assertEquals(res.status, 200);
});

Deno.test("rejects non-POST", async () => {
  const res = await handle(new Request("http://x", { method: "GET" }), env, async () => true);
  assertEquals(res.status, 405);
});
