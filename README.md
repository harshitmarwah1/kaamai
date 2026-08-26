# KaamAI

**Build your own AI, don't just search with it.**

A guided, gamified PWA that walks a non-technical professional through building
their own real AI assistant (a Gemini Gem) for their daily grunt work, in one
sitting. Rung 1 of a larger reskilling ladder.

## Run locally

```
python3 -m http.server 8743
```

Open http://localhost:8743/ in a phone-width browser window (or on an actual
phone on the same network).

## Stack

Plain HTML/CSS/JS, no build step, no framework. **Supabase is the system of
record** (identity, the built assistant, progress, funnel events); `localStorage`
is an offline working-copy that syncs up (last-write-wins by `updated_at`). If
Supabase is not configured, the app runs local-only exactly as before.
Installable PWA (`manifest.json` + `sw.js` offline shell cache). Content (the
5-step curriculum, all role/task combinations) lives in `content/curriculum.json`,
completely separate from the app logic in `app.js` — editing the curriculum never
touches code.

## Structure

```
index.html        shell
styles.css        design tokens (teal/amber, Baloo 2 + Mulish) + all screens
app.js            state machine, curriculum engine, screen renderers
config.js         PUBLIC Supabase URL + anon key (fill these in; empty = local-only)
sync.js           the only module that talks to Supabase (auth, sync, events)
vendor/
  supabase.min.js vendored @supabase/supabase-js v2 UMD build (no CDN at runtime)
db/
  schema.sql      Postgres schema + Row-Level Security (apply on a fresh project)
manifest.json     PWA manifest
sw.js             offline shell cache
content/
  curriculum.json the real 5-step "build your AI assistant" content, 9 roles x 4 tasks
fonts/            Baloo 2 + Mulish, self-hosted
icons/            app icons
test/
  harness.mjs     jsdom harness (npm test)
```

## Backend (Supabase)

The app is the system of record for everything a user does; here is how to wire it:

1. Create a Supabase project. Run `db/schema.sql` in the SQL editor (creates
   `profiles`, `assistants`, `step_completions`, `events`, all with RLS so each
   user only reads/writes their own rows).
2. Enable the **Email** auth provider (disable Phone). Users authenticate with a
   6-digit **email** code, either at the **Commit** step (new users, after the
   onramp) or via the **"Log in"** entry on the welcome screen (returning users
   resume on any device). In **Authentication → Email Templates**, edit the
   Magic Link / OTP template to include `{{ .Token }}` so the mail shows the
   6-digit code (the default template sends a link instead). For real delivery,
   configure a custom SMTP provider — **Resend** — under **Project Settings →
   Auth → SMTP** (free tier; verify a sending domain, or use `onboarding@resend.dev`
   to test). No SMS provider, DLT, or WhatsApp setup is needed.
3. Put the project's **public** URL + anon key in `config.js` (Settings → API).
   These are safe to ship — RLS is what protects data. **Never** put the
   `service_role` key in the client.

Leaving `config.js` empty keeps the app fully working in local-only mode.

## Data model

- `profiles` (1:1 with `auth.users`) — email, name, and per-user gamification
  (xp, streak, last_active_day).
- `assistants` — the artifact the user builds: role/task/audience, the generated
  instructions, status, and the variadic bits (`answers`, `step_progress`) as
  JSONB. Many-per-user allowed for future rungs.
- `step_completions` — append-only, one row per finished step (XP audit).
- `events` — append-only funnel analytics (welcome_start, role_picked,
  task_picked, otp_verified, step_completed, rung1_complete, notify_rung2).
  Pre-auth events are buffered locally and flushed once the user verifies.

## What's real vs. simulated

- **Real:** the Gemini Gems creation flow the app teaches (verified against
  Google's own docs), the generated Gem Instructions text (genuinely valid,
  pasteable), the deep link to gemini.google.com/gems.
- **Simulated (by design, for MVP):** the in-app coach is a scripted chip-driven
  flow, not a live AI reading free text. Creating/testing the actual Gem
  happens for real, outside the app, in Gemini.

## Status

Deployed (GitHub + Vercel). Supabase backend: email-OTP auth (6-digit code) at
the Commit screen and via the "Log in" entry, account + assistant provisioning,
offline-first sync, and funnel analytics. Requires a Supabase project +
`config.js` values to go live; runs local-only until then. Still to do: enable
the Email provider, add the `{{ .Token }}` email template, and configure Resend SMTP.

## Testing

```
npm install   # jsdom (dev only; the app has no build step)
npm test      # node test/harness.mjs
```

The harness executes the real `app.js` + `sync.js` inside jsdom and drives real
click events: (A) local-only mode end-to-end through all five steps to the
ladder, proving the pre-backend behaviour is untouched; (B) backend mode against
a mocked Supabase client — email-OTP send/verify, account + assistant provisioning,
buffered funnel-event flush, step-completion rows, and debounced sync-up; (C)
boot-time restore from an existing session with server-wins-when-newer merge; and
(D) the hybrid "Log in" entry, returning-vs-new routing, and email validation.

Not verified here: actual visual/pixel rendering in a real browser and a live
round-trip against a real Supabase project (needs project + Resend email) — the
logic and DOM output are proven correct; give the deployed app a manual look.
