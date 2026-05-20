// App.js — MyPaceZone

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
// STRAVA CONFIG  — fill in your Client ID and Secret from
//                  strava.com/settings/api after registering the app
// ═══════════════════════════════════════════════════════════════
const STRAVA = {
  clientId:    "245325",
  clientSecret:"e6b2fde025f498e2322e86e47ac5bb56feb3e5f9",
  redirectUri: "https://mypacezone.com/app/",
  scope:       "activity:read_all"
};

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════
let planViewMode = null; // "calendar" or "chart" — persists during session
let expandedAthletes = new Set(); // userIds with workouts expanded in Command Center

const MOODS = [
  { key: "great",      label: "Great",      emoji: "😁", score: 5 },
  { key: "happy",      label: "Happy",      emoji: "🙂", score: 4 },
  { key: "soso",       label: "So-So",      emoji: "😐", score: 3 },
  { key: "offrun",     label: "Off Run",    emoji: "😕", score: 2 },
  { key: "struggling", label: "Struggling", emoji: "😩", score: 1 }
];

let state = {
  user:              null,
  profile:           null,
  zones:             null,
  goal:              null,
  workouts:          [],
  allUsers:          null,
  pendingRequests:   [],
  pendingCount:      0,
  editingWorkout:    null,
  groupData:         null,
  adminGroups:       [],
  stravaTokens:      null,   // { accessToken, refreshToken, expiresAt, athleteId }
  stravaActivities:  null,   // fetched runs pending import
  stravaLoading:     false,
  view:              "login",
  loading:           false,
  error:             null
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
  const [profileSnap, zonesSnap, goalSnap, workoutsSnap, userDocSnap] = await Promise.all([
    userDoc(userId).collection("data").doc("profile").get(),
    userDoc(userId).collection("data").doc("zones").get(),
    userDoc(userId).collection("data").doc("goal").get(),
    userDoc(userId).collection("workouts").orderBy("date", "desc").limit(100).get(),
    userDoc(userId).get()
  ]);
  return {
    profile:      profileSnap.exists  ? profileSnap.data()  : null,
    zones:        zonesSnap.exists    ? zonesSnap.data()    : null,
    goal:         goalSnap.exists     ? goalSnap.data()     : null,
    workouts:     workoutsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    stravaTokens: userDocSnap.exists  ? (userDocSnap.data().stravaTokens || null) : null
  };
}

async function saveData(docName, data) {
  await userDoc().collection("data").doc(docName).set(data, { merge: true });
}

async function addWorkout(data) {
  await userDoc().collection("workouts").add(data);
}

async function updateWorkout(id, data) {
  await userDoc().collection("workouts").doc(id).set(data);
}

async function loadGroupData(groupId, currentUserId) {
  const groupSnap = await db.collection("groups").doc(groupId).get();
  if (!groupSnap.exists) return null;
  const group = groupSnap.data();
  const otherIds = (group.memberIds || []).filter(id => id !== currentUserId);
  if (!otherIds.length) return { id: groupId, name: group.name, members: [] };

  const approvedSnap = await db.collection("approvedUsers").get();
  const nameMap = {};
  approvedSnap.docs.forEach(d => { nameMap[d.id] = d.data().name; });

  const members = await Promise.all(otherIds.map(async uid => {
    const snap = await db.collection("users").doc(uid).collection("workouts")
      .orderBy("date", "desc").limit(5).get();
    return { userId: uid, name: nameMap[uid] || "Teammate", workouts: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  }));
  return { id: groupId, name: group.name, members };
}

async function createGroup(name) {
  const ref = await db.collection("groups").add({ name, memberIds: [], createdAt: new Date().toISOString() });
  return ref.id;
}

async function setAthleteGroup(userId, groupId) {
  // Remove from old group first
  const groupsSnap = await db.collection("groups").where("memberIds", "array-contains", userId).get();
  await Promise.all(groupsSnap.docs.map(d => d.ref.update({ memberIds: d.data().memberIds.filter(id => id !== userId) })));
  if (groupId) {
    await db.collection("groups").doc(groupId).update({ memberIds: firebase.firestore.FieldValue.arrayUnion(userId) });
  }
  // Save groupId on user profile
  await db.collection("users").doc(userId).collection("data").doc("profile").set({ groupId: groupId || null }, { merge: true });
}

// ═══════════════════════════════════════════════════════════════
// STRAVA HELPERS
// ═══════════════════════════════════════════════════════════════

function stravaConnectURL() {
  return `https://www.strava.com/oauth/authorize?client_id=${STRAVA.clientId}` +
    `&redirect_uri=${encodeURIComponent(STRAVA.redirectUri)}` +
    `&response_type=code&approval_prompt=auto&scope=${STRAVA.scope}`;
}

async function stravaExchangeCode(code) {
  const resp = await fetch("https://www.strava.com/oauth/token", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id:     STRAVA.clientId,
      client_secret: STRAVA.clientSecret,
      code,
      grant_type: "authorization_code"
    })
  });
  return resp.json();
}

async function stravaRefreshToken(refreshToken) {
  const resp = await fetch("https://www.strava.com/oauth/token", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id:     STRAVA.clientId,
      client_secret: STRAVA.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  return resp.json();
}

async function stravaGetValidToken() {
  const tokens = state.stravaTokens;
  if (!tokens) return null;
  // Token still valid (with 60s buffer)
  if (Date.now() / 1000 < tokens.expiresAt - 60) return tokens.accessToken;
  // Refresh
  try {
    const data = await stravaRefreshToken(tokens.refreshToken);
    if (!data.access_token) return null;
    const newTokens = { ...tokens, accessToken: data.access_token, expiresAt: data.expires_at };
    await userDoc().set({ stravaTokens: newTokens }, { merge: true });
    setState({ stravaTokens: newTokens });
    return newTokens.accessToken;
  } catch (_) { return null; }
}

async function stravaSaveTokens(data) {
  const tokens = {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
    expiresAt:    data.expires_at,
    athleteId:    data.athlete?.id || null
  };
  await userDoc().set({ stravaTokens: tokens }, { merge: true });
  return tokens;
}

async function stravaDisconnect() {
  await userDoc().set({ stravaTokens: null }, { merge: true });
  setState({ stravaTokens: null, stravaActivities: null });
}

async function fetchStravaActivityDetail(token, activityId) {
  try {
    const resp = await fetch(
      `https://www.strava.com/api/v3/activities/${activityId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return await resp.json();
  } catch (err) {
    return null;
  }
}

async function fetchStravaActivities() {
  setState({ stravaLoading: true });
  try {
    const token = await stravaGetValidToken();
    if (!token) { setState({ stravaLoading: false, error: "Strava token invalid. Please reconnect." }); return; }

    // Step 1 — fetch activity list
    const resp = await fetch(
      "https://www.strava.com/api/v3/athlete/activities?per_page=30&page=1",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const all = await resp.json();
    if (!Array.isArray(all)) { setState({ stravaLoading: false, error: "Strava returned an unexpected response." }); return; }

    // Step 2 — fetch full details for each activity (gets per-mile splits with HR)
    // Throttle to avoid rate limit — fetch in batches of 5
    const detailed = [];
    for (let i = 0; i < all.length; i += 5) {
      const batch = all.slice(i, i + 5);
      const results = await Promise.all(
        batch.map(a => fetchStravaActivityDetail(token, a.id))
      );
      results.forEach((detail, idx) => {
        // Merge detail data over summary — fall back to summary if detail failed
        detailed.push(detail && !detail.errors ? { ...batch[idx], ...detail } : batch[idx]);
      });
    }

    setState({ stravaActivities: detailed, stravaLoading: false, view: "strava-import" });
  } catch (err) {
    setState({ stravaLoading: false, error: "Could not fetch Strava activities: " + err.message });
  }
}

function stravaToWorkout(activity) {
  const sportType = activity.sport_type || activity.type || "Run";
  const durSec    = activity.moving_time || 0;
  const dateStr   = (activity.start_date_local || "").split("T")[0];
  const avgHR     = activity.average_heartrate ? Math.round(activity.average_heartrate) : null;
  const maxHR     = activity.max_heartrate     ? Math.round(activity.max_heartrate)     : null;

  // Map Strava sport type → app type
  const typeMap = { Run: "Run", Walk: "Walk", Ride: "Bike", VirtualRide: "Bike",
                    Swim: "Swim", Yoga: "Yoga / Stretch", WeightTraining: "Strength",
                    Workout: "Strength", Hike: "Walk" };
  const type = typeMap[sportType] || "Run";

  // Extract per-mile splits from detail data (splits_standard = imperial/miles)
  // Each split has: distance, elapsed_time, moving_time, average_speed, average_heartrate, pace_zone
  let splits = null;
  let splitHRs = null;
  if (activity.splits_standard && Array.isArray(activity.splits_standard) && activity.splits_standard.length > 0) {
    const validSplits = activity.splits_standard.filter(s => s.moving_time > 0);
    if (validSplits.length > 0) {
      // Format splits as pace string per mile e.g. "9:10, 9:25, 9:05"
      splits = validSplits.map(s => {
        const distMi = s.distance / 1609.344;
        if (distMi < 0.1) return null;
        const paceDecimal = (s.moving_time / 60) / distMi;
        const pMin = Math.floor(paceDecimal);
        const pSec = Math.round((paceDecimal - pMin) * 60);
        return `${pMin}:${String(pSec).padStart(2, "0")}`;
      }).filter(Boolean).join(", ");

      // Store per-mile avg HR array for evaluation
      splitHRs = validSplits
        .map(s => s.average_heartrate ? Math.round(s.average_heartrate) : null)
        .filter(Boolean);
      if (splitHRs.length === 0) splitHRs = null;
    }
  }

  const base = {
    date: dateStr, type, durationSec: durSec,
    avgHR, maxHR, notes: activity.name || "",
    splits: splits || null,
    splitHRs: splitHRs || null,
    source: "strava", stravaId: activity.id, loggedAt: new Date().toISOString()
  };

  if (type === "Swim") {
    // Strava swim distance is in meters → convert to yards (1m = 1.0936 yd)
    const distYards = Math.round(activity.distance * 1.0936);
    const per100    = distYards > 0 ? (durSec / 60) / (distYards / 100) : 0;
    const pMin      = Math.floor(per100);
    const pSec      = Math.round((per100 - pMin) * 60);
    const pace      = distYards > 0 ? `${pMin}:${String(pSec).padStart(2, "0")}` : null;
    return { ...base, distanceYards: distYards, pace, paceUnit: "min/100yd" };
  }

  if (type === "Run" || type === "Walk" || type === "Bike") {
    const distMi      = parseFloat((activity.distance / 1609.344).toFixed(2));
    const paceDecimal = distMi > 0 ? (durSec / 60) / distMi : 0;
    const pMin        = Math.floor(paceDecimal);
    const pSec        = Math.round((paceDecimal - pMin) * 60);
    const pace        = distMi > 0 ? `${pMin}:${String(pSec).padStart(2, "0")}` : null;
    const result      = { ...base, distanceMi: distMi, pace, paceUnit: "min/mi" };
    if (type === "Run" && distMi > 0) {
      const predictedFinishSec = riegelPredict(durSec, distMi, MARATHON_MI);
      Object.assign(result, { predictedFinishSec, predictedFinishStr: secsToHMS(predictedFinishSec), predictedPaceStr: predictedPace(predictedFinishSec) + "/mi" });
    }
    return result;
  }

  return base; // Yoga / Strength / Other — time only
}

// Called on app init — checks URL for ?code= from Strava OAuth redirect
async function checkStravaCallback() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get("code");
  const error  = params.get("error");
  if (!code && !error) return false;
  // Clean the URL immediately
  window.history.replaceState({}, "", window.location.pathname);
  if (error) { setState({ error: "Strava authorization was cancelled." }); return true; }
  if (!state.user) { setState({ error: "Please log in first, then reconnect Strava." }); return true; }
  setState({ loading: true });
  try {
    const data = await stravaExchangeCode(code);
    if (!data.access_token) throw new Error(data.message || "Token exchange failed");
    const tokens = await stravaSaveTokens(data);
    setState({ stravaTokens: tokens, loading: false });
    await fetchStravaActivities();
  } catch (err) {
    setState({ loading: false, error: "Strava connection failed: " + err.message });
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════
// EMAIL NOTIFICATIONS  (Formspree — no server needed)
// ═══════════════════════════════════════════════════════════════
async function notifyAdmin(name, note) {
  if (!FORMSPREE_ID) return; // not configured — silent no-op
  try {
    await fetch(`https://formspree.io/f/${FORMSPREE_ID}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        subject:   `MyPaceZone — new beta request from ${name}`,
        name,
        note:      note || "(no note left)",
        timestamp: new Date().toLocaleString()
      })
    });
  } catch (_) {
    // Notification failure is non-fatal — request is already saved in Firebase
  }
}

// ═══════════════════════════════════════════════════════════════
// HR ZONES  (Karvonen + Tanaka)
// ═══════════════════════════════════════════════════════════════
function estimateMaxHR(age) {
  return Math.round(207 - (0.7 * age));
}

// ── Karvonen-based threshold zone calculation ──────────────────
// Threshold = 0.81 × (MaxHR - RestingHR) + RestingHR
// Run zones calculated as % of HRR + RestingHR
// Bike zones = Run zones - 11 bpm across the board
// Gap between ZR and Z1 is intentional — not a valid training zone
function calcZones(maxHR, restingHR) {
  const hrr       = maxHR - restingHR;
  const threshold = Math.round(0.81 * hrr + restingHR);
  const r = (lo, hi) => ({ low: Math.round(restingHR + lo * hrr), high: Math.round(restingHR + hi * hrr) });

  // Run zones
  const runZR = r(0.50, 0.62);
  const runZ1 = r(0.66, 0.74);
  const runZ2 = r(0.74, 0.82);
  const runZ3 = r(0.82, 0.90);

  // Bike zones = run zones - 11 bpm
  const bikeZR = { low: runZR.low - 11, high: runZR.high - 11 };
  const bikeZ1 = { low: runZ1.low - 11, high: runZ1.high - 11 };
  const bikeZ2 = { low: runZ2.low - 11, high: runZ2.high - 11 };
  const bikeZ3 = { low: runZ3.low - 11, high: runZ3.high - 11 };

  return {
    maxHR, restingHR, hrr, threshold,
    // Run zones
    zr: { name: "Recovery", ...runZR, desc: "Very easy. Full sentences. Warm-up, cool-down, rest days." },
    z1: { name: "Zone 1",   ...runZ1, desc: "Comfortable. Start here, build through the mile. Your aerobic base." },
    z2: { name: "Zone 2",   ...runZ2, desc: "Controlled effort. Negative split territory. Aerobic engine building." },
    z3: { name: "Zone 3",   ...runZ3, desc: "Hard. Few words only. Sub-threshold. Race pace work." },
    // Bike zones (cross-train days)
    bikeZr: { name: "Recovery", ...bikeZR, desc: "Very easy spin. Active recovery only." },
    bikeZ1: { name: "Zone 1",   ...bikeZ1, desc: "Comfortable aerobic ride. Endurance base." },
    bikeZ2: { name: "Zone 2",   ...bikeZ2, desc: "Controlled effort on the bike." },
    bikeZ3: { name: "Zone 3",   ...bikeZ3, desc: "Hard effort. Sub-threshold riding." },
    // Gap range (intentional — no valid training zone)
    gapLow:  runZR.high + 1,
    gapHigh: runZ1.low - 1
  };
}

// ═══════════════════════════════════════════════════════════════
// RIEGEL FORMULA + GOAL VALIDATION
// ═══════════════════════════════════════════════════════════════
const MARATHON_MI = 26.2188;

// Backward compatibility: old fitness level keys → new keys
const FITNESS_LEVEL_COMPAT = { beginner: "scratch", novice: "firstTimer", intermediate: "beenHereBefore", advanced: "competitive" };
function normalizeFitnessLevel(lvl) { return FITNESS_LEVEL_COMPAT[lvl] || lvl || "firstTimer"; }

const PLAN_LEVELS = {
  scratch: {
    label: "Walk to Run — just getting started",
    desc:  "Build from walk/run intervals to running continuously. Every step counts.",
    longStart: 3,  longPeak: 18,
    easyMiRange: [2, 4], midMiRange: [0, 0],
    hasFartlek: false
  },
  firstTimer: {
    label: "First Timer — comfortable running 3–4 miles",
    desc:  "Your first marathon. We'll get you to the start line strong and the finish line proud.",
    longStart: 6,  longPeak: 20,
    easyMiRange: [3, 5], midMiRange: [4, 7],
    hasFartlek: true
  },
  beenHereBefore: {
    label: "Been Here Before — done a race, ready to go farther",
    desc:  "You know what to do. Let's run it smarter and finish stronger.",
    longStart: 8,  longPeak: 20,
    easyMiRange: [4, 7], midMiRange: [5, 9],
    hasFartlek: true
  },
  competitive: {
    label: "Competitive — chasing a time goal",
    desc:  "Speed work, tempo runs, and peak mileage. Racing to a PR.",
    longStart: 10, longPeak: 20,
    easyMiRange: [5, 8], midMiRange: [6, 10],
    hasFartlek: true
  }
};

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
  // Only use runs of 4+ miles — shorter efforts give wildly inaccurate Riegel projections
  const valid = workouts.filter(w => RUNNING_TYPES.has(w.type) && w.distanceMi >= 4 && w.durationSec > 0);
  if (!valid.length) return null;
  // Pick the workout that produces the fastest (lowest) predicted finish — not just the latest
  let best = null;
  for (const w of valid) {
    const sec = riegelPredict(w.durationSec, w.distanceMi, MARATHON_MI);
    if (!best || sec < best.sec) best = { sec, w };
  }
  const { sec, w } = best;
  const confident = w.distanceMi >= 8; // 8+ mile runs give much more reliable estimates
  return {
    sec,
    timeStr:   secsToHMS(sec),
    paceStr:   predictedPace(sec) + "/mi",
    distMi:    w.distanceMi,
    date:      w.date,
    confident
  };
}

