// Pure mapping from a Slack message event to a Moments "post" draft.
// Kept side-effect-free so it's trivially testable; the handler does the I/O.

export type SlackFile = {
  id: string;
  mimetype: string;
  filetype: string;
  url_private_download: string;
};

export type SlackEvent = {
  type: string;
  subtype?: string;
  user?: string;
  text?: string;
  ts?: string;
  files?: SlackFile[];
  client_msg_id?: string;
};

export type MomentDraft = {
  author: string;
  post_date: string;
  caption: string;
  photos: string[];
  stickers: string[];
  border: string;
  dedupe_key: string;
};

const IGNORED_SUBTYPES = new Set([
  "bot_message",
  "message_changed",
  "message_deleted",
  "channel_join",
  "channel_leave",
]);

function dateFromTs(ts: string): string {
  const d = new Date(Math.floor(Number(ts) * 1000));
  return (
    d.getUTCFullYear() +
    "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getUTCDate()).padStart(2, "0")
  );
}

export function imageFiles(ev: SlackEvent): SlackFile[] {
  return (ev.files ?? []).filter((f) => f.mimetype?.startsWith("image/"));
}

/** Returns a draft, or null when the event should be ignored. */
export function toMomentDraft(
  ev: SlackEvent,
  userMap: Record<string, string>,
): MomentDraft | null {
  if (ev.type !== "message") return null;
  if (ev.subtype && IGNORED_SUBTYPES.has(ev.subtype)) return null;
  if (imageFiles(ev).length === 0) return null; // Moments-from-Slack = photo posts only
  if (!ev.ts) return null;
  return {
    author: (ev.user && userMap[ev.user]) || "guest",
    post_date: dateFromTs(ev.ts),
    caption: ev.text ?? "",
    photos: [], // filled in by the handler after upload
    stickers: [],
    border: "",
    dedupe_key: ev.client_msg_id ?? ev.ts, // stable per Slack message
  };
}
