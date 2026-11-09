// ironman-engine.js — Ironman Training engine
// Pure functions only (no DOM, no Firebase). Loaded by the browser as window.IM
// and by node tests via require().
//
// The method: long base and strength first, intensity late. Four-week blocks
// (three build weeks, one easy week at about half the hours). One key session
// per sport per week, everything else easy. Paces come from one test per sport.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.IM = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // DATES (all UTC, ISO yyyy-mm-dd, weeks start Monday)
  // ─────────────────────────────────────────────────────────────
  const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const DAY_FULL  = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  function toDate(iso) { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); }
  function toISO(dt)   { return dt.toISOString().slice(0, 10); }
  function addDays(iso, n) { const x = toDate(iso); x.setUTCDate(x.getUTCDate() + n); return toISO(x); }
  function weekdayIdx(iso) { return (toDate(iso).getUTCDay() + 6) % 7; } // Mon=0 … Sun=6
  function mondayOf(iso) { return addDays(iso, -weekdayIdx(iso)); }
  function weeksBetween(aMon, bMon) { return Math.round((toDate(bMon) - toDate(aMon)) / (7 * 864e5)); }
  function todayISO() { const n = new Date(); return toISO(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()))); }

  // ─────────────────────────────────────────────────────────────
  // DEFAULT TIMELINE. Blank on purpose: each athlete picks their own race in setup.
  // ─────────────────────────────────────────────────────────────
  const DEFAULT_TIMELINE = {
    raceName:      "",
    raceDate:      "",
    raceDateConfirmed: false,
    registerDate:  null,
    buildStart:    null,           // blank = the engine lays out the season back from the race
    halfName:      "",
    halfDate:      null,
    backupHalf:    "",
    raceHeatF:     80              // typical warm race day; athlete can change it
  };

  // ─────────────────────────────────────────────────────────────
  // LABELS (our own names)
  // ─────────────────────────────────────────────────────────────
  const PHASES = {
    "foundation":   { label: "Foundation",     note: "Base and weight. Zone 1 only. Gym strength. Learn to swim well. No intensity." },
    "aerobic-base": { label: "Aerobic Base",   note: "Base is everything. Zone 1 only, swim drills, high cadence (95+ rpm bike, 86+ spm run)." },
    "power-base":   { label: "Power Base",     note: "Strength in the sport: low-cadence bike efforts, hill circuits, swim paddles." },
    "threshold":    { label: "Threshold",      note: "Intervals set from your tests. Long ride adds Zone 2 minutes." },
    "race-build":   { label: "Race Build",     note: "Race-specific: intervals plus more Zone 2 in the long ride and run." },
    "peak":         { label: "Peak",           note: "Two overload weeks, then taper. You will feel beat. That's the point." },
    "off":          { label: "Off",            note: "Three weeks off. One week of nothing, then short easy stuff if you're itching." }
  };
  const WEEK_TYPES = {
    "build":         "Build",
    "recovery":      "Recovery",
    "intro":         "Easy start",
    "half-race":     "Half race week",
    "overload-run":  "Overload: run",
    "overload-bike": "Overload: bike",
    "sharpen":       "Sharpen",
    "taper":         "Taper",
    "race":          "Race week",
    "off":           "Off"
  };
  // Race distances. "target" = the longest single session you need to reach in training
  // (swim yards non-stop, ride minutes, run miles), not the race itself.
  const DISTANCES = {
    sprint:  { label: "Sprint",            race: { swimYd: 820,  bikeMi: 12.4, runMi: 3.1 },  target: { swimYd: 300,  rideMin: 60,  runMi: 3 },  finishWeeks: 2, minPeakHours: 4,  longRideCap: 90,  longRunCap: 50,  raceMin: 90 },
    olympic: { label: "Olympic",           race: { swimYd: 1640, bikeMi: 24.8, runMi: 6.2 },  target: { swimYd: 1000, rideMin: 105, runMi: 6 },  finishWeeks: 3, minPeakHours: 6,  longRideCap: 150, longRunCap: 75,  raceMin: 180 },
    half:    { label: "Half Ironman 70.3", race: { swimYd: 2112, bikeMi: 56,   runMi: 13.1 }, target: { swimYd: 1650, rideMin: 180, runMi: 10 }, finishWeeks: 4, minPeakHours: 8,  longRideCap: 240, longRunCap: 120, raceMin: 360 },
    full:    { label: "Full Ironman",      race: { swimYd: 4224, bikeMi: 112,  runMi: 26.2 }, target: { swimYd: 3000, rideMin: 330, runMi: 18 }, finishWeeks: 6, minPeakHours: 11, longRideCap: 390, longRunCap: 180, raceMin: 720 }
  };
  const EASY_TYPES = new Set(["recovery", "intro", "taper", "half-race", "race", "off"]);
  const NO_INTENSITY_PHASES = new Set(["foundation", "aerobic-base"]);

  // ─────────────────────────────────────────────────────────────
  // SEASON BUILDER
  // cfg: { planStart, raceDate, halfDate?, registerDate?, buildStart?, hoursNow, hoursPeak, foundationPeakHours? }
  // ─────────────────────────────────────────────────────────────
  function buildSeason(cfg) {
    const startMon = mondayOf(cfg.planStart || todayISO());
    const raceMon  = mondayOf(cfg.raceDate);
    const R = weeksBetween(startMon, raceMon);
    if (R < 8) throw new Error("Race is less than 8 weeks out. Too close to build a full season.");

    const hoursNow  = Math.max(2, Number(cfg.hoursNow) || 5);
    const hoursPeak = Math.max(hoursNow, Number(cfg.hoursPeak) || 14);

    const distance = DISTANCES[cfg.distance] ? cfg.distance : "full";
    let H = null;
    if (cfg.halfDate && distance === "full") {
      const h = weeksBetween(startMon, mondayOf(cfg.halfDate));
      if (h >= 1 && h <= R - 8) H = h;
    }
    let B = cfg.buildStart ? weeksBetween(startMon, mondayOf(cfg.buildStart)) : 0;
    B = Math.min(Math.max(0, B), R - 8);

    // Where intensity phases start, counted back from the half (or the race if no half)
    let thresholdStart, powerStart;
    if (H != null) { thresholdStart = H - 4; powerStart = H - 12; }
    else           { thresholdStart = R - 6 - 12; powerStart = thresholdStart - 8; }
    powerStart     = Math.max(powerStart, B, 2);   // weeks 1-2 are start tests + easy base, never interval weeks
    thresholdStart = Math.max(thresholdStart, powerStart);

    const foundationEnd = Number(cfg.foundationPeakHours) ||
      Math.min(hoursNow * 1.6, Math.max(hoursNow, hoursPeak * 0.6));
    const peakIdx = R - 7;

    // Load level: ramps foundation → build → peak
    function load(i) {
      if (B > 0 && i < B) return lerp(hoursNow, foundationEnd, i / Math.max(1, B));
      const from = B > 0 ? foundationEnd : hoursNow;
      return lerp(from, hoursPeak, (i - B) / Math.max(1, peakIdx - B));
    }

    const weeks = [];
    let block = 1;
    for (let i = 0; i <= R + 3; i++) {
      let type, phase;
      const k = (R - 6) - i;               // weeks before the pre-overload recovery week
      if (i > R)            { type = "off"; }
      else if (i === R)     { type = "race"; }
      else if (i === R - 1) { type = "taper"; }
      else if (i === R - 2) { type = "sharpen"; }
      else if (i === R - 3) { type = "recovery"; }
      else if (i === R - 4) { type = "overload-bike"; }
      else if (i === R - 5) { type = "overload-run"; }
      else if (k % 4 === 0) { type = "recovery"; }  // includes R-6
      else                  { type = "build"; }

      if (H != null && i === H) type = "half-race";
      else if (H != null && i === H + 1) type = "recovery";
      if (i === 0 && type === "recovery") type = "intro";

      if (i > R) phase = "off";
      else if (i >= R - 5) phase = "peak";
      else if (i < B) phase = "foundation";
      else if (i < powerStart) phase = "aerobic-base";
      else if (i < thresholdStart) phase = "power-base";
      else if (H == null || i < H) phase = "threshold";
      else phase = "race-build";

      const L = load(Math.min(i, peakIdx));
      const pos = type === "build" ? 4 - (k % 4) : null; // 1,2,3 within the block
      let hours;
      switch (type) {
        case "build":         hours = L * [0.92, 1.0, 1.08][pos - 1]; break;
        case "recovery":      hours = L * 0.5; break;
        case "intro":         hours = L * 0.75; break;
        case "half-race":     hours = L * 0.6; break;
        case "overload-run":  hours = hoursPeak * 1.15; break;
        case "overload-bike": hours = hoursPeak * 1.2; break;
        case "sharpen":       hours = hoursPeak * 0.8; break;
        case "taper":         hours = hoursPeak * 0.55; break;
        case "race":          hours = hoursPeak * 0.3; break;
        default:              hours = 0;
      }
      hours = type === "off" ? 0 : Math.max(2, Math.round(hours * 10) / 10);

      const weekStart = addDays(startMon, i * 7);
      const weekEnd = addDays(weekStart, 6);
      const inWeek = iso => iso && iso >= weekStart && iso <= weekEnd;
      const events = [];
      if (inWeek(cfg.registerDate)) events.push({ date: cfg.registerDate, kind: "register", label: "Register for " + (cfg.raceName || "the race") });
      if (B > 0 && i === B) events.push({ date: weekStart, kind: "build", label: "Ironman build starts" });
      if (H != null && i === H) events.push({ date: cfg.halfDate, kind: "half", label: cfg.halfName || "Half Ironman" });
      if (i === R) events.push({ date: cfg.raceDate, kind: "race", label: cfg.raceName || "Race day" });

      weeks.push({
        idx: i, weekNo: i + 1, weekStart, weekEnd, type, typeLabel: WEEK_TYPES[type], distance,
        phase, phaseLabel: PHASES[phase].label, block, blockPos: pos,
        hours, strength: strengthFor(i, B, R, phase, type), events
      });
      if (type === "recovery" || type === "intro") block++;
    }
    // Tests: first build week of each block from Power Base on
    for (let i = 1; i < weeks.length; i++) {
      const w = weeks[i];
      if (w.type === "build" && w.blockPos === 1 && (w.phase === "power-base" || w.phase === "threshold" || w.phase === "race-build")) w.testWeek = true;
    }
    // Start tests: week 1 = bike + swim, week 2 = run. Checks the evaluation answers.
    weeks[0].startTests = ["bike", "swim"];
    weeks[1].startTests = ["run"];
    const realisticPeak = capRamp(weeks, hoursNow);
    return { startMon, raceIdx: R, halfIdx: H, buildIdx: B, distance, weeks, realisticPeak, hoursPeakAsked: hoursPeak };
  }

  // Safe growth: a hard week is never more than ~10% over the last hard week.
  // Easy weeks are sized off the last hard week so they stay easy after a cap.
  const RAMP = 0.10;
  const CAP_VS_LAST_HARD = { "build": 1 + RAMP, "overload-run": 1 + RAMP, "overload-bike": 1 + RAMP, "sharpen": 0.7,
                             "recovery": 0.55, "intro": 1.0, "half-race": 0.65, "taper": 0.7, "race": 0.4 };
  function capRamp(weeks, hoursNow) {
    let lastHard = hoursNow, peak = 0;
    for (const w of weeks) {
      const k = CAP_VS_LAST_HARD[w.type];
      if (k == null) continue;
      const cap = Math.max(2, Math.floor(lastHard * k * 10) / 10);
      if (w.hours > cap) { w.hours = cap; w.capped = true; }
      if (w.type === "build" || w.type === "overload-run" || w.type === "overload-bike" || w.type === "sharpen") {
        lastHard = w.hours;
        if (w.type === "build") peak = Math.max(peak, w.hours);   // overload weeks sit on top of this
      }
    }
    return peak;
  }

  function strengthFor(i, B, R, phase, type) {
    if (type === "off" || type === "race" || type === "taper" || type === "sharpen" || type === "half-race") return { phase: "none", perWeek: 0 };
    if (phase === "peak") return { phase: "hold", perWeek: 1 };
    if (type === "intro") return { phase: "adapt", perWeek: 2 };          // learn the lifts in week one
    if (type === "recovery") return { phase: "hold", perWeek: 1 };
    if (B > 0 && i < B) {
      if (i < 6)  return { phase: "adapt", perWeek: 3 };
      if (i < 12) return { phase: "max", perWeek: 2 };
      return { phase: "hold", perWeek: 1 };
    }
    const j = i - B;
    if (B === 0) {
      if (j < 6)  return { phase: "adapt", perWeek: 3 };
      if (j < 12) return { phase: "max", perWeek: 2 };
      return { phase: "hold", perWeek: 1 };
    }
    if (j < 4) return { phase: "max", perWeek: 2 };
    return { phase: "hold", perWeek: 1 };
  }

  function lerp(a, b, t) { return a + (b - a) * Math.min(1, Math.max(0, t)); }

  // ─────────────────────────────────────────────────────────────
  // PACES FROM ONE TEST PER SPORT
  // ─────────────────────────────────────────────────────────────
  function parseTime(str) {
    if (str == null || str === "") return null;
    if (typeof str === "number") return str;
    const parts = String(str).trim().split(":").map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }
  function fmtTime(sec) {
    if (sec == null || !isFinite(sec)) return "—";
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  }

  // Swim: 400 time trial. Easy = TT pace +15 s/100, Z1 = +10, Z2 = +5.
  function swimPaces(swim400Sec) {
    if (!swim400Sec) return null;
    const tt = swim400Sec / 4;
    return { tt, easy: tt + 15, z1: tt + 10, z2: tt + 5 };
  }
  // Bike: 20-minute power. Interval targets offset from it.
  function bikeTargets(p20) {
    if (!p20) return null;
    return { p20, i20: p20 - 35, i10: p20 - 20, i5: p20, i2_5: p20 + 20, ftp: Math.round(p20 * 0.95) };
  }
  // Run: 5K pace per mile. Interval targets offset from it.
  function runTargets(run5kSec) {
    if (!run5kSec) return null;
    const p = run5kSec / 3.10686;
    return { pace5k: p, rep5k: p + 30, mile: p + 10, half: p - 20, quarter: p - 40 };
  }
  function trainerMinutes(outdoorMin) { return Math.round(outdoorMin / 1.2); }

  function hrRange(z) { return z ? `${z.low}–${z.high} bpm` : "set your zones"; }
  function descendNote(z) {
    if (!z) return "Start at the low end of the zone and finish at the top.";
    const mid = Math.round((z.low + z.high) / 2);
    return `Descend: first half ${z.low}–${mid} bpm, second half ${mid}–${z.high} bpm.`;
  }

  // ─────────────────────────────────────────────────────────────
  // WEEKLY PLAN GENERATOR
  // ath: { zones, swim400Sec, p20, hasPower, run5kSec, swimAbility, hasTrainer }
  // ─────────────────────────────────────────────────────────────
  const LONG_RUN_SPLIT_MIN = 120;     // split the long run above this
  const T_RUN_CAP = 45;
  const SWIM_CAP = 70;                // weekday swims stay under the long-swim line

  function buildWeekPlan(week, ath, opts) {
    ath = ath || {};
    opts = opts || {};
    const z = ath.zones || null;
    const days = DAY_NAMES.map((name, idx) => ({ idx, name, full: DAY_FULL[idx], date: addDays(week.weekStart, idx), sessions: [] }));
    const add = (dayIdx, s) => { s.id = `${week.weekStart}-${dayIdx}-${days[dayIdx].sessions.length}`; days[dayIdx].sessions.push(s); };

    if (week.type === "off") {
      days.forEach(d => add(d.idx, session("rest", "Off", 0, "", "Rest. Nothing structured.", {})));
      return finish(week, days, opts);
    }
    if (week.type === "race" || week.type === "half-race") {
      const raceDate = (week.events.find(e => e.kind === "race" || e.kind === "half") || {}).date;
      return finish(week, raceWeek(week, days, add, raceDate, ath, z), opts);
    }

    const totalMin = Math.round(week.hours * 60);
    const strengthMin = week.strength.perWeek * 30;
    const coreMin = 15;
    const endurance = Math.max(60, totalMin - strengthMin - coreMin);

    let share = { swim: 0.18, bike: 0.52, run: 0.30 };
    if (week.phase === "foundation") share = { swim: 0.20, bike: 0.52, run: 0.28 };
    if (week.type === "overload-run")  share = { swim: 0.15, bike: 0.43, run: 0.42 };
    if (week.type === "overload-bike") share = { swim: 0.15, bike: 0.62, run: 0.23 };
    const swimMin = endurance * share.swim, bikeMin = endurance * share.bike, runMin = endurance * share.run;

    const easyWeek = EASY_TYPES.has(week.type);
    const intensityAllowed = !easyWeek && !NO_INTENSITY_PHASES.has(week.phase);
    const z2Share = easyWeek ? 0 : ({ "power-base": 0.15, "threshold": 0.30, "race-build": 0.30, "peak": 0.33 }[week.phase] || 0);

    // Bike: Tue key, Wed recovery, Sat long
    let bikeTue = round5(bikeMin * 0.25), bikeWed = round5(bikeMin * 0.15), bikeSat = round5(bikeMin * 0.60);
    if (bikeWed < 30) { bikeSat += bikeWed; bikeWed = 0; }
    if (bikeTue > 150) { bikeSat += bikeTue - 150; bikeTue = 150; }   // key ride never becomes a long ride
    bikeWed = Math.min(bikeWed, 120);
    const D = DISTANCES[week.distance] || DISTANCES.full;
    bikeSat = Math.min(bikeSat, D.longRideCap);
    // Run: Tue off-bike, Thu key, Sat off-bike, Sun long
    let runTue = round5(runMin * 0.12), runThu = round5(runMin * 0.30), runSat = round5(runMin * 0.13), runSun = round5(runMin * 0.45);
    runTue = clamp(runTue, 10, 30); runSat = clamp(runSat, 10, T_RUN_CAP);
    if (runThu > 80) { runSun += runThu - 80; runThu = 80; }          // key run never becomes a long run
    runSun = Math.min(runSun, D.longRunCap);
    // Swim: Mon recovery, Wed steady, Fri key
    let swimMon = round5(swimMin * 0.30), swimWed = round5(swimMin * 0.25), swimFri = round5(swimMin * 0.45);
    if (swimMin < 75) { swimFri = round5(swimMin * 0.55); swimMon = round5(swimMin * 0.45); swimWed = 0; }
    swimMon = Math.max(swimMon, 20); swimFri = Math.max(swimFri, 20);
    if (swimWed) swimWed = Math.max(swimWed, 20);
    // Floors so low-hour weeks still have real sessions (they may run a little over the hours)
    bikeTue = Math.max(bikeTue, 30); bikeSat = Math.max(bikeSat, 45);
    runThu = Math.max(runThu, 20); runSun = Math.max(runSun, 30, runThu + 10);
    swimMon = Math.min(swimMon, SWIM_CAP); swimWed = Math.min(swimWed, SWIM_CAP); swimFri = Math.min(swimFri, SWIM_CAP);

    const sw = swimPaces(ath.swim400Sec);
    const learning = ath.swimAbility === "learning" || ath.swimAbility === "basic";

    // ── Monday: recovery
    add(0, swimSession("recovery", swimMon, sw, learning, week));
    if (week.strength.perWeek >= 1) add(0, strengthSession(week.strength.phase));

    // ── Tuesday: key bike, then short run off the bike
    add(1, keyBike(week, bikeTue, ath, z, intensityAllowed));
    add(1, session("run", "Run off the bike", runTue, "Z1", `Straight off the bike. ${hrRange(z && z.z1)}. Short, quick steps (86+ spm).`, { brick: true }));

    // ── Wednesday: recovery
    if (bikeWed) add(2, session("bike", "Recovery ride", bikeWed, "ZR", `Easy spin, ${hrRange(z && z.bikeZr)}. 95+ rpm. ${trainerNote(bikeWed)}`, {}));
    if (swimWed) add(2, swimSession("steady", swimWed, sw, learning, week));
    if (week.strength.perWeek >= 3) add(2, strengthSession(week.strength.phase));

    // ── Thursday: key run
    add(3, keyRun(week, runThu, ath, z, intensityAllowed));
    if (week.strength.perWeek === 2) add(3, strengthSession(week.strength.phase));

    // ── Friday: key swim and core
    add(4, (week.startTests || []).includes("swim") ? swimTest(swimFri, learning) : swimSession("key", swimFri, sw, learning, week));
    add(4, session("core", "Core", coreMin, "", "15 minutes: back extensions, push-ups, sit-ups, planks. Three rounds.", {}));
    if (week.strength.perWeek >= 3) add(4, strengthSession(week.strength.phase));

    // ── Saturday: long ride with set Zone 2 minutes, then a run off the bike
    const z2Min = Math.round(bikeSat * z2Share / 5) * 5;
    add(5, session("bike", "Long ride", bikeSat, z2Min ? "Z1+Z2" : "Z1",
      `${hrRange(z && z.bikeZ1)}. ${descendNote(z && z.bikeZ1)}` +
      (z2Min ? ` Get ${z2Min} min in Zone 2 (${hrRange(z && z.bikeZ2)}): hills, or harder riding in the last hour.` : " All Zone 1.") +
      ` One 30-second surge each half hour. 90+ rpm. ${trainerNote(bikeSat)}`, { long: true, key: true, z2Min }));
    add(5, session("run", "Run off the long ride", runSat, "Z1", `${hrRange(z && z.z1)}. Find your run legs. Not long.`, { brick: true }));

    // ── Sunday: long run (split at peak)
    const runZ2 = Math.round(runSun * (z2Share * 0.6) / 5) * 5;
    const longRunDetail = `${hrRange(z && z.z1)}. ${descendNote(z && z.z1)}` +
      (runZ2 ? ` Finish with ${runZ2} min in Zone 2 (${hrRange(z && z.z2)}).` : "") +
      " Walk 30 s at each mile if you need it. Practice race fueling.";
    if (runSun > LONG_RUN_SPLIT_MIN) {
      const am = round5(runSun * 0.55), pm = runSun - am;
      add(6, session("run", "Long run, part 1 (AM)", am, runZ2 ? "Z1+Z2" : "Z1", longRunDetail + " Split run: less pounding, same total time.", { long: true, key: true, splitOf: runSun }));
      add(6, session("run", "Long run, part 2 (PM)", pm, "Z1", `${hrRange(z && z.z1)}. Second half of the split long run.`, { splitOf: runSun }));
    } else {
      add(6, session("run", "Long run", runSun, runZ2 ? "Z1+Z2" : "Z1", longRunDetail, { long: true, key: true }));
    }

    return finish(week, days, opts);
  }

  function finish(week, days, opts) {
    const totalMin = days.reduce((a, d) => a + d.sessions.reduce((b, s) => b + (s.minutes || 0), 0), 0);
    const plan = { week, days, totalMin };
    plan.violations = checkWeek(days, { week, prevDay: opts.prevDay, nextDay: opts.nextDay });
    return plan;
  }

  function round5(n) { return Math.max(0, Math.round(n / 5) * 5); }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function trainerNote(min) { return min ? `Trainer: ${trainerMinutes(min)} min (outdoor ÷ 1.2).` : ""; }

  function session(sport, title, minutes, zone, detail, flags) {
    return Object.assign({ sport, title, minutes, zone, detail, intense: false, long: false, key: false }, flags || {});
  }

  function swimSession(kind, min, sw, learning, week) {
    const z1 = sw ? `${fmtTime(sw.z1)}/100` : "easy, steady";
    const ez = sw ? `${fmtTime(sw.easy)}/100` : "very easy";
    const z2 = sw ? `${fmtTime(sw.z2)}/100` : "steady-hard";
    const yards = sw ? Math.round((min * 60) / sw.z1 * 100 / 50) * 50 : null;
    const yd = yards ? ` About ${yards} yds.` : "";
    if (learning) {
      return session("swim", kind === "key" ? "Swim skills (key)" : "Swim skills", min, "",
        "Learning block: kickboard 4×25, side-breathing drill 6×25, then 25s or 50s with as much rest as you need. A lesson or masters coach is worth more than any set. Goal: 400 yds non-stop, then take the 400 test.",
        { key: kind === "key", keySwim: kind === "key" });
    }
    if (kind === "recovery") return session("swim", "Recovery swim", min, "ZR", `Easy and continuous, ${ez}.${yd}`, {});
    if (kind === "steady")   return session("swim", "Steady swim", min, "Z1", `Long repeats (e.g. 3×500) at ${z1}, 30 s rest.${yd}`, {});
    // key
    let main;
    if (week.testWeek) main = "Test day: warm up 600, then a 400 time trial, all out, even pace. Enter the time in Tests.";
    else if (NO_INTENSITY_PHASES.has(week.phase) || EASY_TYPES.has(week.type)) main = `Drill set: 8×50 (side-kick, catch-up, fist, swim), then 6×100 at ${z1} on 15 s rest. Rest of the time steady.`;
    else if (week.phase === "power-base") main = `Paddles: 3 rounds of 3×100 paddles at ${z2} + 200 pull easy. Watch the shoulders.`;
    else main = `Main set: 400 at ${z2}, then 6×100 at ${sw ? fmtTime(sw.tt + 3) + "/100" : "hard but even"} on 15 s rest, then 8×50 fast, 20 s rest.`;
    return session("swim", "Key swim", min, "key", main + yd, { key: true, keySwim: true });
  }

  function swimTest(min, learning) {
    const d = learning
      ? "Start test: warm up easy, then swim as far as you can without stopping, up to 400 yds. Stop when you have to. Enter how far you got in Tests. No shame in 25 yds: it sets where the plan starts."
      : "Start test: warm up 600 easy, then a 400 time trial, all out, even pace. Couldn't swim the whole 400 non-stop? Enter how far you got instead. Results go in Tests.";
    return session("swim", "Swim test", min, "test", d, { key: true, keySwim: true, test: true });
  }

  function strengthSession(phase) {
    const list = "leg press, squat (hack or goblet), lat pulldown, seated row, leg extension, hamstring curl";
    if (phase === "adapt") return session("strength", "Gym: adaptation", 30, "", `3 sets each of ${list}: 20, 15, 10 reps. 90 s rest. Light enough to finish clean.`, {});
    if (phase === "max")   return session("strength", "Gym: max strength", 30, "", `Heavy: 4, 6, 8 reps of leg press, row, pulldown, squat, hamstring curl. 3 min rest. Plus back extensions, push-ups, sit-ups.`, {});
    return session("strength", "Gym: hold strength", 30, "", `One round of 8–10 reps of ${list}. Keep what you built.`, {});
  }

  function keyBike(week, min, ath, z, intensityAllowed) {
    const bt = ath.hasPower ? bikeTargets(ath.p20) : null;
    if ((week.startTests || []).includes("bike")) {
      return session("bike", "Bike test (20 min)", Math.max(min, 60), "test",
        "Start test: 20 min easy warm-up, then 20 minutes as hard as you can hold evenly (trainer is best). Power meter: note average watts. No power: note average HR and how far you got. Had to stop or back way off? Tick that in Tests. No bike yet? Skip it and do it in your first week with one.",
        { key: true, intense: true, test: true });
    }
    if (!intensityAllowed) {
      return session("bike", week.phase === "foundation" ? "Key ride (Z1)" : "Key ride (Z1 steady)", min, "Z1",
        `${hrRange(z && z.bikeZ1)}. 95+ rpm all ride. One 30-second surge each half hour. ${trainerNote(min)}`, { key: true });
    }
    let main;
    if (week.testWeek) {
      main = ath.hasPower
        ? "Test: 20 min warm-up, then 20 minutes all-out, even effort. Average power = your new 20-min number."
        : "Test: 20 min warm-up, then 20 minutes all-out on the trainer. Note average HR and speed/gear.";
    } else if (week.phase === "power-base") {
      const reps = min >= 75 ? 4 : 3;
      main = `${reps}×8 min at 55–60 rpm, best effort you can repeat every rep (same watts or same gear). 4 min easy spin at 90 rpm between.`;
    } else {
      const pos = week.blockPos || 2;
      const hard = week.type === "overload-bike" ? 3 : pos;
      if (hard === 1) main = bt ? `2×20 min at ${bt.i20} W, 5 min easy between.` : "2×20 min at the best effort you can hold for both. 5 min easy between.";
      else if (hard === 2) main = bt ? `3×10 min at ${bt.i10} W, 5 min easy between.` : "3×10 min best sustainable effort, 5 min easy between.";
      else main = bt ? `5×5 min at ${bt.i5} W, 3 min easy between. Last one all out.` : "5×5 min hard and even, 3 min easy between. Last one all out.";
      if (week.type === "sharpen") main = bt ? `3×5 min at ${bt.i5} W, 3 min easy. Stay sharp, don't dig a hole.` : "3×5 min hard and even, 3 min easy.";
    }
    return session("bike", "Key ride (intervals)", min, "key",
      `Warm up 20 min Z1. ${main} Cool down Z1. 90 rpm on the efforts. Best done on the trainer.`, { key: true, intense: true });
  }

  function keyRun(week, min, ath, z, intensityAllowed) {
    const rt = runTargets(ath.run5kSec);
    if ((week.startTests || []).includes("run")) {
      return session("run", "5K test", Math.max(min, 45), "test",
        "Start test: warm up 15 min easy, then a 5K as fast as you can hold evenly (track or flat loop). Walk breaks are fine, but tick them in Tests. Enter the time.",
        { key: true, intense: true, test: true });
    }
    if (!intensityAllowed) {
      return session("run", week.phase === "foundation" ? "Key run (Z1)" : "Key run (Z1 steady)", min, "Z1",
        `${hrRange(z && z.z1)}. Cadence drill: 30 s at 100+ spm, 1 min normal, repeat 5 times mid-run.`, { key: true });
    }
    let main;
    if (week.testWeek) main = "Test: warm up 15 min, then a 5K all-out (track or flat loop). Enter the time in Tests.";
    else if (week.phase === "power-base") main = "Hill circuit: 1 min up a 6–10% hill with a long stride and slow cadence, 3 min easy on top, quick light steps back down. 6–8 times. No hills nearby? Use a bridge or a parking garage ramp.";
    else {
      const pos = week.type === "overload-run" ? 3 : (week.blockPos || 2);
      if (week.type === "sharpen") main = rt ? `3×800 at ${fmtTime(rt.half)}/mi, 2.5 min jog.` : "3×800 hard and even, 2.5 min jog.";
      else if (pos === 1) main = rt ? `3×1 mile at ${fmtTime(rt.mile)}/mi, 3 min jog.` : "3×1 mile best even effort, 3 min jog.";
      else if (pos === 2) main = rt ? `5×800 at ${fmtTime(rt.half)}/mi, 2.5 min jog.` : "5×800 best even effort, 2.5 min jog.";
      else main = rt ? `1×2 miles at ${fmtTime(rt.rep5k)}/mi, 3 min jog, then 2×1 mile at ${fmtTime(rt.mile)}/mi, 3 min jog.` : "2 miles steady-hard, then 2×1 mile harder, 3 min jog.";
    }
    return session("run", "Key run (intervals)", min, "key", `Warm up Z1. ${main} Cool down Z1.`, { key: true, intense: true });
  }

  function raceWeek(week, days, add, raceDate, ath, z) {
    const rIdx = raceDate ? weekdayIdx(raceDate) : 5;
    const isFull = week.type === "race";
    const raceMin = isFull ? (DISTANCES[week.distance] || DISTANCES.full).raceMin : 360;
    for (let i = 0; i < 7; i++) {
      if (i === rIdx) {
        add(i, session("race", isFull ? "RACE DAY" : "HALF RACE", raceMin, "race",
          "Follow your pacing plan. Drink until you pee, then keep drinking. Pee at least twice on the bike.", { long: true, intense: true, key: true }));
      } else if (i === rIdx - 1) {
        add(i, session("bike", "Shakeout: bike + run", 30, "ZR", "20 min easy bike with 3×30 s quick, 10 min easy jog. Rack the bike. Feet up.", {}));
      } else if (i === rIdx - 2) {
        add(i, session("swim", "Short swim", 20, "ZR", "Easy 20 min, a few strokes at race pace. Otherwise rest.", {}));
      } else if (i > rIdx) {
        add(i, session("rest", "Off", 0, "", isFull ? "Done. Rest before the next thing." : "Off. Walk, eat, sleep.", {}));
      } else {
        const easy = [
          session("swim", "Easy swim", 30, "Z1", "Steady, with 4×50 at race pace.", {}),
          session("bike", "Easy ride with openers", 60, "Z1", "3×3 min at race effort (not hard), the rest Z1. 90+ rpm.", {}),
          session("run", "Easy run with strides", 30, "Z1", "4×20 s strides, the rest easy.", {}),
          session("rest", "Off", 0, "", "Rest. Pack. Lay out race nutrition.", {})
        ];
        add(i, easy[i % easy.length]);
      }
    }
    return days;
  }

  // ─────────────────────────────────────────────────────────────
  // SAFETY CHECKS (hard rules)
  // Intensity rules count bike, run and race intensity. Key swims are
  // low systemic stress and don't count toward "two intense days in a row".
  // ─────────────────────────────────────────────────────────────
  function isLongSession(s) {
    if (s.long) return true;
    if (s.sport === "race") return true;
    if (s.sport === "run" && s.minutes >= 90) return true;
    if (s.sport === "bike" && s.minutes >= 180) return true;
    if (s.sport === "swim" && s.minutes >= 75) return true;
    return false;
  }
  function isIntenseSession(s) { return !!s.intense && (s.sport === "bike" || s.sport === "run" || s.sport === "race"); }
  function dayFlags(day) {
    const ss = (day && day.sessions) || [];
    return { intense: ss.some(isIntenseSession), longCount: ss.filter(isLongSession).length, isRace: ss.some(s => s.sport === "race") };
  }

  function checkSequence(days) {
    const v = [];
    const label = d => `${d.name} ${d.date}`;
    for (let i = 0; i < days.length; i++) {
      const d = days[i], f = dayFlags(d);
      if (f.longCount > 1) v.push({ rule: "two-long-one-day", date: d.date, msg: `${label(d)}: two long workouts on one day.` });
      for (const s of d.sessions) {
        if (s.sport === "run" && s.minutes > LONG_RUN_SPLIT_MIN && !s.splitOf) v.push({ rule: "unsplit-long-run", date: d.date, msg: `${label(d)}: ${s.minutes}-min run should be split.` });
      }
      if (i === 0) continue;
      const pd = days[i - 1], pf = dayFlags(pd);
      if (pf.intense && f.intense) v.push({ rule: "intense-back-to-back", date: d.date, msg: `${label(pd)} and ${label(d)}: two intense days in a row.` });
      if (!(pf.isRace || f.isRace)) {
        if ((pf.longCount && f.intense) || (pf.intense && f.longCount)) v.push({ rule: "long-next-to-intense", date: d.date, msg: `${label(pd)} and ${label(d)}: long and intense on back-to-back days.` });
      }
    }
    return v;
  }

  function checkWeek(days, ctx) {
    ctx = ctx || {};
    const seq = [ctx.prevDay, ...days, ctx.nextDay].filter(Boolean);
    const v = checkSequence(seq);
    const week = ctx.week;
    if (week) {
      const noIntensity = EASY_TYPES.has(week.type) || NO_INTENSITY_PHASES.has(week.phase);
      if (noIntensity) {
        days.forEach(d => d.sessions.forEach(s => {
          if (isIntenseSession(s) && s.sport !== "race" && !s.test) v.push({ rule: "intensity-in-easy-week", date: d.date, msg: `${d.name} ${d.date}: intensity in a ${week.typeLabel} / ${week.phaseLabel} week.` });
        }));
      }
    }
    return v;
  }

  // Whole season, including the joins between weeks
  function buildSeasonPlans(season, ath) {
    const plans = season.weeks.map(w => buildWeekPlan(w, ath));
    const allDays = plans.flatMap(p => p.days);
    const violations = checkSequence(allDays);
    plans.forEach(p => {
      const noI = EASY_TYPES.has(p.week.type) || NO_INTENSITY_PHASES.has(p.week.phase);
      if (noI) p.days.forEach(d => d.sessions.forEach(s => { if (isIntenseSession(s) && s.sport !== "race" && !s.test) violations.push({ rule: "intensity-in-easy-week", date: d.date, msg: "intensity in easy week" }); }));
    });
    return { plans, violations };
  }

  // ─────────────────────────────────────────────────────────────
  // MISSED KEY WORKOUT → make it up at easy effort only
  // ─────────────────────────────────────────────────────────────
  function easyVersion(s) {
    return Object.assign({}, s, {
      id: s.id + "-makeup", title: "Make-up: " + s.title.replace(/\s*\(.*\)$/, ""), zone: "Z1",
      intense: false, key: false,
      detail: `Missed ${s.title}. Make it up at easy effort only: same duration, Zone 1 or recovery by feel. No intervals. Intensity on the wrong day is how people get hurt.`
    });
  }
  function moveMissed(plan, fromIdx, sessionId, toIdx) {
    const days = plan.days.map(d => Object.assign({}, d, { sessions: d.sessions.slice() }));
    const si = days[fromIdx].sessions.findIndex(s => s.id === sessionId);
    if (si < 0) throw new Error("Session not found");
    const [s] = days[fromIdx].sessions.splice(si, 1);
    days[toIdx].sessions.push(easyVersion(s));
    return { days, violations: checkWeek(days, { week: plan.week }) };
  }
  function makeUpOptions(plan, fromIdx, sessionId) {
    const out = [];
    for (let to = fromIdx + 1; to < 7; to++) {
      const r = moveMissed(plan, fromIdx, sessionId, to);
      const before = plan.violations.length;
      if (r.violations.length <= before) out.push(to);
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────
  // "FEELING BEAT" RULES
  // ─────────────────────────────────────────────────────────────
  function feelingBeat(s, canMatchLastTime) {
    if (!s) return "";
    if (s.intense || (s.key && s.zone === "key")) {
      return canMatchLastTime === false
        ? "Key day and you can't match last time: stop the efforts and spin/jog the rest easy in Zone 1. No hero stuff."
        : "Key day: start the first rep. If you can match or beat last time, keep going. If not, spin the rest easy in Zone 1.";
    }
    if (s.zone === "ZR") return "Recovery day: ride or run at the bottom of the zone, or below it. That's the job today.";
    if (s.zone && s.zone.startsWith("Z1")) return "Zone 1 day: try to get there. If you can't, decide to stay in recovery for the rest of it. That's fine.";
    return "Listen to your body. Easy is never wrong this far out.";
  }

  // ─────────────────────────────────────────────────────────────
  // RACE-DAY PACING PLAN
  // ─────────────────────────────────────────────────────────────
  // Estimate flat-course bike speed (mph) from power. Rough: CdA 0.30, Crr 0.005, hot air.
  function bikeSpeedMph(watts, riderLbs) {
    const m = (riderLbs || 180) / 2.2046 + 9, g = 9.81, crr = 0.005, cda = 0.30, rho = 1.15, eff = 0.97;
    let lo = 1, hi = 20;
    for (let i = 0; i < 60; i++) {
      const v = (lo + hi) / 2;
      const p = (crr * m * g * v + 0.5 * rho * cda * v * v * v) / eff;
      if (p > watts) hi = v; else lo = v;
    }
    return lo * 2.23694;
  }

  function racePacingPlan(o) {
    const full = o.distance !== "half";
    const z = o.zones || null;
    const heatF = o.heatF != null ? Number(o.heatF) : 85;
    const hot = heatF >= 80;
    const firstTimer = o.firstTimer !== false;

    // HR caps
    const bikeCapBase = z ? (full ? z.bikeZ1.high : Math.round((z.bikeZ2.low + z.bikeZ2.high) / 2)) : null;
    const heatAllow = hot ? 2 : 0;
    const bikeCap = bikeCapBase != null ? bikeCapBase + heatAllow : null;
    const runHR = bikeCap != null ? { low: bikeCap + 5, high: bikeCap + 8 } : null;

    // Power
    const heatPowerCut = hot ? Math.min(0.08, ((heatF - 70) / 5) * 0.015) : 0;
    let watts = null, easeIn = null, climbCap = null;
    if (o.hasPower && o.p20) {
      const ftp = o.p20 * 0.95;
      const frac = full ? (firstTimer ? 0.66 : 0.70) : (firstTimer ? 0.76 : 0.80);
      watts = Math.round(ftp * frac * (1 - heatPowerCut));
      easeIn = watts - 10;
      climbCap = Math.round(watts * 1.25);
    }

    // Run pace
    const heatSlow = heatF > 60 ? ((heatF - 60) / 5) * 0.015 : 0;
    let runPace = null, firstTwoCap = null;
    if (o.run5kSec) {
      const p5 = o.run5kSec / 3.10686;
      const mult = full ? (firstTimer ? 1.45 : 1.38) : 1.18;
      runPace = p5 * mult * (1 + heatSlow);
      firstTwoCap = runPace + 20;
    }

    // Swim
    const swimYds = full ? 4224 : 2112;
    const swimPer100 = o.swim400Sec ? o.swim400Sec / 4 + 10 : null;

    // Estimates
    const bikeMi = full ? 112 : 56, runMi = full ? 26.2 : 13.1;
    const est = {
      swim: swimPer100 ? swimPer100 * swimYds / 100 : null,
      bike: watts ? (bikeMi / bikeSpeedMph(watts, o.weightLbs)) * 3600 : null,
      run:  runPace ? runPace * runMi : null,
      transitions: full ? 13 * 60 : 8 * 60
    };
    est.total = (est.swim && est.bike && est.run) ? est.swim + est.bike + est.run + est.transitions : null;

    const lastHoldMile = full ? 23 : 11;
    const loops = o.runLoops || (full ? 3 : 2);

    const swim = [
      "Start controlled. First 200–400 yds a bit firm to find space, then settle into your rhythm.",
      swimPer100 ? `Settle near ${fmtTime(swimPer100)}/100 yds (your 400 test pace + 10 s).` : "Settle into a pace you could hold for twice the distance.",
      "Sight every 6–8 strokes. Find feet and sit on them.",
      "Light kick until the last 3 minutes, then kick more to wake the legs up."
    ];
    const bike = [
      bikeCap != null ? `Heart rate cap: ${bikeCap} bpm${heatAllow ? ` (includes +${heatAllow} for heat; that's the ceiling, not a target)` : ""}. Above it at any point: back off and let it settle.` : "Set your HR zones first. The cap comes from your bike Zone 1 top.",
      watts ? `Power: first 20 min at ${easeIn} W. Then build to ${watts} W on the flats. Bridges and overpasses: no higher than ${climbCap} W.` : "No power meter: ride by heart rate only. If HR drifts up late, ease off. Don't chase it.",
      "Ease into the day. It should feel too easy for the first hour.",
      "Cadence 90+. Into a headwind spin higher and drop a few watts. With a tailwind, cadence can drop a bit and power rise a bit.",
      "Every aid station: grab a sports drink and a water. Water goes on your head and down your back.",
      "Drink nearly nonstop from the start until you pee the first time. Then taper the fluids. You must pee at least twice on the bike.",
      "Start carbs early: about 60 g per hour is a starting point. Use what you practiced in training. Nothing new on race day."
    ];
    const run = [
      runPace ? `First 2 miles: no faster than ${fmtTime(firstTwoCap)}/mi, HR at or under ${runHR ? runHR.low : "—"} bpm. It will feel very easy. Good.` : `First 2 miles: very easy, HR at or under ${runHR ? runHR.low : "—"} bpm.`,
      runHR ? `Then run at ${runHR.low}–${runHR.high} bpm (bike cap + 5 to 8). HR above that: slow down now. It means heat is building and a shutdown is coming.` : "Then run by HR: bike cap + 5 to 8 bpm.",
      runPace ? `Settle toward ${fmtTime(runPace)}/mi. Don't go faster than that until mile ${lastHoldMile}, no matter how good you feel.` : `Hold steady until mile ${lastHoldMile}. Then race if you have it.`,
      `${loops} loops: loop 1 controlled, loop 2 hold steady, last loop race what's left.`,
      hot ? `Heat (~${heatF}°F expected): ice down the top and in the shorts, sponges, water on the head at every aid station. Walk the aid stations if you need to cool down. The heat adjustment is already in the pace above.` : "Cool yourself at every aid station anyway.",
      "Biggest dose of caffeine around halfway if you're fading mentally."
    ];
    return {
      distance: full ? "full" : "half",
      bikeCap, runHR, watts, easeIn, climbCap, runPace, firstTwoCap, swimPer100, heatF, heatAllow, heatPowerCut, heatSlow,
      est, lastHoldMile, swim, bike, run,
      disclaimer: "Times are estimates for fun. The plan is about pacing, not the clock. Weather, wind and fueling decide the rest."
    };
  }

  // ─────────────────────────────────────────────────────────────
  // POST-RACE RUN REVIEW
  // ─────────────────────────────────────────────────────────────
  function parseSplits(str) {
    if (Array.isArray(str)) return str.map(parseTime).filter(x => x);
    if (!str) return [];
    return String(str).split(/[,\s]+/).map(parseTime).filter(x => x);
  }
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

  function reviewRun(o) {
    const pace = parseSplits(o.splits);
    const hr = (o.splitHRs || []).map(Number).filter(x => x > 0);
    if (pace.length < 4) return { ok: false, msg: "Need at least 4 mile splits to review." };
    const n = pace.length, mid = Math.floor(n / 2);
    const p1 = avg(pace.slice(0, mid)), p2 = avg(pace.slice(mid));
    const fade = p2 - p1;
    const flags = [];
    let verdict;
    if (fade <= 0) verdict = { level: "good", msg: `Halves ${fmtTime(p1)} / ${fmtTime(p2)} per mile. Even or faster second half. That's the ideal.` };
    else if (fade <= 15) verdict = { level: "ok", msg: `Halves ${fmtTime(p1)} / ${fmtTime(p2)} per mile. Faded ${Math.round(fade)} s/mi. Inside the 15 s limit.` };
    else verdict = { level: "bad", msg: `Halves ${fmtTime(p1)} / ${fmtTime(p2)} per mile. Faded ${Math.round(fade)} s/mi. More than 15 s: paced or fueled wrong.` };

    const overall = avg(pace);
    const first2 = avg(pace.slice(0, 2));
    if ((o.firstTwoCapSec && first2 < o.firstTwoCapSec - 2) || first2 < overall - 15) {
      flags.push({ kind: "fast-start", msg: `Out too hard: first 2 miles averaged ${fmtTime(first2)}/mi vs ${fmtTime(overall)} overall${o.firstTwoCapSec ? ` (cap was ${fmtTime(o.firstTwoCapSec)})` : ""}.` });
    }

    let h1 = null, h2 = null;
    if (hr.length === n) {
      h1 = avg(hr.slice(0, mid)); h2 = avg(hr.slice(mid));
      const W = 3;
      let fuelFlag = null, heatFlag = null;
      for (let i = W + 2; i + W <= n; i++) {   // skip the first 2 miles: a fast start isn't a fueling problem
        const pa = avg(pace.slice(i - W, i)), pb = avg(pace.slice(i, i + W));
        const ha = avg(hr.slice(i - W, i)), hb = avg(hr.slice(i, i + W));
        if (!fuelFlag && pb - pa >= 20 && hb - ha <= -3) fuelFlag = { from: i + 1, to: i + W, dp: pb - pa, dh: hb - ha };
        if (!heatFlag && pb - pa >= 20 && hb - ha >= 3) heatFlag = { from: i + 1, to: i + W, dp: pb - pa, dh: hb - ha };
      }
      if (fuelFlag) flags.push({ kind: "fueling", msg: `Miles ${fuelFlag.from}–${fuelFlag.to}: pace slowed ${Math.round(fuelFlag.dp)} s/mi while HR dropped ${Math.round(-fuelFlag.dh)} bpm. That's fueling or stomach, not fitness. Look at how much you drank on the bike.` });
      if (heatFlag) flags.push({ kind: "heat", msg: `Miles ${heatFlag.from}–${heatFlag.to}: pace slowed ${Math.round(heatFlag.dp)} s/mi while HR rose ${Math.round(heatFlag.dh)} bpm. That's heat or fatigue: cool earlier, start slower.` });
    }
    return { ok: true, n, firstHalf: p1, secondHalf: p2, fade, hrFirstHalf: h1, hrSecondHalf: h2, verdict, flags };
  }

  // ─────────────────────────────────────────────────────────────
  // WEIGHT TREND + FUELING CHECK
  // entries: [{date, lbs}]. Rate from a least-squares line over the last 28 days.
  // ─────────────────────────────────────────────────────────────
  function weightTrend(entries, ctx) {
    ctx = ctx || {};
    const pts = (entries || []).filter(e => e && e.date && e.lbs).map(e => ({ date: e.date, lbs: Number(e.lbs) }))
      .sort((a, b) => a.date < b.date ? -1 : 1);
    if (pts.length < 2) return { points: pts, status: "none", msg: "Log your weight a few times a week to see a trend." };
    const last = pts[pts.length - 1].date;
    const recent = pts.filter(p => (toDate(last) - toDate(p.date)) / 864e5 <= 28);
    const span = (toDate(last) - toDate(recent[0].date)) / 864e5;
    if (recent.length < 2 || span < 7) return { points: pts, status: "none", msg: "Need at least a week of weigh-ins for a trend." };
    const xs = recent.map(p => (toDate(p.date) - toDate(recent[0].date)) / (7 * 864e5)), ys = recent.map(p => p.lbs);
    const mx = avg(xs), my = avg(ys);
    const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) * (x - mx), 0);
    const current = pts[pts.length - 1].lbs;
    const pct = slope / current * 100;
    const losingPhase = !ctx.phase || ctx.phase === "foundation";
    const maxLoss = losingPhase ? 1.0 : 0.5;
    let status, msg;
    if (pct < -maxLoss) {
      status = "warn";
      msg = `Losing ${Math.abs(slope).toFixed(1)} lb/week (${Math.abs(pct).toFixed(1)}% of body weight). Faster than ${maxLoss}%/week${losingPhase ? "" : " for a build phase"}. Eat more around training. Fuel the work.`;
    } else if (pct < -0.2) {
      status = "good";
      msg = losingPhase ? `Losing ${Math.abs(slope).toFixed(1)} lb/week. Right pace. Keep it steady.` : `Losing ${Math.abs(slope).toFixed(1)} lb/week. OK, but in the build hold weight steady and fuel the sessions.`;
    } else if (pct > 0.5) {
      status = "info"; msg = `Up ${slope.toFixed(1)} lb/week. Check portions on easy days.`;
    } else {
      status = losingPhase && ctx.goalWeight && current > ctx.goalWeight ? "info" : "good";
      msg = status === "info" ? `Holding steady at ${current} lbs. Goal is ${ctx.goalWeight}. Small changes, not crash diets.` : `Holding steady at ${current} lbs.`;
    }
    if (ctx.goalWeight) {
      const toGo = current - ctx.goalWeight;
      if (toGo > 0 && slope < 0) msg += ` About ${Math.ceil(toGo / Math.abs(slope))} weeks to goal at this rate.`;
    }
    return { points: pts, slopePerWeek: slope, pctPerWeek: pct, current, status, msg };
  }

  // Week index for a given date
  function weekIndexFor(season, iso) {
    const i = weeksBetween(season.startMon, mondayOf(iso));
    return Math.max(0, Math.min(season.weeks.length - 1, i));
  }

  // Seconds-per-mile compliance helper: minutes logged vs planned this week
  function weekCompliance(plan, workouts) {
    const start = plan.week.weekStart, end = plan.week.weekEnd;
    const done = (workouts || []).filter(w => w.date >= start && w.date <= end).reduce((a, w) => a + (w.durationSec || 0) / 60, 0);
    return { plannedMin: plan.totalMin, doneMin: Math.round(done), pct: plan.totalMin ? Math.round(done / plan.totalMin * 100) : 0 };
  }

  // ─────────────────────────────────────────────────────────────
  // EVALUATION → SCORE → READINESS
  // Facts, not self-ratings. answers (all optional, blanks = worst case):
  //   swimMax: 0 | 25 | 100 | 400 | 1000   longest non-stop swim today, yards
  //   openWater, swimHate: bool
  //   bikeType: "none" | road | tri | other, rideLongest: none | lt1 | 1to2 | 2to3 | 3plus (last month)
  //   runLongestMi, runsPerWeek: number, raced: none | 10k | half | marathon
  //   doctorOK: bool, injuries: text
  // Growth model: the long session in each sport grows about 10% a week (swim 25%:
  // it's mostly skill and low impact), with every 4th week a recovery week.
  // ─────────────────────────────────────────────────────────────
  const RIDE_MIN = { none: 0, lt1: 45, "1to2": 90, "2to3": 150, "3plus": 200 };
  const GROW = { swim: 0.25, bike: 0.10, run: 0.10 };
  const START = { swim: 25, bike: 30, run: 1 };          // first real session size
  const LEARN_WEEKS = { swim: 6, bike: 3, run: 4 };      // from zero to that first session

  function growWeeks(from, to, rate) {
    if (from >= to) return 0;
    return Math.ceil(Math.log(to / from) / Math.log(1 + rate) * 4 / 3);  // ×4/3 for recovery weeks
  }
  function sportWeeks(sport, now, target, a) {
    let w = 0, from = now;
    if (!from || from < START[sport]) { w += LEARN_WEEKS[sport]; from = START[sport]; }
    w += growWeeks(from, target, GROW[sport]);
    if (sport === "swim" && a.swimHate) w = Math.ceil(w * 1.15);
    if (sport === "run" && (Number(a.runsPerWeek) || 0) <= 1) w = Math.ceil(w * 1.25);
    return w;
  }
  function currentLevels(a) {
    a = a || {};
    const hasBike = a.bikeType && a.bikeType !== "none";
    return {
      swimYd:  Number(a.swimMax) || 0,
      rideMin: hasBike ? (RIDE_MIN[a.rideLongest] || 0) : 0,
      runMi:   Number(a.runLongestMi) || 0
    };
  }
  // Swim level the week plan uses, from the longest non-stop swim
  function swimAbilityFrom(swimMax) {
    const y = Number(swimMax) || 0;
    return y < 50 ? "learning" : y < 400 ? "basic" : "continuous";
  }

  function scoreSports(answers, distance) {
    const D = DISTANCES[distance] || DISTANCES.full;
    const lv = currentLevels(answers);
    const mk = (sport, now, target, raceAmt, nowAmt, unit) => {
      const weeks = sportWeeks(sport, now, target, answers || {});
      const label = weeks <= 10 ? "Ready" : weeks <= 20 ? "Building" : "Starting";
      return { sport, label, weeks, pctOfRace: Math.min(100, Math.round(nowAmt / raceAmt * 100)), now: nowAmt, race: raceAmt, unit };
    };
    return {
      swim: mk("swim", lv.swimYd, D.target.swimYd, D.race.swimYd, lv.swimYd, "yd"),
      bike: mk("bike", lv.rideMin, D.target.rideMin, D.race.bikeMi, Math.round(lv.rideMin / 60 * 15), "mi"),   // ~15 mph
      run:  mk("run",  lv.runMi,   D.target.runMi,   D.race.runMi,  lv.runMi, "mi")
    };
  }
  function weeksNeeded(answers, distance, hoursNow) {
    const D = DISTANCES[distance] || DISTANCES.full;
    const sc = scoreSports(answers, distance);
    const limiter = ["swim", "bike", "run"].reduce((m, k) => sc[k].weeks > sc[m].weeks ? k : m, "swim");
    // Weekly hours have to grow too: from what you train now to what this distance needs
    const hoursWeeks = growWeeks(Math.max(1, Number(hoursNow) || 2), D.minPeakHours, RAMP);
    const base = Math.max(sc[limiter].weeks, hoursWeeks);
    return { weeks: Math.max(8, base + D.finishWeeks), limiter: sc[limiter].weeks >= hoursWeeks ? limiter : "hours", scores: sc };
  }

  const SPORT_WORD = { swim: "swimming", bike: "riding", run: "running", hours: "weekly training time" };
  function fmtMonth(iso) { return toDate(iso).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", year: "numeric" }); }

  // tri: the saved setup (planStart, raceDate, distance, hoursNow, hoursPeak, eval: answers)
  function readiness(tri) {
    tri = tri || {};
    const a = tri.eval || {};
    const distance = DISTANCES[tri.distance] ? tri.distance : "full";
    const D = DISTANCES[distance];
    const start = mondayOf(tri.planStart || todayISO());
    const weeksOut = tri.raceDate ? weeksBetween(start, mondayOf(tri.raceDate)) : null;
    const need = weeksNeeded(a, distance, tri.hoursNow);
    const sc = need.scores;
    const reasons = [], notes = [];
    let level;
    if (weeksOut == null) level = "unknown";
    else if (weeksOut < need.weeks) level = "red";
    else if (weeksOut < need.weeks + Math.max(4, Math.round(need.weeks * 0.25))) level = "yellow";
    else level = "green";

    // Plain-words reasons
    const lv = currentLevels(a);
    if (lv.swimYd < 25) reasons.push("You can't swim a pool length non-stop yet. Swimming is a skill: it takes weeks of lessons before any distance.");
    else if (lv.swimYd < 400) reasons.push(`Longest non-stop swim is ${lv.swimYd} yds. The race swim is ${D.race.swimYd.toLocaleString()} yds.`);
    if (a.swimHate) reasons.push("You don't like swimming. That's fine, but it means more early pool time and slower progress.");
    if (!a.bikeType || a.bikeType === "none") reasons.push("No bike yet. You need one, a fit, and a few weeks of easy riding before training starts to count.");
    else if (lv.rideMin < 90) reasons.push(`Longest ride in the last month is under ${lv.rideMin ? "an hour" : "a few minutes"}. The race bike is ${D.race.bikeMi} miles.`);
    if (lv.runMi < D.target.runMi / 2) reasons.push(`Longest recent run is ${lv.runMi || 0} mi. Training needs to reach about ${D.target.runMi} mi${distance === "full" ? " (the race is 26.2)" : ""}. Runs grow about 10% a week or something gets hurt.`);
    if ((Number(a.runsPerWeek) || 0) <= 1) reasons.push("Running once a week or less: the legs need a few runs a week before long runs are safe.");
    if (weeksOut != null) reasons.unshift(`${weeksOut} weeks to race day. Getting your ${SPORT_WORD[need.limiter]} to race level safely takes about ${need.weeks}.`);

    // Hours
    let realisticPeak = null;
    if (weeksOut != null && weeksOut >= 8) {
      try { realisticPeak = buildSeason(Object.assign({}, tri, { distance })).realisticPeak; } catch (_) { /* too close */ }
    }
    const asked = Number(tri.hoursPeak) || null;
    if (asked && asked < D.minPeakHours) {
      notes.push(`${asked} hours a week is thin for a ${D.label}. Most people need about ${D.minPeakHours}+ at the peak.`);
      if (level === "green") level = "yellow";
    }
    if (realisticPeak && asked && realisticPeak < asked * 0.85) {
      notes.push(`At about 10% more a week, you safely top out near ${realisticPeak.toFixed(1)} hours a week before race day, not the ${asked} you entered.`);
      if (level === "green") level = "yellow";
    } else if (realisticPeak && level === "yellow") {
      notes.push(`Weekly hours grow about 10% at most. Realistic peak: about ${Math.min(realisticPeak, asked || realisticPeak).toFixed(1)} hours a week.`);
    }
    if (!a.doctorOK) notes.push("No doctor's OK ticked yet. Get a check-up before the hard training starts.");
    if (a.injuries) notes.push(`Injuries to watch: ${a.injuries}`);
    if (!a.openWater && distance !== "sprint") notes.push("Never swum in open water: plan a few lake or ocean swims before race day.");

    // Realistic options (stepping stones). Dates count from the plan start.
    const options = ["sprint", "olympic", "half", "full"].map(d => {
      const w = weeksNeeded(a, d, tri.hoursNow).weeks;
      const date = addDays(start, w * 7);
      return { distance: d, label: DISTANCES[d].label, weeks: w, months: Math.ceil(w / 4.35), date, month: fmtMonth(date),
               fitsRaceDate: weeksOut != null && w <= weeksOut };
    });

    const headline = {
      red: "Not safe in the time you have.",
      yellow: "Tight. Doable if the plan grows slowly.",
      green: "Enough time. Build as planned.",
      unknown: "Add a race date to check the timeline."
    }[level];
    return { level, headline, distance, distanceLabel: D.label, weeksOut, weeksNeeded: need.weeks, limiter: need.limiter,
             scores: sc, reasons, notes, options, realisticPeak, hoursPeakAsked: asked };
  }

  // ─────────────────────────────────────────────────────────────
  // TRUST BUT VERIFY: start-test results vs the evaluation answers.
  // tests: [{kind: "swim400", value: sec} | {kind: "swimShort", value: yards}
  //         | {kind: "run5k", value: sec, walked} | {kind: "p20" | "ride20", stopped}]
  // Only ever moves answers DOWN. Returns { answers, changes: [{sport, msg}] }.
  // ─────────────────────────────────────────────────────────────
  function checkTestsVsEval(answers, tests) {
    const a = Object.assign({}, answers || {});
    const changes = [];
    const latest = kind => (tests || []).filter(t => t.kind === kind).slice(-1)[0];
    const swShort = latest("swimShort"), sw400 = latest("swim400"), run = latest("run5k");
    const ride = [latest("p20"), latest("ride20")].filter(Boolean).slice(-1)[0];
    const swimNow = Number(a.swimMax) || 0;
    if (swShort && swShort.value < swimNow) {
      const y = [0, 25, 100, 400].filter(v => v <= swShort.value).pop();
      a.swimMax = y;
      changes.push({ sport: "swim", msg: `Swim: you said ${swimNow} yds non-stop, the test stopped at ${swShort.value}. Plan now starts from ${y || "learning"}${y ? " yds" : ""}.` });
    } else if (sw400 && swimNow >= 1000 && sw400.value > 15 * 60) {
      a.swimMax = 400;
      changes.push({ sport: "swim", msg: `Swim: a ${fmtTime(sw400.value)} 400 says 1,000+ non-stop is a stretch. Plan now starts from 400 yds.` });
    }
    const runNow = Number(a.runLongestMi) || 0;
    if (run && run.walked && runNow > 3.1) {
      a.runLongestMi = 2;
      changes.push({ sport: "run", msg: `Run: you said ${runNow} mi, but the 5K needed walk breaks. Plan now starts from about 2 mi.` });
    } else if (run && run.value > 40 * 60 && runNow >= 6) {
      a.runLongestMi = 3;
      changes.push({ sport: "run", msg: `Run: a ${fmtTime(run.value)} 5K doesn't match ${runNow}-mile runs yet. Plan now starts from about 3 mi.` });
    }
    const rideNow = RIDE_MIN[a.rideLongest] || 0;
    if (ride && ride.stopped && rideNow > RIDE_MIN.lt1) {
      a.rideLongest = "lt1";
      changes.push({ sport: "bike", msg: "Bike: the 20-minute test was cut short. Plan now treats your longest ride as under an hour." });
    }
    return { answers: a, changes };
  }

  // Apply the check to a saved setup: lower answers, re-ramp hours, swim level.
  // Returns a new tri (or the same one if nothing changed).
  function applyTestCheck(tri) {
    const r = checkTestsVsEval(tri.eval, tri.tests);
    if (!r.changes.length) return { tri, changes: [] };
    const before = readiness(tri);
    const nt = Object.assign({}, tri, { eval: r.answers });
    const cut = Math.pow(0.85, r.changes.length);                    // 15% less starting load per sport that came in low
    nt.hoursNow = Math.max(2, Math.round((Number(tri.hoursNow) || 4) * cut * 2) / 2);
    if (r.changes.some(c => c.sport === "swim") && !tri.swim400Sec) nt.swimAbility = swimAbilityFrom(r.answers.swimMax);
    else if (r.changes.some(c => c.sport === "swim")) nt.swimAbility = swimAbilityFrom(r.answers.swimMax) === "continuous" ? tri.swimAbility : swimAbilityFrom(r.answers.swimMax);
    const after = readiness(nt);
    nt.testCheck = { changes: r.changes, levelBefore: before.level, levelAfter: after.level,
                     msg: "Your tests say you're earlier than your answers. The plan moved." };
    return { tri: nt, changes: r.changes, before, after };
  }

  return {
    DAY_NAMES, DAY_FULL, DEFAULT_TIMELINE, PHASES, WEEK_TYPES, DISTANCES,
    readiness, scoreSports, weeksNeeded, checkTestsVsEval, applyTestCheck, swimAbilityFrom, RIDE_MIN,
    toDate, toISO, addDays, mondayOf, weekdayIdx, weeksBetween, todayISO,
    buildSeason, buildWeekPlan, buildSeasonPlans, checkWeek, checkSequence, isLongSession, isIntenseSession,
    swimPaces, bikeTargets, runTargets, trainerMinutes, parseTime, fmtTime,
    moveMissed, makeUpOptions, easyVersion, feelingBeat,
    racePacingPlan, bikeSpeedMph, reviewRun, parseSplits, weightTrend, weekIndexFor, weekCompliance,
    LONG_RUN_SPLIT_MIN
  };
});