function validateGoal(targetPaceStr, predictedSec) {
  const tps = paceToSecs(targetPaceStr);
  if (!tps) return null;
  const goalSec = secsToMarathon(tps);
  const pctDiff = (predictedSec - goalSec) / predictedSec;
  const gapMin  = Math.round(Math.abs(predictedSec - goalSec) / 60);
  const predStr = secsToHMS(predictedSec);
  const goalStr = secsToHMS(goalSec);
  let status, msg;
  if (pctDiff <= 0.02) {
    status = "achievable";
    msg = `Right on target — your current fitness already predicts ${predStr}, right in line with your ${goalStr} goal. Stay consistent and trust the plan.`;
  } else if (pctDiff <= 0.12) {
    status = "stretch";
    msg = `Your current fitness predicts ${predStr}. Your goal is ${goalStr} — that's ${gapMin} minutes to find. A real stretch goal, and fully achievable with consistent training.`;
  } else if (pctDiff <= 0.22) {
    status = "aggressive";
    msg = `You're currently predicting ${predStr}. Your goal is ${goalStr} — ${gapMin} minutes away. Big goal. Let's train hard this cycle and reassess — you may want a stepping-stone target for race day while keeping the bigger goal in mind.`;
  } else {
    status = "unsafe";
    msg = `You're currently predicting ${predStr}. Your goal of ${goalStr} is ${gapMin} minutes ahead — that's a large jump for one training cycle. Most runners get there in 2–3 blocks. Let's see what this training produces and close the gap together.`;
  }
  const realisticSec = predictedSec * 0.92;
  const rpm = realisticSec / MARATHON_MI;
  return { status, msg, goalSec, predictedSec, realisticPace: `${Math.floor(rpm / 60)}:${pad(Math.round(rpm % 60))}`, realisticFinishStr: secsToHMS(realisticSec) };
}

// ═══════════════════════════════════════════════════════════════
// PLAN LENGTH RECOMMENDATION
// ═══════════════════════════════════════════════════════════════
function recommendedPlanWeeks(weeklyMileage, fitnessLevel, marathonHistory) {
  const key = normalizeFitnessLevel(fitnessLevel);
  const mi  = weeklyMileage || 0;
  if (mi < 15 || key === "scratch" || marathonHistory === "first") return { min: 20, max: 24 };
  if (mi < 25) return { min: 18, max: 20 };
  if (mi < 35) return { min: 16, max: 18 };
  return { min: 12, max: 16 };
}

