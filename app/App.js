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
  user:            null,
  profile:         null,
  zones:           null,
  goal:            null,
  workouts:        [],
  allUsers:        null,
  pendingRequests: [],
  pendingCount:    0,
  editingWorkout:  null,
  groupData:       null,
  adminGroups:     [],
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
    longStart: 10, longPeak: 22,
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
  const valid = workouts.filter(w => w.type !== "Walk" && w.distanceMi >= 4 && w.durationSec > 0);
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
// TRAINING PLAN ENGINE
// ═══════════════════════════════════════════════════════════════
const DAYS   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const DNAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function weeksUntil(dateStr) {
  return Math.max(0, Math.round((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24 * 7)));
}

function getPhase(weeksToRace) {
  if (weeksToRace <= 1)  return { name: "Race Week",   note: "Rest, hydrate, believe. You are ready." };
  if (weeksToRace <= 3)  return { name: "Taper",       note: "Cut volume, keep sharpness. Rest is training." };
  if (weeksToRace <= 7)  return { name: "Peak",        note: "Your hardest weeks. Trust the process. This is where it comes together." };
  if (weeksToRace <= 14) return { name: "Build",       note: "Add quality runs. Long runs grow each week. Consistency beats intensity." };
  if (weeksToRace <= 20) return { name: "Base",        note: "Easy miles. Build your aerobic engine. Nothing heroic yet." };
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

function calcWeekData(fitnessLevel, weeksIn, weeksToRace) {
  const key   = normalizeFitnessLevel(fitnessLevel);
  const level = PLAN_LEVELS[key] || PLAN_LEVELS.firstTimer;
  const phase = getPhase(weeksToRace);

  // Race week: gentle shakeout
  if (weeksToRace <= 1) {
    return { longMi: 3, easyMi: 2, midMi: 0, isCutback: false, phase, hasFartlek: false, levelKey: key, weeksToRace };
  }
  // Taper
  if (weeksToRace === 2) {
    return { longMi: roundHalf(level.longPeak * 0.55), easyMi: level.easyMiRange[0], midMi: 0, isCutback: false, phase, hasFartlek: false, levelKey: key, weeksToRace };
  }
  if (weeksToRace === 3) {
    return { longMi: roundHalf(level.longPeak * 0.75), easyMi: level.easyMiRange[0], midMi: level.midMiRange[0], isCutback: false, phase, hasFartlek: level.hasFartlek, levelKey: key, weeksToRace };
  }

  // 3:1 block progression with 10% rule
  const blockNum  = Math.floor(weeksIn / 4);
  const blockWeek = weeksIn % 4;
  const isCutback = blockWeek === 3;

  // Build weeks elapsed (cutback weeks don't count as increases)
  const buildWeeks = blockNum * 3 + Math.min(blockWeek, 2);

  let longMi;
  if (isCutback) {
    // Cutback = 72% of that block's peak (week 3 of the block)
    const blockPeak = roundHalf(Math.min(level.longStart * Math.pow(1.10, blockNum * 3 + 2), level.longPeak));
    longMi = roundHalf(blockPeak * 0.72);
  } else {
    // 10% increase per build week, capped at peak
    longMi = roundHalf(Math.min(level.longStart * Math.pow(1.10, buildWeeks), level.longPeak));
  }

  // Easy and mid miles scale proportionally with long run progress
  const progressRatio = (longMi - level.longStart) / Math.max(1, level.longPeak - level.longStart);
  const easyMi = roundHalf(lerp(level.easyMiRange[0], level.easyMiRange[1], progressRatio));
  const midMi  = roundHalf(lerp(level.midMiRange[0],  level.midMiRange[1],  progressRatio));

  return { longMi, easyMi, midMi, isCutback, phase, hasFartlek: level.hasFartlek, levelKey: key, weeksToRace };
}

function getCurrentWeekData(profile) {
  const start       = profile.trainingStart || profile.createdAt;
  const weeksIn     = Math.max(0, Math.floor((Date.now() - new Date(start)) / (7 * 24 * 60 * 60 * 1000)));
  const weeksToRace = profile.raceDate ? weeksUntil(profile.raceDate) : 99;
  return calcWeekData(profile.fitnessLevel, weeksIn, weeksToRace);
}

// ─────────────────────────────────────────────────────────────
// Long run notes — always slow and steady, never race pace finish
// ─────────────────────────────────────────────────────────────
function buildLongRunNotes(phaseName, longMi, isCutback, z1, z2) {
  const z1str = z1 ? ` (target ${z1.label})` : " (Zone 1)";
  const z2str = z2 ? ` (target ${z2.label})` : " (Zone 2)";
  if (phaseName === "Race Week") {
    return `Short shakeout — 3 mi max. Easy, easy, easy${z1str}. Just wake up the legs. No need to prove anything today.`;
  }
  if (phaseName === "Taper") {
    return `${longMi} mi — your last long run before race day. Start slow, stay slow${z1str}. Finish feeling like you could have done more. Do NOT pick up the pace at the end — save it.`;
  }
  if (isCutback) {
    return `${longMi} mi — recovery week long run. Back off the effort. Stay in Z1${z1str} the whole time. Your body is consolidating 3 weeks of training. Run relaxed and enjoy the easier day.`;
  }
  return `${longMi} mi long run. Start in Z1${z1str}, settle into Z2${z2str} by mile 2–3, and hold there. If HR drifts above Z2, slow down or walk briefly. Finish at the same pace you started — never pick it up at the end. Why: the long run builds your aerobic engine and fat-burning capacity. Slow IS the workout.`;
}

// ─────────────────────────────────────────────────────────────
// Phase × Level quality workout matrix
//
// Quality tier cap by training days:
//   3 days → "fartlek"  (Fartlek/Base only — long run IS the hard day)
//   4 days → "tempo"    (Tempo / Race Pace OK, Yasso 800s held back)
//   5 days → "full"     (complete progression, Yasso unlocked)
// ─────────────────────────────────────────────────────────────
function getQualityWorkout(phaseName, levelKey, weekData, zones, goal, weeksToRace, trainingDays) {
  const { easyMi, midMi, isCutback } = weekData;
  const z1 = zones?.z1 ? zoneTargetBpm(zones.z1) : null;
  const z2 = zones?.z2 ? zoneTargetBpm(zones.z2) : null;
  const z3 = zones?.z3 ? zoneTargetBpm(zones.z3) : null;
  const z1str = z1 ? ` (target ${z1.label})` : " (Zone 1)";
  const z2str = z2 ? ` (target ${z2.label})` : " (Zone 2)";
  const z3str = z3 ? ` (target ${z3.label})` : " (Zone 3)";
  const qMi = Math.max(easyMi, midMi || easyMi);
  const days = trainingDays || 4;
  // capFartlek = 3-day runners: only easy/fartlek-level work (long run is the hard effort)
  // capTempo   = 4-day runners: tempo and race pace OK, Yasso 800s held back
  const capFartlek = days <= 3;
  const capTempo   = days === 4;

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
function buildFlexibleWeekPlan(longRunDay, trainingDays, weekData, zones, goal) {
  const { longMi, easyMi, isCutback, phase, levelKey, weeksToRace } = weekData;
  const days      = trainingDays || 4;
  const phaseName = phase?.name || "Foundation";

  const z1 = zones?.z1 ? zoneTargetBpm(zones.z1) : null;
  const z2 = zones?.z2 ? zoneTargetBpm(zones.z2) : null;
  const z1str = z1 ? ` (target ${z1.label})` : " (Zone 1)";
  const z2str = z2 ? ` (target ${z2.label})` : " (Zone 2)";

  const slot = (offset) => (longRunDay + offset) % 7;

  // Base array — all rest
  const plan = DAYS.map((d, i) => ({
    idx: i, day: d, type: "Rest", zone: null,
    notes: "Full rest or a gentle 20-min walk. Recovery is where adaptation happens — this day is as important as any run.",
    duration: "", miles: 0
  }));

  // +0 Long Run
  plan[slot(0)] = {
    idx: slot(0), day: DAYS[slot(0)], type: "Long Run", zone: isCutback ? "Z1" : "Z1→Z2",
    notes: buildLongRunNotes(phaseName, longMi, isCutback, z1, z2),
    duration: `${longMi} mi`, miles: longMi
  };

  // +1 Cross-Train
  plan[slot(1)] = {
    idx: slot(1), day: DAYS[slot(1)], type: "Cross-Train", zone: "Z1",
    notes: `Easy bike, swim, yoga, or walk${z1str}. Move without pounding — your legs are still recovering from yesterday's long run. 30–45 min is plenty. Why: active recovery flushes soreness and drives blood to repair muscle without adding impact stress.`,
    duration: "30–45 min", miles: 0
  };

  // +2 Rest
  plan[slot(2)] = {
    idx: slot(2), day: DAYS[slot(2)], type: "Rest", zone: null,
    notes: "Rest day. You ran long two days ago and still absorbing it. Sleep, eat well, and hydrate. Foam roll if you have time.",
    duration: "", miles: 0
  };

  // +3 Quality Run (intensity scales with training days)
  const quality = getQualityWorkout(phaseName, levelKey || "firstTimer", weekData, zones, goal, weeksToRace ?? 99, days);
  plan[slot(3)] = { idx: slot(3), day: DAYS[slot(3)], ...quality };

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
    duration: "", miles: 0
  };

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
    case "setup-prefs":    return SetupPrefs();
    case "setup-goal":     return SetupGoal();
    case "update-plan":    return UpdatePlanPage();
    case "edit-profile":   return EditProfile();
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
        const [data, pendingSnap] = await Promise.race([
          Promise.all([
            loadUserData(ADMIN.id),
            db.collection("signupRequests").where("status", "==", "pending").get()
          ]),
          timeout
        ]);
        const pendingCount = pendingSnap.size || 0;
        setState({ user: ADMIN, ...data, pendingCount, loading: false, error: null, view: data.profile ? "dashboard" : "setup-profile" });
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
      const groupData = data.profile?.groupId ? await loadGroupData(data.profile.groupId, doc.id) : null;
      setState({ user, ...data, groupData, loading: false, error: null, view: data.profile ? "dashboard" : "setup-profile" });
    } catch (err) {
      setState({ loading: false, error: "Could not connect to Firebase: " + err.message });
    }
  };

  const pwInput = input({ id: "pw", type: "password", placeholder: "Enter your password" });
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
      div("field", pwInput),
      signInBtn,
      div("link-row",
        btn("Request Access",  () => setState({ view: "request-access",  error: null }), "btn-link"),
        btn("Forgot password", () => setState({ view: "forgot-password", error: null }), "btn-link")
      )
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
  const today = new Date().toISOString().split("T")[0];
  const save = async () => {
    const raceDate      = document.getElementById("p-race")?.value;
    const trainingStart = document.getElementById("p-start")?.value;
    const fitnessLevel  = document.getElementById("p-level")?.value;
    const longRunDay    = parseInt(document.getElementById("p-lrd")?.value);
    const trainingDays  = parseInt(document.getElementById("p-days")?.value);
    if (!raceDate)                        { showError("Please enter your race date."); return; }
    if (new Date(raceDate) <= new Date()) { showError("Race date must be in the future."); return; }
    if (!trainingStart)                   { showError("Please enter your training start date."); return; }
    if (!fitnessLevel)                    { showError("Please select your current fitness level."); return; }
    const prefs = { raceDate, trainingStart, fitnessLevel, longRunDay, trainingDays };
    setState({ loading: true });
    await saveData("profile", { ...state.profile, ...prefs });
    setState({ profile: { ...state.profile, ...prefs }, loading: false, view: "setup-goal", error: null });
  };

  return div("page",
    div("setup-page",
      div("step-indicator", "Step 3 of 4 — Training Plan"),
      h2("Build your training plan"),
      errorBanner(),
      field("Race Date *", input({ id: "p-race", type: "date", min: today })),
      field("Training Start Date *", input({ id: "p-start", type: "date", value: today })),
      field("Current Fitness Level *", select("p-level", [
        ["Select your level…", ""],
        ...Object.entries(PLAN_LEVELS).map(([k, v]) => [v.label, k])
      ], "")),
      field("Long Run Day", select("p-lrd", DNAMES.map((d, i) => [d, i]), 6)),
      field("Training Days Per Week", select("p-days", [[3,3],[4,4],[5,5],[6,6]].map(([l,v]) => [`${l} days`, v]), 4)),
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

    // Recalculate zones if age or resting HR changed
    let updatedZones = state.zones;
    if (state.zones && (age !== profile.age || restingHR !== profile.restingHR)) {
      const maxHR = state.zones.method === "tested" ? state.zones.maxHR : estimateMaxHR(age);
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
    zoneBar(zones.z1, "z1"), zoneBar(zones.z2, "z2"), zoneBar(zones.z3, "z3"),
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

  const trackCard = div("card",
    h2("Training"),
    div("menu",
      btn("Log a Workout",          () => setState({ view: "log-workout" })),
      btn("View Workout History",   () => setState({ view: "history" })),
      btn("View Full Training Plan",() => setState({ view: "plan" })),
      btn("Update Fitness Level / Rebuild Plan", () => setState({ view: "update-plan" }), "btn-secondary"),
      btn("Edit Profile & Plan Settings", () => setState({ view: "edit-profile" }), "btn-secondary")
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
// LOG WORKOUT
// ═══════════════════════════════════════════════════════════════
const WORKOUT_TYPES = [
  "Run",
  "Walk",
  "Easy Bike / Swim",
  "Yoga / Stretch",
  "Strength",
  "Other"
];
const RUNNING_TYPES = new Set(["Run"]);

function LogWorkout() {
  const editing = state.editingWorkout;
  const backDest = editing ? "history" : "dashboard";
  let selectedMood = editing?.mood || null;

  const save = async () => {
    const date       = document.getElementById("w-date")?.value;
    const type       = document.getElementById("w-type")?.value || "Run";
    const distanceMi = parseFloat(document.getElementById("w-dist")?.value) || null;
    const durStr     = document.getElementById("w-dur")?.value.trim();
    const avgHR      = parseInt(document.getElementById("w-hr")?.value) || null;
    const paceInput  = document.getElementById("w-pace")?.value.trim();
    const notes      = document.getElementById("w-notes")?.value.trim();
    const weightLbs  = parseFloat(document.getElementById("w-weight")?.value) || null;

    const isRun = RUNNING_TYPES.has(type);

    if (!date)                                     { showError("Please enter the date."); return; }
    if (isRun && (!distanceMi || distanceMi <= 0)) { showError("Please enter a valid distance."); return; }
    if (!durStr)                                   { showError("Please enter the duration."); return; }
    if (!selectedMood)                             { showError("Please select how you felt about this workout."); return; }
    const durationSec = parseDuration(durStr);
    if (!durationSec) { showError("Enter duration as M:SS (e.g. 54:30) or H:MM:SS (e.g. 1:32:00)."); return; }

    let workout = {
      date, type, durationSec, avgHR: avgHR || null, notes: notes || "", weightLbs,
      mood: selectedMood,
      moodOriginal: editing ? (editing.moodOriginal || selectedMood) : selectedMood
    };

    if (isRun && distanceMi) {
      const pace = paceInput || calcPaceStr(durationSec, distanceMi);
      const predictedFinishSec = riegelPredict(durationSec, distanceMi, MARATHON_MI);
      Object.assign(workout, { distanceMi, pace, predictedFinishSec, predictedFinishStr: secsToHMS(predictedFinishSec), predictedPaceStr: predictedPace(predictedFinishSec) + "/mi" });
    } else if (distanceMi) {
      Object.assign(workout, { distanceMi });
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

  // Mood picker
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

  // Duration pre-fill
  const durDefault = editing?.durationSec ? secsToHMS(editing.durationSec) : "";

  // Type select with reactive show/hide
  const initType = editing?.type || "Run";
  const typeSelect = select("w-type", WORKOUT_TYPES.map(t => [t, t]), initType);
  const distRow  = field("Distance (miles)", input({ id: "w-dist", type: "number", placeholder: "e.g. 6.2", step: "0.01", min: "0.1", value: editing?.distanceMi || "" }));
  const paceRow  = field("Pace per mile (M:SS, optional)", input({ id: "w-pace", type: "text", placeholder: "e.g. 9:26 — calculated if blank", value: editing?.pace || "" }));

  distRow.style.display = "";
  paceRow.style.display = RUNNING_TYPES.has(initType) ? "" : "none";
  typeSelect.addEventListener("change", () => {
    const isRun = RUNNING_TYPES.has(typeSelect.value);
    distRow.style.display = "";
    paceRow.style.display = isRun ? "" : "none";
  });

  const title  = editing ? "Edit Workout" : "Log a Workout";
  const saveLbl = editing ? "Update Workout" : "Save Workout";

  return div("page",
    div("card",
      pageHeader(title, () => setState({ editingWorkout: null, view: backDest })),
      editing ? div("banner banner-info", `Editing workout from ${editing.date} — changes replace the original.`) : null,
      errorBanner(),
      field("Date *", input({ id: "w-date", type: "date", value: editing?.date || new Date().toISOString().split("T")[0] })),
      field("Activity type *", typeSelect),
      distRow,
      field("Duration * (M:SS or H:MM:SS)", input({ id: "w-dur", type: "text", placeholder: "e.g. 58:30 or 1:02:45", value: durDefault })),
      field("Average HR (bpm, optional)", input({ id: "w-hr", type: "number", placeholder: "e.g. 142", min: "60", max: "220", value: editing?.avgHR || "" })),
      paceRow,
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
                el("span", { className: "workout-type-tag" }, w.type || "Run"),
                el("span", { className: "workout-dist" },
                  w.distanceMi ? `${w.distanceMi} mi — ${secsToHMS(w.durationSec)}` : secsToHMS(w.durationSec)
                ),
                btn("Edit", () => setState({ editingWorkout: w, view: "log-workout" }), "btn-edit-workout")
              ),
              div("workout-details",
                w.pace      ? span("⏱ ", w.pace, "/mi")        : null,
                w.avgHR     ? span("♥ ", w.avgHR, " bpm")      : null,
                w.weightLbs ? span("⚖️ ", w.weightLbs, " lbs") : null,
                w.predictedFinishStr ? span("📈 ", w.predictedFinishStr) : null
              ),
              workoutMoodTag(w, false),
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
    const wd = calcWeekData(profile.fitnessLevel, w, totalWeeks - w);
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
  const startDate    = new Date(profile.trainingStart || profile.createdAt);

  const weeks = Array.from({ length: totalWeeks }, (_, w) => {
    const wd      = calcWeekData(profile.fitnessLevel, w, totalWeeks - w);
    const plan    = buildFlexibleWeekPlan(longRunDay, trainingDays, wd, state.zones, state.goal);
    const weekStart = new Date(startDate);
    weekStart.setDate(weekStart.getDate() + w * 7);
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
      `https://mytrendscout.github.io/hr-zone-tracker/\n\n` +
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
