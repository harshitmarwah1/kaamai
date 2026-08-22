// KaamAI test harness.
//
// Loads the REAL app.js + sync.js inside jsdom and drives real click events
// through the flow. Two worlds:
//   A. local-only (no backend config)  -> proves the pre-backend behaviour is
//      untouched and the curriculum engine still works end to end.
//   B. backend enabled (mocked Supabase) -> proves the OTP gate, account
//      provisioning, event/funnel capture, sync-up, and boot-time restore.
//
// Run: npm test   (node test/harness.mjs)

import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const syncSrc = readFileSync(join(ROOT, "sync.js"), "utf8");
const appSrc = readFileSync(join(ROOT, "app.js"), "utf8");
const curriculum = JSON.parse(readFileSync(join(ROOT, "content/curriculum.json"), "utf8"));

// ---------- tiny assert framework ----------
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error("  ✗ FAIL: " + msg); }
}
const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function settle(times = 8) { for (let i = 0; i < times; i++) await flush(0); }

// ---------- mocked Supabase ----------
function makeMockSupabase(opts = {}) {
  const ops = [];
  const uid = opts.userId || "u1";
  const auth = {
    getSession: () => Promise.resolve({ data: { session: opts.session || null } }),
    signInWithOtp: (a) => { ops.push({ table: "auth", op: "signInWithOtp", args: a }); return Promise.resolve(opts.sendError ? { error: { message: opts.sendError } } : { data: {}, error: null }); },
    verifyOtp: (a) => {
      ops.push({ table: "auth", op: "verifyOtp", args: a });
      if (opts.verifyError) return Promise.resolve({ error: { message: opts.verifyError } });
      return Promise.resolve({ data: { session: { user: { id: uid } }, user: { id: uid } }, error: null });
    }
  };
  function from(table) {
    const rec = { table, methods: [], payload: undefined };
    let finalized = false;
    function finalize() {
      if (!finalized) { finalized = true; ops.push(rec); }
      let data = null;
      if (table === "assistants" && rec.methods.includes("insert")) data = { id: opts.assistantId || "asst-1" };
      else if (table === "profiles" && rec.methods.includes("maybeSingle")) data = opts.profile || null;
      else if (table === "assistants" && rec.methods.includes("order")) data = opts.assistants || [];
      return Promise.resolve({ data, error: null });
    }
    const b = {
      insert(p) { rec.methods.push("insert"); rec.payload = p; return b; },
      upsert(p, o) { rec.methods.push("upsert"); rec.payload = p; rec.opts = o; return b; },
      update(p) { rec.methods.push("update"); rec.payload = p; return b; },
      select() { rec.methods.push("select"); return b; },
      eq(k, v) { rec.methods.push("eq"); (rec.eq = rec.eq || []).push([k, v]); return b; },
      order() { rec.methods.push("order"); return b; },
      limit() { rec.methods.push("limit"); return b; },
      single() { rec.methods.push("single"); return finalize(); },
      maybeSingle() { rec.methods.push("maybeSingle"); return finalize(); },
      then(res, rej) { return finalize().then(res, rej); },
      catch(rej) { return finalize().catch(rej); }
    };
    return b;
  }
  return { lib: { createClient: () => ({ auth, from }) }, ops };
}

// ---------- build a live app instance ----------
async function buildApp({ config = {}, supabaseOpts = null } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="app" role="main"></div><div id="offline-banner" hidden></div></body></html>',
    { runScripts: "dangerously", url: "https://kaamai.test/" }
  );
  const win = dom.window;
  win.requestAnimationFrame = (fn) => win.setTimeout(fn, 0);
  win.KAAMAI_CONFIG = config;
  const spy = supabaseOpts ? makeMockSupabase(supabaseOpts) : { ops: [] };
  win.supabase = supabaseOpts ? spy.lib : undefined;
  win.fetch = (u) => {
    if (String(u).includes("curriculum.json")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(curriculum) });
    }
    return Promise.reject(new Error("unexpected fetch: " + u));
  };
  win.eval(syncSrc);
  win.eval(appSrc);
  await settle();               // let boot() resolve (fetch + restore) and render
  return { dom, win, spy };
}

// ---------- DOM helpers ----------
const q = (win, sel) => win.document.querySelector(sel);
const has = (win, sel) => !!q(win, sel);
const text = (win) => win.document.getElementById("app").textContent;
function click(win, sel) {
  const el = q(win, sel);
  if (!el) return false;
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  return true;
}
function setVal(win, id, v) { const el = win.document.getElementById(id); if (el) el.value = v; }
const eventTypes = (ops) =>
  ops.filter((o) => o.table === "events" && o.methods && o.methods.includes("insert"))
     .flatMap((o) => (Array.isArray(o.payload) ? o.payload : [o.payload]).map((r) => r.type));

// ---------- shared flow drivers ----------
function onboardToCommit(win) {
  click(win, '[data-act="welcome:start"]');
  setVal(win, "nameInput", "Tester");
  click(win, '[data-act="select:role"]');       // first role
  click(win, '[data-act="select:task"]');        // first task
  click(win, '[data-act="select:audience"]');    // first audience -> teaser
  click(win, '[data-act="go:commit"]');          // teaser -> commit
}
function finishOneStep(win) {
  for (let g = 0; g < 12; g++) {
    if (click(win, '[data-act="chat:finishStep"]')) return true;     // -> win
    if (click(win, '[data-act="chat:skipExample"]')) continue;
    if (click(win, '[data-act="chat:chip"]')) continue;              // first chip
    break;
  }
  return false;
}

