import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifySlack } from "./verify.ts";

const SECRET = "test_signing_secret";

async function sign(body: string, ts: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

Deno.test("rejects when headers are missing", async () => {
  assertEquals(await verifySlack('{"ok":true}', new Headers(), SECRET), false);
});