function planLengthWarning(profile) {
  if (!profile?.raceDate) return null;
  const rec = recommendedPlanWeeks(profile.weeklyMileage, profile.fitnessLevel, profile.marathonHistory);
  const actual = Math.round((new Date(profile.raceDate + "T12:00:00") - new Date()) / (1000 * 60 * 60 * 24 * 7));
  if (actual < rec.min) {
    return `Your race is ${actual} weeks away but your profile suggests ${rec.min}–${rec.max} weeks of preparation. Consider adjusting your goal or race date.`;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// ZONE BOUND RESOLVER  (maps plan zone strings → bpm ranges)
// ═══════════════════════════════════════════════════════════════
function resolveZoneBounds(zoneStr, zones) {
  if (!zones || !zoneStr) return { low: null, high: null };
  switch (zoneStr) {
    case "Recovery": return { low: zones.zr?.low,  high: zones.zr?.high  };
    case "Z1":       return { low: zones.z1?.low,  high: zones.z1?.high  };
    case "Z1→Z2":    // long run (drift ok into Z2) — full band Z1.low → Z2.high
    case "Z1–Z2":    return { low: zones.z1?.low,  high: zones.z2?.high  };
    case "Z2":       return { low: zones.z2?.low,  high: zones.z2?.high  };
    case "Z2–Z3":    return { low: zones.z2?.low,  high: zones.z3?.high  };
    case "Z3":       return { low: zones.z3?.low,  high: zones.z3?.high  };
    default:         return { low: null, high: null };
  }
}

// Convert "YYYY-MM-DD" weekSunday + dayIndex (0=Sun) → "YYYY-MM-DD"
function isoFromWeekStart(weekSundayStr, dayIdx) {
  const d = new Date(weekSundayStr + "T12:00:00");
  d.setDate(d.getDate() + dayIdx);
  return d.toISOString().split("T")[0];
}

// ═══════════════════════════════════════════════════════════════
// TRAINING PLAN ENGINE
// ═══════════════════════════════════════════════════════════════
const DAYS   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const DNAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function weeksUntil(dateStr) {
  return Math.max(0, Math.round((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24 * 7)));
}

function getPhase(weeksToRace) {
  if (weeksToRace <= 1)  return { name: "Race Week",   note: "Rest, hydrate, believe. You are ready." };
  if (weeksToRace <= 4)  return { name: "Taper",       note: "Cut volume, keep sharpness. Rest is training." };
  if (weeksToRace <= 8)  return { name: "Peak",        note: "Your hardest weeks. Trust the process. This is where it comes together." };
  if (weeksToRace <= 15) return { name: "Build",       note: "Add quality runs. Long runs grow each week. Consistency beats intensity." };
  if (weeksToRace <= 21) return { name: "Base",        note: "Easy miles. Build your aerobic engine. Nothing heroic yet." };
  return                         { name: "Foundation", note: "Establish the habit. Every run matters. Keep it easy and stay consistent." };
}

function lerp(a, b, t) { return a + (b - a) * Math.min(1, Math.max(0, t)); }
function roundHalf(n)  { return Math.round(n * 2) / 2; }

// Mid-to-3/4 target band for a given zone
function zoneTargetBpm(zone) {
  if (!zone) return null;
  const mid  = Math.round(zone.lo + (zone.hi - zone.lo) * 0.50);
  const high = Math.round(zone.lo + (zone.hi - zone.lo) * 0.75);
  return { mid, high, label: `${mid}–${high} bpm` };
}

// Yasso 800 pace: "3:55:58" → "3:55" (hours become minutes, minutes become seconds)
function yassoTime(goalFinishStr) {
  if (!goalFinishStr) return null;
  const parts = goalFinishStr.split(":").map(Number);
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
  return `${parts[0]}:${String(parts[1]).padStart(2, "0")}`;
}

function calcWeekData(fitnessLevel, weeksIn, weeksToRace, comfortableLongRun, trainingDays, goalBracket) {
  const key   = normalizeFitnessLevel(fitnessLevel);
  const level = { ...PLAN_LEVELS[key] || PLAN_LEVELS.firstTimer };
  const days  = trainingDays || 4;

  // Finish-only goal: cap long run at 20 mi and disable fartlek progression
  if (goalBracket === "finish" || goalBracket === "sub-5") {
    level.longPeak  = Math.min(level.longPeak, 20);
    level.hasFartlek = false;
  }

  // If user told us their comfortable long run, use that as the starting point
  // but never exceed what the fitness level says is appropriate
  if (comfortableLongRun && comfortableLongRun > 0) {
    level.longStart = Math.min(comfortableLongRun, level.longStart);
  }
  const phase = getPhase(weeksToRace);

  // Helper: compute totalMi from component miles
  const computeTotal = (lMi, eMi, mMi) => {
    const qMi = Math.max(eMi, mMi || eMi);
    if (days >= 6) return roundHalf(lMi + qMi + eMi * 3);
    if (days >= 5) return roundHalf(lMi + qMi + eMi * 2);
    if (days >= 4) return roundHalf(lMi + qMi + eMi);
    return roundHalf(lMi + qMi);
  };

  // Phase-based long run ceiling — prevents premature plateau
  // Long runs only reach their true peak in the Peak phase (weeks 5-8 before race)
  const PHASE_MAX_LONG = {
    "Foundation": 12,
    "Base":       15,
    "Build":      18,
    "Peak":       level.longPeak   // full peak (20 mi) only in Peak phase
  };

  // Race week: gentle shakeout
  if (weeksToRace <= 1) {
    return { longMi: 3, easyMi: 2, midMi: 0, totalMi: computeTotal(3, 2, 0), isCutback: false, phase, hasFartlek: false, levelKey: key, weeksToRace };
  }
  // 3-week taper (MH protocol: -10-15% / -45% / shakeout)
  if (weeksToRace === 2) {
    // Deep taper — ~50% of peak long run, no quality, minimal miles
    const lMi = roundHalf(level.longPeak * 0.50);
    return { longMi: lMi, easyMi: level.easyMiRange[0], midMi: 0, totalMi: computeTotal(lMi, level.easyMiRange[0], 0), isCutback: false, phase, hasFartlek: false, levelKey: key, weeksToRace };
  }
  if (weeksToRace === 3) {
    // Mid taper — ~70% of peak long run, light quality (strides only)
    const lMi = roundHalf(level.longPeak * 0.70);
    return { longMi: lMi, easyMi: level.easyMiRange[0], midMi: level.midMiRange[0], totalMi: computeTotal(lMi, level.easyMiRange[0], level.midMiRange[0]), isCutback: false, phase, hasFartlek: false, levelKey: key, weeksToRace };
  }
  if (weeksToRace === 4) {
    // First taper week — ~85% of peak long run, maintain some quality to stay sharp
    const lMi = roundHalf(level.longPeak * 0.85);
    return { longMi: lMi, easyMi: level.easyMiRange[0], midMi: level.midMiRange[0], totalMi: computeTotal(lMi, level.easyMiRange[0], level.midMiRange[0]), isCutback: false, phase, hasFartlek: level.hasFartlek, levelKey: key, weeksToRace };
  }

  // 3:1 block progression with 10% rule
  const blockNum  = Math.floor(weeksIn / 4);
  const blockWeek = weeksIn % 4;
  const isCutback = blockWeek === 3;

  // Build weeks elapsed (cutback weeks don't count as increases)
  const buildWeeks = blockNum * 3 + Math.min(blockWeek, 2);

  let longMi;
  if (isCutback) {
    // Cutback = 68% of that block's peak (~32% reduction, within MH's 25-40% range)
    const blockPeak = roundHalf(Math.min(level.longStart * Math.pow(1.10, blockNum * 3 + 2), level.longPeak));
    longMi = roundHalf(blockPeak * 0.68);
  } else {
    // 10% increase per build week, capped at phase max first, then absolute peak
    const rawLong   = roundHalf(Math.min(level.longStart * Math.pow(1.10, buildWeeks), level.longPeak));
    const phaseCap  = PHASE_MAX_LONG[phase.name] ?? level.longPeak;
    longMi = Math.min(rawLong, phaseCap);
  }

  // Easy and mid miles scale proportionally with long run progress
  const progressRatio = (longMi - level.longStart) / Math.max(1, level.longPeak - level.longStart);
  const easyMi = roundHalf(lerp(level.easyMiRange[0], level.easyMiRange[1], progressRatio));
  const midMi  = roundHalf(lerp(level.midMiRange[0],  level.midMiRange[1],  progressRatio));

  return { longMi, easyMi, midMi, totalMi: computeTotal(longMi, easyMi, midMi), isCutback, phase, hasFartlek: level.hasFartlek, levelKey: key, weeksToRace, goalBracket };
}

function getCurrentWeekData(profile) {
  const start       = profile.trainingStart || profile.createdAt;
  const weeksIn     = Math.max(0, Math.floor((Date.now() - new Date(start)) / (7 * 24 * 60 * 60 * 1000)));
  const weeksToRace = profile.raceDate ? weeksUntil(profile.raceDate) : 99;
  return calcWeekData(profile.fitnessLevel, weeksIn, weeksToRace, profile.comfortableLongRun);
}

// ─────────────────────────────────────────────────────────────
// Long run notes — always slow and steady, never race pace finish
// ─────────────────────────────────────────────────────────────
function buildLongRunNotes(phaseName, longMi, isCutback, z1, z2) {
  const z1str = z1 ? ` (${z1.label})` : " (Zone 1)";
  const z2str = z2 ? ` (${z2.label})` : " (Zone 2)";
  if (phaseName === "Race Week") {
    return `Short shakeout — 3 mi max. Start in Recovery, stay easy${z1str}. Just wake up the legs. No need to prove anything today.`;
  }
  if (phaseName === "Taper") {
    return `${longMi} mi — your last long run before race day. First mile in Recovery, settle into Zone 1${z1str}. Finish feeling like you could have done more. Do NOT pick up the pace — save it for race day.`;
  }
  if (isCutback) {
    return `${longMi} mi — recovery week long run. First mile in Recovery, stay in Zone 1${z1str} the whole time. Your body is consolidating 3 weeks of training. Run relaxed and enjoy the easier day.`;
  }
  return `${longMi} mi long run. Try to keep mile 1 in Recovery — let your body warm up naturally. Build through Zone 1${z1str} and it's ok if you sneak into Zone 2${z2str} toward the end. Concentrate on negative splits — each mile should feel a little stronger than the last. Target your HR average at the middle to 80% of Zone 1. Why: the long run builds your aerobic engine. Slow IS the workout.`;
}

// ─────────────────────────────────────────────────────────────
// Phase × Level quality workout matrix
//
// Quality tier cap by training days:
//   3 days → "fartlek"  (Fartlek/Base only — long run IS the hard day)
//   4 days → "tempo"    (Tempo / Race Pace OK, Yasso 800s held back)
//   5 days → "full"     (complete progression, Yasso unlocked)
// ─────────────────────────────────────────────────────────────
function getQualityWorkout(phaseName, levelKey, weekData, zones, goal, weeksToRace, trainingDays, goalBracket) {
  const { easyMi, midMi, isCutback } = weekData;
  const zr = zones?.zr ? zoneTargetBpm(zones.zr) : null;
  const z1 = zones?.z1 ? zoneTargetBpm(zones.z1) : null;
  const z2 = zones?.z2 ? zoneTargetBpm(zones.z2) : null;
  const z3 = zones?.z3 ? zoneTargetBpm(zones.z3) : null;
  const zrstr = zr ? ` (target ${zr.label})` : " (Recovery)";
  const z1str = z1 ? ` (target ${z1.label})` : " (Zone 1)";
  const z2str = z2 ? ` (target ${z2.label})` : " (Zone 2)";
  const z3str = z3 ? ` (target ${z3.label})` : " (Zone 3)";
  const qMi = Math.max(easyMi, midMi || easyMi);
  const days = trainingDays || 4;

  // Effective quality cap — strictest of goalBracket and training days
  // finish / sub-5 → fartlek only (easy, no real speed work)
  // sub-4:30       → tempo ok, Yasso 800s held back
  // sub-4 and faster + 4 days → tempo cap; 5 days → full
  const goalForceFartlek = goalBracket === "finish" || goalBracket === "sub-5";
  const goalForceTempo   = goalBracket === "sub-4:30";
  const capFartlek = days <= 3 || goalForceFartlek;
  const capTempo   = !capFartlek && (days === 4 || goalForceTempo);

  // Race Week — easy shakeout only
  if (phaseName === "Race Week") {
    return {
      type: "Easy Shakeout", zone: "Z1",
      notes: `10–15 min easy jog${z1str}. Shake out the legs. No effort, no watch, no pressure. This is not a workout.`,
      duration: "10–15 min", miles: 2
    };
  }

  // Taper — stay sharp without digging a hole
  if (phaseName === "Taper") {
    if (levelKey === "scratch" || capFartlek) {
      return {
        type: "Base Run", zone: "Z1–Z2",
        notes: `Easy run${z2str}. You've done the work — this week is about staying loose and rested, not adding fitness. Keep it short and comfortable.${capFartlek && levelKey !== "scratch" ? " Running 3 days a week, your long run is already your hardest stimulus — taper week is pure rest and shake-out." : ""}`,
        duration: `${easyMi} mi`, miles: easyMi
      };
    }
    const yassoStr = goal?.targetFinish ? yassoTime(goal.targetFinish) : null;
    // Yasso in taper only for 5-day runners at beenHereBefore/competitive level
    if (!capTempo && yassoStr && (levelKey === "beenHereBefore" || levelKey === "competitive")) {
      const reps = isCutback ? 3 : 4;
      return {
        type: "Yasso 800s", zone: "Z3",
        notes: `${reps}×800m at ${yassoStr} per rep${z3str}. Warm up 1 mi easy${z1str}, then ${reps} × 800m at pace, equal-time jog recovery between. Cool down 1 mi. Only ${reps} reps — stay sharp, not building fitness. Why: a small dose of race pace keeps your neuromuscular system primed for race day.`,
        duration: `${(2 + reps * 0.5).toFixed(1)} mi total`, miles: 2 + reps * 0.5
      };
    }
    return {
      type: "Strides", zone: "Z2–Z3",
      notes: `After 15–20 min easy${z2str}, do 4–6 strides: 20-second smooth accelerations to comfortably fast, walk back between each. Not sprints — controlled and fluid. Why: strides wake up your fast-twitch fibers and keep your legs snappy without the fatigue of a real workout.`,
      duration: `${easyMi} mi`, miles: easyMi
    };
  }

  // Peak — highest quality work
  if (phaseName === "Peak") {
    // 3-day runners: long run is the peak stimulus — quality stays controlled
    if (capFartlek) {
      const surges = isCutback ? 4 : 6;
      return {
        type: "Structured Fartlek", zone: "Z2–Z3",
        notes: `Warm up 1 mi easy${z1str}, then ${surges}×1 min at a comfortably hard effort${z3str} with 90 sec easy recovery. Cool down 1 mi. Why: training 3 days a week, your long run is already your hardest session — these short surges sharpen speed without digging a hole you can't climb out of before race day.`,
        duration: `${easyMi} mi`, miles: easyMi
      };
    }
    if (levelKey === "scratch") {
      return {
        type: "Structured Fartlek", zone: "Z2–Z3",
        notes: `Warm up 1 mi easy${z1str}, then 6×1 min at a comfortably hard effort${z3str} with 90 sec easy jog recovery. Cool down 1 mi. Never force it — if it hurts, back off. Why: surges teach your body to handle bursts of effort and return to easy pace — essential for hills and race-day adrenaline.`,
        duration: `${qMi} mi`, miles: qMi
      };
    }
    // 4-day cap: Tempo Run instead of Yasso (good volume, less neuromuscular fatigue risk)
    if (capTempo) {
      return {
        type: "Tempo Run", zone: "Z3",
        notes: `Warm up 1 mi easy${z2str}, then ${Math.max(2, qMi - 2)} mi at comfortably hard${z3str} — 3-word sentences max. Cool down 1 mi easy. Why: at 4 training days, tempo work builds your lactate threshold without the recovery demand that Yasso 800s require. You get race-readiness with less risk.`,
        duration: `${qMi} mi`, miles: qMi
      };
    }
    if (levelKey === "firstTimer") {
      return {
        type: "Tempo Run", zone: "Z3",
        notes: `Warm up 1 mi easy${z2str}, then ${Math.max(2, qMi - 2)} mi at comfortably hard${z3str} — breathing heavy but not gasping, 3-word sentences max. Cool down 1 mi easy. Why: tempo runs raise your lactate threshold — the pace where your body stops clearing acid as fast as it produces it. Higher threshold = stronger marathon finish.`,
        duration: `${qMi} mi`, miles: qMi
      };
    }
    // 5-day beenHereBefore and competitive — full Yasso 800s, ramping 6→10 reps
    const yassoStr = goal?.targetFinish ? yassoTime(goal.targetFinish) : null;
    const peakWeeksIn = Math.max(0, 7 - Math.min(7, weeksToRace)); // 0 at start of peak, grows
    const reps = isCutback ? 4 : Math.min(10, 6 + peakWeeksIn);
    if (yassoStr) {
      return {
        type: "Yasso 800s", zone: "Z3",
        notes: `${reps}×800m at ${yassoStr} per rep${z3str}. Warm up 1 mi easy${z1str}, run each 800m at goal pace (hrs→min, min→sec), recover with equal-time jog. Cool down 1 mi. ${reps < 10 ? `Build toward 10 reps over the peak phase.` : `10 reps — you are race-ready.`} Why: Yasso 800s are the gold standard for marathon readiness. 10 reps at your goal time means you can run that race.`,
        duration: `${(2 + reps * 0.5).toFixed(1)} mi total`, miles: 2 + reps * 0.5
      };
    }
    return {
      type: "Tempo Run", zone: "Z3",
      notes: `Warm up 1 mi easy, then ${Math.max(2, qMi - 2)} mi comfortably hard${z3str}. Cool down 1 mi. Add a goal time in your profile to unlock Yasso 800s — the most race-specific workout in marathon training.`,
      duration: `${qMi} mi`, miles: qMi
    };
  }

  // Build — introducing quality, level-dependent
  if (phaseName === "Build") {
    // 3-day runners: keep quality at unstructured fartlek regardless of level
    if (capFartlek) {
      const surges = isCutback ? 3 : 5;
      return {
        type: "Fartlek", zone: "Z2–Z3",
        notes: `Easy warm up 1 mi${z2str}. Then ${surges}×30–60 sec surges${z3str} — go faster when you feel like it, recover fully between each. Cool down easy. Why: at 3 training days, unstructured speed play gives your aerobic system a boost without the structural fatigue that tempo or interval sessions create. Your long run is already doing the heavy lifting.`,
        duration: `${easyMi} mi`, miles: easyMi
      };
    }
    if (levelKey === "scratch") {
      return {
        type: "Structured Fartlek", zone: "Z2–Z3",
        notes: `After 5 min easy warm-up${z1str}, run 4×1 min at a slightly faster effort${z2str}–${z3str} with 2 min easy jog between. Cool down easy. Never push to the point of gasping. Why: small doses of faster running teach your heart to work at higher loads safely.`,
        duration: `${easyMi} mi`, miles: easyMi
      };
    }
    if (levelKey === "firstTimer") {
      return {
        type: "Structured Fartlek", zone: "Z2–Z3",
        notes: `Warm up 1 mi easy${z1str}, then 6–8×1 min at a strong controlled effort${z3str}, recovering 90 sec easy${z1str} between. Cool down 1 mi. Hard enough to breathe heavy, not hard enough to sprint. Why: timed intervals introduce speed with structure — your body learns to handle intensity without the pressure of race-pace specificity yet.`,
        duration: `${qMi} mi`, miles: qMi
      };
    }
    if (levelKey === "beenHereBefore") {
      return {
        type: "Tempo Run", zone: "Z3",
        notes: `Warm up 1 mi easy${z2str}, then ${Math.max(2, qMi - 2)} mi at comfortably hard${z3str} — conversation is 3-word sentences. Cool down 1 mi easy. Why: tempo pace trains your lactate threshold — the key to a strong marathon finish. The more miles you log in this zone, the later in the race it stays manageable.`,
        duration: `${qMi} mi`, miles: qMi
      };
    }
    // competitive — Race Pace if goal set, Tempo otherwise
    // 4-day cap already cleared above; 5-day gets full Race Pace
    if (goal?.targetPace) {
      return {
        type: "Race Pace Run", zone: "Z3",
        notes: `Warm up 1 mi easy${z2str}, then ${Math.max(2, qMi - 2)} mi at goal marathon pace (${goal.targetPace}/mi)${z3str}. Cool down 1 mi easy. If race pace feels easy — good, that's the goal. If it feels hard — you need more base. Why: marathon pace must feel automatic by race day. This is how you ingrain it.`,
        duration: `${qMi} mi`, miles: qMi
      };
    }
    return {
      type: "Tempo Run", zone: "Z3",
      notes: `Warm up 1 mi easy, then ${Math.max(2, qMi - 2)} mi comfortably hard${z3str}. Cool down 1 mi. Add a goal time in your profile to get specific race-pace targets.`,
      duration: `${qMi} mi`, miles: qMi
    };
  }

  // Base — unstructured speed play, no pressure
  if (phaseName === "Base") {
    if (levelKey === "scratch") {
      return {
        type: "Base Run", zone: "Z1–Z2",
        notes: `Easy run the whole way${z2str}. Walk if you need to. This is your quality slot but right now quality means consistent easy effort. Why: in base phase, every run is about building your aerobic foundation — not speed. The engine comes before the throttle.`,
        duration: `${easyMi} mi`, miles: easyMi
      };
    }
    const surges = isCutback ? 4 : 6;
    return {
      type: "Fartlek", zone: "Z2–Z3",
      notes: `Warm up 1 mi easy${z2str}. Then ${surges}×30–60 sec surges — go faster when you feel like it, for however long feels natural. Recover fully back to Z1${z1str} between. Cool down easy. Why: unstructured surges introduce speed play without rigid pressure. Your fast-twitch fibers get stimulated without digging an aerobic hole.`,
      duration: `${easyMi} mi`, miles: easyMi
    };
  }

  // Foundation — habit-building, almost no intensity
  if (levelKey === "scratch") {
    return {
      type: "Base Run", zone: "Z1",
      notes: `Easy, easy, easy${z1str}. Walk breaks are not just allowed — they're encouraged. You're building the habit right now. Why: your body is adapting to the mechanical stress of running in these first weeks. Slow easy runs build impact resistance that prevents injury for the whole season.`,
      duration: `${easyMi} mi`, miles: easyMi
    };
  }
  return {
    type: "Light Fartlek", zone: "Z1–Z2",
    notes: `Easy run with 3–4 natural surges${z2str} — go faster when you feel good, back off when you don't. No timer, no pressure, just play. Why: foundation phase introduces variety without the stress of structured training. Running should feel like something you want to do.`,
    duration: `${easyMi} mi`, miles: easyMi
  };
}

// ─────────────────────────────────────────────────────────────
// Weekly plan builder — fixed-offset stacking (no consecutive rest days)
//
// Offsets from longRunDay:
//   +0  Long Run      (your chosen day)
//   +1  Cross-Train   (active recovery after long run)
//   +2  Rest          (still absorbing long run)
//   +3  Quality Run   (hard day — furthest from long run)
//   +4  Base Run      (if trainingDays >= 4)
//   +5  Base Run      (if trainingDays >= 5) else Rest
//   +6  Rest          (protect the long run — sleep, prep, hydrate)
// ─────────────────────────────────────────────────────────────
function buildFlexibleWeekPlan(longRunDay, trainingDays, weekData, zones, goal, weekSundayStr) {
  const { longMi, easyMi, isCutback, phase, levelKey, weeksToRace } = weekData;
  const days      = trainingDays || 4;
  const phaseName = phase?.name || "Foundation";

  const zr = zones?.zr ? zoneTargetBpm(zones.zr) : null;
  const z1 = zones?.z1 ? zoneTargetBpm(zones.z1) : null;
  const z2 = zones?.z2 ? zoneTargetBpm(zones.z2) : null;
  const zrstr = zr ? ` (target ${zr.label})` : " (Recovery)";
  const z1str = z1 ? ` (target ${z1.label})` : " (Zone 1)";
  const z2str = z2 ? ` (target ${z2.label})` : " (Zone 2)";

  const slot = (offset) => (longRunDay + offset) % 7;

  // Base array — all rest
  const plan = DAYS.map((d, i) => ({
    idx: i, day: d, type: "Rest", zone: null,
    notes: "Full rest or a gentle 20-min walk. Recovery is where adaptation happens — this day is as important as any run.",
    duration: "", miles: 0,
    targetZoneLow: null, targetZoneHigh: null,
    plannedDate: weekSundayStr ? isoFromWeekStart(weekSundayStr, i) : null
  }));

  // +0 Long Run
  plan[slot(0)] = {
    idx: slot(0), day: DAYS[slot(0)], type: "Long Run", zone: isCutback ? "Z1" : "Z1→Z2",
    notes: buildLongRunNotes(phaseName, longMi, isCutback, z1, z2),
    duration: `${longMi} mi`, miles: longMi
  };

  // +1 Cross-Train or Strength (depending on goal bracket)
  // Sub-4 and faster: scheduled strength training reduces injury 33% and improves economy 2-8%
  const useStrength = weekData.goalBracket === "sub-4" || weekData.goalBracket === "sub-3:30" || weekData.goalBracket === "sub-3";
  plan[slot(1)] = useStrength ? {
    idx: slot(1), day: DAYS[slot(1)], type: "Strength", zone: null,
    notes: "Strength session — 30–45 min. Focus on single-leg stability and hip strength: single-leg deadlifts, step-ups, clamshells, hip bridges, planks, and rows. Your legs are tired from yesterday so keep loads moderate. Why: strength training reduces running injuries by 33% and improves running economy 2–8% — it belongs in every serious training plan.",
    duration: "30–45 min", miles: 0
  } : {
    idx: slot(1), day: DAYS[slot(1)], type: "Cross-Train", zone: "Recovery",
    notes: `Easy bike, swim, yoga, or walk${zrstr}. Move without pounding — your legs are still recovering from yesterday's long run. 30–45 min is plenty. Why: active recovery flushes soreness and drives blood to repair muscle without adding impact stress.`,
    duration: "30–45 min", miles: 0
  };

  // +2 Rest
  plan[slot(2)] = {
    idx: slot(2), day: DAYS[slot(2)], type: "Rest", zone: null,
    notes: "Rest day. You ran long two days ago and still absorbing it. Sleep, eat well, and hydrate. Foam roll if you have time.",
    duration: "", miles: 0
  };

  // +3 Quality Run (intensity scales with training days and goal bracket)
  const quality = getQualityWorkout(phaseName, levelKey || "firstTimer", weekData, zones, goal, weeksToRace ?? 99, days, weekData.goalBracket);
  plan[slot(3)] = { idx: slot(3), day: DAYS[slot(3)], ...quality,
    targetZoneLow: null, targetZoneHigh: null,
    plannedDate: weekSundayStr ? isoFromWeekStart(weekSundayStr, slot(3)) : null
  };

  // +4 and +5 slots — placement depends on training days to avoid consecutive rest days:
  //   5-day: +4=Base, +5=Base  → rests only at +2 and +6 (no consecutive)
  //   4-day: +4=Rest, +5=Base  → rests at +2, +4, +6 (every other — no consecutive)
  //   3-day: +4=Rest, +5=Rest  → rests at +2,+4,+5,+6 (unavoidable pair at +5/+6)
  if (days >= 5) {
    plan[slot(4)] = {
      idx: slot(4), day: DAYS[slot(4)], type: "Base Run", zone: "Z1–Z2",
      notes: `Easy aerobic run${z2str}. Comfortable conversational pace from start to finish. If you're tired from yesterday's quality work, add a 5-min walk warm-up and cut it short. Why: consistent easy mileage is the foundation of all marathon fitness.`,
      duration: `${easyMi} mi`, miles: easyMi
    };
    plan[slot(5)] = {
      idx: slot(5), day: DAYS[slot(5)], type: "Base Run", zone: "Z1–Z2",
      notes: `Second easy run of the week${z2str}. Shorter is fine — even 3 easy miles counts. Run by feel. Why: two easy runs mid-week layer aerobic stimulus without fatigue that would compromise your long run.`,
      duration: `${easyMi} mi`, miles: easyMi
    };
  } else if (days >= 4) {
    // +4 = Rest (spreads rest days evenly: +2, +4, +6), +5 = Base Run
    plan[slot(5)] = {
      idx: slot(5), day: DAYS[slot(5)], type: "Base Run", zone: "Z1–Z2",
      notes: `Easy aerobic run${z2str}. Comfortable conversational pace from start to finish. Cut it short if needed — the goal is consistency, not heroics. Why: one solid easy run mid-week keeps your aerobic engine humming between quality and long run days.`,
      duration: `${easyMi} mi`, miles: easyMi
    };
    // slot(4) stays as Rest (default) — rests now land at +2, +4, +6 with no two in a row
  }

  // +6 Rest before long run
  plan[slot(6)] = {
    idx: slot(6), day: DAYS[slot(6)], type: "Rest", zone: null,
    notes: "Rest day before your long run. Stay off your feet as much as you can. Lay out your gear, plan your route, hydrate throughout the day, and get to bed early.",
    duration: "", miles: 0,
    targetZoneLow: null, targetZoneHigh: null,
    plannedDate: weekSundayStr ? isoFromWeekStart(weekSundayStr, slot(6)) : null
  };

  // Resolve bpm bounds for every day that has a zone target
  for (const day of plan) {
    const { low, high } = resolveZoneBounds(day.zone, zones);
    day.targetZoneLow  = low  ?? null;
    day.targetZoneHigh = high ?? null;
  }

  return plan;
}

// ═══════════════════════════════════════════════════════════════
// MOOD ADAPTATION ENGINE
// ═══════════════════════════════════════════════════════════════
function moodScore(key) {
  return MOODS.find(m => m.key === key)?.score ?? 3;
}

function calcBlockMoodAvg(workouts, blockStartDate, blockEndDate) {
  const start = new Date(blockStartDate);
  const end   = new Date(blockEndDate);
  const block = workouts.filter(w => {
    const d = new Date(w.date);
    return d >= start && d <= end && w.moodOriginal;
  });
  if (block.length < 2) return null;
  return block.reduce((sum, w) => sum + moodScore(w.moodOriginal), 0) / block.length;
}

function getBlockMoodAdaptation(workouts, weeksIn, trainingStart) {
  if (weeksIn < 4) return null;
  const blockWeek = weeksIn % 4;
  if (blockWeek !== 0) return null; // only evaluate at the start of a new block

  // Previous block = 4 weeks ending just before this week
  const blockEndMs   = new Date(trainingStart).getTime() + weeksIn * 7 * 24 * 60 * 60 * 1000;
  const blockStartMs = blockEndMs - 28 * 24 * 60 * 60 * 1000;
  const avg = calcBlockMoodAvg(
    workouts,
    new Date(blockStartMs).toISOString().split("T")[0],
    new Date(blockEndMs).toISOString().split("T")[0]
  );
  if (avg === null) return null;

  const emoji = avg >= 4 ? "😁" : avg >= 3 ? "🙂" : avg >= 2 ? "😐" : "😩";
  if (avg >= 3.5) return { action: "proceed",  emoji, avg, msg: "Strong block — plan progressing normally. Keep it up." };
  if (avg >= 2.5) return { action: "hold",     emoji, avg, msg: "Mixed block — holding mileage steady this block. Listen to your body." };
  return              { action: "recovery", emoji, avg, msg: "Tough block — adding an extra recovery week before pushing forward. Rest is training too." };
}

function getConsecutiveStruggling(workouts) {
  let count = 0;
  for (const w of workouts) {
    if (w.moodOriginal === "struggling" || w.moodOriginal === "offrun") count++;
    else break;
  }
  return count;
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
  if (state.view === "forgot-password" || state.view === "reset-sent") return ForgotPasswordPage();
  if (!state.user)   return LoginPage();
  switch (state.view) {
    case "request-access": return RequestAccessPage();
    case "setup-profile":  return SetupProfile();
    case "setup-zones":    return SetupZones();
    case "setup-test":     return SetupTest();
    case "setup-running":  return SetupRunning();
    case "setup-prefs":    return SetupPrefs();
    case "setup-goal":     return SetupGoal();
    case "update-plan":    return UpdatePlanPage();
    case "goal-update":    return GoalUpdate();
    case "edit-profile":   return EditProfile();
    case "log-workout":    return LogWorkout();
    case "history":        return WorkoutHistory();
    case "plan":           return PlanPage();
    case "test":           return FieldTest();
    case "strava-import":  return StravaImportPage();
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
        const [data, pendingSnap] = await Promise.race([
          Promise.all([
            loadUserData(ADMIN.id),
            db.collection("signupRequests").where("status", "==", "pending").get()
          ]),
          timeout
        ]);
        const pendingCount = pendingSnap.size || 0;
        setState({ user: ADMIN, ...data, pendingCount, loading: false, error: null, view: data.profile ? "dashboard" : "setup-profile" });
        checkStravaCallback();
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
        // Check if this password belongs to a pending request
        const pendingSnap = await db.collection("signupRequests")
          .where("passwordHash", "==", hash)
          .where("status", "==", "pending")
          .get();
        if (!pendingSnap.empty) {
          setState({ loading: false, error: "Your access request is pending approval — check back soon! The admin typically reviews within 24–48 hours." });
        } else {
          setState({ loading: false, error: "Wrong password. Try again or request access below." });
        }
        return;
      }

      const doc  = snap.docs[0];
      const info = doc.data();
      const user = { id: doc.id, name: info.name, admin: false };
      const data = await loadUserData(doc.id);
      // Migrate old zone schema (z1/z2/z3 only) to new schema (zr/z1/z2/z3)
      if (data.zones && !data.zones.zr && data.profile) {
        const maxHR = data.zones.maxHR || data.profile.knownMaxHR || estimateMaxHR(data.profile.age);
        const newZones = { ...calcZones(maxHR, data.profile.restingHR), method: data.zones.method || "estimated", lastTested: data.zones.lastTested || null };
        await db.collection("users").doc(doc.id).collection("data").doc("zones").set(newZones, { merge: true });
        data.zones = newZones;
      }
      const groupData = data.profile?.groupId ? await loadGroupData(data.profile.groupId, doc.id) : null;
      setState({ user, ...data, groupData, loading: false, error: null, view: data.profile ? "dashboard" : "setup-profile" });
      // Check for Strava OAuth callback (user may have been redirected here after connecting)
      checkStravaCallback();
    } catch (err) {
      setState({ loading: false, error: "Could not connect to Firebase: " + err.message });
    }
  };

  const emailInput = input({ id: "login-email", type: "email", placeholder: "Enter your email", autocomplete: "username email" });
  emailInput.addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("pw")?.focus(); });

  const pwInput = input({ id: "pw", type: "password", placeholder: "Enter your password", autocomplete: "current-password" });
  pwInput.addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

  const logoBadge = div("login-logo");
  logoBadge.innerHTML = `<svg viewBox="0 0 56 56" width="56" height="56" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="llg" x1="0" y1="0" x2="56" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#56f6c8"/><stop offset="100%" stop-color="#5cd0ff"/></linearGradient></defs><rect width="56" height="56" rx="13" fill="#0f172e" stroke="rgba(255,255,255,0.12)" stroke-width="1.5"/><path d="M6 28 L15 28 L18 22 L21 10 L25 44 L28 20 L31 28 L50 28" stroke="url(#llg)" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const signInBtn = el("button", { className: "btn-signin" }, "Sign In →");
  signInBtn.addEventListener("click", doLogin);

  return div("login-screen",
    div("login-hero",
      div("login-brand",
        logoBadge,
        div("login-brand-name",
          el("span", { className: "lbn-my" }, "My"),
          el("span", { className: "lbn-wordmark" },
            el("span", { className: "lbn-pace" }, "Pace"),
            el("span", { className: "lbn-zone" }, "Zone")
          )
        )
      ),
      el("p", { className: "login-tagline" }, "Train smarter. Race confident.")
    ),
    div("login-card",
      errorBanner(),
      div("field", emailInput),
      div("field", pwInput),
      signInBtn,
      div("link-row",
        btn("Request Access",  () => setState({ view: "request-access",  error: null }), "btn-link"),
        btn("Forgot password", () => setState({ view: "forgot-password", error: null }), "btn-link")
      ),
      el("p", { className: "login-disclaimer" }, "MyPaceZone is a training tool, not medical advice. Consult your doctor before starting any training program.")
    )
  );
}

function ForgotPasswordPage() {
  return div("login-screen",
    div("login-page",
      pageHeader("Forgot Password", () => setState({ view: "login", error: null })),
      p("Contact the admin to reset your password. Once they reset it, come back and log in with your new one."),
      btn("Back to Login", () => setState({ view: "login", error: null }))
    )
  );
}

function doLogout() {
  setState({ user: null, profile: null, zones: null, goal: null, workouts: [], allUsers: null, pendingRequests: [], pendingCount: 0, editingWorkout: null, groupData: null, adminGroups: [], view: "login", error: null });
}

// ═══════════════════════════════════════════════════════════════
// REQUEST ACCESS
// ═══════════════════════════════════════════════════════════════
function RequestAccessPage() {
  const submit = async () => {
    clearError();
    const name    = (document.getElementById("ra-name")?.value  || "").trim();
    const email   = (document.getElementById("ra-email")?.value || "").trim();
    const pw      = (document.getElementById("ra-pw")?.value    || "").trim();
    const pwConf  = (document.getElementById("ra-pw2")?.value   || "").trim();
    const note    = (document.getElementById("ra-note")?.value  || "").trim();

    if (!name)                           { showError("Please enter your name."); return; }
    if (!email || !/.+@.+\..+/.test(email)) { showError("Please enter a valid email address."); return; }
    if (!pw)                             { showError("Please choose a password."); return; }
    if (pw.length < 6)                   { showError("Password must be at least 6 characters."); return; }
    if (pw !== pwConf)                   { showError("Passwords don't match."); return; }
    if (pw === ADMIN.password)           { showError("That password is not available. Choose a different one."); return; }

    setState({ loading: true, error: null });
    try {
      const hash = await hashPassword(pw);
      const existing = await db.collection("approvedUsers").where("passwordHash", "==", hash).get();
      if (!existing.empty) { setState({ loading: false, error: "That password is already in use. Choose a different one." }); return; }

      await db.collection("signupRequests").add({
        name, email, passwordHash: hash, note, status: "pending",
        source: "app", requestedAt: new Date().toISOString()
      });

      notifyAdmin(name, note);
      setState({ loading: false, view: "request-sent" });
    } catch (err) {
      setState({ loading: false, error: "Could not submit request: " + err.message });
    }
  };

  if (state.view === "request-sent") {
    return div("login-screen",
      div("login-page",
        h1("Request Sent ✓"),
        p("Your request has been submitted. We'll email you within 48 hours."),
        p("Once approved, come back here and log in with the password you chose."),
        btn("Back to Login", () => setState({ view: "login", error: null }))
      )
    );
  }

  return div("login-screen",
    div("login-page",
      pageHeader("Request Access", () => setState({ view: "login", error: null })),
      p("Fill in your details and we'll review your request."),
      errorBanner(),
      field("Your Name *",       input({ id: "ra-name",  type: "text",     placeholder: "e.g. Sara" })),
      field("Email *",           input({ id: "ra-email", type: "email",    placeholder: "you@example.com" })),
      field("Choose a Password *",   input({ id: "ra-pw",   type: "password", placeholder: "At least 6 characters" })),
      field("Confirm Password *",    input({ id: "ra-pw2",  type: "password", placeholder: "Repeat your password" })),
      field("Note (optional)",   input({ id: "ra-note",  type: "text",     placeholder: "e.g. Hi John, I'm your Thursday running partner" })),
      btn("Submit Request", submit)
    )
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
    const knownMaxHR = parseInt(document.getElementById("s-maxhr")?.value) || null;

    if (!name || !age || !weight || !restingHR) { showError("Please fill in all required fields."); return; }
    if (age < 18 || age > 95)                   { showError("Please enter a valid age (18–95)."); return; }
    if (restingHR < 35 || restingHR > 100)       { showError("Resting HR should be between 35–100 bpm."); return; }
    if (knownMaxHR && (knownMaxHR < 130 || knownMaxHR > 220)) { showError("Max HR looks off — should be between 130–220 bpm."); return; }

    const profile = { name, age, heightFt, heightIn, weight, restingHR, knownMaxHR, createdAt: new Date().toISOString() };
    setState({ loading: true });
    await saveData("profile", profile);
    setState({ profile, loading: false, view: "setup-zones", error: null });
  };

  return div("page",
    div("setup-page",
      div("step-indicator", "Step 1 of 5 — Profile"),
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
      field("Highest heart rate you've seen on your watch (bpm)",
        input({ id: "s-maxhr", type: "number", placeholder: "e.g. 174 — leave blank if unsure, we'll test you later", min: "130", max: "220" })
      ),
      btn("Next →", save)
    )
  );
}

// ═══════════════════════════════════════════════════════════════
// SETUP — Zone method
// ═══════════════════════════════════════════════════════════════
function SetupZones() {
  const { age, restingHR, knownMaxHR } = state.profile;
  const maxHR = knownMaxHR || estimateMaxHR(age);
  const est   = calcZones(maxHR, restingHR);
  const usingKnown = !!knownMaxHR;

  const useEstimate = async () => {
    const zoneData = { ...est, method: "estimated", lastTested: null };
    setState({ loading: true });
    await saveData("zones", zoneData);
    setState({ zones: zoneData, loading: false, view: "setup-running" });
  };

  return div("page",
    div("setup-page",
      div("step-indicator", "Step 2 of 5 — Heart Rate Zones"),
      h2("Set up your training zones"),
      p(usingKnown
        ? `Based on your max HR (${maxHR} bpm) and resting HR (${restingHR} bpm), here are your zones:`
        : `Based on your age (${age}) and resting HR (${restingHR} bpm), here are your estimated zones. Run the field test anytime to get exact numbers.`),
      div("zone-preview",
        est.zr ? zoneBar(est.zr, "zr") : null,
        est.z1 ? zoneBar(est.z1, "z1") : null,
        est.z2 ? zoneBar(est.z2, "z2") : null,
        est.z3 ? zoneBar(est.z3, "z3") : null
      ),
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
    setState({ zones: zoneData, loading: false, view: "setup-running", error: null });
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
// SETUP — Your Running (Step 3)
// ═══════════════════════════════════════════════════════════════
function SetupRunning() {
  const save = async () => {
    const marathonHistory  = document.getElementById("r-history")?.value;
    const prevFinish       = document.getElementById("r-prev-finish")?.value.trim() || null;
    const daysPerWeek      = parseInt(document.getElementById("r-days")?.value);
    const weeklyMileage    = parseFloat(document.getElementById("r-weekly-mi")?.value) || null;
    const comfortableLongRun = parseFloat(document.getElementById("r-clr")?.value) || null;
    const easyRunFeel      = document.getElementById("r-feel")?.value;
    const best5k10k        = document.getElementById("r-race-time")?.value.trim() || null;
    const raceType         = document.getElementById("r-race-type")?.value || null;

    if (!marathonHistory)  { showError("Please tell us your marathon experience."); return; }
    if (!daysPerWeek)      { showError("Please select how many days a week you run."); return; }
    if (!easyRunFeel)      { showError("Please tell us how your easy runs feel."); return; }

    // Floor comfortable long run at 3 miles
    const clrSafe = comfortableLongRun ? Math.max(3, comfortableLongRun) : null;

    const runningProfile = { marathonHistory, prevFinish, daysPerWeek, weeklyMileage, comfortableLongRun: clrSafe, easyRunFeel, best5k10k, raceType };
    setState({ loading: true });
    await saveData("profile", { ...state.profile, ...runningProfile });
    setState({ profile: { ...state.profile, ...runningProfile }, loading: false, view: "setup-prefs", error: null });
  };

  const historyVal = () => document.getElementById("r-history")?.value;

  return div("page",
    div("setup-page",
      div("step-indicator", "Step 3 of 5 — Your Running"),
      h2("Tell us about your running"),
      p("This shapes your entire training plan — be honest, not optimistic."),
      errorBanner(),

      field("Marathon experience *", select("r-history", [
        ["Select…", ""],
        ["First marathon — never done one before", "first"],
        ["Done one before — ready to go again", "repeat"],
        ["Multiple marathons — chasing a time goal", "competitive"]
      ], "")),

      el("div", { id: "r-prev-finish-row", style: "display:none" },
        field("Your best marathon finish time", input({ id: "r-prev-finish", type: "text", placeholder: "e.g. 4:32:00" }))
      ),

      field("How many days a week are you currently running? *", select("r-days", [
        ["Select…", ""],
        ["1–2 days", 2],
        ["3 days", 3],
        ["4 days", 4],
        ["5 days", 5],
        ["6+ days", 6]
      ], "")),

      field("Current average weekly mileage (miles)",
        input({ id: "r-weekly-mi", type: "number", placeholder: "e.g. 22 — your typical week lately", min: "0", max: "150", step: "1" })
      ),

      field("Longest comfortable run in the last 30 days (miles)",
        input({ id: "r-clr", type: "number", placeholder: "e.g. 6 — felt good, could have kept going", min: "1", max: "26", step: "0.5" })
      ),

      field("How do your easy runs feel? *", select("r-feel", [
        ["Select…", ""],
        ["Truly easy — I could hold a full conversation", "easy"],
        ["Usually pushing a bit — comfortable but working", "moderate"],
        ["Hard most days — easy never feels easy", "hard"]
      ], "")),

      field("Best 5K or 10K in the last 6 months (optional)", select("r-race-type", [
        ["Select distance…", ""],
        ["5K", "5k"],
        ["10K", "10k"]
      ], "")),
      input({ id: "r-race-time", type: "text", placeholder: "e.g. 28:45 — leave blank if unsure", style: "margin-top:6px" }),

      btn("Next →", save)
    )
  );
}

// Wire up form dynamic behaviours
document.addEventListener("change", e => {
  // Show/hide prev finish time
  if (e.target.id === "r-history") {
    const row = document.getElementById("r-prev-finish-row");
    if (row) row.style.display = e.target.value !== "first" ? "" : "none";
  }
  // Live plan-length warning in SetupPrefs
  if (e.target.id === "p-race" || e.target.id === "p-level") {
    const raceDate    = document.getElementById("p-race")?.value;
    const fitnessLevel = document.getElementById("p-level")?.value;
    const warnEl      = document.getElementById("p-plan-warning");
    if (!warnEl || !raceDate || !fitnessLevel) { if (warnEl) warnEl.textContent = ""; return; }
    const rec    = recommendedPlanWeeks(state.profile?.weeklyMileage, fitnessLevel, state.profile?.marathonHistory);
    const actual = Math.round((new Date(raceDate + "T12:00:00") - new Date()) / (1000 * 60 * 60 * 24 * 7));
    warnEl.textContent = actual < rec.min
      ? `⚠️ Race is ${actual} weeks away — your profile suggests ${rec.min}–${rec.max} weeks. Consider a shorter goal or adjusting your race date.`
      : "";
  }
});

// ═══════════════════════════════════════════════════════════════
// SETUP — Preferences
// ═══════════════════════════════════════════════════════════════
function SetupPrefs() {
  const today = new Date().toISOString().split("T")[0];
  const save = async () => {
    const raceDate      = document.getElementById("p-race")?.value;
    const trainingStart = document.getElementById("p-start")?.value;
    const fitnessLevel  = document.getElementById("p-level")?.value;
    const longRunDay    = parseInt(document.getElementById("p-lrd")?.value);
    const trainingDays  = parseInt(document.getElementById("p-days")?.value);
    const crossTrain    = document.getElementById("p-crosstrain")?.value || null;
    const goalBracket   = document.getElementById("p-goal-bracket")?.value || null;
    if (!raceDate)                                          { showError("Please enter your race date."); return; }
    if (new Date(raceDate + "T12:00:00") <= new Date())    { showError("Race date must be in the future."); return; }
    if (!trainingStart)                   { showError("Please enter your training start date."); return; }
    if (!fitnessLevel)                    { showError("Please select your current fitness level."); return; }
    const prefs = { raceDate, trainingStart, fitnessLevel, longRunDay, trainingDays, crossTrain, goalBracket };
    setState({ loading: true });
    await saveData("profile", { ...state.profile, ...prefs });
    setState({ profile: { ...state.profile, ...prefs }, loading: false, view: "setup-goal", error: null });
  };

  // Show plan-length warning live when race date changes
  const checkPlanLength = () => {
    const raceDate = document.getElementById("p-race")?.value;
    const fitnessLevel = document.getElementById("p-level")?.value;
    const warnEl = document.getElementById("p-plan-warning");
    if (!warnEl) return;
    if (!raceDate || !fitnessLevel) { warnEl.textContent = ""; return; }
    const rec = recommendedPlanWeeks(state.profile?.weeklyMileage, fitnessLevel, state.profile?.marathonHistory);
    const actual = Math.round((new Date(raceDate + "T12:00:00") - new Date()) / (1000 * 60 * 60 * 24 * 7));
    warnEl.textContent = actual < rec.min
      ? `⚠️ Your race is ${actual} weeks away — your profile suggests ${rec.min}–${rec.max} weeks. Consider adjusting your goal or race date.`
      : "";
  };

  return div("page",
    div("setup-page",
      div("step-indicator", "Step 4 of 5 — Your Plan"),
      h2("Build your training plan"),
      errorBanner(),
      field("Race Date *", input({ id: "p-race", type: "date", min: today })),
      el("div", { id: "p-plan-warning", className: "plan-length-warning" }),
      field("Training Start Date *", input({ id: "p-start", type: "date", value: today })),
      field("Current Fitness Level *", select("p-level", [
        ["Select your level…", ""],
        ...Object.entries(PLAN_LEVELS).map(([k, v]) => [v.label, k])
      ], "")),
      field("Race goal *", select("p-goal-bracket", [
        ["Select…", ""],
        ["Finish — I just want to cross the line", "finish"],
        ["Sub-5:00 (11:27/mi)", "sub-5"],
        ["Sub-4:30 (10:18/mi)", "sub-4:30"],
        ["Sub-4:00 (9:09/mi)",  "sub-4"],
        ["Sub-3:30 (8:00/mi)",  "sub-3:30"],
        ["Sub-3:00 (6:52/mi)",  "sub-3"]
      ], "")),
      field("Long Run Day", select("p-lrd", DNAMES.map((d, i) => [d, i]), 6)),
      field("Training Days Per Week", select("p-days", [[3,3],[4,4],[5,5],[6,6]].map(([l,v]) => [`${l} days`, v]), 4)),
      field("Do you cross train?", select("p-crosstrain", [
        ["Select…", ""],
        ["None", "none"],
        ["Bike", "bike"],
        ["Swim", "swim"],
        ["Strength training", "strength"],
        ["Mixed", "mixed"]
      ], "")),
      btn("Next →", save)
    )
  );
}

// ═══════════════════════════════════════════════════════════════
// EDIT PROFILE & PLAN SETTINGS
// ═══════════════════════════════════════════════════════════════
function EditProfile() {
  const { profile } = state;
  const today = new Date().toISOString().split("T")[0];

  const save = async () => {
    const name      = document.getElementById("ep-name")?.value.trim();
    const age       = parseInt(document.getElementById("ep-age")?.value);
    const heightFt  = parseInt(document.getElementById("ep-ht-ft")?.value) || 0;
    const heightIn  = parseInt(document.getElementById("ep-ht-in")?.value) || 0;
    const weight    = parseFloat(document.getElementById("ep-weight")?.value);
    const restingHR = parseInt(document.getElementById("ep-rhr")?.value);
    const raceDate      = document.getElementById("ep-race")?.value;
    const trainingStart = document.getElementById("ep-start")?.value;
    const fitnessLevel  = document.getElementById("ep-level")?.value;
    const longRunDay    = parseInt(document.getElementById("ep-lrd")?.value);
    const trainingDays  = parseInt(document.getElementById("ep-days")?.value);
    if (!name || !age || !weight || !restingHR) { showError("Please fill in all required fields."); return; }
    if (age < 18 || age > 95)                   { showError("Please enter a valid age (18–95)."); return; }
    if (restingHR < 35 || restingHR > 100)       { showError("Resting HR should be between 35–100 bpm."); return; }
    if (!raceDate)                               { showError("Please enter your race date."); return; }
    if (new Date(raceDate) <= new Date())        { showError("Race date must be in the future."); return; }
    if (!fitnessLevel)                           { showError("Please select your fitness level."); return; }

    setState({ loading: true });
    const updated = { ...profile, name, age, heightFt, heightIn, weight, restingHR, raceDate, trainingStart, fitnessLevel, longRunDay, trainingDays };
    await saveData("profile", updated);

    // Recalculate zones if age, resting HR, or knownMaxHR changed
    let updatedZones = state.zones;
    if (state.zones && (age !== profile.age || restingHR !== profile.restingHR)) {
      const maxHR = state.zones.method === "tested" ? state.zones.maxHR : (updated.knownMaxHR || estimateMaxHR(age));
      updatedZones = { ...calcZones(maxHR, restingHR), method: state.zones.method, lastTested: state.zones.lastTested || null };
      await saveData("zones", updatedZones);
    }

    // Re-validate goal against current workouts
    let updatedGoal = state.goal;
    if (state.goal?.targetPace && state.workouts.length) {
      const pred = getBestPrediction(state.workouts);
      if (pred) {
        updatedGoal = { ...state.goal, validation: validateGoal(state.goal.targetPace, pred.sec) };
        await saveData("goal", updatedGoal);
      }
    }

    setState({ profile: updated, zones: updatedZones, goal: updatedGoal, loading: false, view: "dashboard", error: null });
  };

  return div("page",
    div("card",
      pageHeader("Edit Profile & Plan Settings", () => setState({ view: "dashboard" })),
      p("Changes take effect immediately. Your logged workouts are not affected."),
      errorBanner(),
      h3("Personal Info"),
      field("Your Name *", input({ id: "ep-name", type: "text", value: profile?.name || "" })),
      field("Age *", input({ id: "ep-age", type: "number", value: String(profile?.age || ""), min: "18", max: "95" })),
      div("field-row",
        field("Height (ft)", input({ id: "ep-ht-ft", type: "number", value: String(profile?.heightFt || ""), min: "4", max: "7" })),
        field("Height (in)", input({ id: "ep-ht-in", type: "number", value: String(profile?.heightIn || ""), min: "0", max: "11" }))
      ),
      field("Weight (lbs) *", input({ id: "ep-weight", type: "number", step: "0.1", value: String(profile?.weight || "") })),
      field("Resting Heart Rate (bpm) *", input({ id: "ep-rhr", type: "number", value: String(profile?.restingHR || ""), min: "35", max: "100" })),
      h3("Training Plan"),
      field("Race Date *", input({ id: "ep-race", type: "date", value: profile?.raceDate || "", min: today })),
      field("Training Start Date *", input({ id: "ep-start", type: "date", value: profile?.trainingStart || "" })),
      field("Current Fitness Level *", select("ep-level", [
        ["Select your level…", ""],
        ...Object.entries(PLAN_LEVELS).map(([k, v]) => [v.label, k])
      ], normalizeFitnessLevel(profile?.fitnessLevel) || "")),
      field("Long Run Day", select("ep-lrd", DNAMES.map((d, i) => [d, i]), profile?.longRunDay ?? 6)),
      field("Training Days Per Week", select("ep-days", [[3,3],[4,4],[5,5],[6,6]].map(([l,v]) => [`${l} days`, v]), profile?.trainingDays || 4)),
      btn("Save Changes", save)
    )
  );
}

function UpdatePlanPage() {
  const today = new Date().toISOString().split("T")[0];
  const save = async () => {
    const fitnessLevel  = document.getElementById("up-level")?.value;
    const trainingStart = document.getElementById("up-start")?.value;
    if (!fitnessLevel)  { showError("Please select your fitness level."); return; }
    if (!trainingStart) { showError("Please enter your training start date."); return; }
    setState({ loading: true });
    const updated = { ...state.profile, fitnessLevel, trainingStart };
    await saveData("profile", updated);
    setState({ profile: updated, loading: false, view: "dashboard", error: null });
  };

  return div("page",
    div("card",
      pageHeader("Update Training Plan", () => setState({ view: "dashboard" })),
      p("Tell us where you are now so the plan starts at the right level and builds correctly."),
      errorBanner(),
      field("Current Fitness Level *", select("up-level", [
        ["Select your level…", ""],
        ...Object.entries(PLAN_LEVELS).map(([k, v]) => [v.label, k])
      ], normalizeFitnessLevel(state.profile?.fitnessLevel) || "")),
      field("Training Start Date *", input({ id: "up-start", type: "date", value: state.profile?.trainingStart || today })),
      btn("Save & Rebuild Plan", save)
    )
  );
}

// ═══════════════════════════════════════════════════════════════
// GOAL UPDATE — coaching conversation
// ═══════════════════════════════════════════════════════════════
function GoalUpdate() {
  const { profile } = state;
  const currentBracket = profile?.goalBracket || "";

  const BRACKET_LABELS = {
    "finish":    "Finish — I just want to cross the line",
    "sub-5":     "Sub-5:00 (11:27/mi)",
    "sub-4:30":  "Sub-4:30 (10:18/mi)",
    "sub-4":     "Sub-4:00 (9:09/mi)",
    "sub-3:30":  "Sub-3:30 (8:00/mi)",
    "sub-3":     "Sub-3:00 (6:52/mi)"
  };

  const COACHING_INSIGHTS = {
    // driving + training + physical → advice string
    "stronger+on-track+fresh":    "You're firing on all cylinders — a stretch goal makes sense. Just make sure the plan adjusts quality work proportionally.",
    "stronger+on-track+tired":    "Strong motivation + good mileage, but your body needs recovery. Hold the new goal but prioritize sleep and easy days this week.",
    "stronger+more+fresh":        "Running more AND feeling fresh is rare — make sure the extra volume is easy miles, not junk miles. A bump up looks well-earned.",
    "stronger+more+tired":        "More volume plus fatigue — be careful. A modest goal bump is fine, but a down week first will pay off.",
    "stronger+less+fresh":        "Feeling strong despite lower mileage? Trust that instinct, but rebuild gradually before committing to a faster goal.",
    "stronger+less+tired":        "Mixed signals — motivation is up but training and body aren't aligned. Consider holding your current goal for 2 more weeks, then reassess.",
    "new-race+on-track+fresh":    "New race, solid training, fresh legs — great spot to lock in a goal. Your current fitness will carry you there.",
    "new-race+on-track+tired":    "New race energy is real, but your body is talking. Rest now so you're sharp when it counts.",
    "new-race+more+fresh":        "Building well for a new race — a goal in the middle of your bracket range is a smart anchor.",
    "new-race+more+tired":        "Excitement for a new race is great, but back off the volume slightly. Consistency beats hero weeks.",
    "new-race+less+fresh":        "Lower mileage but feeling good — a conservative goal protects the race experience. You can always negative split.",
    "new-race+less+tired":        "New race + low mileage + fatigue — make sure the goal is realistic. An honest finish goal sets you up to love the sport.",
    "setback+on-track+fresh":     "Back on track after a setback and feeling fresh — that's resilience. A modest goal reset keeps momentum without over-promising.",
    "setback+on-track+tired":     "Coming back from a setback while tired — the plan is solid, but add one extra rest day this week.",
    "setback+more+fresh":         "Running strong after a setback is encouraging. Make sure the extra mileage isn't compensating — easy pace first.",
    "setback+more+tired":         "After a setback, more mileage + fatigue is a yellow flag. Drop back to your base target and rebuild.",
    "setback+less+fresh":         "Feeling okay despite lower mileage — that's a body that's healed. A conservative goal keeps confidence high.",
    "setback+less+tired":         "Setback + lower mileage + fatigue: your body is asking for more time. A finish goal this race protects your long-term running.",
    "advisor+on-track+fresh":     "Coached change + solid training + fresh body — a well-supported goal shift. Trust the process.",
    "advisor+on-track+tired":     "Your advisor sees something you might not. Combine their guidance with an honest check-in on fatigue this week.",
    "advisor+more+fresh":         "More volume on your advisor's plan and feeling good — this is how breakthroughs happen.",
    "advisor+more+tired":         "Advisor-driven and putting in the miles, but your body is tired. Communicate the fatigue — a great coach adjusts.",
    "advisor+less+fresh":         "Advisor tweaked the goal on lower mileage, but you feel fresh — trust that recovery is working.",
    "advisor+less+tired":         "Lower mileage, fatigue, and a new advisor goal — make sure the adjustment is intentional, not reactive. A down week may be prescribed.",

    // beaten-up physical state — always a caution message
    "stronger+on-track+beaten":   "Something hurts — even with strong motivation and solid training, racing through pain rarely ends well. See a physio before committing to a faster goal.",
    "stronger+more+beaten":       "Beaten up while running more? This is overuse territory. Pull back the volume, address the pain, then revisit the goal.",
    "stronger+less+beaten":       "Lower volume but still hurting — your body needs a rest block before a goal change makes sense.",
    "new-race+on-track+beaten":   "New race excitement is real, but racing injured is a bigger gamble than a conservative goal. Get the pain assessed first.",
    "new-race+more+beaten":       "New race + extra volume + pain = injury waiting to happen. Take a down week, see a physio, then lock in a goal.",
    "new-race+less+beaten":       "New race on the calendar, but you're hurting — a finish goal protects your ability to toe the line at all.",
    "setback+on-track+beaten":    "Coming back from a setback while still in pain suggests incomplete recovery. Prioritize healing over the goal bracket.",
    "setback+more+beaten":        "More mileage than planned and beaten up after a setback — this is a red flag. Ease off and let your body catch up.",
    "setback+less+beaten":        "Low mileage, a setback, and ongoing pain — a finish goal is the right call. Get to the start line healthy.",
    "advisor+on-track+beaten":    "Your advisor should know you're in pain. Communicate it — no plan survives contact with injury.",
    "advisor+more+beaten":        "Running your advisor's plan but hurting — flag this at your next check-in. Pain always overrides the program.",
    "advisor+less+beaten":        "Below target mileage and beaten up — rest is the training right now. Your goal will wait."
  };

  const save = async () => {
    const newBracket  = document.getElementById("gu-bracket")?.value;
    const driving     = document.getElementById("gu-driving")?.value;
    const training    = document.getElementById("gu-training")?.value;
    const physical    = document.getElementById("gu-physical")?.value;

    if (!newBracket)  { showError("Please select a goal bracket."); return; }
    if (!driving)     { showError("Tell us what's driving this change."); return; }
    if (!training)    { showError("Tell us how training has been going."); return; }
    if (!physical)    { showError("Tell us how you feel physically."); return; }

    setState({ loading: true });
    const updated = {
      ...profile,
      goalBracket: newBracket,
      goalChangeContext: { driving, training, physical, changedAt: new Date().toISOString() }
    };
    await saveData("profile", updated);
    setState({ profile: updated, loading: false, view: "dashboard", error: null });
  };

  // Compute live coaching insight from current dropdown values
  const getInsight = () => {
    const d = document.getElementById("gu-driving")?.value;
    const t = document.getElementById("gu-training")?.value;
    const p = document.getElementById("gu-physical")?.value;
    if (!d || !t || !p) return null;
    return COACHING_INSIGHTS[`${d}+${t}+${p}`] || null;
  };

  const insightId = "gu-insight";
  const updateInsight = () => {
    const box = document.getElementById(insightId);
    if (!box) return;
    const msg = getInsight();
    box.textContent = msg || "";
    box.style.display = msg ? "block" : "none";
  };

  // Wire up live insight on change
  setTimeout(() => {
    ["gu-driving", "gu-training", "gu-physical"].forEach(id => {
      const el2 = document.getElementById(id);
      if (el2) el2.addEventListener("change", updateInsight);
    });
  }, 0);

  const currentLabel = BRACKET_LABELS[currentBracket];

  return div("page",
    div("card goal-update-card",
      pageHeader("Update Your Race Goal", () => setState({ view: "dashboard" })),
      errorBanner(),

      currentBracket
        ? div("goal-update-current",
            el("span", { className: "goal-update-current-label" }, "Current goal:"),
            el("span", { className: "goal-update-current-value" }, currentLabel || currentBracket)
          )
        : p("You haven't set a goal bracket yet — let's do that now."),

      div("goal-update-section",
        h3("What's your new goal?"),
        el("p", { className: "goal-update-hint" }, "Be honest with yourself — the right goal for where you are now beats an aspirational goal that breaks you."),
        field("Race goal bracket", select("gu-bracket", [
          ["Select a goal…", ""],
          ["Finish — I just want to cross the line", "finish"],
          ["Sub-5:00 (11:27/mi)", "sub-5"],
          ["Sub-4:30 (10:18/mi)", "sub-4:30"],
          ["Sub-4:00 (9:09/mi)",  "sub-4"],
          ["Sub-3:30 (8:00/mi)",  "sub-3:30"],
          ["Sub-3:00 (6:52/mi)",  "sub-3"]
        ], currentBracket))
      ),

      div("goal-update-section",
        h3("What's driving this change?"),
        field("", select("gu-driving", [
          ["Select one…", ""],
          ["I've been feeling stronger lately", "stronger"],
          ["New race on the calendar", "new-race"],
          ["Injury, illness, or setback", "setback"],
          ["My coach or advisor suggested it", "advisor"]
        ], ""))
      ),

      div("goal-update-section",
        h3("How has training been going?"),
        field("", select("gu-training", [
          ["Select one…", ""],
          ["On track — hitting most sessions", "on-track"],
          ["Running more than planned", "more"],
          ["Running less than planned", "less"]
        ], ""))
      ),

      div("goal-update-section",
        h3("How do you feel physically right now?"),
        field("", select("gu-physical", [
          ["Select one…", ""],
          ["Fresh and ready to push", "fresh"],
          ["Tired but managing fine", "tired"],
          ["Beaten up — something hurts", "beaten"]
        ], ""))
      ),

      el("div", { id: insightId, className: "goal-update-insight", style: "display:none" }, ""),

      div("goal-update-actions",
        btn("Save Goal & Rebuild Plan", save),
        btn("Cancel", () => setState({ view: "dashboard", error: null }), "btn-secondary")
      )
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
  const weekData      = profile ? getCurrentWeekData(profile) : null;
  const phase         = weeks != null ? weekData?.phase || getPhase(weeks) : null;
  const plan          = (profile?.raceDate && profile?.longRunDay != null && weekData)
    ? buildFlexibleWeekPlan(profile.longRunDay, profile.trainingDays || 4, weekData, zones, goal) : null;
  const recentWeights  = workouts.filter(w => w.weightLbs).slice(0, 7).map(w => w.weightLbs);
  const weightWarning  = checkWeightFlag(recentWeights);
  const retestDue      = zones?.lastTested && daysSince(zones.lastTested) > 28;
  const weeksIn        = weekData ? Math.max(0, Math.floor((Date.now() - new Date(profile?.trainingStart || profile?.createdAt)) / (7 * 24 * 60 * 60 * 1000))) : 0;
  const moodAdaptation = profile ? getBlockMoodAdaptation(workouts, weeksIn, profile.trainingStart || profile.createdAt) : null;
  const toughStreak    = getConsecutiveStruggling(workouts);
  const needsPlanSetup = profile && !profile.fitnessLevel;
  const todayIdx      = new Date().getDay();
  const todayPlan     = plan ? plan[todayIdx] : null;

  const raceCard = weeks != null ? div("card",
    h2("Race Overview"),
    div("stat-row",
      statBox("Race Date", new Date(profile.raceDate + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })),
      statBox("Weeks Out", weeks),
      statBox("Phase", phase.name)
    ),
    div("phase-note", phase.note),
    prediction ? div("prediction-box",
      p(el("span", { className: "pred-main" }, `📈 Fitness estimate: ${prediction.timeStr} (${prediction.paceStr})`)),
      el("p", { className: "pred-source" }, `Based on your ${prediction.distMi}-mile run on ${prediction.date}${prediction.confident ? "" : " — accuracy improves as your long runs get longer"}`),
      goal ? p(`🎯 Your goal: ${goal.targetFinish} (${goal.targetPace}/mi)`) : null,
      goal?.validation
        ? prediction?.confident
          ? div(`goal-status ${goal.validation.status}`, goal.validation.msg)
          : div("goal-status achievable", `Goal set — your prediction will sharpen once your long runs reach 8+ miles. Keep building.`)
        : null
    ) : p("No fitness estimate yet — log a run of 4+ miles to see one.")
  ) : null;

  const zonesCard = zones ? div("card",
    h2("Your HR Zones"),
    el("div", { className: "zone-method" }, `Method: ${zones.method === "tested" ? "Field test ✓" : "Estimated"}`),
    zones.zr ? zoneBar(zones.zr, "zr") : null,
    zones.z1 ? zoneBar(zones.z1, "z1") : null,
    zones.z2 ? zoneBar(zones.z2, "z2") : null,
    zones.z3 ? zoneBar(zones.z3, "z3") : null,
    btn("Update Zones (Run Field Test)", () => setState({ view: "test" }), "btn-secondary")
  ) : null;

  // Check if athlete already logged a workout today
  const todayISO   = new Date().toISOString().split("T")[0];
  const todayLog   = state.workouts.find(w => w.date === todayISO);

  // Today's workout card — detailed instructions + log button, or completed results
  const todayCard = todayPlan ? div("card today-card",
    h2(`Today — ${DNAMES[todayIdx]}`),
    weekData?.isCutback ? div("cutback-badge", "Recovery Week — keep it easy") : null,

    todayLog ? div("today-complete",
      div("today-complete-header", "✓ Completed"),
      div("today-complete-type", todayLog.type || "Run"),
      div("today-complete-stats",
        todayLog.distanceMi ? el("span", null, `📍 ${todayLog.distanceMi} mi`) : null,
        todayLog.durationSec ? el("span", null, `⏱ ${secsToHMS(todayLog.durationSec)}`) : null,
        todayLog.pace && todayLog.type === "Run" ? el("span", null, `🏃 ${todayLog.pace}/mi`) : null,
        todayLog.avgHR  ? el("span", null, `♥ ${todayLog.avgHR} bpm`) : null
      ),
      todayLog.notes ? div("today-complete-notes", `"${todayLog.notes}"`) : null,
      btn("View History", () => setState({ view: "history" }), "btn-secondary btn-sm")
    )

    : todayPlan.type === "Rest"
      ? div("today-rest", todayPlan.notes || "Rest day. Recover, hydrate, sleep well.")
      : div("today-workout",
          div("today-run-type", todayPlan.type),
          div("today-run-zone", todayPlan.zone),
          todayPlan.duration ? div("today-run-duration", `Target: ${todayPlan.duration}`) : null,
          div("today-run-instructions", todayPlan.notes),
          btn("Log Today's Results →", () => setState({ view: "log-workout" }), "btn-log-today")
        )
  ) : null;

  const weekCard = plan ? div("card",
    h2("This Week"),
    div("week-plan",
      plan.map(day => {
        const isToday = day.idx === todayIdx;
        return div(`day-slot${day.type === "Rest" ? " rest" : ""}${isToday ? " today" : ""}`,
          el("strong", null, day.day),
          el("span", { className: "day-type" }, day.type),
          day.zone     ? el("span", { className: "day-zone" },     day.zone)     : null,
          day.duration ? el("span", { className: "day-duration" }, day.duration) : null
        );
      })
    )
  ) : null;

  const stravaConnected = !!state.stravaTokens;
  const stravaBtn = stravaConnected
    ? div("strava-connected",
        div("strava-connected-label",
          div("strava-dot"),
          el("span", null, "Strava connected")
        ),
        div("strava-connected-actions",
          btn("Sync runs →", fetchStravaActivities, "btn-strava-sync"),
          btn("Disconnect", stravaDisconnect, "btn-link btn-strava-disconnect")
        )
      )
    : (() => {
        const b = el("a", {
          href: stravaConnectURL(),
          className: "btn-strava-connect"
        });
        b.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="white" style="margin-right:8px;vertical-align:middle"><path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169"/></svg>Connect with Strava`;
        return b;
      })();

  const trackCard = div("card",
    h2("Training"),
    div("menu",
      btn("Log a Workout",          () => setState({ view: "log-workout" })),
      btn("View Workout History",   () => setState({ view: "history" })),
      btn("View Full Training Plan",() => setState({ view: "plan" })),
      btn("Update My Race Goal", () => setState({ view: "goal-update" }), "btn-secondary"),
      btn("Update Fitness Level / Rebuild Plan", () => setState({ view: "update-plan" }), "btn-secondary"),
      btn("Edit Profile & Plan Settings", () => setState({ view: "edit-profile" }), "btn-secondary")
    ),
    div("strava-section",
      el("p", { className: "strava-section-label" }, "Strava"),
      stravaBtn
    )
  );

  const groupCard = state.groupData ? div("card group-card",
    h2(`${state.groupData.name} — Your Group`),
    state.groupData.members.length === 0
      ? p("No other members in your group yet.")
      : div("group-members",
          state.groupData.members.map(member => div("group-member",
            el("strong", { className: "group-member-name" }, member.name),
            member.workouts.length === 0
              ? p("No workouts logged yet.")
              : div("group-workout-rows",
                  member.workouts.map(w => {
                    const mood = MOODS.find(m => m.key === w.mood);
                    return div("group-workout-row",
                      el("span", { className: "gw-date" }, w.date),
                      el("span", { className: "gw-type" }, w.type || "Run"),
                      w.distanceMi ? el("span", { className: "gw-dist" }, `${w.distanceMi} mi`) : null,
                      el("span", { className: "gw-dur" }, secsToHMS(w.durationSec)),
                      mood ? el("span", { className: "gw-mood" }, mood.emoji) : null
                    );
                  })
                )
          ))
        )
  ) : null;

  return div("page",
    el("header", null,
      h1(`Hi, ${profile?.name || user.name}`),
      div("header-actions",
        user.admin ? (() => {
          const label = state.pendingCount > 0
            ? `Command Center 🔴 ${state.pendingCount}`
            : "Command Center";
          return btn(label, () => loadCommandCenter(), "btn-small");
        })() : null,
        btn("Logout", doLogout, "btn-logout")
      )
    ),

    needsPlanSetup? div("banner banner-warning", "📋 Your training plan isn't personalized yet — we don't know your fitness level. ", el("span", { className: "banner-link", onClick: () => setState({ view: "update-plan" }) }, "Fix this now →")) : null,
    retestDue    ? div("banner banner-info",    "⏱ 4+ weeks since your last field test. ", el("span", { className: "banner-link", onClick: () => setState({ view: "test" }) }, "Run it now →")) : null,
    weightWarning? div("banner banner-warning",  `⚖️ ${weightWarning}`) : null,
    !goal        ? div("banner banner-info",     "🎯 No race goal set yet. ", el("span", { className: "banner-link", onClick: () => setState({ view: "setup-goal" }) }, "Set one now →")) : null,
    toughStreak >= 3 ? div("banner banner-warning", `😩 You've logged ${toughStreak} tough workouts in a row. Consider an easy day or rest — recovery is part of the plan.`) : null,
    moodAdaptation ? div(`mood-adaptation-card mood-adapt-${moodAdaptation.action}`,
      el("span", { className: "mood-adapt-emoji" }, moodAdaptation.emoji),
      div("mood-adapt-body",
        el("strong", null, "Block Check-In"),
        p(moodAdaptation.msg)
      )
    ) : null,

    div("dashboard-grid",
      div("dash-col", raceCard, zonesCard, groupCard),
      div("dash-col", todayCard, weekCard, trackCard)
    )
  );
}

