import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { toMomentDraft } from "./map.ts";

const MAP = { U_PAOLO: "paolo", U_KASH: "kashish" };

Deno.test("maps an image message to a draft", () => {
  const ev = {
    type: "message",
    user: "U_KASH",
    text: "team lunch 🍜",
    ts: "1719662400.0001",
    client_msg_id: "abc-123",
    files: [{ id: "F1", mimetype: "image/jpeg", filetype: "jpg", url_private_download: "https://files.slack.com/F1" }],
  };
  const d = toMomentDraft(ev, MAP)!;
  assertEquals(d.author, "kashish");
  assertEquals(d.caption, "team lunch 🍜");
  assertEquals(d.post_date, "2024-06-29"); // 1719662400 = 2024-06-29 UTC
  assertEquals(d.dedupe_key, "abc-123");
  assertEquals(d.stickers, []);
  assertEquals(d.border, "");
  assertEquals(d.photos, []);
});

Deno.test("ignores messages with no image files", () => {
  assertEquals(toMomentDraft({ type: "message", user: "U_KASH", text: "hi", ts: "1.0" }, MAP), null);
});

Deno.test("ignores bot messages and edits", () => {
  assertEquals(toMomentDraft({ type: "message", subtype: "bot_message", ts: "1.0" }, MAP), null);
  assertEquals(toMomentDraft({ type: "message", subtype: "message_changed", ts: "1.0" }, MAP), null);
});

Deno.test("ignores non-message events", () => {
  assertEquals(toMomentDraft({ type: "reaction_added", ts: "1.0" }, MAP), null);
});

Deno.test("unknown Slack user falls back to 'guest'", () => {
  const ev = {
    type: "message",
    user: "U_NEW",
    ts: "1719662400.0",
    client_msg_id: "x",
    files: [{ id: "F", mimetype: "image/png", filetype: "png", url_private_download: "u" }],
  };
  assertEquals(toMomentDraft(ev, MAP)!.author, "guest");
});

Deno.test("falls back to ts for dedupe when no client_msg_id", () => {
  const ev = {
    type: "message",
    user: "U_PAOLO",
    ts: "1719662400.5",
    files: [{ id: "F", mimetype: "image/png", filetype: "png", url_private_download: "u" }],
  };
  assertEquals(toMomentDraft(ev, MAP)!.dedupe_key, "1719662400.5");
});
