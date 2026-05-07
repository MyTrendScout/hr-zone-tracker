// App.js — HR Zone Tracker

// ═══════════════════════════════════════════════════════════════
// FIREBASE
// ═══════════════════════════════════════════════════════════════
let db;
try {
  firebase.initializeApp(FIREBASE_CONFIG);
  db = firebase.firestore();
} catch (e) {
  document.getElementById("root").innerHTML =
    '<div class="error"><h2>Firebase not configured</h2>' +
    '<p>Open <strong>firebase-config.js</strong> and fill in your Firebase project values.</p></div>';
}

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════
let state = {
  user:            null,
  profile:         null,
  zones:           null,
  goal:            null,
  workouts:        [],
  allUsers:        null,
  pendingRequests: [],
  view:            "login",
  loading:         false,
  error:           null
};

function setState(updates) {
  Object.assign(state, updates);
  render();
}

// ═══════════════════════════════════════════════════════════════
// PASSWORD HASHING  (Web Crypto — built into all modern browsers)
// ═══════════════════════════════════════════════════════════════
async function hashPassword(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ═══════════════════════════════════════════════════════════════
// FIRESTORE HELPERS
// ═══════════════════════════════════════════════════════════════
function userDoc(userId) {
  return db.collection("users").doc(userId || state.user.id);
}

async function loadUserData(userId) {
  const [profileSnap, zonesSnap, goalSnap, workoutsSnap] = await Promise.all([
    userDoc(userId).collection("data").doc("profile").get(),
    userDoc(userId).collection("data").doc("zones").get(),
    userDoc(userId).collection("data").doc("goal").get(),
    userDoc(userId).collection("workouts").orderBy("date", "desc").limit(100).get()
  ]);
  return {
    profile:  profileSnap.exists  ? profileSnap.data()  : null,
    zones:    zonesSnap.exists    ? zonesSnap.data()    : null,
    goal:     goalSnap.exists     ? goalSnap.data()     : null,
    workouts: workoutsSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  };
}

async function saveData(docName, data) {
  await userDoc().collection("data").doc(docName).set(data, { merge: true });
}

async function addWorkout(data) {
  await userDoc().collection("workouts").add(data);
}

// ═══════════════════════════════════════════════════════════════
// HR ZONES  (Karvonen + Tanaka)
// ═══════════════════════════════════════════════════════════════
function estimateMaxHR(age) {
  return Math.round(207 - (0.7 * age));
}

function calcZones(maxHR, restingHR) {
  const hrr = maxHR - restingHR;
  const z = (lo, hi) => ({ low: Math.round(restingHR + lo * hrr), high: Math.round(restingHR + hi * hrr) });
  return {
    maxHR, restingHR, hrr,
    z1: { name: "Recovery", ...z(0.50, 0.65), desc: "Very easy. Full sentences. Warm-up, cool-down, rest days." },
    z2: { name: "Base",     ...z(0.65, 0.80), desc: "Comfortable. Can talk in sentences. Your aerobic engine." },
    z3: { name: "Speed",    ...z(0.80, 0.92), desc: "Hard. Few words only. Tempo and threshold work." }
  };
}

// ═══════════════════════════════════════════════════════════════
// RIEGEL FORMULA + GOAL VALIDATION
// ═══════════════════════════════════════════════════════════════
const MARATHON_MI = 26.2188;

function riegelPredict(timeSec, distMi, targetMi) {
  return timeSec * Math.pow(targetMi / distMi, 1.06);
}

function secsToHMS(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${pad(m)}:${pad(sec)}`;
}

function pad(n) { return String(n).padStart(2, "0"); }

function paceToSecs(str) {
  if (!str) return null;
  const parts = str.trim().split(":");
  if (parts.length !== 2) return null;
  const m = parseInt(parts[0], 10), s = parseInt(parts[1], 10);
  if (isNaN(m) || isNaN(s) || s >= 60) return null;
  return m * 60 + s;
}

function secsToMarathon(secsPerMile) { return secsPerMile * MARATHON_MI; }

function predictedPace(finishSec) {
  const spm = finishSec / MARATHON_MI;
  return `${Math.floor(spm / 60)}:${pad(Math.round(spm % 60))}`;
}

function getBestPrediction(workouts) {
  const valid = workouts.filter(w => w.distanceMi > 0.5 && w.durationSec > 0);
  if (!valid.length) return null;
  const w = valid[0];
  const sec = riegelPredict(w.durationSec, w.distanceMi, MARATHON_MI);
  return { sec, timeStr: secsToHMS(sec), paceStr: predictedPace(sec) + "/mi", basedOn: w };
}

function validateGoal(targetPaceStr, predictedSec) {
  const tps = paceToSecs(targetPaceStr);
  if (!tps) return null;
  const goalSec = secsToMarathon(tps);
  const pctDiff = (predictedSec - goalSec) / predictedSec;
  let status, msg;
  if (pctDiff <= 0.02)      { status = "achievable"; msg = "Your goal is right in line with your current fitness. Great target."; }
  else if (pctDiff <= 0.12) { status = "stretch";    msg = `Requires ~${Math.round(pctDiff * 100)}% improvement. A solid stretch goal — achievable with consistent training.`; }
  else if (pctDiff <= 0.22) { status = "aggressive"; msg = `Requires ~${Math.round(pctDiff * 100)}% improvement. Aggressive for one cycle. Consider a stepping-stone goal.`; }
  else                      { status = "unsafe";     msg = `Requires ~${Math.round(pctDiff * 100)}% improvement. This risks overtraining and injury. We strongly recommend a safer goal.`; }
  const realisticSec = predictedSec * 0.92;
  const rpm = realisticSec / MARATHON_MI;
  return { status, msg, goalSec, predictedSec, realisticPace: `${Math.floor(rpm / 60)}:${pad(Math.round(rpm % 60))}`, realisticFinishStr: secsToHMS(realisticSec) };
}

// ═══════════════════════════════════════════════════════════════
// TRAINING PLAN
// ═══════════════════════════════════════════════════════════════
const DAYS   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const DNAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function weeksUntil(dateStr) {
  return Math.max(0, Math.round((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24 * 7)));
}

function currentPhase(weeks) {
  if (weeks > 20) return { name: "Base Building", note: "Easy miles. Build your aerobic engine. Nothing heroic yet." };
  if (weeks > 12) return { name: "Build",          note: "Add tempo runs. Long runs grow each week." };
  if (weeks > 6)  return { name: "Peak",           note: "Your hardest weeks. Trust the process." };
  if (weeks > 2)  return { name: "Taper",          note: "Cut volume, keep sharpness. Rest is training." };
  return               { name: "Race Week",      note: "Rest, hydrate, believe. You're ready." };
}

function buildWeekPlan(longRunDay, totalDays) {
  const plan = DAYS.map((d, i) => ({ idx: i, day: d, type: "Rest", zone: null, notes: "" }));
  plan[longRunDay] = { idx: longRunDay, day: DAYS[longRunDay], type: "Long Run",  zone: "Base (Z2)",     notes: "Stay in Zone 2 the whole run. Slow down if needed." };
  const placed = [longRunDay];
  let rem = totalDays - 1;
  const tempoDay = (longRunDay + 4) % 7;
  if (rem > 0 && !placed.includes(tempoDay)) {
    plan[tempoDay] = { idx: tempoDay, day: DAYS[tempoDay], type: "Tempo Run", zone: "Speed (Z3)", notes: "10 min warm-up → 20–30 min at Zone 3 → 10 min cool-down." };
    placed.push(tempoDay); rem--;
  }
  for (let offset = 1; offset < 7 && rem > 0; offset++) {
    const d = (longRunDay + offset) % 7;
    if (!placed.includes(d)) {
      plan[d] = { idx: d, day: DAYS[d], type: "Easy Run", zone: "Recovery (Z1)", notes: "Conversational pace only. No watch pressure." };
      placed.push(d); rem--;
    }
  }
  return plan;
}

// ═══════════════════════════════════════════════════════════════
// DOM HELPERS
// ═══════════════════════════════════════════════════════════════
function el(tag, props, ...children) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k === "className") e.className = v;
      else if (k === "htmlFor") e.setAttribute("for", v);
      else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
      else e[k] = v;
    }
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    e.appendChild(typeof child === "string" || typeof child === "number"
      ? document.createTextNode(String(child))
      : child);
  }
  return e;
}

function div(cls, ...c)  { return el("div",    { className: cls }, ...c); }
function h1(...c)        { return el("h1",     null, ...c); }
function h2(...c)        { return el("h2",     null, ...c); }
function h3(...c)        { return el("h3",     null, ...c); }
function p(...c)         { return el("p",      null, ...c); }
function span(...c)      { return el("span",   null, ...c); }
function li(...c)        { return el("li",     null, ...c); }

function btn(label, onClick, cls) { return el("button", { onClick, className: cls || "" }, label); }

function field(labelText, inputEl) {
  return div("field", el("label", { htmlFor: inputEl.id || inputEl.name }, labelText), inputEl);
}

function input(props) { return el("input", props); }

function select(id, options, value) {
  const s = el("select", { id });
  for (const [label, val] of options) {
    const o = el("option", { value: val }, label);
    if (String(val) === String(value)) o.selected = true;
    s.appendChild(o);
  }
  return s;
}

function pageHeader(title, onBack) {
  return el("header", null, h1(title), onBack ? btn("← Back", onBack, "btn-back") : null);
}

function statBox(label, value) {
  return div("stat-box",
    el("span", { className: "stat-value" }, String(value ?? "—")),
    el("span", { className: "stat-label" }, label)
  );
}

function zoneBar(zone, cls) {
  return div(`zone-bar ${cls}`,
    div("zone-bar-label",
      el("span", { className: "zone-name" }, zone.name),
      el("span", { className: "zone-range" }, `${zone.low}–${zone.high} bpm`)
    ),
    p(zone.desc)
  );
}

function showError(msg) { setState({ error: msg }); }
function clearError()   { state.error = null; }
function errorBanner() {
  if (!state.error) return null;
  return div("banner banner-warning", state.error);
}

// ═══════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════
function render() {
  const root = document.getElementById("root");
  if (!root || !db) return;
  root.innerHTML = "";
  root.appendChild(getView());
}

function getView() {
  if (state.loading) return div("loading", "Loading…");
  // These views are accessible without being logged in
  if (state.view === "request-access" || state.view === "request-sent") return RequestAccessPage();
  if (!state.user)   return LoginPage();
  switch (state.view) {
    case "request-access": return RequestAccessPage();
    case "setup-profile":  return SetupProfile();
    case "setup-zones":    return SetupZones();
    case "setup-test":     return SetupTest();
    case "setup-prefs":    return SetupPrefs();
    case "setup-goal":     return SetupGoal();
    case "log-workout":    return LogWorkout();
    case "history":        return WorkoutHistory();
    case "plan":           return PlanPage();
    case "test":           return FieldTest();
    case "command":        return state.user.admin ? CommandCenter() : Dashboard();
    default:               return Dashboard();
  }
}

// ═══════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════
function LoginPage() {
  const doLogin = async () => {
    clearError();
    const pw = (document.getElementById("pw")?.value || "").trim();
    if (!pw) return;
    document.getElementById("pw").value = "";

    // Admin — plain text compare (password lives only in firebase-config.js)
    if (pw === ADMIN.password) {
      setState({ loading: true, error: null });
      try {
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("Connection timed out.")), 8000));
        const data = await Promise.race([loadUserData(ADMIN.id), timeout]);
        setState({ user: ADMIN, ...data, loading: false, error: null, view: data.profile ? "dashboard" : "setup-profile" });
      } catch (err) {
        setState({ loading: false, error: "Could not connect to Firebase: " + err.message });
      }
      return;
    }

    // Everyone else — hash and look up in approvedUsers
    setState({ loading: true, error: null });
    try {
      const hash = await hashPassword(pw);
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("Connection timed out.")), 8000));
      const snap = await Promise.race([
        db.collection("approvedUsers").where("passwordHash", "==", hash).get(),
        timeout
      ]);

      if (snap.empty) {
        setState({ loading: false, error: "Wrong password. Try again or request access below." });
        return;
      }

      const doc  = snap.docs[0];
      const info = doc.data();
      const user = { id: doc.id, name: info.name, admin: false };
      const data = await loadUserData(doc.id);
      setState({ user, ...data, loading: false, error: null, view: data.profile ? "dashboard" : "setup-profile" });
    } catch (err) {
      setState({ loading: false, error: "Could not connect to Firebase: " + err.message });
    }
  };

  const pwInput = input({ id: "pw", type: "password", placeholder: "Password" });
  pwInput.addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

  return div("login-page",
    h1("HR Zone Tracker"),
    p("Enter your password to access your training."),
    errorBanner(),
    div("field", pwInput),
    btn("Login", doLogin),
    div("link-row",
      btn("Request Access →", () => setState({ view: "request-access", error: null }), "btn-link")
    )
  );
}

function doLogout() {
  setState({ user: null, profile: null, zones: null, goal: null, workouts: [], allUsers: null, pendingRequests: [], view: "login", error: null });
}

// ═══════════════════════════════════════════════════════════════
// REQUEST ACCESS
// ═══════════════════════════════════════════════════════════════
function RequestAccessPage() {
  const submit = async () => {
    clearError();
    const name    = (document.getElementById("ra-name")?.value || "").trim();
    const pw      = (document.getElementById("ra-pw")?.value   || "").trim();
    const pwConf  = (document.getElementById("ra-pw2")?.value  || "").trim();
    const note    = (document.getElementById("ra-note")?.value || "").trim();

    if (!name)        { showError("Please enter your name."); return; }
    if (!pw)          { showError("Please choose a password."); return; }
    if (pw.length < 6){ showError("Password must be at least 6 characters."); return; }
    if (pw !== pwConf){ showError("Passwords don't match."); return; }
    if (pw === ADMIN.password) { showError("That password is not available. Choose a different one."); return; }

    // Check not already pending
    setState({ loading: true, error: null });
    try {
      const hash = await hashPassword(pw);

      // Reject if already approved with same password
      const existing = await db.collection("approvedUsers").where("passwordHash", "==", hash).get();
      if (!existing.empty) { setState({ loading: false, error: "That password is already in use. Choose a different one." }); return; }

      await db.collection("signupRequests").add({
        name, passwordHash: hash, note, status: "pending",
        requestedAt: new Date().toISOString()
      });

      setState({ loading: false, view: "request-sent" });
    } catch (err) {
      setState({ loading: false, error: "Could not submit request: " + err.message });
    }
  };

  // Success screen
  if (state.view === "request-sent") {
    return div("login-page",
      h1("Request Sent ✓"),
      p("Your access request has been submitted. The admin will review it and let you know when you're approved."),
      p("Once approved, come back here and log in with the password you chose."),
      btn("Back to Login", () => setState({ view: "login", error: null }))
    );
  }

  return div("login-page",
    pageHeader("Request Access", () => setState({ view: "login", error: null })),
    p("Fill in your details below. The admin will approve your request before you can log in."),
    errorBanner(),
    field("Your Name *", input({ id: "ra-name", type: "text", placeholder: "e.g. Sara" })),
    field("Choose a Password *", input({ id: "ra-pw", type: "password", placeholder: "At least 6 characters" })),
    field("Confirm Password *", input({ id: "ra-pw2", type: "password", placeholder: "Repeat your password" })),
    field("Note to admin (optional)", input({ id: "ra-note", type: "text", placeholder: "e.g. Hi John, I'm your Thursday running partner" })),
    btn("Submit Request", submit)
  );
}

// ═══════════════════════════════════════════════════════════════
// SETUP — Profile
// ═══════════════════════════════════════════════════════════════
function SetupProfile() {
  const save = async () => {
    const name      = document.getElementById("s-name")?.value.trim();
    const age       = parseInt(document.getElementById("s-age")?.value);
    const heightFt  = parseInt(document.getElementById("s-ht-ft")?.value) || 0;
    const heightIn  = parseInt(document.getElementById("s-ht-in")?.value) || 0;
    const weight    = parseFloat(document.getElementById("s-weight")?.value);
    const restingHR = parseInt(document.getElementById("s-rhr")?.value);

    if (!name || !age || !weight || !restingHR) { showError("Please fill in all required fields."); return; }
    if (age < 18 || age > 95)                   { showError("Please enter a valid age (18–95)."); return; }
    if (restingHR < 35 || restingHR > 100)       { showError("Resting HR should be between 35–100 bpm."); return; }

    const profile = { name, age, heightFt, heightIn, weight, restingHR, createdAt: new Date().toISOString() };
    setState({ loading: true });
    await saveData("profile", profile);
    setState({ profile, loading: false, view: "setup-zones", error: null });
  };

  return div("page",
    div("setup-page",
      div("step-indicator", "Step 1 of 4 — Profile"),
      h2("Tell us about yourself"),
      p("This helps us calculate your heart rate zones and flag fueling issues."),
      errorBanner(),
      field("Your Name *", input({ id: "s-name", type: "text", placeholder: "e.g. John" })),
      field("Age *", input({ id: "s-age", type: "number", placeholder: "e.g. 52", min: "18", max: "95" })),
      div("field-row",
        field("Height (ft)", input({ id: "s-ht-ft", type: "number", placeholder: "5", min: "4", max: "7" })),
        field("Height (in)", input({ id: "s-ht-in", type: "number", placeholder: "10", min: "0", max: "11" }))
      ),
      field("Weight (lbs) *", input({ id: "s-weight", type: "number", placeholder: "e.g. 165", step: "0.1" })),
      field("Resting Heart Rate (bpm) *", input({ id: "s-rhr", type: "number", placeholder: "e.g. 58 — check first thing in the morning", min: "35", max: "100" })),
      btn("Next →", save)
    )
  );
}

// ═══════════════════════════════════════════════════════════════
// SETUP — Zone method
// ═══════════════════════════════════════════════════════════════
function SetupZones() {
  const { age, restingHR } = state.profile;
  const maxHR = estimateMaxHR(age);
  const est   = calcZones(maxHR, restingHR);

  const useEstimate = async () => {
    const zoneData = { ...est, method: "estimated", lastTested: null };
    setState({ loading: true });
    await saveData("zones", zoneData);
    setState({ zones: zoneData, loading: false, view: "setup-prefs" });
  };

  return div("page",
    div("setup-page",
      div("step-indicator", "Step 2 of 4 — Heart Rate Zones"),
      h2("Set up your training zones"),
      p(`Based on your age (${age}) and resting HR (${restingHR} bpm), here are your estimated zones:`),
      div("zone-preview", zoneBar(est.z1, "z1"), zoneBar(est.z2, "z2"), zoneBar(est.z3, "z3")),
      p("Estimates are a solid starting point. You can run a field test at any time to get exact numbers."),
      btn("Use These Zones — Continue", useEstimate),
      div("link-row", btn("I want to do the field test now →", () => setState({ view: "setup-test" }), "btn-link"))
    )
  );
}

// ═══════════════════════════════════════════════════════════════
// SETUP — Field test
// ═══════════════════════════════════════════════════════════════
function SetupTest() {
  const save = async () => {
    const avgHR  = parseInt(document.getElementById("t-avg")?.value);
    const peakHR = parseInt(document.getElementById("t-peak")?.value);
    if (!avgHR || !peakHR)           { showError("Please enter both values."); return; }
    if (peakHR <= avgHR)             { showError("Peak HR must be higher than your average HR."); return; }
    if (peakHR < 100 || peakHR > 220){ showError("Peak HR looks off — check you entered it correctly."); return; }
    const zoneData = { ...calcZones(peakHR, state.profile.restingHR), method: "tested", lastTested: new Date().toISOString() };
    setState({ loading: true });
    await saveData("zones", zoneData);
    setState({ zones: zoneData, loading: false, view: "setup-prefs", error: null });
  };

  return div("page",
    div("setup-page",
      div("step-indicator", "Step 2 of 4 — Field Test"),
      pageHeader("Baseline Heart Rate Test", () => setState({ view: "setup-zones" })),
      errorBanner(),
      p("Do this on a flat track. Wear your HR monitor."),
      el("ol", null,
        li("Easy 20-minute jog to warm up."),
        li("Run 3 laps on a 400m track:"),
        li("Laps 1–2 at about 80% effort. Watch your average HR."),
        li("Lap 3: go as fast as you can. Note your peak HR.")
      ),
      field("Average HR during laps 1–2 (bpm)", input({ id: "t-avg", type: "number", placeholder: "e.g. 148", min: "80", max: "200" })),
      field("Peak HR during lap 3 (bpm)",        input({ id: "t-peak", type: "number", placeholder: "e.g. 174", min: "100", max: "220" })),
      btn("Save & Continue →", save)
    )
  );
}

// ═══════════════════════════════════════════════════════════════
// SETUP — Preferences
// ═══════════════════════════════════════════════════════════════
function SetupPrefs() {
  const save = async () => {
    const raceDate     = document.getElementById("p-race")?.value;
    const longRunDay   = parseInt(document.getElementById("p-lrd")?.value);
    const trainingDays = parseInt(document.getElementById("p-days")?.value);
    if (!raceDate)                    { showError("Please enter your race date."); return; }
    if (new Date(raceDate) <= new Date()) { showError("Race date must be in the future."); return; }
    const prefs = { raceDate, longRunDay, trainingDays };
    setState({ loading: true });
    await saveData("profile", { ...state.profile, ...prefs });
    setState({ profile: { ...state.profile, ...prefs }, loading: false, view: "setup-goal", error: null });
  };

  return div("page",
    div("setup-page",
      div("step-indicator", "Step 3 of 4 — Training Preferences"),
      h2("Plan your training"),
      errorBanner(),
      field("Race Date *", input({ id: "p-race", type: "date", min: new Date().toISOString().split("T")[0] })),
      field("Long Run Day", select("p-lrd", DNAMES.map((d, i) => [d, i]), 6)),
      field("Training Days Per Week", select("p-days", [[3,3],[4,4],[5,5],[6,6]].map(([l,v]) => [`${l} days`, v]), 4)),
      btn("Next →", save)
    )
  );
}

// ═══════════════════════════════════════════════════════════════
// SETUP — Race goal
// ═══════════════════════════════════════════════════════════════
function SetupGoal() {
  const prediction = getBestPrediction(state.workouts);

  const save = async () => {
    const paceInput  = document.getElementById("g-pace")?.value.trim();
    const secPerMile = paceToSecs(paceInput);
    if (!secPerMile) { showError("Enter your goal pace as M:SS — for example 9:30"); return; }
    const finishSec  = secsToMarathon(secPerMile);
    const validation = prediction ? validateGoal(paceInput, prediction.sec) : null;
    const goal = { targetPace: paceInput, targetFinish: secsToHMS(finishSec), validation, setAt: new Date().toISOString() };
    setState({ loading: true });
    await saveData("goal", goal);
    setState({ goal, loading: false, view: "dashboard", error: null });
  };

  return div("page",
    div("setup-page",
      div("step-indicator", "Step 4 of 4 — Race Goal"),
      h2("What's your goal pace?"),
      errorBanner(),
      !prediction && p("You haven't logged any workouts yet — we can't validate this against current fitness. You can update your goal any time."),
      prediction && p(`Current predicted marathon finish: ${prediction.timeStr} (${prediction.paceStr})`),
      field("Target pace per mile (M:SS)", input({ id: "g-pace", type: "text", placeholder: "e.g. 10:00" })),
      btn("Save Goal & Go to Dashboard", save),
      div("link-row", btn("Skip for now", () => setState({ view: "dashboard", error: null }), "btn-link"))
    )
  );
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════
function Dashboard() {
  const { profile, zones, goal, workouts, user } = state;
  const prediction    = getBestPrediction(workouts);
  const weeks         = profile?.raceDate ? weeksUntil(profile.raceDate) : null;
  const phase         = weeks != null ? currentPhase(weeks) : null;
  const plan          = (profile?.raceDate && profile?.longRunDay != null) ? buildWeekPlan(profile.longRunDay, profile.trainingDays || 4) : null;
  const recentWeights = workouts.filter(w => w.weightLbs).slice(0, 7).map(w => w.weightLbs);
  const weightWarning = checkWeightFlag(recentWeights);
  const retestDue     = zones?.lastTested && daysSince(zones.lastTested) > 28;

  return div("page",
    el("header", null,
      h1(`Hi, ${profile?.name || user.name}`),
      div("header-actions",
        user.admin ? btn("Command Center", () => loadCommandCenter(), "btn-small") : null,
        btn("Logout", doLogout, "btn-logout")
      )
    ),

    retestDue ? div("banner banner-info", "⏱ 4+ weeks since your last field test. ", el("span", { className: "banner-link", onClick: () => setState({ view: "test" }) }, "Run it now →")) : null,
    weightWarning ? div("banner banner-warning", `⚖️ ${weightWarning}`) : null,
    !goal ? div("banner banner-info", "🎯 No race goal set yet. ", el("span", { className: "banner-link", onClick: () => setState({ view: "setup-goal" }) }, "Set one now →")) : null,

    weeks != null ? div("card",
      h2("Race Overview"),
      div("stat-row",
        statBox("Race Date", new Date(profile.raceDate + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })),
        statBox("Weeks Out", weeks),
        statBox("Phase", phase.name)
      ),
      div("phase-note", phase.note),
      prediction ? div("prediction-box",
        p(el("span", { className: "pred-main" }, `📈 Predicted finish: ${prediction.timeStr} (${prediction.paceStr})`)),
        goal ? p(`🎯 Your goal: ${goal.targetFinish} (${goal.targetPace}/mi)`) : null,
        goal?.validation ? div(`goal-status ${goal.validation.status}`, goal.validation.msg) : null
      ) : p("Log a workout to see your predicted marathon finish time.")
    ) : null,

    zones ? div("card",
      h2("Your HR Zones"),
      el("div", { className: "zone-method" }, `Method: ${zones.method === "tested" ? "Field test ✓" : "Estimated"}`),
      zoneBar(zones.z1, "z1"), zoneBar(zones.z2, "z2"), zoneBar(zones.z3, "z3"),
      btn("Update Zones (Run Field Test)", () => setState({ view: "test" }), "btn-secondary")
    ) : null,

    plan ? div("card",
      h2("This Week"),
      div("week-plan",
        plan.map(day =>
          div(`day-slot ${day.type === "Rest" ? "rest" : "active"}`,
            el("strong", null, day.day),
            el("span", { className: "day-type" }, day.type),
            day.zone ? el("span", { className: "day-zone" }, day.zone) : null
          )
        )
      )
    ) : null,

    div("card",
      h2("Track Your Training"),
      div("menu",
        btn("Log a Workout",          () => setState({ view: "log-workout" })),
        btn("View Workout History",   () => setState({ view: "history" })),
        btn("View Full Training Plan",() => setState({ view: "plan" }))
      )
    )
  );
}

// ═══════════════════════════════════════════════════════════════
// LOG WORKOUT
// ═══════════════════════════════════════════════════════════════
function LogWorkout() {
  const save = async () => {
    const date       = document.getElementById("w-date")?.value;
    const distanceMi = parseFloat(document.getElementById("w-dist")?.value);
    const durStr     = document.getElementById("w-dur")?.value.trim();
    const avgHR      = parseInt(document.getElementById("w-hr")?.value) || null;
    const paceInput  = document.getElementById("w-pace")?.value.trim();
    const notes      = document.getElementById("w-notes")?.value.trim();
    const weightLbs  = parseFloat(document.getElementById("w-weight")?.value) || null;

    if (!date)                       { showError("Please enter the date."); return; }
    if (!distanceMi || distanceMi <= 0) { showError("Please enter a valid distance."); return; }
    if (!durStr)                     { showError("Please enter the duration."); return; }
    const durationSec = parseDuration(durStr);
    if (!durationSec)                { showError("Enter duration as M:SS (e.g. 54:30) or H:MM:SS (e.g. 1:32:00)."); return; }

    const pace = paceInput || calcPaceStr(durationSec, distanceMi);
    const predictedFinishSec = riegelPredict(durationSec, distanceMi, MARATHON_MI);
    const workout = { date, distanceMi, durationSec, avgHR, pace, notes: notes || "", weightLbs, predictedFinishSec, predictedFinishStr: secsToHMS(predictedFinishSec), predictedPaceStr: predictedPace(predictedFinishSec) + "/mi" };

    setState({ loading: true });
    await addWorkout(workout);
    const data = await loadUserData(state.user.id);
    let updatedGoal = state.goal;
    if (state.goal?.targetPace) {
      const newPred = getBestPrediction(data.workouts);
      if (newPred) { updatedGoal = { ...state.goal, validation: validateGoal(state.goal.targetPace, newPred.sec) }; await saveData("goal", updatedGoal); }
    }
    setState({ workouts: data.workouts, goal: updatedGoal, loading: false, view: "dashboard", error: null });
  };

  return div("page",
    div("card",
      pageHeader("Log a Workout", () => setState({ view: "dashboard" })),
      errorBanner(),
      field("Date *", input({ id: "w-date", type: "date", value: new Date().toISOString().split("T")[0] })),
      field("Distance (miles) *", input({ id: "w-dist", type: "number", placeholder: "e.g. 6.2", step: "0.01", min: "0.1" })),
      field("Duration * (M:SS or H:MM:SS)", input({ id: "w-dur", type: "text", placeholder: "e.g. 58:30 or 1:02:45" })),
      field("Average HR (bpm, optional)", input({ id: "w-hr", type: "number", placeholder: "e.g. 142", min: "60", max: "220" })),
      field("Pace per mile (M:SS, optional)", input({ id: "w-pace", type: "text", placeholder: "e.g. 9:26 — calculated if blank" })),
      field("Weight today (lbs, optional)", input({ id: "w-weight", type: "number", placeholder: "e.g. 162.5", step: "0.1" })),
      field("Notes (optional)", input({ id: "w-notes", type: "text", placeholder: "How did it feel?" })),
      btn("Save Workout", save)
    )
  );
}

// ═══════════════════════════════════════════════════════════════
// WORKOUT HISTORY
// ═══════════════════════════════════════════════════════════════
function WorkoutHistory() {
  return div("page",
    el("header", null, h1("Workout History"), btn("← Back", () => setState({ view: "dashboard" }), "btn-back")),
    state.workouts.length === 0
      ? div("card", p("No workouts logged yet."))
      : div("workout-list",
          state.workouts.map(w =>
            div("workout-card",
              div("workout-header",
                el("span", { className: "workout-date" }, w.date),
                el("span", { className: "workout-dist" }, `${w.distanceMi} mi — ${secsToHMS(w.durationSec)}`)
              ),
              div("workout-details",
                w.pace      ? span("⏱ ", w.pace, "/mi")        : null,
                w.avgHR     ? span("♥ ", w.avgHR, " bpm")      : null,
                w.weightLbs ? span("⚖️ ", w.weightLbs, " lbs") : null,
                span("📈 ", w.predictedFinishStr || "—")
              ),
              w.notes ? div("workout-notes", w.notes) : null
            )
          )
        )
  );
}

// ═══════════════════════════════════════════════════════════════
// FULL PLAN
// ═══════════════════════════════════════════════════════════════
function PlanPage() {
  const { profile } = state;
  if (!profile?.raceDate) return div("page", div("card", p("Complete setup to see your training plan.")));
  const weeks = weeksUntil(profile.raceDate);
  const phase = currentPhase(weeks);
  const plan  = buildWeekPlan(profile.longRunDay ?? 6, profile.trainingDays || 4);

  return div("page",
    el("header", null, h1("Training Plan"), btn("← Back", () => setState({ view: "dashboard" }), "btn-back")),
    div("card",
      div("stat-row", statBox("Weeks Out", weeks), statBox("Phase", phase.name), statBox("Days/Week", profile.trainingDays || 4)),
      div("phase-note", phase.note)
    ),
    div("card",
      h2("This Week"),
      plan.map(day =>
        div(`plan-day ${day.type === "Rest" ? "rest" : "active"}`,
          el("span", { className: "day-name" }, DNAMES[day.idx]),
          el("span", { className: "day-type-full" }, day.type),
          day.zone  ? el("span", { className: "day-zone-full" }, day.zone)  : null,
          day.notes ? el("span", { className: "day-notes" }, day.notes) : null
        )
      )
    )
  );
}

// ═══════════════════════════════════════════════════════════════
// FIELD TEST
// ═══════════════════════════════════════════════════════════════
function FieldTest() {
  const save = async () => {
    const avgHR  = parseInt(document.getElementById("ft-avg")?.value);
    const peakHR = parseInt(document.getElementById("ft-peak")?.value);
    if (!avgHR || !peakHR) { showError("Please enter both values."); return; }
    if (peakHR <= avgHR)   { showError("Peak HR must be higher than your lap 1–2 average."); return; }
    if (peakHR > 220)      { showError("Peak HR looks too high — double-check your reading."); return; }
    const zoneData = { ...calcZones(peakHR, state.profile.restingHR), method: "tested", lastTested: new Date().toISOString() };
    setState({ loading: true });
    await saveData("zones", zoneData);
    setState({ zones: zoneData, loading: false, view: "dashboard", error: null });
  };

  return div("page",
    div("card",
      pageHeader("Field Test", () => setState({ view: "dashboard" })),
      errorBanner(),
      p("Run this on a flat track. Wear your HR monitor."),
      el("ol", null,
        li("20-minute easy warm-up jog."),
        li("3 laps on the track:"),
        li("Laps 1–2 at 80% effort — note your average HR."),
        li("Lap 3 as fast as you can — note your peak HR.")
      ),
      field("Average HR during laps 1–2 (bpm)", input({ id: "ft-avg", type: "number", placeholder: "e.g. 148", min: "80", max: "200" })),
      field("Peak HR during lap 3 (bpm)",        input({ id: "ft-peak", type: "number", placeholder: "e.g. 174", min: "100", max: "220" })),
      btn("Save & Update My Zones", save)
    )
  );
}

// ═══════════════════════════════════════════════════════════════
// COMMAND CENTER  (admin only)
// ═══════════════════════════════════════════════════════════════
async function loadCommandCenter() {
  setState({ loading: true, view: "command" });
  try {
    const [approvedSnap, pendingSnap] = await Promise.all([
      db.collection("approvedUsers").get(),
      db.collection("signupRequests").where("status", "==", "pending").get()
    ]);

    const approved = approvedSnap.docs.map(d => ({ docId: d.id, ...d.data() }));
    const pending  = pendingSnap.docs.map(d => ({ docId: d.id, ...d.data() }));

    const allUsers = await Promise.all([
      // Admin's own data
      loadUserData(ADMIN.id).then(d => ({ ...d, name: ADMIN.name, userId: ADMIN.id, admin: true })),
      // All approved users
      ...approved.map(u => loadUserData(u.docId).then(d => ({ ...d, name: u.name, userId: u.docId, admin: false })))
    ]);

    setState({ allUsers, pendingRequests: pending, loading: false });
  } catch (err) {
    setState({ loading: false, error: "Could not load command center: " + err.message });
  }
}

async function approveRequest(docId, requestData) {
  await db.collection("approvedUsers").doc(docId).set({
    name: requestData.name,
    passwordHash: requestData.passwordHash,
    admin: false,
    approvedAt: new Date().toISOString()
  });
  await db.collection("signupRequests").doc(docId).update({ status: "approved" });
  await loadCommandCenter();
}

async function rejectRequest(docId) {
  await db.collection("signupRequests").doc(docId).update({ status: "rejected" });
  setState({ pendingRequests: state.pendingRequests.filter(r => r.docId !== docId) });
}

function CommandCenter() {
  const { allUsers, pendingRequests } = state;

  return div("page",
    el("header", null,
      h1("Command Center"),
      btn("← Back", () => setState({ view: "dashboard" }), "btn-back")
    ),

    // ── Pending requests
    pendingRequests.length > 0 ? div("card",
      h2(`Pending Requests (${pendingRequests.length})`),
      div("pending-list",
        pendingRequests.map(req =>
          div("pending-request",
            div("pending-info",
              el("strong", null, req.name),
              req.note ? p(req.note) : null,
              el("span", { className: "pending-date" }, `Requested: ${new Date(req.requestedAt).toLocaleDateString()}`)
            ),
            div("pending-actions",
              btn("✓ Approve", () => approveRequest(req.docId, req), "btn-approve"),
              btn("✗ Reject",  () => rejectRequest(req.docId),       "btn-reject")
            )
          )
        )
      )
    ) : div("card", p("No pending access requests.")),

    // ── All athletes
    h2("Athletes"),
    div("user-cards",
      (allUsers || []).map(u => {
        if (!u.profile) return div("user-card empty", el("em", null, `${u.name} — no profile yet`));
        const pred    = getBestPrediction(u.workouts);
        const weights = u.workouts.filter(w => w.weightLbs).slice(0, 7).map(w => w.weightLbs);
        const wFlag   = checkWeightFlag(weights);
        const retestDue = u.zones?.lastTested && daysSince(u.zones.lastTested) > 28;
        const last    = u.workouts[0];

        return div("user-card",
          h3(u.profile.name + (u.admin ? " ⭐" : "")),
          div("stat-row",
            statBox("Age",     u.profile.age),
            statBox("Runs",    u.workouts.length),
            statBox("Zones",   u.zones?.method || "none")
          ),
          last  ? p(`Last run: ${last.date} — ${last.distanceMi} mi`) : p("No workouts yet."),
          pred  ? p(`📈 Predicted: ${pred.timeStr} (${pred.paceStr})`) : null,
          u.goal ? p(`🎯 Goal: ${u.goal.targetFinish} (${u.goal.targetPace}/mi)`) : null,
          u.goal?.validation ? div(`goal-status ${u.goal.validation.status}`, u.goal.validation.msg) : null,
          wFlag     ? div("flag", `⚖️ ${wFlag}`)                       : null,
          retestDue ? div("flag", "⏱ Field test overdue (4+ weeks)")   : null
        );
      })
    )
  );
}

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════
function parseDuration(str) {
  const parts = str.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function calcPaceStr(durationSec, distMi) {
  const spm = durationSec / distMi;
  return `${Math.floor(spm / 60)}:${pad(Math.round(spm % 60))}`;
}

function daysSince(isoStr) {
  return Math.floor((Date.now() - new Date(isoStr)) / (1000 * 60 * 60 * 24));
}

function checkWeightFlag(weights) {
  if (weights.length < 2) return null;
  const dropped = weights[weights.length - 1] - weights[0];
  const pct = dropped / weights[weights.length - 1];
  if (pct > 0.02) return `Weight dropped ${Math.abs(dropped).toFixed(1)} lbs recently — check your fueling.`;
  return null;
}

// ═══════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", render);