// ═══════════════════════════════════════════════════════════════
// STRAVA IMPORT PAGE
// ═══════════════════════════════════════════════════════════════
function StravaImportPage() {
  const activities = state.stravaActivities || [];
  const existingStravaIds = new Set(state.workouts.filter(w => w.stravaId).map(w => String(w.stravaId)));

  const importOne = async (activity) => {
    const workout = stravaToWorkout(activity);
    setState({ loading: true });
    try {
      await addWorkout(workout);
      const newWorkouts = [{ id: Date.now().toString(), ...workout }, ...state.workouts];
      // Remove from pending list
      const remaining = (state.stravaActivities || []).filter(a => a.id !== activity.id);
      // If nothing left to import, go straight to history to show results
      if (remaining.length === 0) {
        setState({ workouts: newWorkouts, stravaActivities: remaining, loading: false, view: "history" });
      } else {
        setState({ workouts: newWorkouts, stravaActivities: remaining, loading: false });
      }
    } catch (err) {
      setState({ loading: false, error: "Import failed: " + err.message });
    }
  };

  const importAll = async () => {
    const toImport = activities.filter(a => !existingStravaIds.has(String(a.id)));
    if (!toImport.length) return;
    setState({ loading: true });
    try {
      await Promise.all(toImport.map(a => addWorkout(stravaToWorkout(a))));
      // Reload workouts fresh
      const snap = await userDoc().collection("workouts").orderBy("date", "desc").limit(100).get();
      const workouts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Navigate to history so the user can see their imported workouts
      setState({ workouts, stravaActivities: [], loading: false, view: "history", error: null });
    } catch (err) {
      setState({ loading: false, error: "Import failed: " + err.message });
    }
  };

  const newActivities = activities.filter(a => !existingStravaIds.has(String(a.id)));

  return div("page",
    div("card",
      pageHeader("Import from Strava", () => setState({ view: "dashboard" })),
      state.stravaLoading
        ? p("Fetching your Strava activities…")
        : activities.length === 0
          ? div(null,
              p("No activities found in your last 30 Strava activities."),
              btn("Back to Dashboard", () => setState({ view: "dashboard" }))
            )
          : div(null,
              errorBanner(),
              newActivities.length > 0
                ? div("strava-import-header",
                    el("p", { className: "strava-import-count" },
                      `${newActivities.length} new activit${newActivities.length !== 1 ? "ies" : "y"} ready to import`
                    ),
                    btn(`Import All (${newActivities.length})`, importAll, "btn-strava-import-all")
                  )
                : p("All recent Strava activities are already in your log."),

              div("strava-activity-list",
                activities.map(activity => {
                  const alreadyImported = existingStravaIds.has(String(activity.id));
                  const distMi  = (activity.distance / 1609.344).toFixed(2);
                  const durMin  = Math.round((activity.moving_time || 0) / 60);
                  const hrs     = Math.floor(durMin / 60);
                  const mins    = durMin % 60;
                  const durStr  = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
                  const dateStr = (activity.start_date_local || "").split("T")[0];
                  const hr      = activity.average_heartrate ? `♥ ${Math.round(activity.average_heartrate)} bpm` : null;

                  return div(`strava-activity-row${alreadyImported ? " strava-already-imported" : ""}`,
                    div("strava-activity-info",
                      el("span", { className: "strava-activity-name" }, activity.name || activity.sport_type || activity.type || "Activity"),
                      el("span", { className: "strava-activity-date" }, dateStr),
                      div("strava-activity-stats",
                        el("span", null, `📍 ${distMi} mi`),
                        el("span", null, `⏱ ${durStr}`),
                        hr ? el("span", null, hr) : null
                      )
                    ),
                    alreadyImported
                      ? el("span", { className: "strava-imported-badge" }, "✓ In log")
                      : btn("Import", () => importOne(activity), "btn-strava-import-one")
                  );
                })
              )
            )
    )
  );
}

