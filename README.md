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

Plain HTML/CSS/JS, no build step, no framework. `localStorage` for progress
(no backend yet). Installable PWA (`manifest.json` + `sw.js` offline shell
cache). Content (the 5-step curriculum, all role/task combinations) lives in
`content/curriculum.json`, completely separate from the app logic in `app.js`
— editing the curriculum never touches code.

## Structure

```
index.html        shell
styles.css        design tokens (teal/amber, Baloo 2 + Mulish) + all screens
app.js            state machine, curriculum engine, screen renderers
manifest.json     PWA manifest
sw.js             offline shell cache
content/
  curriculum.json the real 5-step "build your AI assistant" content, 9 roles x 4 tasks
fonts/            Baloo 2 + Mulish, self-hosted
icons/            app icons
```

## What's real vs. simulated

- **Real:** the Gemini Gems creation flow the app teaches (verified against
  Google's own docs), the generated Gem Instructions text (genuinely valid,
  pasteable), the deep link to gemini.google.com/gems.
- **Simulated (by design, for MVP):** the in-app coach is a scripted chip-driven
  flow, not a live AI reading free text. Creating/testing the actual Gem
  happens for real, outside the app, in Gemini.

## Status

Local build complete and tested (see below). Not yet pushed to git or
deployed. No backend yet (Supabase integration is a planned next step, to
replace localStorage with real accounts/sync).

## Testing

Verified with a headless jsdom harness that executes the real `app.js` against
the real `index.html`, simulating actual clicks through the entire flow twice
(two different role/task combinations, plus the "no example" branch and the
"stuck" help branch), plus a reload/resume test and a corrupted-localStorage
resilience test. 89/89 assertions passed, 0 console errors, across all runs.

Not yet verified: actual visual/pixel rendering in a real browser (no browser
automation tool was available in that session) — the logic and DOM output are
proven correct; final visual polish should still get a manual look.