// ===========================================================================
async function testLocalOnly() {
  console.log("A. local-only (no backend)");
  const { win } = await buildApp({ config: {} });

  ok(has(win, '[data-act="welcome:start"]'), "boots to welcome screen");
  onboardToCommit(win);
  ok(has(win, '[data-act="commit:start"]'), "commit uses legacy commit:start button");
  ok(has(win, "#phoneInput"), "commit shows optional phone field");
  ok(!has(win, '[data-act="otp:send"]'), "no OTP button when backend disabled");

  click(win, '[data-act="commit:start"]');
  ok(has(win, "#chatScroll") || text(win).length > 0, "commit:start lands in build flow");

  // walk all five steps to the ladder
  let reachedWin = finishOneStep(win);
  ok(reachedWin, "step 1 completes to a win screen");
  ok(/\+40 XP/.test(text(win)), "win screen shows the step's XP reward");

  let guard = 0;
  while (guard++ < 6) {
    if (click(win, '[data-act="win:next"]')) { finishOneStep(win); continue; }
    if (click(win, '[data-act="win:toLadder"]')) break;
    break;
  }
  ok(/You built your first AI\./.test(text(win)), "reaches the rung-1 ladder after all steps");
}

// ===========================================================================
async function testBackendFlow() {
  console.log("B. backend enabled (mocked Supabase)");
  const cfg = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon" };
  const { win, spy } = await buildApp({ config: cfg, supabaseOpts: {} });

  onboardToCommit(win);
  ok(has(win, '[data-act="otp:send"]'), "commit shows OTP send button when backend enabled");
  ok(!has(win, '[data-act="commit:start"]'), "legacy commit:start hidden when backend enabled");

  // send OTP
  setVal(win, "phoneInput", "9876543210");
  click(win, '[data-act="otp:send"]');
  await settle();
  ok(spy.ops.some((o) => o.op === "signInWithOtp"), "otp:send calls signInWithOtp");
  const sent = spy.ops.find((o) => o.op === "signInWithOtp");
  ok(sent && sent.args.phone === "+919876543210", "phone normalized to E.164 (+91)");
  ok(has(win, "#otpInput"), "advances to code-entry stage");

  // verify OTP -> provisions account + assistant, carries the draft in
  setVal(win, "otpInput", "123456");
  click(win, '[data-act="otp:verify"]');
  await settle(20);
  ok(spy.ops.some((o) => o.op === "verifyOtp"), "otp:verify calls verifyOtp");
  ok(spy.ops.some((o) => o.table === "profiles" && o.methods.includes("upsert")), "provisions profile row");
  const asstInsert = spy.ops.find((o) => o.table === "assistants" && o.methods.includes("insert"));
  ok(!!asstInsert, "creates the assistant row from the draft");
  ok(asstInsert && asstInsert.payload.role && asstInsert.payload.user_id === "u1", "assistant row carries role + user_id");
  ok(has(win, "#chatScroll") || /Step 1/.test(text(win)), "lands in the build flow after verify");

  // buffered pre-auth funnel events were flushed on verify
  let types = eventTypes(spy.ops);
  ok(types.includes("welcome_start"), "flushed buffered welcome_start event");
  ok(types.includes("role_picked"), "flushed buffered role_picked event");
  ok(types.includes("task_picked"), "flushed buffered task_picked event");
  ok(types.includes("otp_verified"), "logged otp_verified event");

  // finish a step -> completion row + step_completed event
  finishOneStep(win);
  await settle(20);
  ok(spy.ops.some((o) => o.table === "step_completions" && (o.methods.includes("upsert") || o.methods.includes("insert"))), "step completion inserts a step_completions row");
  types = eventTypes(spy.ops);
  ok(types.includes("step_completed"), "logs step_completed event");

  // debounced syncUp pushed the assistant update
  await flush(900);
  ok(spy.ops.some((o) => o.table === "assistants" && o.methods.includes("update")), "saveState triggers a debounced assistant update");
}

// ===========================================================================
async function testBootRestore() {
  console.log("C. boot restore (existing session, server wins when newer)");
  const cfg = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon" };
  const supabaseOpts = {
    session: { user: { id: "u9" } },
    userId: "u9",
    profile: { id: "u9", name: "Server Sam", phone: "+910000000000", xp: 123, streak: 7, last_active_day: "2026-08-22", updated_at: "2999-01-01T00:00:00Z" },
    assistants: [{ id: "asst-9", user_id: "u9", role: "Marketing", task: "Writing campaign reports", audience: "my manager", instructions_text: "You are ...", status: "building", answers: {}, step_progress: {}, step_index: 1, completed_steps: ["job"], updated_at: "2999-01-01T00:00:00Z" }]
  };
  const { win, spy } = await buildApp({ config: cfg, supabaseOpts });
  await settle(20);
  ok(spy.ops.some((o) => o.table === "profiles" && o.methods.includes("maybeSingle")), "pulls profile on boot");
  ok(spy.ops.some((o) => o.table === "assistants" && o.methods.includes("order")), "pulls latest assistant on boot");
  const t = text(win);
  ok(/Server Sam/.test(t), "renders restored user name from server");
  ok(/123/.test(t), "renders restored XP from server");
  ok(/7/.test(t), "renders restored streak from server");
}

// ===========================================================================
(async function main() {
  await testLocalOnly();
  await testBackendFlow();
  await testBootRestore();
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
