(function () {
  "use strict";

  var STORAGE_KEY = "kaamai_state_v1";
  var CURRICULUM_URL = "content/curriculum.json";

  var app = document.getElementById("app");
  var offlineBanner = document.getElementById("offline-banner");

  var CUR = null; // curriculum.json, loaded async

  // Backend sync layer (sync.js). Fall back to no-ops if it failed to load, so
  // the app always runs, backend or not.
  var SYNC = window.KaamaiSync || {
    init: function () { return false; },
    enabled: function () { return false; },
    authed: function () { return false; },
    getSession: function () { return Promise.resolve(null); },
    sendOtp: function () { return Promise.resolve({ ok: false, error: "backend-disabled" }); },
    verifyOtp: function () { return Promise.resolve({ ok: false, error: "backend-disabled" }); },
    provisionFromDraft: function () { return Promise.resolve(null); },
    ensureAssistant: function () { return Promise.resolve(null); },
    syncUp: function () {},
    logEvent: function () {},
    insertCompletion: function () {},
    flushQueues: function () {},
    pullState: function () { return Promise.resolve(null); }
  };

  // Transient OTP UI state, shared by the Commit gate and the Log in screen
  // (never persisted). `context` tells the verify handler where to route.
  var otpUI = { stage: "email", email: "", error: "", sending: false, verifying: false, context: "commit" };
  function resetOtpUI(context) {
    otpUI.stage = "email";
    otpUI.email = "";
    otpUI.error = "";
    otpUI.sending = false;
    otpUI.verifying = false;
    otpUI.context = context || "commit";
  }

  // ---------- short, clean assistant-name labels per task ----------
  var SHORT_TASK = {
    "Writing campaign reports": "Report",
    "Drafting social posts": "Social Post",
    "Coming up with content ideas": "Content Idea",
    "Summarizing research": "Research Summary",
    "Writing follow-up emails": "Follow-up",
    "Preparing call notes": "Call Notes",
    "Building proposals": "Proposal",
    "Summarizing pipeline updates": "Pipeline Update",
    "Writing job descriptions": "Job Description",
    "Screening summaries": "Screening",
    "Drafting policy notes": "Policy Note",
    "Interview questions": "Interview Prep",
    "Writing status reports": "Status Report",
    "Documenting processes": "Process Doc",
    "Summarizing incidents": "Incident Summary",
    "Vendor comparisons": "Vendor Comparison",
    "Explaining numbers to non-finance": "Numbers Explainer",
    "Monthly summaries": "Monthly Summary",
    "Expense reviews": "Expense Review",
    "Budget notes": "Budget Note",
    "Replying to common questions": "Reply",
    "Summarizing tickets": "Ticket Summary",
    "Writing help articles": "Help Article",
    "Escalation notes": "Escalation Note",
    "Making lesson plans": "Lesson Plan",
    "Writing feedback for students": "Feedback",
    "Creating quiz questions": "Quiz",
    "Parent updates": "Parent Update",
    "Writing meeting minutes": "Minutes",
    "Scheduling messages": "Scheduling",
    "Formatting documents": "Formatting",
    "Travel summaries": "Travel Summary",
    "Writing reports": "Report",
    "Drafting emails": "Email",
    "Summarizing documents": "Summary",
    "Preparing notes": "Notes"
  };

  // ---------- state ----------
  function defaultState() {
    return {
      screen: "welcome",
      name: "",
      role: "",
      task: "",
      audience: "",
      email: "",
      stepIndex: 0,
      answers: {}, // merged across all turns: lead, tone, constraint, hasExample, example, created, result, willUse, outcome
      instructionsText: "",
      completedSteps: [],
      xp: 0,
      streak: 0,
      lastActiveDay: null,
      lastWinReward: null,
      stepProgress: freshStepProgress(),
      assistantId: null,
      assistantStatus: "building",
      updatedAt: null
    };
  }

  function freshStepProgress() {
    return {
      turnIndex: 0,
      awaitingInput: false,
      stuckShown: false,
      branchMsg: null,
      awaitingContinue: false
    };
  }

  var state = null;

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      var parsed = JSON.parse(raw);
      var fresh = defaultState();
      // shallow-merge so a future field addition never crashes an old saved state
      for (var k in fresh) {
        if (parsed[k] === undefined) parsed[k] = fresh[k];
      }
      if (!parsed.stepProgress) parsed.stepProgress = freshStepProgress();
      return parsed;
    } catch (e) {
      console.warn("KaamAI: could not read saved state, starting fresh.", e);
      return defaultState();
    }
  }

  function saveState() {
    state.updatedAt = Date.now();
    saveLocalOnly();
    SYNC.syncUp(state); // debounced, no-op until authenticated
  }

  // Write to localStorage without bumping updatedAt or triggering a sync — used
  // when applying server state during boot merge, so we don't clobber it.
  function saveLocalOnly() {
    state.assistantName = assistantName();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("KaamAI: could not persist state (storage may be full/blocked).", e);
    }
  }

  // Overwrite local fields with the server's copy (server wins when newer).
  function mergeServerState(serverState, updatedAt) {
    for (var k in serverState) {
      if (serverState.hasOwnProperty(k)) state[k] = serverState[k];
    }
    if (!state.stepProgress) state.stepProgress = freshStepProgress();
    state.updatedAt = updatedAt || Date.now();
    saveLocalOnly();
  }

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fillTemplate(tpl, vars) {
    return tpl.replace(/\{(\w+)\}/g, function (m, key) {
      return vars.hasOwnProperty(key) && vars[key] != null ? vars[key] : "";
    });
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function shortTaskLabel(task) {
    return SHORT_TASK[task] || task;
  }

  function assistantName() {
    if (!state.role || !state.task) return "Your Assistant";
    return state.role + " " + shortTaskLabel(state.task) + " Assistant";
  }

  function tasksForRole(role) {
    if (!CUR) return [];
    return CUR.roles[role] || CUR.roles["Other"] || [];
  }

  function currentStep() {
    if (!CUR || state.stepIndex >= CUR.steps.length) return null;
    return CUR.steps[state.stepIndex];
  }

  function svgAvatar(sizeClass) {
    return (
      '<svg class="avatar ' + (sizeClass || "") + '" viewBox="0 0 48 48" aria-hidden="true">' +
      '<rect x="6" y="9" width="36" height="33" rx="14" fill="#0f766e"/>' +
      '<circle cx="34.5" cy="8" r="3.2" fill="#f59e0b"/>' +
      '<circle cx="19" cy="25" r="3" fill="#fff"/><circle cx="30" cy="25" r="3" fill="#fff"/>' +
      '<path d="M18.5 32 q5.5 5 11 0" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round"/>' +
      "</svg>"
    );
  }

  function icon(name, extra) {
    var paths = {
      back: '<path d="M15 18l-6-6 6-6"/>',
      arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
      check: '<path d="M20 6L9 17l-5-5"/>',
      flame: '<path d="M12 3c2 3 4 4 4 8a4 4 0 0 1-8 0c0-1 .5-2 1-2.5C9 10 12 8 12 3z"/>',
      bolt: '<path d="M13 2L3 14h6l-1 8 10-12h-6z" fill="currentColor" stroke="none"/>',
      copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
      lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'
    };
    return (
      '<svg width="' + (extra && extra.size || 18) + '" height="' + (extra && extra.size || 18) +
      '" viewBox="0 0 24 24" fill="none" stroke="' + (extra && extra.stroke || "currentColor") +
      '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (paths[name] || "") + "</svg>"
    );
  }

  // ---------- rewards ----------
  function applyStepCompletionRewards(step) {
    var today = todayISO();
    if (state.lastActiveDay !== today) {
      state.streak = (state.streak || 0) + 1;
      state.lastActiveDay = today;
    }
    state.xp = (state.xp || 0) + step.xp;
    if (state.completedSteps.indexOf(step.id) === -1) {
      state.completedSteps.push(step.id);
    }
    var pct = Math.round((state.completedSteps.length / CUR.steps.length) * 100);
    state.lastWinReward = {
      xpGained: step.xp,
      streak: state.streak,
      pct: pct,
      closing: step.closing,
      isFinal: state.completedSteps.length >= CUR.steps.length
    };
  }

  // ---------- render dispatcher ----------
  function render() {
    var html = "";
    switch (state.screen) {
      case "welcome": html = renderWelcome(); break;
      case "name": html = renderName(); break;
      case "taskAudience": html = renderTaskAudience(); break;
      case "teaser": html = renderTeaser(); break;
      case "commit": html = renderCommit(); break;
      case "login": html = renderLogin(); break;
      case "home": html = renderHome(); break;
      case "chat": html = renderChat(); break;
      case "win": html = renderWin(); break;
      case "ladder": html = renderLadder(); break;
      default: html = renderWelcome();
    }
    app.innerHTML = html;
    if (state.screen === "win") spawnConfetti();
    var focusTarget = app.querySelector("[data-autofocus]");
    if (focusTarget) focusTarget.focus();
  }

  // ---------- screens ----------
  function renderWelcome() {
    return (
      '<div class="screen">' +
      '<div class="appbar"><div class="brand"><span class="mark">' + brandMarkSvg() + "</span><span>KaamAI</span></div></div>" +
      '<div class="content" style="justify-content:space-between;flex:1;">' +
      '<div style="flex:1;display:flex;flex-direction:column;justify-content:center;gap:26px;">' +
      '<div class="art">' + welcomeArtSvg() + "</div>" +
      '<div style="display:flex;flex-direction:column;gap:14px;">' +
      '<h1 class="h1 xl">Still using ChatGPT like a search box?</h1>' +
      '<p class="sub">Let’s build you an AI that actually works for you, not the other way around.</p>' +
      "</div></div>" +
      '<div style="display:flex;flex-direction:column;gap:14px;">' +
      '<button class="btn btn-amber" data-act="welcome:start" data-autofocus>Start (2 min, free) ' + icon("arrow", { stroke: "#3d2c06" }) + "</button>" +
      (SYNC.enabled() ? '<button class="btn btn-ghost" data-act="login:open">Already started? Log in</button>' : "") +
      '<p class="note">No sign-up needed to begin.</p>' +
      "</div></div></div>"
    );
  }

  function renderName() {
    var roles = CUR ? Object.keys(CUR.roles) : [];
    var chips = roles.map(function (r) {
      return chipHtml(r, "select:role", r, state.role === r);
    }).join("");
    return (
      '<div class="screen">' +
      topBar(true, 1, 4) +
      '<div class="content">' +
      '<h1 class="h1">First, what should we call you?</h1>' +
      '<p class="sub">Totally optional, but it makes this feel like yours.</p>' +
      '<div class="field">' +
      '<label class="flabel" for="nameInput">Your name</label>' +
      '<input class="textinput" id="nameInput" type="text" placeholder="e.g. Priya" value="' + esc(state.name) + '" maxlength="40" data-autofocus>' +
      "</div>" +
      '<div class="field">' +
      '<span class="flabel">What do you do?</span>' +
      '<div class="chips">' + chips + "</div>" +
      "</div>" +
      '<p class="note" style="margin-top:auto;">Tap a role to continue</p>' +
      "</div></div>"
    );
  }

  function renderTaskAudience() {
    var tasks = tasksForRole(state.role);
    var taskChips = tasks.map(function (t) {
      return chipHtml(t, "select:task", t, state.task === t, "col");
    }).join("");
    var audiences = CUR ? CUR.audiences : [];
    var audChips = audiences.map(function (a) {
      return chipHtml(a, "select:audience", a, state.audience === a);
    }).join("");
    return (
      '<div class="screen">' +
      topBar(true, 2, 4) +
      '<div class="content">' +
      '<span class="chip sel" style="align-self:flex-start;cursor:default;">' + icon("check", { size: 14, stroke: "#0a5850" }) + esc(state.role) + (state.name ? " &middot; " + esc(state.name) : "") + "</span>" +
      '<h1 class="h1">What eats too much of your time?</h1>' +
      '<p class="sub">Pick the task your assistant will take off your plate.</p>' +
      '<p class="flabel">Your grunt work</p>' +
      '<div class="chips col">' + taskChips + "</div>" +
      '<div class="divider"></div>' +
      '<p class="flabel">Who usually reads it?</p>' +
      '<div class="chips">' + audChips + "</div>" +
      '<p class="note" style="margin-top:auto;">Tap to continue</p>' +
      "</div></div>"
    );
  }

  function renderTeaser() {
    var an = assistantName();
    return (
      '<div class="screen">' +
      topBar(false, 3, 4) +
      '<div class="content">' +
      '<p class="eyebrow" style="display:flex;align-items:center;gap:7px;">' + icon("bolt", { size: 16, stroke: "#0f766e" }) + "This is what you’re about to build</p>" +
      '<div class="card" style="border:2px solid var(--teal);box-shadow:0 10px 26px -16px rgba(15,118,110,.4);">' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">' + svgAvatar() +
      '<div><div style="font-family:var(--display);font-weight:800;font-size:17px;">' + esc(state.name ? state.name + "’s Assistant" : "Your Assistant") + "</div>" +
      '<div style="font-size:12px;color:var(--ink3);font-weight:700;">' + esc(an) + "</div></div></div>" +
      '<div style="background:var(--teal-soft);border-radius:14px;padding:12px 14px;font-size:13.5px;line-height:1.4;color:var(--teal-dark);margin-bottom:12px;">' +
      "Give me your " + esc(state.task.toLowerCase()) + ", I’ll draft it ready for " + esc(state.audience) + ".</div>" +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      '<span class="chip" style="cursor:default;background:var(--amber-soft);border-color:transparent;color:var(--amber-dark);font-size:12px;">' + esc(state.audience) + "-ready</span>" +
      '<span class="chip" style="cursor:default;background:var(--amber-soft);border-color:transparent;color:var(--amber-dark);font-size:12px;">Yours to keep</span>' +
      "</div></div>" +
      '<h1 class="h1" style="font-size:19px;line-height:1.35;">' + esc(state.name ? state.name + ", meet your " + an + "." : "Meet your " + an + ".") + " You’ll build this, today.</h1>" +
      '<button class="btn btn-amber" style="margin-top:auto;" data-act="go:commit" data-autofocus>Let’s build it ' + icon("arrow", { stroke: "#3d2c06" }) + "</button>" +
      "</div></div>"
    );
  }

  function renderCommit() {
    var steps = CUR ? CUR.steps : [];
    var stepsHtml = steps.map(function (s, i) {
      return (
        '<div class="pstep" style="display:flex;align-items:center;gap:12px;padding:8px 0;">' +
        '<div style="width:28px;height:28px;border-radius:9px;background:var(--teal-soft);color:var(--teal-dark);font-family:var(--display);font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center;flex:none;">' + (i + 1) + "</div>" +
        '<span style="font-size:14px;font-weight:700;">' + esc(s.title) + "</span></div>"
      );
    }).join("");
    var backend = SYNC.enabled();
    var sub = !backend
      ? "Everything is saved on this device so it’s here when you come back."
      : SYNC.authed()
        ? "You’re signed in. Let’s build your assistant."
        : "Verify your email so your assistant is saved to your account, on any device.";
    return (
      '<div class="screen">' +
      topBar(true, 4, 4) +
      '<div class="content">' +
      '<h1 class="h1" style="font-size:23px;">Ready? ' + steps.length + ' quick steps and it’s built.</h1>' +
      '<p class="sub">' + sub + "</p>" +
      '<div class="card">' +
      '<p class="flabel" style="margin-bottom:10px;">Your build path</p>' + stepsHtml +
      "</div>" +
      commitAuthRegion(backend) +
      '<div class="reassure">' + icon("lock", { size: 16, stroke: "var(--ink3)" }) +
      "<span>Go as fast as you like. Steps unlock the moment you finish one, no waiting.</span></div>" +
      "</div></div>"
    );
  }

  // The email/OTP/start region of the Commit screen. Local-only mode keeps the
  // original optional-email + "Start step 1" behaviour untouched. When the user
  // is already authenticated (e.g. they arrived via "Log in" then filled the
  // onramp), skip the OTP and let them start building directly.
  function commitAuthRegion(backend) {
    var arrow = icon("arrow", { stroke: "#3d2c06" });
    if (!backend) {
      return (
        '<div class="field">' +
        '<label class="flabel" for="emailInput">Email (optional)</label>' +
        '<input class="textinput" id="emailInput" type="email" inputmode="email" placeholder="you@example.com" value="' + esc(state.email) + '">' +
        "</div>" +
        '<button class="btn btn-amber" data-act="commit:start" data-autofocus>Start step 1 ' + arrow + "</button>"
      );
    }
    if (SYNC.authed()) {
      return (
        '<div class="reassure" style="margin-bottom:12px;">' + icon("check", { size: 16, stroke: "#0a5850" }) +
        "<span>You’re signed in" + (state.email ? " as <b>" + esc(state.email) + "</b>" : "") + ".</span></div>" +
        '<button class="btn btn-amber" data-act="commit:startAuthed" data-autofocus>Start step 1 ' + arrow + "</button>"
      );
    }
    if (otpUI.stage === "code") return otpCodeStage();
    return otpEmailStage({ autofocus: true });
  }

  // Shared OTP fields, used by BOTH the Commit gate and the "Log in" screen so the
  // send/verify handlers (which read #emailInput / #otpInput and drive otpUI) work
  // identically in either place. otpUI.context tells the verify handler where to go.
  function otpEmailStage(opts) {
    opts = opts || {};
    var arrow = icon("arrow", { stroke: "#3d2c06" });
    var err = otpUI.error ? '<p class="note" style="color:#c0392b;">' + esc(otpUI.error) + "</p>" : "";
    return (
      '<div class="field">' +
      '<label class="flabel" for="emailInput">Email</label>' +
      '<input class="textinput" id="emailInput" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="' + esc(otpUI.email || state.email) + '"' + (opts.autofocus ? " data-autofocus" : "") + ">" +
      "</div>" + err +
      '<button class="btn btn-amber" data-act="otp:send"' + (otpUI.sending ? " disabled" : "") + ">" +
      (otpUI.sending ? "Sending…" : "Send code " + arrow) + "</button>" +
      '<p class="note">We’ll email you a 6-digit code to verify it’s you.</p>'
    );
  }

  function otpCodeStage() {
    var arrow = icon("arrow", { stroke: "#3d2c06" });
    var disp = otpUI.email;
    var err = otpUI.error ? '<p class="note" style="color:#c0392b;">' + esc(otpUI.error) + "</p>" : "";
    var verifyLabel = otpUI.context === "login" ? "Verify &amp; continue " : "Verify &amp; start ";
    return (
      '<p class="sub" style="margin-top:2px;">Enter the code we sent to <b>' + esc(disp) + "</b>. " +
      '<a data-act="otp:back" style="color:var(--teal);cursor:pointer;font-weight:700;">change email</a></p>' +
      '<div class="field">' +
      '<label class="flabel" for="otpInput">Verification code</label>' +
      '<input class="textinput" id="otpInput" type="tel" inputmode="numeric" autocomplete="one-time-code" placeholder="Code from your email" maxlength="8" data-autofocus>' +
      "</div>" + err +
      '<button class="btn btn-amber" data-act="otp:verify"' + (otpUI.verifying ? " disabled" : "") + ">" +
      (otpUI.verifying ? "Verifying…" : verifyLabel + arrow) + "</button>" +
      '<button class="btn btn-ghost" data-act="otp:resend">Resend code</button>'
    );
  }

  // "Log in" screen — returning users authenticate with mobile + OTP and resume.
  function renderLogin() {
    var region = otpUI.stage === "code" ? otpCodeStage() : otpEmailStage({ autofocus: true });
    return (
      '<div class="screen">' +
      topBar(true, 0, 0) +
      '<div class="content">' +
      '<h1 class="h1">Welcome back</h1>' +
      '<p class="sub">Log in with your email to pick up where you left off, on any device.</p>' +
      region +
      "</div></div>"
    );
  }

  function renderHome() {
    var totalSteps = CUR ? CUR.steps.length : 5;
    var doneCount = state.completedSteps.length;
    var pct = Math.round((doneCount / totalSteps) * 100);
    var ringR = 27, ringC = 2 * Math.PI * ringR;
    var ringOffset = ringC * (1 - pct / 100);
    var allDone = doneCount >= totalSteps;
    var step = currentStep();

    var todayCard;
    if (allDone) {
      todayCard = (
        '<div class="today done">' +
        '<div class="today-top"><span class="eyebrow">All done</span></div>' +
        '<h2 class="today-title">Your assistant is built</h2>' +
        '<p class="today-sub">' + esc(assistantName()) + ' is ready to use. Revisit the ladder for what’s next.</p>' +
        '<button class="btn btn-teal" data-act="home:viewInstructions">View my instructions</button>' +
        "</div>"
      );
    } else if (step) {
      todayCard = (
        '<div class="today">' +
        '<div class="today-top"><span class="eyebrow">Next step</span><span class="mins">~' + step.minutes + " min</span></div>" +
        '<h2 class="today-title">' + esc(step.title) + "</h2>" +
        '<p class="today-sub">' + esc(step.subtitle) + "</p>" +
        '<button class="btn btn-amber" data-act="go:chat" data-autofocus>Continue building ' + icon("arrow", { stroke: "#3d2c06" }) + "</button>" +
        "</div>"
      );
    } else {
      todayCard = "";
    }

    var nodes = (CUR ? CUR.steps : []).map(function (s, i) {
      var cls = state.completedSteps.indexOf(s.id) > -1 ? "done" : (i === state.stepIndex && !allDone ? "current" : "locked");
      var label = cls === "done" ? "&check;" : (i + 1);
      var conn = i < (CUR.steps.length - 1) ? '<div class="conn ' + (state.completedSteps.indexOf(s.id) > -1 ? "filled" : "") + '"></div>' : "";
      return '<div class="node ' + cls + '">' + label + "</div>" + conn;
    }).join("");

    return (
      '<div class="screen">' +
      '<div class="appbar">' +
      '<div><div class="hello">Hi ' + esc(state.name || "there") + "</div><div class=\"hsub\">" + doneCount + " of " + totalSteps + ' steps built</div></div>' +
      '<div class="spacer"></div>' + svgAvatar() +
      "</div>" +
      '<div class="content">' +
      '<div class="stats">' +
      '<div class="stat">' + icon("flame", { size: 24, stroke: "#f59e0b" }) + '<span class="snum">' + (state.streak || 0) + '</span><span class="slbl">day streak</span></div>' +
      '<div class="stat"><div class="ringwrap"><svg class="ring" viewBox="0 0 64 64"><circle class="ring-bg" cx="32" cy="32" r="' + ringR + '"/><circle class="ring-fg" cx="32" cy="32" r="' + ringR + '" stroke-dasharray="' + ringC.toFixed(1) + '" stroke-dashoffset="' + ringOffset.toFixed(1) + '"/></svg><div class="ringpct">' + pct + '%</div></div><span class="slbl">assistant built</span></div>' +
      '<div class="stat">' + icon("bolt", { size: 24, stroke: "#f59e0b" }) + '<span class="snum">' + (state.xp || 0) + '</span><span class="slbl">XP</span></div>' +
      "</div>" +
      todayCard +
      '<div class="build">' +
      '<div class="build-top">' + svgAvatar("sm") + '<div><div class="build-name">' + esc(assistantName()) + '</div><div class="build-sub">Being built by you</div></div></div>' +
      '<div class="nodes">' + nodes + "</div>" +
      "</div></div></div>"
    );
  }

  function renderChat() {
    var step = currentStep();
    if (!step) { state.screen = "ladder"; saveState(); return renderLadder(); }
    var sp = state.stepProgress;
    var vars = chatVars();

    var rows = "";
    for (var i = 0; i < sp.turnIndex; i++) {
      var t = step.turns[i];
      rows += chatRow(fillTemplate(t.coach, vars), "coach");
      var chosen = getTurnAnswer(step, i);
      if (chosen) rows += chatRow(esc(chosen), "user");
    }
    var curTurn = step.turns[sp.turnIndex];

    if (curTurn) {
      rows += chatRow(fillTemplate(curTurn.coach, vars), "coach");
      if (curTurn.action && curTurn.action.type === "openBuilder") {
        rows += '<div class="row"><a class="btn btn-teal" style="max-width:260px;" href="' + esc(CUR.meta.builderUrl) + '" target="_blank" rel="noopener" data-act="noop">' + esc(curTurn.action.label) + " " + icon("arrow", { stroke: "#fff" }) + "</a></div>";
      }
      if (sp.stuckShown && step.help) {
        rows += chatRow(step.help.stuck, "coach");
      }
    }

    if (sp.branchMsg) {
      rows += chatRow(sp.branchMsg, "coach");
    }

    var resultCard = "";
    if (sp.awaitingContinue && (step.produces === "instructions" || step.produces === "instructionsAppend")) {
      resultCard = chatRow(
        '<div class="result"><h4>Your assistant’s instructions</h4><pre id="instrPreview">' + esc(state.instructionsText) + '</pre>' +
        '<button class="copybtn" id="copyBtn" data-act="chat:copy">' + icon("copy", { size: 14 }) + "Copy instructions</button></div>",
        "coach", true
      );
    }

    if (sp.awaitingContinue) {
      rows += resultCard;
      rows += chatRow(esc(step.closing), "coach");
    }

    var composer;
    if (sp.awaitingInput) {
      composer =
        '<div class="field">' +
        '<label class="flabel" for="exampleInput">Your example</label>' +
        '<textarea class="textarea" id="exampleInput" aria-label="Paste an example of your past work" placeholder="Paste a few lines of your old ' + esc(state.task.toLowerCase()) + '..." data-autofocus></textarea>' +
        '</div><button class="btn btn-teal" style="margin-top:10px;" data-act="chat:submitExample">Use this example ' + icon("arrow", { stroke: "#fff" }) + "</button>" +
        '<button class="btn btn-ghost" style="margin-top:8px;" data-act="chat:skipExample">I don’t have one, skip</button>';
    } else if (sp.awaitingContinue) {
      composer = '<button class="btn btn-amber" data-act="chat:finishStep" data-autofocus>Continue ' + icon("arrow", { stroke: "#3d2c06" }) + "</button>";
    } else if (curTurn) {
      composer = '<div class="chips">' + curTurn.chips.map(function (c, ci) {
        return '<button class="chip" data-act="chat:chip" data-val="' + ci + '">' + esc(c.label) + "</button>";
      }).join("") + "</div>";
    } else {
      composer = "";
    }

    return (
      '<div class="screen">' +
      '<div class="chat-bar">' +
      '<button class="iconbtn" data-act="go:home" aria-label="Back to home">' + icon("back", { stroke: "#57534e" }) + "</button>" +
      '<div class="chat-title"><b>Step ' + (state.stepIndex + 1) + " of " + CUR.steps.length + "</b><span class=\"chat-sub\">" + esc(step.title) + "</span></div>" +
      '<div class="spacer"></div>' + svgAvatar("sm") +
      "</div>" +
      '<div class="chat" id="chatScroll">' + rows + "</div>" +
      '<div class="composer">' + composer + "</div>" +
      "</div>"
    );
  }

  function chatRow(html, who, noAvatar) {
    var avatar = who === "coach" && !noAvatar ? svgAvatar("sm") : "";
    return '<div class="row ' + (who === "user" ? "user" : "") + '">' + avatar + '<div class="msg ' + who + ' enter">' + html + "</div></div>";
  }

  function chatVars() {
    var a = state.answers;
    return {
      audience: state.audience,
      task: (state.task || "").toLowerCase(),
      assistantName: assistantName(),
      lead: a.lead, tone: a.tone, constraint: a.constraint, example: a.example
    };
  }

  function getTurnAnswer(step, turnIdx) {
    var turn = step.turns[turnIdx];
    var key = "_turnLabel_" + step.id + "_" + turnIdx;
    return state.answers[key] || null;
  }

  function renderWin() {
    var r = state.lastWinReward || { xpGained: 0, streak: state.streak, pct: 0, isFinal: false };
    var primaryLabel = r.isFinal ? "See what’s next →" : "Next step →";
    var primaryAct = r.isFinal ? "win:toLadder" : "win:next";
    return (
      '<div class="screen win">' +
      '<div class="confetti" id="confettiLayer"></div>' +
      '<div class="win-inner">' +
      svgAvatar("lg cheer") +
      '<h2 class="win-h">Nice work!</h2>' +
      '<p class="win-p">' + esc(r.closing || "You made real progress.") + "</p>" +
      '<div class="rewards">' +
      '<div class="reward">' + icon("flame", { size: 24, stroke: "#ffb84d" }) + '<span><b class="amberchip">' + (state.streak >= 2 ? "+1" : "") + '</b> streak, now ' + r.streak + " day" + (r.streak === 1 ? "" : "s") + "</span></div>" +
      '<div class="reward">' + icon("bolt", { size: 24, stroke: "#ffb84d" }) + '<span><b class="amberchip">+' + r.xpGained + " XP</b></span></div>" +
      '<div class="reward">' + icon("copy", { size: 24, stroke: "#fff" }) + '<span><b>Assistant ' + r.pct + '% built</b></span></div>' +
      "</div>" +
      '<div class="winbtns">' +
      '<button class="btn btn-white" data-act="' + primaryAct + '" data-autofocus>' + primaryLabel + "</button>" +
      '<button class="btn btn-outline-w" data-act="go:home">I’ll continue later</button>' +
      "</div></div></div>"
    );
  }

  function renderLadder() {
    return (
      '<div class="screen">' +
      '<div class="content" style="padding-top:36px;">' +
      '<div class="badge-lg">' + icon("flame", { size: 34, stroke: "#c97e07" }) + "</div>" +
      '<h1 class="h1" style="text-align:center;">You built your first AI.</h1>' +
      '<p class="sub" style="text-align:center;">Most people never get past using ChatGPT as search. You have a working assistant you made yourself.</p>' +
      '<div class="card" style="display:flex;align-items:center;gap:13px;">' + svgAvatar() +
      '<div><b style="font-family:var(--display);font-weight:800;font-size:14.5px;display:block;">' + esc(assistantName()) + '</b><span style="font-size:12px;color:var(--ink3);font-weight:700;">Built by you &middot; ready to use</span></div></div>' +
      '<div class="rungs">' +
      '<div class="rung done"><div class="rnum">&check;</div><span class="rtext">Build your AI assistant</span></div>' +
      '<div class="rung next"><div class="rnum">2</div><span class="rtext">Give it your knowledge</span><span class="rtag">Next</span></div>' +
      '<div class="rung"><div class="rnum">3</div><span class="rtext">Automate a real task</span></div>' +
      '<div class="rung"><div class="rnum">4</div><span class="rtext">Build a tool others use</span></div>' +
      "</div>" +
      '<button class="btn btn-amber" style="margin-top:6px;" data-act="ladder:rung2" data-autofocus>Notify me for rung 2 ' + icon("arrow", { stroke: "#3d2c06" }) + "</button>" +
      '<button class="btn btn-ghost" data-act="go:home">Back to my assistant</button>' +
      "</div></div>"
    );
  }

  // ---------- small shared bits ----------
  function topBar(showBack, step, total) {
    var dots = "";
    for (var i = 1; i <= total; i++) dots += '<span class="dot ' + (i <= step ? "on" : "") + '"></span>';
    return (
      '<div class="top">' +
      (showBack ? '<button class="back" data-act="go:back" aria-label="Back">' + icon("back", { stroke: "#57534e" }) + "</button>" : "") +
      '<div class="dots">' + dots + "</div></div>"
    );
  }

  function chipHtml(label, act, val, selected, extraClass) {
    return (
      '<button class="chip ' + (selected ? "sel" : "") + " " + (extraClass || "") + '" data-act="' + act + '" data-val="' + esc(val) + '">' +
      (selected ? icon("check", { size: 14, stroke: "#0a5850" }) : "") + esc(label) + "</button>"
    );
  }

  function brandMarkSvg() {
    return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v6M12 16v6M2 12h6M16 12h6"/><circle cx="12" cy="12" r="3"/></svg>';
  }

  function welcomeArtSvg() {
    return (
      '<svg width="130" height="110" viewBox="0 0 130 110" fill="none" stroke="#0f766e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="20" y="18" width="90" height="66" rx="12"/>' +
      '<circle cx="47" cy="48" r="4" fill="#0f766e" stroke="none"/><circle cx="83" cy="48" r="4" fill="#0f766e" stroke="none"/>' +
      '<path d="M46 64q19 14 38 0"/><path d="M65 84v14M50 98h30"/></svg>'
    );
  }

  function spawnConfetti() {
    var layer = document.getElementById("confettiLayer");
    if (!layer) return;
    var colors = ["#f59e0b", "#ffd789", "#16a34a", "#7fe0d3", "#ffffff"];
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 26; i++) {
      var s = document.createElement("span");
      s.style.left = Math.random() * 100 + "%";
      s.style.background = colors[i % colors.length];
      s.style.animationDuration = (1.6 + Math.random() * 1.4) + "s";
      s.style.animationDelay = Math.random() * 0.5 + "s";
      s.style.transform = "rotate(" + Math.random() * 360 + "deg)";
      frag.appendChild(s);
    }
    layer.appendChild(frag);
  }

  // ---------- actions ----------
  function go(screen) {
    state.screen = screen;
    saveState();
    render();
  }

  function handleAction(act, val, el) {
    switch (act) {
      case "welcome:start":
        SYNC.logEvent("welcome_start", {});
        go("name");
        break;

      case "select:role": {
        var nameEl = document.getElementById("nameInput");
        if (nameEl) state.name = nameEl.value.trim().slice(0, 40);
        state.role = val;
        state.task = ""; // role changed, task choice no longer valid
        SYNC.logEvent("role_picked", { role: val });
        saveState();
        go("taskAudience");
        break;
      }

      case "select:task":
        state.task = val;
        SYNC.logEvent("task_picked", { task: val });
        saveState();
        render();
        break;

      case "select:audience":
        state.audience = val;
        saveState();
        if (state.task && state.audience) go("teaser"); else render();
        break;

      case "go:back":
        if (state.screen === "name") go("welcome");
        else if (state.screen === "taskAudience") go("name");
        else if (state.screen === "login") go("welcome");
        else render();
        break;

      case "go:commit":
        otpUI.context = "commit";
        otpUI.error = "";
        go("commit");
        break;

      case "login:open":
        resetOtpUI("login");
        go("login");
        break;

      case "commit:start": {
        var emailEl = document.getElementById("emailInput");
        if (emailEl) state.email = emailEl.value.trim();
        state.stepIndex = 0;
        state.stepProgress = freshStepProgress();
        saveState();
        go("chat");
        break;
      }

      case "commit:startAuthed": {
        // Already authenticated (arrived via "Log in", then filled the onramp).
        // Provision the profile + assistant from the draft, then start building.
        state.stepIndex = 0;
        state.stepProgress = freshStepProgress();
        saveState();
        go("chat");
        SYNC.provisionFromDraft(state).then(function (assistantId) {
          if (assistantId) { state.assistantId = assistantId; saveState(); }
        });
        break;
      }

      case "otp:send":
      case "otp:resend": {
        var eEl = document.getElementById("emailInput");
        var email = eEl ? eEl.value.trim() : otpUI.email;
        if (act === "otp:send") {
          if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            otpUI.error = "Enter a valid email address.";
            render();
            break;
          }
          otpUI.email = email;
        }
        otpUI.error = "";
        otpUI.sending = true;
        render();
        SYNC.sendOtp(otpUI.email).then(function (res) {
          otpUI.sending = false;
          if (res.ok) {
            otpUI.stage = "code";
            if (act === "otp:resend") toast("Code re-sent.");
          } else {
            otpUI.error = friendlyAuthError(res.error);
          }
          render();
        });
        break;
      }

      case "otp:back":
        otpUI.stage = "email";
        otpUI.error = "";
        render();
        break;

      case "otp:verify": {
        var cEl = document.getElementById("otpInput");
        var code = cEl ? cEl.value.trim() : "";
        if (!/^\d{4,8}$/.test(code)) {
          otpUI.error = "Enter the code we sent you.";
          render();
          break;
        }
        otpUI.error = "";
        otpUI.verifying = true;
        render();
        SYNC.verifyOtp(otpUI.email, code).then(function (res) {
          otpUI.verifying = false;
          if (!res.ok) {
            otpUI.error = friendlyAuthError(res.error);
            render();
            return;
          }
          state.email = otpUI.email;
          SYNC.logEvent("otp_verified", {});
          if (otpUI.context === "login") completeLogin();
          else completeCommitVerify();
        });
        break;
      }

      case "go:chat":
        state.stepProgress = freshStepProgress();
        saveState();
        go("chat");
        break;

      case "go:home":
        go("home");
        break;

      case "home:viewInstructions":
        alert(state.instructionsText || "No instructions yet.");
        break;

      case "chat:chip":
        handleChatChip(parseInt(val, 10));
        break;

      case "chat:submitExample": {
        var ex = document.getElementById("exampleInput");
        var text = ex ? ex.value.trim() : "";
        if (!text) { render(); break; }
        state.answers.example = text.slice(0, 1200);
        state.answers.hasExample = true;
        advanceAfterInputTurn();
        break;
      }

      case "chat:skipExample":
        state.answers.hasExample = false;
        advanceAfterInputTurn();
        break;

      case "chat:copy":
        copyInstructions(el);
        break;

      case "chat:finishStep":
        finishCurrentStep();
        break;

      case "win:next":
        state.stepIndex += 1;
        state.stepProgress = freshStepProgress();
        saveState();
        go("chat");
        break;

      case "win:toLadder":
        go("ladder");
        break;

      case "ladder:rung2":
        SYNC.logEvent("notify_rung2", {});
        toast("Rung 2 is coming soon. We’ll notify you when it’s ready.");
        break;

      case "noop":
        break;
    }
  }

  function handleChatChip(chipIndex) {
    var step = currentStep();
    var sp = state.stepProgress;
    var turn = step.turns[sp.turnIndex];
    if (!turn || isNaN(chipIndex) || !turn.chips[chipIndex]) return;
    var chip = turn.chips[chipIndex];

    // record label for transcript replay
    state.answers["_turnLabel_" + step.id + "_" + sp.turnIndex] = chip.label;
    // merge sets
    if (chip.sets) {
      for (var k in chip.sets) state.answers[k] = chip.sets[k];
    }

    // special: step 'create' stuck handling — keep same turn, show help, don't advance
    if (step.id === "create" && chip.sets && chip.sets.created === false) {
      sp.stuckShown = true;
      saveState();
      render();
      return;
    }

    // special: step 'test' branch handling
    if (step.branches && chip.sets && chip.sets.result) {
      sp.branchMsg = step.branches[chip.sets.result] || null;
      sp.awaitingContinue = true;
      finalizeStepOutput(step);
      saveState();
      render();
      return;
    }

    if (chip.opensInput) {
      sp.awaitingInput = true;
      saveState();
      render();
      return;
    }

    advanceTurn();
  }

  function advanceAfterInputTurn() {
    var step = currentStep();
    var sp = state.stepProgress;
    sp.awaitingInput = false;
    advanceTurn();
  }

  function advanceTurn() {
    var step = currentStep();
    var sp = state.stepProgress;
    sp.turnIndex += 1;
    if (sp.turnIndex >= step.turns.length) {
      sp.awaitingContinue = true;
      finalizeStepOutput(step);
    }
    saveState();
    render();
    scrollChatToBottom();
  }

  function finalizeStepOutput(step) {
    var vars = chatVars();
    if (step.produces === "instructions") {
      state.instructionsText = fillTemplate(step.outputTemplate, vars);
    } else if (step.produces === "instructionsAppend") {
      if (state.answers.hasExample && state.answers.example) {
        state.instructionsText += fillTemplate(step.outputTemplate, vars);
      } else if (step.noExampleNote) {
        state.stepProgress.branchMsg = fillTemplate(step.noExampleNote, vars);
      }
    }
  }

  function finishCurrentStep() {
    var step = currentStep();
    applyStepCompletionRewards(step);
    var isFinal = state.completedSteps.length >= CUR.steps.length;
    if (isFinal) state.assistantStatus = "complete";
    else if (step.id === "test") state.assistantStatus = "tested";
    SYNC.insertCompletion(state, step);
    SYNC.logEvent("step_completed", { stepId: step.id, n: step.n });
    if (isFinal) SYNC.logEvent("rung1_complete", {});
    saveState();
    go("win");
  }

  // After OTP verify from the Commit gate: this is now a real account; carry the
  // local draft into it and start building. Provisioning runs in the background.
  function completeCommitVerify() {
    state.stepIndex = 0;
    state.stepProgress = freshStepProgress();
    saveState();
    go("chat"); // optimistic — provisioning runs in the background
    SYNC.provisionFromDraft(state).then(function (assistantId) {
      if (assistantId) { state.assistantId = assistantId; saveState(); }
    });
  }

  // After OTP verify from the "Log in" screen: pull the server copy and route.
  // Existing assistant -> resume on the home dashboard. New email (or a profile
  // with no assistant yet) -> treat as a new user and drop into the onramp; they
  // are already authenticated, so the Commit step skips a second OTP.
  function completeLogin() {
    saveState();
    SYNC.pullState().then(function (pulled) {
      SYNC.flushQueues();
      if (pulled && pulled.state) {
        mergeServerState(pulled.state, pulled.updatedAt);
        if (pulled.state.assistantId) { go("home"); return; }
      }
      go("name");
    }).catch(function () { go("name"); });
  }

  function friendlyAuthError(err) {
    var e = String(err || "");
    if (/backend-disabled/.test(e)) return "Verification isn’t set up yet. Try again later.";
    if (/rate|too many|limit/i.test(e)) return "Too many tries. Wait a minute and retry.";
    if (/invalid|expired|token/i.test(e)) return "That code didn’t match. Check it and try again.";
    if (/network|fetch|Failed/i.test(e)) return "Network hiccup. Check your connection and retry.";
    return e || "Something went wrong. Please try again.";
  }

  function copyInstructions(btnEl) {
    var text = state.instructionsText || "";
    function done(ok) {
      if (!btnEl) return;
      btnEl.classList.toggle("copied", ok);
      btnEl.textContent = ok ? "Copied!" : "Copy failed, select manually";
      setTimeout(function () {
        if (btnEl) { btnEl.classList.remove("copied"); btnEl.innerHTML = icon("copy", { size: 14 }) + "Copy instructions"; }
      }, 1800);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  }

  function scrollChatToBottom() {
    requestAnimationFrame(function () {
      var el = document.getElementById("chatScroll");
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById("kaamai-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "kaamai-toast";
      el.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#1c1b19;color:#fff;padding:12px 18px;border-radius:12px;font-size:13.5px;font-weight:700;z-index:80;max-width:86%;text-align:center;box-shadow:0 10px 24px -10px rgba(0,0,0,.4);";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = "none"; }, 2600);
  }

  // ---------- boot ----------
  app.addEventListener("click", function (e) {
    var el = e.target.closest("[data-act]");
    if (!el) return;
    if (el.tagName === "A") e.preventDefault() || window.open(el.href, "_blank", "noopener");
    handleAction(el.getAttribute("data-act"), el.getAttribute("data-val"), el);
  });

  window.addEventListener("online", function () { offlineBanner.hidden = true; });
  window.addEventListener("offline", function () { offlineBanner.hidden = false; });
  if (!navigator.onLine) offlineBanner.hidden = false;

  function boot() {
    state = loadState();

    var curriculumP = fetch(CURRICULUM_URL)
      .then(function (r) {
        if (!r.ok) throw new Error("curriculum fetch failed: " + r.status);
        return r.json();
      })
      .then(function (json) { CUR = json; });

    // Restore from the backend if a session exists. Server wins when its copy is
    // newer than the local one (last-write-wins by updated_at). Never blocks the
    // app: any failure falls back to the local state.
    var restoreP = Promise.resolve();
    if (SYNC.enabled()) {
      restoreP = SYNC.getSession().then(function (session) {
        if (!session) return null;
        return SYNC.pullState().then(function (pulled) {
          if (pulled && pulled.updatedAt >= (state.updatedAt || 0)) {
            mergeServerState(pulled.state, pulled.updatedAt);
          }
          SYNC.flushQueues();
        });
      }).catch(function (e) { console.warn("KaamAI: restore skipped", e); });
    }

    Promise.all([curriculumP, restoreP])
      .then(function () { render(); })
      .catch(function (err) {
        console.error("KaamAI: failed to load curriculum.json", err);
        app.innerHTML =
          '<div class="screen"><div class="errbox">' +
          '<h1 class="h1">Something didn’t load</h1>' +
          '<p class="sub">Check your connection and reload. Your progress is safe on this device.</p>' +
          '<button class="btn btn-teal" onclick="location.reload()">Reload</button>' +
          "</div></div>";
      });

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("sw.js").catch(function (e) {
          console.warn("KaamAI: service worker registration failed", e);
        });
      });
    }
  }

  boot();
})();