// ═══════════════════════════════════════════════════════════════
// LOG WORKOUT
// ═══════════════════════════════════════════════════════════════
const WORKOUT_TYPES = [
  "Run",
  "Walk",
  "Bike",
  "Swim",
  "Yoga / Stretch",
  "Strength",
  "Other"
];
const DISTANCE_TYPES = new Set(["Run", "Walk", "Bike", "Swim", "Other"]);
const RUNNING_TYPES  = new Set(["Run"]);  // only runs feed Riegel prediction
const SWIM_TYPE      = "Swim";

function LogWorkout() {
  const editing  = state.editingWorkout;
  const backDest = editing ? "history" : "dashboard";
  let selectedMood = editing?.mood || null;

  // ── helpers ──────────────────────────────────────────────────
  function calcSwimPace(durationSec, distYards) {
    if (!distYards || distYards <= 0) return null;
    const per100 = (durationSec / 60) / (distYards / 100);
    const m = Math.floor(per100);
    const s = Math.round((per100 - m) * 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  const save = async () => {
    const date      = document.getElementById("w-date")?.value;
    const type      = document.getElementById("w-type")?.value || "Run";
    const durStr    = document.getElementById("w-dur")?.value.trim();
    const avgHR     = parseInt(document.getElementById("w-hr")?.value)    || null;
    const maxHR     = parseInt(document.getElementById("w-maxhr")?.value) || null;
    const paceInput = document.getElementById("w-pace")?.value?.trim()    || null;
    const splitsRaw = document.getElementById("w-splits")?.value?.trim()  || null;
    const notes     = document.getElementById("w-notes")?.value.trim();
    const weightLbs = parseFloat(document.getElementById("w-weight")?.value) || null;

    const isSwim    = type === SWIM_TYPE;
    const needsDist = DISTANCE_TYPES.has(type);
    const distRaw   = parseFloat(document.getElementById("w-dist")?.value) || null;

    if (!date)        { showError("Please enter the date."); return; }
    if (!durStr)      { showError("Please enter the duration."); return; }
    if (needsDist && !distRaw) { showError(`Please enter a distance (${isSwim ? "yards" : "miles"}).`); return; }
    if (!selectedMood){ showError("Please select how you felt about this workout."); return; }

    const durationSec = parseDuration(durStr);
    if (!durationSec) { showError("Enter duration as M:SS (e.g. 54:30) or H:MM:SS (e.g. 1:32:00)."); return; }

    let workout = {
      date, type, durationSec,
      avgHR:    avgHR  || null,
      maxHR:    maxHR  || null,
      notes:    notes  || "",
      splits:   splitsRaw || null,
      weightLbs,
      mood:         selectedMood,
      moodOriginal: editing ? (editing.moodOriginal || selectedMood) : selectedMood,
      loggedAt:     editing?.loggedAt || new Date().toISOString()
    };

    if (isSwim && distRaw) {
      const pace = paceInput || calcSwimPace(durationSec, distRaw);
      Object.assign(workout, { distanceYards: distRaw, pace, paceUnit: "min/100yd" });
    } else if (needsDist && distRaw) {
      const pace = paceInput || calcPaceStr(durationSec, distRaw);
      Object.assign(workout, { distanceMi: distRaw, pace, paceUnit: "min/mi" });
      if (RUNNING_TYPES.has(type)) {
        const predictedFinishSec = riegelPredict(durationSec, distRaw, MARATHON_MI);
        Object.assign(workout, { predictedFinishSec, predictedFinishStr: secsToHMS(predictedFinishSec), predictedPaceStr: predictedPace(predictedFinishSec) + "/mi" });
      }
    }

    setState({ loading: true });
    if (editing) {
      await updateWorkout(editing.id, workout);
    } else {
      await addWorkout(workout);
    }
    const data = await loadUserData(state.user.id);
    let updatedGoal = state.goal;
    if (state.goal?.targetPace) {
      const newPred = getBestPrediction(data.workouts);
      if (newPred) { updatedGoal = { ...state.goal, validation: validateGoal(state.goal.targetPace, newPred.sec) }; await saveData("goal", updatedGoal); }
    }
    setState({ workouts: data.workouts, goal: updatedGoal, editingWorkout: null, loading: false, view: editing ? "history" : "dashboard", error: null });
  };

  // ── Mood picker ───────────────────────────────────────────────
  const moodBtns = MOODS.map(m => {
    const b = div(`mood-btn${selectedMood === m.key ? " selected" : ""}`,
      el("span", { className: "mood-emoji" }, m.emoji),
      el("span", { className: "mood-label" }, m.label)
    );
    b.addEventListener("click", () => {
      selectedMood = m.key;
      document.querySelectorAll(".mood-btn").forEach(x => x.classList.remove("selected"));
      b.classList.add("selected");
    });
    return b;
  });
  const moodPicker = div("mood-picker-wrap",
    el("label", { className: "mood-picker-label" }, "How did it feel? *"),
    div("mood-picker", ...moodBtns)
  );

  // ── Reactive form fields ──────────────────────────────────────
  const initType     = editing?.type || "Run";
  const initIsSwim   = initType === SWIM_TYPE;
  const initNeedDist = DISTANCE_TYPES.has(initType) || initType === "Easy Bike / Swim";

  // Pre-fill distance — swim uses yards, others use miles
  const initDist = initIsSwim
    ? (editing?.distanceYards || "")
    : (editing?.distanceMi    || "");

  // Include legacy "Easy Bike / Swim" type if the workout being edited has it
  const typeOptions = WORKOUT_TYPES.includes(initType)
    ? WORKOUT_TYPES
    : [...WORKOUT_TYPES, initType]; // keep legacy type selectable during edit
  const typeSelect = select("w-type", typeOptions.map(t => [t, t]), initType);

  // Distance row — label + input both update on type change
  const distLabel = el("label", { htmlFor: "w-dist" }, initIsSwim ? "Distance (yards) *" : "Distance (miles) *");
  const distInput = input({ id: "w-dist", type: "number", step: "0.01", min: "0",
    placeholder: initIsSwim ? "e.g. 1500" : "e.g. 6.2",
    value: initDist });
  const distRow = div("field", distLabel, distInput);
  distRow.style.display = initNeedDist ? "" : "none";

  // Pace row — label updates on type change
  const paceLabel = el("label", { htmlFor: "w-pace" },
    initIsSwim ? "Pace per 100 yds (M:SS, optional)" : "Pace per mile (M:SS, optional)");
  const paceInput = input({ id: "w-pace", type: "text",
    placeholder: initIsSwim ? "e.g. 2:05 — calculated if blank" : "e.g. 9:26 — calculated if blank",
    value: editing?.pace || "" });
  const paceRow = div("field", paceLabel, paceInput);
  const paceTypes = new Set(["Run", "Walk", "Bike", "Swim"]);
  paceRow.style.display = paceTypes.has(initType) ? "" : "none";

  // Splits row — label updates on type change
  const splitsLabel = el("label", { htmlFor: "w-splits" },
    initIsSwim ? "Splits per 100 yds (optional)" : "Splits per mile (optional)");
  const splitsInput = input({ id: "w-splits", type: "text",
    placeholder: initIsSwim ? "e.g. 2:05, 2:10, 2:08" : "e.g. 9:10, 9:25, 9:05",
    value: editing?.splits || "" });
  const splitsRow = div("field", splitsLabel, splitsInput);
  splitsRow.style.display = paceTypes.has(initType) ? "" : "none";

  typeSelect.addEventListener("change", () => {
    const t      = typeSelect.value;
    const isSwim = t === SWIM_TYPE;
    const needDist = DISTANCE_TYPES.has(t);
    const hasPace  = paceTypes.has(t);

    distRow.style.display   = needDist ? "" : "none";
    paceRow.style.display   = hasPace  ? "" : "none";
    splitsRow.style.display = hasPace  ? "" : "none";

    distLabel.textContent  = isSwim ? "Distance (yards) *"           : "Distance (miles) *";
    distInput.placeholder  = isSwim ? "e.g. 1500"                    : "e.g. 6.2";
    paceLabel.textContent  = isSwim ? "Pace per 100 yds (M:SS, optional)" : "Pace per mile (M:SS, optional)";
    paceInput.placeholder  = isSwim ? "e.g. 2:05 — calculated if blank"   : "e.g. 9:26 — calculated if blank";
    splitsLabel.textContent = isSwim ? "Splits per 100 yds (optional)" : "Splits per mile (optional)";
    splitsInput.placeholder = isSwim ? "e.g. 2:05, 2:10, 2:08"         : "e.g. 9:10, 9:25, 9:05";

    // Clear distance on type switch to avoid unit confusion
    distInput.value = "";
    paceInput.value = "";
    splitsInput.value = "";
  });

  const durDefault = editing?.durationSec ? secsToHMS(editing.durationSec) : "";
  const title   = editing ? "Edit Workout" : "Log a Workout";
  const saveLbl = editing ? "Update Workout" : "Save Workout";

  return div("page",
    div("card",
      pageHeader(title, () => setState({ editingWorkout: null, view: backDest })),
      editing ? div("banner banner-info", `Editing workout from ${editing.date} — changes replace the original.`) : null,
      errorBanner(),
      field("Date *",            input({ id: "w-date",   type: "date",   value: editing?.date || new Date().toISOString().split("T")[0] })),
      field("Activity type *",   typeSelect),
      distRow,
      field("Duration * (M:SS or H:MM:SS)", input({ id: "w-dur", type: "text", placeholder: "e.g. 58:30 or 1:02:45", value: durDefault })),
      div("field-row",
        field("Avg HR (bpm, optional)", input({ id: "w-hr",    type: "number", placeholder: "e.g. 142", min: "60", max: "220", value: editing?.avgHR || "" })),
        field("Max HR (bpm, optional)", input({ id: "w-maxhr", type: "number", placeholder: "e.g. 168", min: "60", max: "220", value: editing?.maxHR || "" }))
      ),
      paceRow,
      splitsRow,
      field("Weight today (lbs, optional)", input({ id: "w-weight", type: "number", placeholder: "e.g. 162.5", step: "0.1", value: editing?.weightLbs || "" })),
      field("Notes (optional)", input({ id: "w-notes", type: "text", placeholder: "How did it feel?", value: editing?.notes || "" })),
      moodPicker,
      btn(saveLbl, save)
    )
  );
}

// ═══════════════════════════════════════════════════════════════
// WORKOUT HISTORY
// ═══════════════════════════════════════════════════════════════
function workoutZoneResult(w) {
  const zones = state.zones;
  if (!w.avgHR || !zones || !zones.zr) return null;
  const hr = w.avgHR;

  let label, cls;
  if      (hr < zones.zr.low)                              { label = "Below Recovery"; cls = "wz-below"; }
  else if (hr <= zones.zr.high)                            { label = "Recovery";       cls = "wz-zr";    }
  else if (hr < zones.z1.low)                              { label = "Gap Zone";       cls = "wz-gap";   }
  else if (hr <= zones.z1.high)                            { label = "Zone 1";         cls = "wz-z1";    }
  else if (hr <= zones.z2.high)                            { label = "Zone 2";         cls = "wz-z2";    }
  else if (zones.z3 && hr <= zones.z3.high)                { label = "Zone 3";         cls = "wz-z3";    }
  else                                                     { label = "Above Z3";       cls = "wz-above"; }

  return el("span", { className: `workout-zone-result ${cls}` }, `● ${label}`);
}

function workoutMoodTag(w, showFlag) {
  const cur  = MOODS.find(m => m.key === w.mood);
  const orig = MOODS.find(m => m.key === w.moodOriginal);
  if (!cur && !orig) return null;
  const changed = showFlag && orig && cur && orig.key !== cur.key;
  return div("workout-mood",
    el("span", { className: `mood-tag mood-${cur?.key || orig?.key}` },
      `${cur?.emoji || orig?.emoji} ${cur?.label || orig?.label}`
    ),
    changed ? el("span", { className: "mood-changed-flag" }, `(logged: ${orig.emoji} ${orig.label})`) : null
  );
}

// ═══════════════════════════════════════════════════════════════
// WORKOUT EVALUATION ENGINE
// ═══════════════════════════════════════════════════════════════
function buildPlanIndex(profile, zones, goal) {
  if (!profile?.raceDate || !profile?.trainingStart) return {};
  const startDate  = new Date(profile.trainingStart + "T12:00:00");
  const raceDate   = new Date(profile.raceDate + "T12:00:00");
  const totalWeeks = Math.max(1, Math.ceil((raceDate - startDate) / (7 * 24 * 60 * 60 * 1000)));

  // Sunday of week 0
  const week0Sunday = new Date(startDate);
  week0Sunday.setDate(week0Sunday.getDate() - week0Sunday.getDay());

  const longRunDay   = profile.longRunDay ?? 6;
  const trainingDays = profile.trainingDays || 4;
  const goalBracket  = profile.goalBracket || null;
  const index        = {};

  for (let w = 0; w < totalWeeks; w++) {
    const weekSunday = new Date(week0Sunday);
    weekSunday.setDate(week0Sunday.getDate() + w * 7);
    const weekSundayStr = weekSunday.toISOString().split("T")[0];
    const wd = calcWeekData(profile.fitnessLevel, w, totalWeeks - w, profile.comfortableLongRun, trainingDays, goalBracket);
    const plan = buildFlexibleWeekPlan(longRunDay, trainingDays, wd, zones, goal, weekSundayStr);
    for (const day of plan) {
      if (day.plannedDate) index[day.plannedDate] = day;
    }
  }
  return index;
}

function evaluateWorkout(workout, planIndex) {
  if (!workout?.date || !planIndex) return null;
  const planned = planIndex[workout.date];
  if (!planned) return null; // outside plan window — show nothing

  if (planned.type === "Rest") {
    return { grade: "bonus", label: "Bonus — rest day run" };
  }
  if (planned.type === "Strength" || planned.type === "Cross-Train") {
    return { grade: "info", label: planned.type, plannedType: planned.type };
  }
  if (!workout.avgHR) {
    return { grade: "no-hr", label: `Planned: ${planned.type}${planned.zone ? " (" + planned.zone + ")" : ""}`, plannedType: planned.type };
  }

  const lo = planned.targetZoneLow;
  const hi = planned.targetZoneHigh;
  if (!lo || !hi) {
    return { grade: "no-hr", label: `Planned: ${planned.type}`, plannedType: planned.type };
  }

  const hr = workout.avgHR;
  if (hr >= lo && hr <= hi)  return { grade: "green",  label: `✅ On target — ${planned.type}`,          plannedType: planned.type, plannedZone: planned.zone };
  if (hr < lo)               return { grade: "yellow", label: `🟡 Below target zone — ${planned.type}`,  plannedType: planned.type, plannedZone: planned.zone };
                             return { grade: "red",    label: `🔴 Above target zone — ${planned.type}`,  plannedType: planned.type, plannedZone: planned.zone };
}

function workoutEvalBadge(ev) {
  if (!ev) return null;
  const cls = ev.grade === "green"  ? "eval-green"  :
              ev.grade === "yellow" ? "eval-yellow" :
              ev.grade === "red"    ? "eval-red"    :
              ev.grade === "bonus"  ? "eval-bonus"  :
              ev.grade === "info"   ? "eval-info"   : "eval-nohr";
  return el("span", { className: `workout-eval-badge ${cls}` }, ev.label);
}

function analyzeSplitHRDrift(splitHRs, zones) {
  if (!splitHRs || splitHRs.length < 2 || !zones) return null;
  const zoneFor = hr => {
    if (!hr) return null;
    if (hr <= (zones.zr?.high || 0)) return "Recovery";
    if (hr < (zones.z1?.low  || 0)) return "Gap";
    if (hr <= (zones.z1?.high || 0)) return "Z1";
    if (hr <= (zones.z2?.high || 0)) return "Z2";
    if (hr <= (zones.z3?.high || 0)) return "Z3";
    return "Above Z3";
  };
  const first = zoneFor(splitHRs[0]);
  const last  = zoneFor(splitHRs[splitHRs.length - 1]);
  const driftedHigh = last === "Z3" || last === "Above Z3";
  const startedHigh = first === "Z3" || first === "Above Z3";
  if (startedHigh) return "Started too hard — began in Z3.";
  if (driftedHigh) return "HR drifted into Z3 late — good effort, watch pacing next time.";
  return null; // healthy drift — no warning needed
}

function WorkoutHistory() {
  const planIndex = buildPlanIndex(state.profile, state.zones, state.goal);
  return div("page",
    el("header", null, h1("Workout History"), btn("← Back", () => setState({ view: "dashboard" }), "btn-back")),
    state.workouts.length === 0
      ? div("card", p("No workouts logged yet."))
      : div("workout-list",
          state.workouts.map(w => {
            const evaluation  = evaluateWorkout(w, planIndex);
            const driftNote   = w.splitHRs ? analyzeSplitHRDrift(w.splitHRs, state.zones) : null;
            return div("workout-card",
              div("workout-header",
                el("span", { className: "workout-date" }, w.date),
                el("span", { className: "workout-type-tag" }, w.type || "Run"),
                el("span", { className: "workout-dist" },
                  w.distanceYards ? `${w.distanceYards} yds — ${secsToHMS(w.durationSec)}` :
                  w.distanceMi    ? `${w.distanceMi} mi — ${secsToHMS(w.durationSec)}` :
                  secsToHMS(w.durationSec)
                ),
                btn("Edit", () => setState({ editingWorkout: w, view: "log-workout" }), "btn-edit-workout")
              ),
              div("workout-details",
                w.pace && w.type === "Swim" ? span("⏱ ", w.pace, "/100 yds") :
                w.pace                      ? span("⏱ ", w.pace, "/mi")       : null,
                w.avgHR     ? span("♥ avg ", w.avgHR, " bpm")                 : null,
                w.maxHR     ? span("♥ max ", w.maxHR, " bpm")                 : null,
                w.weightLbs ? span("⚖️ ", w.weightLbs, " lbs")                : null,
                w.predictedFinishStr ? span("📈 ", w.predictedFinishStr)       : null,
                workoutZoneResult(w)
              ),
              workoutEvalBadge(evaluation),
              w.splits ? div("workout-splits",
                el("span", { className: "splits-label" }, w.type === "Swim" ? "Splits /100 yds:" : "Splits /mi:"),
                el("span", { className: "splits-values" }, w.splits)
              ) : null,
              w.splitHRs && w.splitHRs.length > 0 ? div("workout-splits",
                el("span", { className: "splits-label" }, "Mile HRs:"),
                el("span", { className: "splits-values" }, w.splitHRs.join(", ") + " bpm")
              ) : null,
              driftNote ? el("p", { className: "drift-note" }, driftNote) : null,
              workoutMoodTag(w, false),
              w.notes ? div("workout-notes", w.notes) : null,
              w.source === "strava" ? el("span", { className: "strava-source-tag" }, "via Strava") : null
            );
          })
        )
  );
}

// ═══════════════════════════════════════════════════════════════
// FULL PLAN
// ═══════════════════════════════════════════════════════════════
function PlanPage() {
  const { profile } = state;
  if (!profile?.raceDate) return div("page", div("card", p("Complete setup to see your training plan.")));

  const totalWeeks     = weeksUntil(profile.raceDate);
  const phase          = getPhase(totalWeeks);
  const startDate      = new Date(profile.trainingStart || profile.createdAt);
  const raceDate       = new Date(profile.raceDate + "T12:00:00");
  const totalPlanWeeks = Math.max(1, Math.ceil((raceDate - startDate) / (7 * 24 * 60 * 60 * 1000)));
  const currentWeekIdx = Math.max(0, Math.floor((Date.now() - startDate) / (7 * 24 * 60 * 60 * 1000)));

  const statsCard = div("card",
    div("stat-row", statBox("Plan Weeks", totalPlanWeeks), statBox("Weeks Left", totalWeeks), statBox("Phase", phase.name)),
    div("phase-note", phase.note)
  );

  const backBtn  = btn("← Back", () => setState({ view: "dashboard" }), "btn-back");

  if (!planViewMode) {
    return div("page",
      el("header", null, h1("Training Plan"), backBtn),
      statsCard,
      div("card",
        h2("How would you like to view your plan?"),
        p("Pick your preferred layout. You can switch anytime."),
        div("plan-view-picker",
          btn("📅  Full Calendar — week-by-week grid", () => { planViewMode = "calendar"; render(); }),
          btn("📊  Progress Chart — bar chart of the whole plan", () => { planViewMode = "chart"; render(); }, "btn-secondary")
        )
      )
    );
  }

  const switchBtn = btn(
    planViewMode === "calendar" ? "📊 Switch to Chart" : "📅 Switch to Calendar",
    () => { planViewMode = planViewMode === "calendar" ? "chart" : "calendar"; render(); },
    "btn-small"
  );

  const content = planViewMode === "chart"
    ? renderPlanChart(profile, totalPlanWeeks, currentWeekIdx)
    : renderPlanCalendar(profile, totalPlanWeeks, currentWeekIdx);

  return div("page",
    el("header", null, h1("Training Plan"), div("header-actions", switchBtn, backBtn)),
    statsCard,
    content
  );
}

function renderPlanChart(profile, totalWeeks, currentWeekIdx) {
  const key   = normalizeFitnessLevel(profile.fitnessLevel);
  const level = PLAN_LEVELS[key] || PLAN_LEVELS.firstTimer;
  const maxLong = level.longPeak;

  const weeks = Array.from({ length: totalWeeks }, (_, w) => {
    const wd = calcWeekData(profile.fitnessLevel, w, totalWeeks - w, profile.comfortableLongRun, profile.trainingDays || 4, profile.goalBracket || null);
    return { weekNum: w + 1, wd, isCurrent: w === currentWeekIdx };
  });

  return div("card",
    h2("Full Plan — Progress Chart"),
    p("Each bar is one week. Height = long run miles. Orange = recovery week. Blue = current week."),
    div("chart-scroll",
      div("chart-container",
        weeks.map(w => {
          const heightPct = Math.max(4, Math.round((w.wd.longMi / maxLong) * 100));
          const barCls = w.isCurrent ? "chart-bar current-bar" : w.wd.isCutback ? "chart-bar cutback-bar" : "chart-bar";
          return div("chart-col",
            el("span", { className: "bar-mins" }, w.wd.longMi),
            el("div", { className: barCls, style: { height: `${heightPct}%` } }),
            el("span", { className: "bar-week" }, `W${w.weekNum}`)
          );
        })
      )
    )
  );
}

function renderPlanCalendar(profile, totalWeeks, currentWeekIdx) {
  const longRunDay   = profile.longRunDay ?? 6;
  const trainingDays = profile.trainingDays || 4;
  const goalBracket  = profile.goalBracket || null;
  const startDate    = new Date((profile.trainingStart || profile.createdAt) + "T12:00:00");

  // Compute the Sunday of training week 0 (for plannedDate mapping)
  const week0Sunday = new Date(startDate);
  week0Sunday.setDate(week0Sunday.getDate() - week0Sunday.getDay());

  const weeks = Array.from({ length: totalWeeks }, (_, w) => {
    const wd = calcWeekData(profile.fitnessLevel, w, totalWeeks - w, profile.comfortableLongRun, trainingDays, goalBracket);
    const weekSunday = new Date(week0Sunday);
    weekSunday.setDate(week0Sunday.getDate() + w * 7);
    const weekSundayStr = weekSunday.toISOString().split("T")[0];
    const plan = buildFlexibleWeekPlan(longRunDay, trainingDays, wd, state.zones, state.goal, weekSundayStr);
    const weekStart = new Date(startDate);
    weekStart.setDate(startDate.getDate() + w * 7);
    return { weekNum: w + 1, plan, wd, isCurrent: w === currentWeekIdx, weekStart };
  });

  return div("card",
    h2("Full Plan — Calendar"),
    div("plan-calendar",
      weeks.map(w => {
        const dateStr   = w.weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const phaseName = w.wd.phase?.name || "";
        return div(`plan-week${w.isCurrent ? " current-week" : ""}${w.wd.isCutback ? " cutback-week" : ""}`,
          div("plan-week-header",
            el("span", { className: "plan-week-num" }, `Week ${w.weekNum}`),
            el("span", { className: "plan-week-date" }, dateStr),
            el("span", { className: "plan-phase-tag" }, phaseName),
            w.wd.totalMi ? el("span", { className: "plan-week-miles" }, `~${w.wd.totalMi} mi`) : null,
            w.isCurrent    ? el("span", { className: "plan-tag current-tag" }, "← Now")      : null,
            w.wd.isCutback ? el("span", { className: "plan-tag cutback-tag" }, "↓ Recovery") : null
          ),
          div("plan-week-days",
            w.plan.map(day => {
              const typeCls =
                day.type === "Long Run"           ? "long"    :
                day.type === "Cross-Train"        ? "cross"   :
                day.type === "Rest"               ? "rest"    :
                ["Fartlek","Light Fartlek","Structured Fartlek","Strides"].includes(day.type) ? "fartlek" :
                ["Tempo Run","Race Pace Run","Yasso 800s","Easy Shakeout"].includes(day.type)  ? "quality" :
                "easy";
              const shortMi = day.miles ? ` ${day.miles} mi` : "";
              const cellLabel =
                day.type === "Long Run"        ? `Long\n${w.wd.longMi} mi` :
                day.type === "Cross-Train"     ? "X-Train"                 :
                day.type === "Rest"            ? "Rest"                    :
                day.type === "Base Run"        ? `Base${shortMi}`          :
                day.type === "Fartlek"         ? `Fartlek${shortMi}`       :
                day.type === "Light Fartlek"   ? `Fartlek${shortMi}`       :
                day.type === "Structured Fartlek" ? `Intervals${shortMi}`  :
                day.type === "Tempo Run"       ? `Tempo${shortMi}`         :
                day.type === "Race Pace Run"   ? `Race Pace${shortMi}`     :
                day.type === "Yasso 800s"      ? `Yasso 800s`              :
                day.type === "Easy Shakeout"   ? `Shakeout`                :
                day.type === "Strides"         ? `Strides`                 :
                day.type;
              return div(`plan-day-cell ${typeCls}`,
                el("span", { className: "plan-cell-day" }, day.day),
                el("span", { className: "plan-cell-type" }, cellLabel)
              );
            })
          )
        );
      })
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
  setState({ loading: true, view: "command", error: null });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("Connection timed out.")), 10000));
  try {
    const [approvedSnap, pendingSnap, groupsSnap] = await Promise.race([
      Promise.all([
        db.collection("approvedUsers").get(),
        db.collection("signupRequests").where("status", "==", "pending").get(),
        db.collection("groups").get()
      ]),
      timeout
    ]);

    const approved = approvedSnap.docs.map(d => ({ docId: d.id, ...d.data() }));
    const pending  = pendingSnap.docs.map(d => ({ docId: d.id, ...d.data() }));
    const groups   = groupsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const allUsers = await Promise.race([
      Promise.all([
        loadUserData(ADMIN.id).then(d => ({ ...d, name: ADMIN.name, userId: ADMIN.id, admin: true })),
        ...approved.map(u => loadUserData(u.docId).then(d => ({ ...d, name: u.name, userId: u.docId, admin: false })))
      ]),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Timed out loading athlete data.")), 10000))
    ]);

    setState({ allUsers, pendingRequests: pending, pendingCount: pending.length, adminGroups: groups, loading: false });
  } catch (err) {
    setState({ loading: false, error: "Command Center: " + err.message });
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

  // Open pre-filled approval email if we have their address
  if (requestData.email) {
    const subject = encodeURIComponent("You're in — MyPaceZone beta access approved");
    const body = encodeURIComponent(
      `Hi ${requestData.name},\n\n` +
      `Great news — your beta access to MyPaceZone has been approved!\n\n` +
      `Log in here using the password you chose:\n` +
      `https://mypacezone.com/app/\n\n` +
      `Once you're in, complete your profile and we'll build your training plan.\n\n` +
      `Welcome to the team!\nJohn`
    );
    window.open(`mailto:${requestData.email}?subject=${subject}&body=${body}`);
  }

  await loadCommandCenter();
}

async function rejectRequest(docId) {
  const req = state.pendingRequests.find(r => r.docId === docId);
  await db.collection("signupRequests").doc(docId).update({ status: "rejected" });
  const filtered = state.pendingRequests.filter(r => r.docId !== docId);
  setState({ pendingRequests: filtered, pendingCount: filtered.length });

  // Open pre-filled rejection email if we have their address
  if (req?.email) {
    const subject = encodeURIComponent("MyPaceZone — beta request update");
    const body = encodeURIComponent(
      `Hi ${req.name},\n\n` +
      `Thanks for your interest in MyPaceZone.\n\n` +
      `We're not able to add you to the beta right now, but we'll keep your info on file and reach out when a spot opens up.\n\n` +
      `John`
    );
    window.open(`mailto:${req.email}?subject=${subject}&body=${body}`);
  }
}

async function deleteAthlete(userId, name) {
  if (!window.confirm(`Delete ${name}? This removes their login and all training data permanently.`)) return;
  setState({ loading: true });
  try {
    // Delete data subcollection docs
    const dataSnap = await db.collection("users").doc(userId).collection("data").get();
    await Promise.all(dataSnap.docs.map(d => d.ref.delete()));
    // Delete all workouts
    const wSnap = await db.collection("users").doc(userId).collection("workouts").get();
    await Promise.all(wSnap.docs.map(d => d.ref.delete()));
    // Delete user doc itself
    await db.collection("users").doc(userId).delete();
    // Remove from approvedUsers
    await db.collection("approvedUsers").doc(userId).delete();
  } catch (err) {
    setState({ loading: false, error: "Could not delete athlete: " + err.message });
    return;
  }
  await loadCommandCenter();
}

async function changeAthletePassword(userId, name) {
  const newPw = window.prompt(`Enter a new password for ${name} (min 6 characters):`);
  if (!newPw) return;
  if (newPw.length < 6) { alert("Password must be at least 6 characters."); return; }
  const hash = await hashPassword(newPw);
  await db.collection("approvedUsers").doc(userId).update({ passwordHash: hash });
  alert(`Password updated for ${name}. Let them know their new password.`);
}

async function handleCreateGroup() {
  const name = window.prompt("Group name (e.g. Orlando, Tampa):");
  if (!name?.trim()) return;
  setState({ loading: true });
  await createGroup(name.trim());
  await loadCommandCenter();
}

async function handleAssignGroup(userId, userName, currentGroupId) {
  const groups = state.adminGroups || [];
  const options = ["(No group)", ...groups.map(g => g.name)].join("\n");
  const choice  = window.prompt(`Assign ${userName} to a group:\n\n${options}\n\nType the exact group name (or leave blank to remove from group):`);
  if (choice === null) return;
  const matched = groups.find(g => g.name.toLowerCase() === choice.trim().toLowerCase());
  setState({ loading: true });
  await setAthleteGroup(userId, matched?.id || null);
  await loadCommandCenter();
}

function CommandCenter() {
  const { allUsers, pendingRequests, adminGroups } = state;

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
              el("strong", null, req.name || req.email || "Unknown"),
              req.email && req.name !== req.email ? el("span", { className: "pending-email" }, req.email) : null,
              req.source === "landing-page" ? el("span", { className: "pending-source" }, "via landing page") : null,
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

    // ── Groups
    div("card",
      div("cc-section-head",
        h2("Groups"),
        btn("+ New Group", handleCreateGroup, "btn-secondary btn-sm")
      ),
      (!adminGroups || adminGroups.length === 0)
        ? p("No groups yet. Create one to organize runners by location.")
        : div("group-admin-list",
            adminGroups.map(g => {
              const members = (allUsers || []).filter(u => u.profile?.groupId === g.id);
              return div("group-admin-row",
                el("strong", null, g.name),
                el("span", { className: "group-member-count" }, `${members.length} member${members.length !== 1 ? "s" : ""}`),
                members.length > 0
                  ? el("span", { className: "group-member-names" }, members.map(u => u.profile.name).join(", "))
                  : null
              );
            })
          )
    ),

    // ── All athletes
    h2("Athletes"),
    div("user-cards",
      (allUsers || []).map(u => {
        if (!u.profile) return div("user-card empty",
          el("em", null, `${u.name} — no profile yet`),
          !u.admin ? div("card-admin-actions",
            btn("Change Password", () => changeAthletePassword(u.userId, u.name), "btn-secondary btn-sm"),
            btn("Delete Athlete",  () => deleteAthlete(u.userId, u.name),         "btn-delete")
          ) : null
        );
        const pred    = getBestPrediction(u.workouts);
        const weights = u.workouts.filter(w => w.weightLbs).slice(0, 7).map(w => w.weightLbs);
        const wFlag   = checkWeightFlag(weights);
        const retestDue = u.zones?.lastTested && daysSince(u.zones.lastTested) > 28;
        const last    = u.workouts[0];

        const isExpanded = expandedAthletes.has(u.userId);
        const toggleWorkouts = () => {
          if (isExpanded) expandedAthletes.delete(u.userId);
          else expandedAthletes.add(u.userId);
          render();
        };

        const workoutList = isExpanded ? div("admin-workout-list",
          u.workouts.length === 0 ? p("No workouts logged yet.") :
          u.workouts.map(w => {
            const cur  = MOODS.find(m => m.key === w.mood);
            const orig = MOODS.find(m => m.key === w.moodOriginal);
            const moodChanged = cur && orig && cur.key !== orig.key;
            return div("admin-workout-row",
              el("span", { className: "awr-date" }, w.date),
              el("span", { className: "awr-type" }, w.type || "Run"),
              w.distanceMi ? el("span", { className: "awr-dist" }, `${w.distanceMi} mi`) : null,
              el("span", { className: "awr-dur" }, secsToHMS(w.durationSec)),
              cur  ? el("span", { className: "awr-mood" }, cur.emoji) : null,
              moodChanged ? el("span", { className: "awr-mood-flag" }, `← orig: ${orig.emoji} ${orig.label}`) : null
            );
          })
        ) : null;

        return div("user-card",
          h3(u.profile.name + (u.admin ? " ⭐" : "")),
          div("stat-row",
            statBox("Age",     u.profile.age),
            statBox("Runs",    u.workouts.length),
            statBox("Zones",   u.zones?.method || "none")
          ),
          last  ? p(`Last run: ${last.date} — ${last.distanceMi ?? "?"} mi`) : p("No workouts yet."),
          pred  ? p(`📈 Predicted: ${pred.timeStr} (${pred.paceStr})`) : null,
          u.goal ? p(`🎯 Goal: ${u.goal.targetFinish} (${u.goal.targetPace}/mi)`) : null,
          u.goal?.validation ? div(`goal-status ${u.goal.validation.status}`, u.goal.validation.msg) : null,
          wFlag     ? div("flag", `⚖️ ${wFlag}`)                       : null,
          retestDue ? div("flag", "⏱ Field test overdue (4+ weeks)")   : null,
          (() => {
            const athleteGroup = adminGroups?.find(g => g.id === u.profile?.groupId);
            return athleteGroup
              ? el("span", { className: "athlete-group-tag" }, `Group: ${athleteGroup.name}`)
              : el("span", { className: "athlete-group-tag no-group" }, "No group");
          })(),
          btn(
            isExpanded ? "▲ Hide Workouts" : `▼ View Workouts (${u.workouts.length})`,
            toggleWorkouts,
            "btn-secondary btn-sm"
          ),
          workoutList,
          !u.admin ? div("card-admin-actions",
            btn("Assign Group", () => handleAssignGroup(u.userId, u.profile.name, u.profile?.groupId), "btn-secondary btn-sm"),
            btn("Change Password", () => changeAthletePassword(u.userId, u.profile.name), "btn-secondary btn-sm"),
            btn("Delete Athlete",  () => deleteAthlete(u.userId, u.profile.name),         "btn-delete")
          ) : null
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
