# Moments — the perfect solution (recommendation)

_Date: 2026-06-29 · Author: Kashish + Claude · Status: proposal, not yet approved/built_

## The one-line answer

**Keep Supabase. Harden it. Add a free Slack bridge so people can post from Slack.**
Everything stays inside two accounts you already own (Supabase + Slack), it costs **£0**,
nothing has to be rebuilt, and it adds the Slack convenience you wanted — without
ever putting a secret in the public page.

## Why this is the right call (against your constraints)

| Your constraint | How this meets it |
|---|---|
| Don't want to pay / free | Supabase free tier + Slack (already free to you) + Supabase Edge Functions (free). £0. |
| My own account, don't mix with company/other accounts | Only your Supabase project + a Slack app in your workspace. No AWS, no new SaaS. |
| Works for the whole team (shared photos) | Already does — Supabase is shared + realtime. Slack posting adds a zero-friction path. |
| "In a good way" (secure, not hacky) | The Slack bridge runs server-side (Edge Function); Slack + service keys never touch the page. |
| Use it on Slack | Post a photo in `#moments` → it appears on the wall automatically. |
| Least effort | Reuses 100% of the existing app; we add one function + tighten settings. |

The only constraint this does **not** meet is "no third party" — but you chose to keep
Supabase, which resolves that. Supabase is the pragmatic winner; every no-third-party
option we explored was clunkier, less secure, or needed everyone to have GitHub.

## What's there today (so the plan is grounded)

- **Single static file** `index.html` (~760 lines), pure front-end, gorgeous: calendar,
  polaroid/washi-tape photo frames, animal avatars, stickers, themes, reactions, comments.
- **Backend = Supabase**: tables `posts {author, post_date, caption, stickers[], border, photos[]}`,
  `comments {post_id, author, body}`, `reactions {post_id, author, emoji}`; a `photos` storage
  bucket (public URLs). Live updates via Supabase Realtime `postgres_changes`.
- **Auth** = a client-side `TEAM_PASSWORD` check, then pick-your-name from a hardcoded
  `PEOPLE` list; identity stored in `localStorage`. No real per-user accounts.

## ⚠️ Security findings (must address — independent of Slack)

**Hosting fact (verified 2026-06-29):** the site is live via **GitHub Pages** at
`https://rani-kashish.github.io/moments/`, served from the **public** repo, branch `main`.

1. **Making the repo private does NOT help — and would break the site.** On a free GitHub
   plan, Pages can't serve from a private repo, so going private takes the live site down.
   And it wouldn't add security anyway: the deployed public page already ships the Supabase
   URL, anon key, and password to every visitor's browser (view-source). The secret is
   exposed by the *live site*, not just the repo. **So: keep the repo public; do NOT rely on
   privacy for security.**
2. **Row-Level Security is the only real protection.** The Supabase anon key is _designed_
   to be public — safe ONLY if RLS policies are correct. Verified read-only probe: an
   anonymous request to `/rest/v1/posts` returns **HTTP 200** — i.e. the table is currently
   world-readable to anyone with the (public) key. For a non-sensitive team wall that may be
   acceptable, but **the critical action is to confirm in the Supabase dashboard that anon
   can INSERT only what it should and CANNOT DELETE/UPDATE arbitrary rows.** (Not tested from
   here — that would mean writing junk to your DB.)
3. **A client-side password is inherently soft.** The check runs in the browser, so anyone
   who views source sees it — repo private or not. For a low-stakes internal wall this is an
   acceptable "soft gate". Rotating `moments2026` is cosmetic, not real security. The only
   real gate is **Supabase Auth (magic-link email)** — free, true per-person identity, kills
   impersonation. Optional (Phase 3); more friction.

## Target architecture

```
                 ┌────────────────────────────────────────────┐
  Teammates  ──► │  Slack  #moments  (post photo + caption)     │
  (in Slack)     └───────────────┬────────────────────────────┘
                                 │  Slack Events API (file_shared/message)
                                 ▼
                 ┌────────────────────────────────────────────┐
                 │  Supabase Edge Function  "slack-ingest"      │
                 │  • verify Slack signature                    │
                 │  • download the image from Slack             │
                 │  • upload to Supabase `photos` bucket        │
                 │  • map Slack user → PEOPLE id                │
                 │  • insert a row into `posts`                 │
                 │  (Slack token + service key live HERE only)  │
                 └───────────────┬────────────────────────────┘
                                 │ Supabase Realtime
                                 ▼
   Anyone with the page  ◄──  Moments web app (unchanged, live-updates)
   Teammates can ALSO still post via the in-app composer as today.
```

Both input paths coexist: **Slack** (easy for everyone) and the **in-app composer**
(for stickers/borders/back-dating). They write to the same `posts` table.

## Slack → Supabase mapping

| Slack | Moments `posts` field |
|---|---|
| Who posted (Slack user id) | `author` (mapped to a `PEOPLE` id; unknown users → a default/"guest") |
| Message timestamp | `post_date` (YYYY-MM-DD) + `created_at` |
| Message text | `caption` |
| Attached image(s) | `photos[]` (downloaded → re-uploaded to the `photos` bucket) |
| _(later)_ Slack emoji reactions | `reactions` |
| _(later)_ Slack thread replies | `comments` |

## Build plan (phased)

- **Phase 0 — Harden (do regardless):** in the Supabase dashboard, confirm/lock RLS so anon
  can INSERT but not DELETE/UPDATE arbitrary rows (the one that matters); decide if
  world-readable posts are OK or tighten read; optionally rotate the password (cosmetic).
  Keep the repo public (Pages needs it). ~30 min, mostly dashboard, no app code.
- **Phase 1 — Slack ingest:** create a Slack app (scopes: `files:read`, `channels:history`,
  event subscriptions), write the `slack-ingest` Edge Function, map users, test posting a
  photo in `#moments` → appears on the wall. This is the core of "use it on Slack".
- **Phase 2 — Polish (optional):** Slack 👍/emoji → reactions; thread replies → comments;
  a `/moment` slash command for a tidy modal instead of channel-sweeping.
- **Phase 3 — Auth upgrade (optional):** swap the soft password for Supabase Auth magic links
  if strict identity ever matters.

## Hard dependency / open question

- **Can you install a Slack app in your workspace** (or get an admin to approve one)? The
  entire Slack path depends on this. If not, we stop at Phase 0 + keep the in-app composer.

## Honest caveats

- Supabase free tier: ~1 GB photo storage (photos accumulate) and **free projects pause
  after ~7 days of inactivity** (an active wall won't hit it; easy to resume if it does).
- Slack scheduled/Events ingestion has a small delay (seconds–minutes) — fine for a scrapbook.
- The in-app password stays "soft" unless we move to real auth (Phase 3).
