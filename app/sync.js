// KaamAI — Supabase sync layer (the ONLY module that talks to the backend).
//
// Contract with app.js: every method is safe to call unconditionally. When the
// backend is not configured, the client failed to load, there is no session, or
// the network is down, calls become no-ops (or queue locally) and the app keeps
// working purely on localStorage. Supabase is the system of record; localStorage
// is an offline working-copy that syncs up. Conflicts resolve last-write-wins by
// updated_at (see pullState + app.js boot merge).
(function () {
  "use strict";

  var EVENTS_QUEUE_KEY = "kaamai_events_queue_v1";
  var COMPLETIONS_QUEUE_KEY = "kaamai_completions_queue_v1";
  var SYNC_DEBOUNCE_MS = 800;

  var client = null;      // supabase-js client, or null when disabled
  var currentUser = null; // { id, ... } once authenticated
  var syncTimer = null;
  var pendingState = null;

  // ---------- setup ----------
  function config() {
    return (typeof window !== "undefined" && window.KAAMAI_CONFIG) || {};
  }

  // True only when we have a URL, an anon key, and the vendored library loaded.
  function init() {
    if (client) return true;
    var c = config();
    var lib = typeof window !== "undefined" ? window.supabase : null;
    if (!c.SUPABASE_URL || !c.SUPABASE_ANON_KEY || !lib || !lib.createClient) {
      return false;
    }
    try {
      client = lib.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY);
      return true;
    } catch (e) {
      console.warn("KaamAI: Supabase client init failed; running local-only.", e);
      client = null;
      return false;
    }
  }

  function enabled() {
    return !!client || init();
  }

  function authed() {
    return !!(client && currentUser);
  }

  // ---------- email helper ----------
  function normalizeEmail(raw) {
    return String(raw || "").trim().toLowerCase();
  }

  // ---------- auth ----------
  function getSession() {
    if (!enabled()) return Promise.resolve(null);
    return client.auth.getSession().then(function (res) {
      var session = res && res.data ? res.data.session : null;
      currentUser = session ? session.user : null;
      return session;
    }).catch(function () { return null; });
  }

  function sendOtp(email) {
    if (!enabled()) return Promise.resolve({ ok: false, error: "backend-disabled" });
    return client.auth.signInWithOtp({ email: normalizeEmail(email) })
      .then(function (res) {
        if (res.error) return { ok: false, error: res.error.message };
        return { ok: true };
      })
      .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }

  function verifyOtp(email, code) {
    if (!enabled()) return Promise.resolve({ ok: false, error: "backend-disabled" });
    return client.auth.verifyOtp({ email: normalizeEmail(email), token: String(code), type: "email" })
      .then(function (res) {
        if (res.error) return { ok: false, error: res.error.message };
        var session = res.data ? res.data.session : null;
        currentUser = session ? session.user : (res.data ? res.data.user : null);
        return { ok: true, session: session, user: currentUser };
      })
      .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }

  // ---------- write helpers ----------
  function assistantRowFromState(state) {
    return {
      role: state.role || null,
      task: state.task || null,
      audience: state.audience || null,
      name: state.assistantName || null,
      instructions_text: state.instructionsText || "",
      status: state.assistantStatus || "building",
      answers: state.answers || {},
      step_progress: state.stepProgress || {},
      step_index: state.stepIndex || 0,
      completed_steps: state.completedSteps || [],
      updated_at: new Date().toISOString()
    };
  }

  function profileRowFromState(state) {
    return {
      id: currentUser.id,
      email: normalizeEmail(state.email) || null,
      name: state.name || null,
      xp: state.xp || 0,
      streak: state.streak || 0,
      last_active_day: state.lastActiveDay || null,
      updated_at: new Date().toISOString()
    };
  }

  // Create the assistant row from the pre-auth draft. Returns its id (or null).
  // Idempotent: if state already has an assistantId, returns it unchanged.
  function ensureAssistant(state) {
    if (!authed()) return Promise.resolve(null);
    if (state.assistantId) return Promise.resolve(state.assistantId);
    var row = assistantRowFromState(state);
    row.user_id = currentUser.id;
    row.created_at = new Date().toISOString();
    return client.from("assistants").insert(row).select("id").single()
      .then(function (res) {
        if (res.error) { console.warn("KaamAI: create assistant failed", res.error); return null; }
        return res.data ? res.data.id : null;
      })
      .catch(function (e) { console.warn("KaamAI: create assistant threw", e); return null; });
  }

  // Provision profile + assistant right after OTP verify, from the local draft.
  // Returns the assistantId to stash in state.
  function provisionFromDraft(state) {
    if (!authed()) return Promise.resolve(null);
    return client.from("profiles").upsert(profileRowFromState(state))
      .then(function () { return ensureAssistant(state); })
      .then(function (assistantId) { flushQueues(); return assistantId; })
      .catch(function (e) { console.warn("KaamAI: provision failed", e); return null; });
  }

  // Debounced upsert of profile + assistant from the current state.
  function syncUp(state) {
    if (!authed() || !state.assistantId) return;
    pendingState = state;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(flushSync, SYNC_DEBOUNCE_MS);
  }

  function flushSync() {
    syncTimer = null;
    var state = pendingState;
    if (!state || !authed() || !state.assistantId) return;
    // NOTE: .then(noop, noop) — NOT .catch(). The PostgREST query builder is
    // thenable but has no .catch(), so `.catch(noop)` threw synchronously and
    // aborted this whole function before either write executed (profile xp/
    // streak and assistant progress silently never synced). .then triggers the
    // request and swallows success + error alike.
    client.from("profiles").upsert(profileRowFromState(state)).then(noop, noop);
    client.from("assistants").update(assistantRowFromState(state))
      .eq("id", state.assistantId).then(noop, noop);
    flushQueues();
  }

  // ---------- append-only queues (events + completions) ----------
  // Buffered so pre-auth funnel events survive until we have a user to attribute
  // them to (RLS blocks inserts with no auth.uid()), and so offline writes retry.
  function readQueue(key) {
    try { return JSON.parse(localStorage.getItem(key) || "[]"); }
    catch (e) { return []; }
  }
  function writeQueue(key, arr) {
    try { localStorage.setItem(key, JSON.stringify(arr)); } catch (e) {}
  }

  function logEvent(type, payload) {
    var q = readQueue(EVENTS_QUEUE_KEY);
    q.push({ type: type, payload: payload || {}, ts: new Date().toISOString() });
    writeQueue(EVENTS_QUEUE_KEY, q);
    flushQueues();
  }

  function insertCompletion(state, step) {
    if (!step) return;
    var q = readQueue(COMPLETIONS_QUEUE_KEY);
    q.push({ assistant_id: state.assistantId || null, step_id: step.id, xp: step.xp || 0 });
    writeQueue(COMPLETIONS_QUEUE_KEY, q);
    flushQueues();
  }

  // Flush both queues when we have a session. Attributes buffered rows to the
  // now-known user, preserving each row's original client timestamp.
  function flushQueues() {
    if (!authed()) return;

    var events = readQueue(EVENTS_QUEUE_KEY);
    if (events.length) {
      var eventRows = events.map(function (e) {
        return { user_id: currentUser.id, type: e.type, payload: e.payload, created_at: e.ts };
      });
      client.from("events").insert(eventRows)
        .then(function (res) { if (!res.error) writeQueue(EVENTS_QUEUE_KEY, []); })
        .catch(noop);
    }

    var comps = readQueue(COMPLETIONS_QUEUE_KEY)
      .filter(function (c) { return c.assistant_id; }); // need an assistant to attach to
    if (comps.length) {
      var compRows = comps.map(function (c) {
        return { user_id: currentUser.id, assistant_id: c.assistant_id,
                 step_id: c.step_id, xp_awarded: c.xp };
      });
      // ignoreDuplicates: the (assistant_id, step_id) unique constraint makes replays safe.
      client.from("step_completions").upsert(compRows, { onConflict: "assistant_id,step_id", ignoreDuplicates: true })
        .then(function (res) { if (!res.error) writeQueue(COMPLETIONS_QUEUE_KEY, []); })
        .catch(noop);
    }
  }

  // ---------- read / restore ----------
  // Pull the server's copy for the current user and assemble it into the app's
  // state shape. Returns { state, updatedAt } or null when there is nothing.
  function pullState() {
    if (!authed()) return Promise.resolve(null);
    var profileP = client.from("profiles").select("*").eq("id", currentUser.id).maybeSingle();
    var assistantP = client.from("assistants").select("*")
      .eq("user_id", currentUser.id).order("updated_at", { ascending: false }).limit(1);
    return Promise.all([profileP, assistantP]).then(function (out) {
      var profile = out[0] && out[0].data;
      var assistantRows = out[1] && out[1].data;
      var assistant = assistantRows && assistantRows.length ? assistantRows[0] : null;
      if (!profile && !assistant) return null;

      var s = {};
      if (profile) {
        s.name = profile.name || "";
        s.email = profile.email || "";
        s.xp = profile.xp || 0;
        s.streak = profile.streak || 0;
        s.lastActiveDay = profile.last_active_day || null;
      }
      if (assistant) {
        s.assistantId = assistant.id;
        s.role = assistant.role || "";
        s.task = assistant.task || "";
        s.audience = assistant.audience || "";
        s.instructionsText = assistant.instructions_text || "";
        s.assistantStatus = assistant.status || "building";
        s.answers = assistant.answers || {};
        s.stepProgress = assistant.step_progress || {};
        s.stepIndex = assistant.step_index || 0;
        s.completedSteps = assistant.completed_steps || [];
      }
      s.screen = "home";
      var updatedAt = assistant ? Date.parse(assistant.updated_at) : (profile ? Date.parse(profile.updated_at) : 0);
      return { state: s, updatedAt: updatedAt || 0 };
    }).catch(function (e) { console.warn("KaamAI: pullState failed", e); return null; });
  }

  function noop() {}

  window.KaamaiSync = {
    init: init,
    enabled: enabled,
    authed: authed,
    getSession: getSession,
    sendOtp: sendOtp,
    verifyOtp: verifyOtp,
    provisionFromDraft: provisionFromDraft,
    ensureAssistant: ensureAssistant,
    syncUp: syncUp,
    logEvent: logEvent,
    insertCompletion: insertCompletion,
    flushQueues: flushQueues,
    pullState: pullState
  };
})();
