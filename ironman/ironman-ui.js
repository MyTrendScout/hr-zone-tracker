// ironman-ui.js — Ironman Training screens (Ironman mode), built on App.js helpers.
// Loaded after App.js. Uses: state, setState, el, div, h2, h3, p, btn, field, input,
// select, statBox, zoneBar, errorBanner, showError, db, hashPassword, loadCommandCenter.

(function () {
  "use strict";
  const X = window.IM;
  const PHASE_COLORS = {
    "foundation": "#7fa7d4", "aerobic-base": "#2f6fbf", "power-base": "#d99a2b",
    "threshold": "#d9622b", "race-build": "#b23a12", "peak": "#6d3fc9", "off": "#9aa3ad"
  };
  const SPORT_ICON = { swim: "🏊", bike: "🚴", run: "🏃", strength: "🏋️", core: "🧱", race: "🏁", rest: "·" };

  // ─────────────────────────────────────────────────────────────
  // CONTEXT: who are we looking at (me, or an athlete the coach opened)
  // ─────────────────────────────────────────────────────────────
  function subject() {
    if (state.coachAthlete && state.user && state.user.admin) return state.coachAthlete;
    return { userId: state.user.id, name: state.profile?.name || state.user.name, profile: state.profile || {},
             zones: state.zones, workouts: state.workouts || [], weights: state.weights || [], self: true };
  }
  function athleteOf(sub) {
    const t = sub.profile?.tri || {};
    return { zones: sub.zones && sub.zones.z1 ? sub.zones : null, swim400Sec: t.swim400Sec || null, p20: t.p20 || null,
             hasPower: !!t.hasPower, run5kSec: t.run5kSec || null, swimAbility: t.swimAbility || "continuous" };
  }
  function seasonOf(sub) {
    const t = sub.profile?.tri;
    if (!t) return null;
    try { return X.buildSeason(t); } catch (e) { return { error: e.message }; }
  }
  function nowIdx(season) { return X.weekIndexFor(season, X.todayISO()); }
  function planFor(season, i, sub) {
    const ath = athleteOf(sub), w = season.weeks[i];
    const prevDay = i > 0 ? X.buildWeekPlan(season.weeks[i - 1], ath).days[6] : null;
    const nextDay = i < season.weeks.length - 1 ? X.buildWeekPlan(season.weeks[i + 1], ath).days[0] : null;
    let plan = X.buildWeekPlan(w, ath, { prevDay, nextDay });
    const moves = ((sub.profile.tri || {}).moves || {})[w.weekStart] || [];
    for (const m of moves) {
      try {
        const r = X.moveMissed(plan, m.from, m.id, m.to);
        plan = Object.assign({}, plan, { days: r.days, violations: X.checkWeek(r.days, { week: w, prevDay, nextDay }) });
      } catch (_) { /* session no longer exists after a plan change */ }
    }
    return plan;
  }
  async function saveTri(sub, tri, extra) {
    const upd = Object.assign({ tri }, extra || {});
    await db.collection("users").doc(sub.userId).collection("data").doc("profile").set(upd, { merge: true });
    const profile = Object.assign({}, sub.profile, upd);
    if (sub.self) state.profile = profile;
    else state.coachAthlete = Object.assign({}, state.coachAthlete, { profile });
    if (state.allUsers) state.allUsers = state.allUsers.map(u => u.userId === sub.userId ? Object.assign({}, u, { profile }) : u);
  }
  function back() {
    if (state.coachAthlete) setState({ coachAthlete: null, view: "command", error: null });
    else setState({ view: "dashboard", error: null });
  }
  function header(title, sub) {
    return el("header", null,
      div("im-head",
        h1x(title),
        sub && !sub.self ? el("span", { className: "im-coach-tag" }, `Coach view: ${sub.name}`) : null),
      btn("← Back", back, "btn-back"));
  }
  function h1x(t) { return el("h1", null, t); }
  const fmtDate = (iso, opts) => X.toDate(iso).toLocaleDateString("en-US", Object.assign({ timeZone: "UTC", month: "short", day: "numeric" }, opts || {}));
  const hrs = min => (min / 60).toFixed(1);
  const val = id => (document.getElementById(id)?.value || "").trim();
  const num = id => { const v = parseFloat(val(id)); return isNaN(v) ? null : v; };

  function weightEntries(sub) {
    const map = {};
    (sub.workouts || []).forEach(w => { if (w.weightLbs) map[w.date] = w.weightLbs; });
    (sub.weights || []).forEach(w => { map[w.date] = w.lbs; });
    return Object.entries(map).map(([date, lbs]) => ({ date, lbs }));
  }

  // ─────────────────────────────────────────────────────────────
  // ONBOARDING / EDIT: Ironman setup
  // ─────────────────────────────────────────────────────────────
  function SetupTri() {
    const sub = subject();
    const D = X.DEFAULT_TIMELINE;
    const t = Object.assign({}, D, { planStart: X.todayISO(), distance: "full", hoursNow: "", hoursPeak: "", hasPower: false, hasTrainer: false, gymAccess: true, firstTimer: true }, sub.profile?.tri || {});
    const ev = t.eval || {};
    const editing = !!sub.profile?.tri;
    const prof = sub.profile || {};
    const yn = (id, v) => select(id, [["Yes", "yes"], ["No", "no"]], v ? "yes" : "no");
    const ynBlank = (id, v) => select(id, [["Select…", ""], ["Yes", "yes"], ["No", "no"]], v === true ? "yes" : v === false ? "no" : "");
    const askBody = !prof.age || !prof.restingHR;   // athletes give these in step 1; coach-made setups may not have them

    const save = async () => {
      const tri = Object.assign({}, sub.profile?.tri || {}, {
        raceName: val("t-race-name"),
        raceDate: val("t-race-date"),
        raceDateConfirmed: val("t-race-conf") === "yes",
        registerDate: val("t-reg") || null,
        buildStart: val("t-build") || null,
        halfName: val("t-half-name") || null,
        halfDate: val("t-half-date") || null,
        backupHalf: D.backupHalf,
        planStart: val("t-start") || X.todayISO(),
        hoursNow: num("t-hrs-now"),
        hoursPeak: num("t-hrs-peak"),
        swim400Sec: X.parseTime(val("t-swim400")),
        hasPower: val("t-power") === "yes",
        p20: num("t-p20"),
        hasTrainer: val("t-trainer") === "yes",
        bikeType: val("t-bike"),
        run5kSec: X.parseTime(val("t-5k")),
        watch: val("t-watch"),
        hrStrap: val("t-strap") === "yes",
        gymAccess: val("t-gym") === "yes",
        goalWeight: num("t-goal-wt"),
        firstTimer: val("t-first") === "yes",
        raceHeatF: num("t-heat") || D.raceHeatF,
        notes: val("t-notes"),
        distance: val("t-dist") || "full"
      });
      const yes = id => val(id) === "yes" ? true : val(id) === "no" ? false : null;
      tri.eval = Object.assign({}, ev, {
        swimMax: val("e-swim-max") === "" ? null : Number(val("e-swim-max")),
        openWater: yes("e-ow"),
        swimHate: val("e-swim-like") === "hate",
        swimLike: val("e-swim-like"),
        bikeType: tri.bikeType,
        rideLongest: val("e-ride"),
        runLongestMi: num("e-run-mi"),
        runsPerWeek: num("e-run-wk"),
        raced: val("e-raced"),
        doctorOK: val("e-doc") === "yes",
        injuries: tri.notes || ""
      }, askBody ? { age: num("e-age"), restingHR: num("e-rhr"), heightIn: num("e-ht") } : {});
      tri.swimAbility = tri.swim400Sec ? (t.swimAbility === "learning" || t.swimAbility === "basic" ? "continuous" : (t.swimAbility || "continuous")) : X.swimAbilityFrom(tri.eval.swimMax);
      delete tri.testCheck;   // fresh answers: the old "plan moved" note no longer applies
      const curWt = num("t-cur-wt");
      if (!tri.raceName) return showError("What race are you doing? Type its name.");
      if (!curWt || curWt < 70 || curWt > 500) return showError("Enter your current weight in pounds.");
      if (!tri.raceDate) return showError("Race date is required. A best guess is fine; you can change it later.");
      if (tri.eval.swimMax == null) return showError("Pick your longest non-stop swim. Be honest: it sets where the swim plan starts.");
      if (!tri.eval.rideLongest) return showError("Pick your longest ride in the last month (\"none\" is a fine answer).");
      if (tri.eval.runLongestMi == null || tri.eval.runsPerWeek == null) return showError("Fill in your longest run and runs per week (0 is a fine answer).");
      if (!tri.hoursNow || !tri.hoursPeak) return showError("Fill in both hour fields.");
      if (tri.hoursPeak < tri.hoursNow) return showError("Peak hours should be at least what you train now.");
      if (tri.hoursPeak > 25) return showError("Peak over 25 hours a week is pro territory. Pick something real.");
      try { X.buildSeason(tri); } catch (e) { return showError(e.message); }
      setState({ loading: true });
      try {
        await saveTri(sub, tri, { weight: curWt });
        state.loading = false;
        setState({ view: sub.self ? "readiness" : "coach-readiness", error: null });
      } catch (e) { setState({ loading: false, error: "Could not save: " + e.message }); }
    };

    return div("page",
      div("setup-page",
        sub.self && !editing ? div("step-indicator", "Step 3 of 3 — Ironman setup") : header(editing ? "Ironman setup" : `Set up ${sub.name}`, sub),
        h2(sub.self ? "Your Ironman season" : `${sub.name}'s Ironman season`),
        p("Everything here can change later. Unknown? Leave it blank. The plan works from what it has, and tests fill in the rest."),
        errorBanner(),
        el("h3", { className: "im-form-h" }, "Timeline"),
        div("field-row",
          field("What race are you doing? *", input({ id: "t-race-name", type: "text", placeholder: "e.g. IRONMAN Florida", value: t.raceName || "" })),
          field("Distance", select("t-dist", [["Full Ironman (140.6)", "full"], ["Half Ironman (70.3)", "half"], ["Olympic", "olympic"], ["Sprint", "sprint"]], t.distance || "full"))),
        div("field-row",
          field("Race date *", input({ id: "t-race-date", type: "date", value: t.raceDate || "" })),
          field("Date confirmed?", select("t-race-conf", [["Not yet (guess)", "no"], ["Confirmed", "yes"]], t.raceDateConfirmed ? "yes" : "no"))),
        div("field-row",
          field("Register on (approx.)", input({ id: "t-reg", type: "date", value: t.registerDate || "" })),
          field("Ironman build starts", input({ id: "t-build", type: "date", value: t.buildStart || "" }))),
        p("Before the build: Foundation (base and weight loss). Zone 1 only."),
        div("field-row",
          field("Tune-up half Ironman (optional, about 5 months before)", input({ id: "t-half-name", type: "text", placeholder: "e.g. IRONMAN 70.3 Florida", value: t.halfName || "" })),
          field("Half date", input({ id: "t-half-date", type: "date", value: t.halfDate || "" }))),
        div("field-row",
          field("Plan starts", input({ id: "t-start", type: "date", value: t.planStart })),
          field("Race-day heat (°F)", input({ id: "t-heat", type: "number", value: t.raceHeatF || 80 }))),

        el("h3", { className: "im-form-h" }, "Where you are today"),
        el("p", { className: "im-note" }, "Facts, not feelings. What you actually did, not what you think you could do. Weeks 1 and 2 of the plan test these answers."),
        el("h3", { className: "im-form-h" }, "Swim"),
        field("Longest you can swim non-stop today *", select("e-swim-max", [
          ["Select…", ""], ["Can't swim a pool length yet", "0"], ["About 25 yards (one length)", "25"], ["About 100 yards", "100"],
          ["About 400 yards", "400"], ["1,000 yards or more", "1000"]], ev.swimMax == null ? "" : String(ev.swimMax))),
        div("field-row",
          field("Ever swum in open water (lake, ocean)?", ynBlank("e-ow", ev.openWater)),
          field("Do you like swimming?", select("e-swim-like", [["Select…", ""], ["Like it", "like"], ["It's OK", "ok"], ["Hate it (fine, just tell us)", "hate"]], ev.swimLike || (ev.swimHate ? "hate" : "")))),
        field("400-yard time trial (M:SS, blank if not done)", input({ id: "t-swim400", type: "text", placeholder: "e.g. 8:30", value: t.swim400Sec ? X.fmtTime(t.swim400Sec) : "" })),

        el("h3", { className: "im-form-h" }, "Bike"),
        div("field-row",
          field("Bike you own and ride", select("t-bike", [["No bike yet", "none"], ["Road bike", "road"], ["Tri bike", "tri"], ["Other", "other"]], t.bikeType || "none")),
          field("Longest ride in the last month *", select("e-ride", [["Select…", ""], ["None", "none"], ["Under 1 hour", "lt1"], ["1 to 2 hours", "1to2"], ["2 to 3 hours", "2to3"], ["3+ hours", "3plus"]], ev.rideLongest || ""))),
        div("field-row",
          field("Indoor trainer?", yn("t-trainer", t.hasTrainer)),
          field("Power meter?", yn("t-power", t.hasPower))),
        field("20-min power (watts, blank if none)", input({ id: "t-p20", type: "number", value: t.p20 || "" })),

        el("h3", { className: "im-form-h" }, "Run"),
        div("field-row",
          field("Longest run in the last month (miles) *", input({ id: "e-run-mi", type: "number", step: "0.5", min: "0", placeholder: "e.g. 4", value: ev.runLongestMi ?? "" })),
          field("Runs per week, lately *", input({ id: "e-run-wk", type: "number", min: "0", max: "14", placeholder: "e.g. 3", value: ev.runsPerWeek ?? "" }))),
        div("field-row",
          field("Ever raced a 10K, half or marathon?", select("e-raced", [["None of those", "none"], ["10K", "10k"], ["Half marathon", "half"], ["Marathon", "marathon"]], ev.raced || "none")),
          field("Recent 5K time (blank if unknown)", input({ id: "t-5k", type: "text", placeholder: "e.g. 27:30", value: t.run5kSec ? X.fmtTime(t.run5kSec) : "" }))),

        el("h3", { className: "im-form-h" }, "Time"),
        div("field-row",
          field("Hours a week you train now *", input({ id: "t-hrs-now", type: "number", step: "0.5", min: "1", max: "25", placeholder: "e.g. 4", value: t.hoursNow ?? "" })),
          field("Real hours a week you can give (at most) *", input({ id: "t-hrs-peak", type: "number", step: "0.5", min: "4", max: "25", placeholder: "e.g. 14", value: t.hoursPeak ?? "" }))),

        el("h3", { className: "im-form-h" }, "Gear, body, history"),
        div("field-row",
          field("Watch", select("t-watch", [["None", "none"], ["Garmin", "garmin"], ["Apple Watch", "apple"], ["COROS", "coros"], ["Polar", "polar"], ["Wahoo", "wahoo"], ["Other", "other"]], t.watch || "none")),
          field("Chest HR strap?", yn("t-strap", t.hrStrap))),
        div("field-row",
          field("Current weight (lbs) *", input({ id: "t-cur-wt", type: "number", step: "0.1", placeholder: "e.g. 228", value: sub.profile?.weight || "" })),
          field("Goal weight (lbs, optional)", input({ id: "t-goal-wt", type: "number", step: "0.5", value: t.goalWeight || "" }))),
        askBody ? div("field-row",
          field("Age", input({ id: "e-age", type: "number", min: "14", max: "90", value: ev.age || prof.age || "" })),
          field("Height (inches)", input({ id: "e-ht", type: "number", min: "48", max: "90", placeholder: "e.g. 70", value: ev.heightIn || "" })),
          field("Resting HR (bpm)", input({ id: "e-rhr", type: "number", min: "35", max: "100", value: ev.restingHR || prof.restingHR || "" }))) : null,
        div("field-row",
          field("Gym access?", yn("t-gym", t.gymAccess)),
          field("First Ironman?", yn("t-first", t.firstTimer !== false))),
        field("Injuries, now or past, or anything the coach should know", input({ id: "t-notes", type: "text", value: t.notes || "" })),
        field("Doctor's OK to train hard?", select("e-doc", [["Not yet", "no"], ["Yes, I've had a check-up", "yes"]], ev.doctorOK ? "yes" : "no")),
        btn(editing ? "Save setup" : "Build my season →", save)
      ));
  }

  // ─────────────────────────────────────────────────────────────
  // READINESS: setup result, dashboard card, coach card
  // ─────────────────────────────────────────────────────────────
  const LEVEL = { red: { dot: "🔴", cls: "im-rd-red", word: "Red" }, yellow: { dot: "🟡", cls: "im-rd-yellow", word: "Yellow" },
                  green: { dot: "🟢", cls: "im-rd-green", word: "Green" }, unknown: { dot: "⚪", cls: "", word: "No date" } };
  function readinessOf(sub) { const t = sub.profile?.tri; return t && t.eval ? X.readiness(t) : null; }

  async function switchRace(sub, opt) {
    const t = sub.profile.tri;
    const nt = Object.assign({}, t, { distance: opt.distance, raceDate: opt.date, raceDateConfirmed: false,
      raceName: `${opt.label} (pick one near ${opt.month})`, halfName: null, halfDate: null, previousRace: { name: t.raceName, date: t.raceDate, distance: t.distance || "full" } });
    setState({ loading: true });
    await saveTri(sub, nt);
    setState({ loading: false, error: null });
  }

  function readinessCard(sub, opts) {
    opts = opts || {};
    const r = readinessOf(sub);
    const t = sub.profile?.tri || {};
    if (!r) return opts.compact ? null : div("card", h2("Readiness"), p("No evaluation yet. Open setup and answer the 'Where you are today' questions."),
      btn("Answer them", () => setState({ view: sub.self ? "setup-tri" : "coach-setup" }), "btn-secondary btn-sm"));
    const L = LEVEL[r.level];
    const sportRow = k => {
      const x = r.scores[k];
      return div("im-rd-sport", el("span", null, `${SPORT_ICON[k]} ${k[0].toUpperCase() + k.slice(1)}`),
        el("strong", { className: `im-rd-lbl im-rd-${x.label.toLowerCase()}` }, x.label),
        el("span", { className: "im-meta" }, `${x.now.toLocaleString()} of ${x.race.toLocaleString()} ${x.unit} (${x.pctOfRace}%)`));
    };
    const moved = t.testCheck ? div("banner banner-warning", `${t.testCheck.msg} `, el("ul", null, t.testCheck.changes.map(c => el("li", null, c.msg)))) : null;
    if (opts.compact) {
      return div(`im-rd im-rd-compact ${L.cls}`,
        el("strong", null, `${L.dot} ${L.word}: ${r.headline}`),
        r.weeksOut != null ? el("span", { className: "im-meta" }, ` ${r.weeksOut} wks out, about ${r.weeksNeeded} needed for a ${r.distanceLabel}.`) : null,
        div("im-rd-mini", ["swim", "bike", "run"].map(k => el("span", { className: `im-rd-lbl im-rd-${r.scores[k].label.toLowerCase()}` }, `${SPORT_ICON[k]} ${r.scores[k].label}`))),
        t.testCheck ? el("div", { className: "im-flag" }, "Tests came in under the answers. Plan moved.") : null);
    }
    const smaller = r.options.filter(o => o.distance !== r.distance && (X.DISTANCES[o.distance] ? true : false) && o.weeks < r.weeksNeeded);
    const same = r.options.find(o => o.distance === r.distance);
    return div(`card im-rd ${L.cls}`,
      div("im-rd-head", el("span", { className: "im-rd-dot" }, L.dot), div(null, h2(`${L.word}: ${r.headline}`),
        el("p", { className: "im-note" }, `${t.raceName || "Race"} · ${r.distanceLabel} · ${t.raceDate ? fmtDate(t.raceDate, { year: "numeric" }) : "no date"}`))),
      moved,
      div("im-rd-sports", ["swim", "bike", "run"].map(sportRow)),
      el("p", { className: "im-note" }, "Starting = a long way to go. Building = on the way. Ready = close to what training for this distance needs."),
      r.reasons.length ? el("ul", { className: "im-list" }, r.reasons.map(x => el("li", null, x))) : null,
      r.notes.length ? el("ul", { className: "im-list im-rd-notes" }, r.notes.map(x => el("li", null, x))) : null,
      r.level === "red" ? div("im-rd-opts",
        h3("Realistic options"),
        el("ul", { className: "im-list" },
          smaller.map(o => el("li", null, `${o.label}: in about ${o.months} month${o.months > 1 ? "s" : ""} (${o.month})${o.fitsRaceDate ? ", fits before your race date" : ""}.`)),
          same ? el("li", null, `${same.label}: in about ${same.months} months (${same.month}).`) : null),
        el("p", { className: "im-note" }, "Smart move: race a shorter one first, then build to the full. Switch the plan to a stepping-stone race? You pick the actual race later. Your original race is saved."),
        div("im-actions", smaller.map(o =>
          btn(`Switch to ${/^[AEIOU]/.test(o.label) ? "an" : "a"} ${o.label} (${o.month})`, () => switchRace(sub, o), "btn-secondary btn-sm")))) : null,
      r.level === "yellow" ? el("p", { className: "im-note" }, "The plan already caps weekly growth at about 10%. Miss a week? Don't make it up by doubling the next one.") : null,
      el("p", { className: "im-note" }, "This warns. It never blocks. Weeks 1 and 2 test the answers; if the tests come in lower, this updates and the plan moves."));
  }

  function ReadinessPage() {
    const sub = subject();
    return div("page im-page",
      sub.self ? div("step-indicator", "Your readiness check") : header("Readiness", sub),
      errorBanner(),
      readinessCard(sub),
      btn(sub.self ? "Go to my dashboard →" : "See their season →", () => setState({ view: sub.self ? "dashboard" : "coach-season", error: null })),
      btn("Change my answers", () => setState({ view: sub.self ? "setup-tri" : "coach-setup" }), "btn-secondary"));
  }

  // ─────────────────────────────────────────────────────────────
  // SMALL BUILDING BLOCKS
  // ─────────────────────────────────────────────────────────────
  function svg(html, cls) { const d = div(cls || "im-svg"); d.innerHTML = html; return d; }

  function seasonHistogram(season, curIdx, opts) {
    opts = opts || {};
    const W = 10, gap = 2, H = opts.height || 120;
    const n = season.weeks.length;
    const maxH = Math.max(...season.weeks.map(w => w.hours), 1);
    const width = n * (W + gap);
    let bars = "";
    season.weeks.forEach((w, i) => {
      const h = Math.max(2, (w.hours / maxH) * (H - 20));
      const x = i * (W + gap), y = H - h;
      const op = (w.type === "recovery" || w.type === "intro" || w.type === "taper") ? 0.45 : 1;
      bars += `<rect x="${x}" y="${y}" width="${W}" height="${h}" fill="${PHASE_COLORS[w.phase]}" opacity="${op}" rx="1.5"><title>Week ${w.weekNo} · ${fmtDate(w.weekStart)} · ${w.phaseLabel} · ${w.typeLabel} · ${w.hours} h</title></rect>`;
      w.events.forEach(e => {
        const c = e.kind === "race" ? "#111" : e.kind === "half" ? "#b23a12" : e.kind === "register" ? "#0a7d4f" : "#555";
        bars += `<line x1="${x + W / 2}" x2="${x + W / 2}" y1="4" y2="${H}" stroke="${c}" stroke-width="1.5" stroke-dasharray="3 2"/>`;
      });
    });
    if (curIdx != null) {
      const x = curIdx * (W + gap);
      bars += `<rect x="${x - 1.5}" y="1" width="${W + 3}" height="${H - 1}" fill="none" stroke="#111" stroke-width="1.5" rx="2"/>`;
    }
    return svg(`<svg viewBox="0 0 ${width} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;display:block">${bars}</svg>`, "im-hist");
  }

  function phaseLegend() {
    return div("im-legend", Object.entries(X.PHASES).map(([k, v]) =>
      el("span", { className: "im-leg" }, el("i", { style: { background: PHASE_COLORS[k] } }), v.label)));
  }

  function lineChart(series, opts) {
    // series: [{points:[{x,y}], color, label}], x numeric
    opts = opts || {};
    const Wd = 600, Ht = opts.height || 160, pad = 28;
    const all = series.flatMap(s => s.points);
    if (all.length < 2) return null;
    const xs = all.map(p => p.x), ys = all.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    let minY = Math.min(...ys), maxY = Math.max(...ys);
    if (maxY - minY < 2) { minY -= 1; maxY += 1; }
    const sx = x => pad + (x - minX) / Math.max(1e-9, maxX - minX) * (Wd - pad * 2);
    const sy = y => opts.invert ? pad / 2 + (y - minY) / (maxY - minY) * (Ht - pad) : Ht - pad / 2 - (y - minY) / (maxY - minY) * (Ht - pad);
    let out = "";
    series.forEach(s => {
      const pts = s.points.map(p => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
      out += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round"/>`;
      s.points.forEach(p => { out += `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3" fill="${s.color}"><title>${p.label || p.y}</title></circle>`; });
    });
    out += `<text x="2" y="12" font-size="11" fill="#666">${opts.topLabel || maxY.toFixed(0)}</text><text x="2" y="${Ht - 2}" font-size="11" fill="#666">${opts.bottomLabel || minY.toFixed(0)}</text>`;
    return svg(`<svg viewBox="0 0 ${Wd} ${Ht}" style="width:100%;height:auto;display:block">${out}</svg>`, "im-line");
  }

  function sessionRow(s, opts) {
    opts = opts || {};
    const meta = [s.minutes ? `${s.minutes} min` : null, s.zone && s.zone !== "key" ? s.zone : null].filter(Boolean).join(" · ");
    const tags = [s.intense ? el("span", { className: "im-tag im-tag-hard" }, "key effort") : null,
                  !s.intense && s.key ? el("span", { className: "im-tag" }, "key") : null,
                  s.long ? el("span", { className: "im-tag im-tag-long" }, "long") : null];
    const row = div(`im-session im-sport-${s.sport}`,
      div("im-session-top",
        el("span", { className: "im-icon" }, SPORT_ICON[s.sport] || "•"),
        el("strong", null, s.title),
        el("span", { className: "im-meta" }, meta),
        ...tags),
      opts.compact ? null : div("im-detail", s.detail));
    if (!opts.compact && s.sport !== "rest" && s.sport !== "race" && s.sport !== "core" && s.sport !== "strength") {
      const d = el("details", { className: "im-beat" }, el("summary", null, "Feeling beat?"),
        s.intense ? el("p", null, X.feelingBeat(s, false)) : el("p", null, X.feelingBeat(s)));
      row.appendChild(d);
    }
    return row;
  }

  function zonesPaces(sub) {
    const z = sub.zones, t = sub.profile?.tri || {};
    const sw = X.swimPaces(t.swim400Sec), bt = t.hasPower ? X.bikeTargets(t.p20) : null, rt = X.runTargets(t.run5kSec);
    const row = (a, b) => div("im-kv", el("span", null, a), el("strong", null, b));
    return div("card",
      h2("Zones and paces"),
      z && z.z1 ? div("im-two",
        div(null, el("h4", null, "Run HR"),
          row("Recovery", `${z.zr.low}–${z.zr.high}`), row("Zone 1", `${z.z1.low}–${z.z1.high}`), row("Zone 2", `${z.z2.low}–${z.z2.high}`), row("Zone 3", `${z.z3.low}–${z.z3.high}`)),
        div(null, el("h4", null, "Bike HR (run − 11)"),
          row("Recovery", `${z.bikeZr.low}–${z.bikeZr.high}`), row("Zone 1", `${z.bikeZ1.low}–${z.bikeZ1.high}`), row("Zone 2", `${z.bikeZ2.low}–${z.bikeZ2.high}`), row("Zone 3", `${z.bikeZ3.low}–${z.bikeZ3.high}`))
      ) : p("No HR zones yet."),
      div("im-two",
        div(null, el("h4", null, "Swim /100 yds"),
          sw ? [row("400 test pace", X.fmtTime(sw.tt)), row("Easy (+15)", X.fmtTime(sw.easy)), row("Zone 1 (+10)", X.fmtTime(sw.z1)), row("Zone 2 (+5)", X.fmtTime(sw.z2))] : p("Take the 400 test.")),
        div(null, el("h4", null, "Bike / Run intervals"),
          bt ? [row("20-min power", `${bt.p20} W`), row("20-min reps", `${bt.i20} W`), row("10-min reps", `${bt.i10} W`), row("5-min reps", `${bt.i5} W`)] : p(t.hasPower ? "Take the 20-min test." : "No power meter: bike by HR."),
          rt ? [row("5K pace", `${X.fmtTime(rt.pace5k)}/mi`), row("Mile reps", `${X.fmtTime(rt.mile)}/mi`), row("800 reps", `${X.fmtTime(rt.half)}/mi`)] : p("Run a 5K to set run paces."))),
      el("p", { className: "im-note" }, "Trainer rides: outdoor time ÷ 1.2. Long sessions: start low in the zone, finish high."),
      sub.self ? btn("Update HR zones (field test)", () => setState({ view: "test" }), "btn-secondary") : null);
  }

  function weightCard(sub, season, idx) {
    const t = sub.profile?.tri || {};
    const entries = weightEntries(sub);
    const tr = X.weightTrend(entries, { phase: season && !season.error ? season.weeks[idx].phase : "foundation", goalWeight: t.goalWeight });
    const pts = tr.points.slice(-30);
    const t0 = pts.length ? X.toDate(pts[0].date).getTime() : 0;
    const chart = pts.length >= 2 ? lineChart([{ color: "#2f6fbf", points: pts.map(p => ({ x: (X.toDate(p.date) - t0) / 864e5, y: p.lbs, label: `${p.date}: ${p.lbs} lbs` })) }]) : null;
    return div("card",
      h2("Weight trend"),
      chart,
      div(`banner ${tr.status === "warn" ? "banner-warning" : "banner-info"}`, `⚖️ ${tr.msg}`),
      t.goalWeight ? el("p", { className: "im-note" }, `Goal: ${t.goalWeight} lbs. Safe loss: up to 1% of body weight a week in Foundation, slower once the build starts.`) : null,
      sub.self && state.view !== "weight" ? btn("Log weight", () => setState({ view: "weight" }), "btn-secondary") : null);
  }

  function nextEvent(season) {
    const today = X.todayISO();
    for (const w of season.weeks) for (const e of w.events) if (e.date >= today && e.kind !== "build") return e;
    return null;
  }
  function daysTo(iso) { return Math.round((X.toDate(iso) - X.toDate(X.todayISO())) / 864e5); }

  // ─────────────────────────────────────────────────────────────
  // ATHLETE DASHBOARD
  // ─────────────────────────────────────────────────────────────
  function Dashboard() {
    const sub = subject();
    const t = sub.profile.tri;
    const season = seasonOf(sub);
    if (!season || season.error) return div("page", header("Dashboard", sub), div("banner banner-warning", "Season can't be built: " + (season?.error || "no setup")), btn("Fix setup", () => setState({ view: "setup-tri" })));
    const idx = nowIdx(season), w = season.weeks[idx];
    const plan = planFor(season, idx, sub);
    const today = X.todayISO();
    const beforeStart = today < season.weeks[0].weekStart;
    const todayDay = plan.days.find(d => d.date === today);
    const ev = nextEvent(season);
    const comp = X.weekCompliance(plan, sub.workouts);
    const todayLogs = (sub.workouts || []).filter(x => x.date === today);

    const overview = div("card im-overview",
      div("im-race-line",
        el("strong", null, t.raceName),
        el("span", null, ` · ${fmtDate(t.raceDate, { year: "numeric", weekday: "short" })}`),
        !t.raceDateConfirmed ? el("span", { className: "im-tag" }, "date not confirmed") : null),
      div("stat-row",
        statBox("Weeks out", Math.max(0, season.raceIdx - idx)),
        statBox("Phase", w.phaseLabel),
        statBox("This week", w.typeLabel)),
      div("phase-note", X.PHASES[w.phase].note),
      ev ? el("p", { className: "im-next" }, `Next: ${ev.label}, ${fmtDate(ev.date, { year: "numeric" })} (${daysTo(ev.date)} days)`) : null,
      seasonHistogram(season, idx, { height: 70 }),
      btn("Season timeline →", () => setState({ view: "season" }), "btn-secondary btn-sm"));

    const todayCard = div("card today-card",
      h2(beforeStart ? `Plan starts ${fmtDate(season.weeks[0].weekStart)}` : `Today — ${todayDay ? todayDay.full : ""}`),
      w.type === "recovery" ? div("cutback-badge", "Recovery week. Keep it easy.") : null,
      w.testWeek ? div("banner banner-info", "Test week: 20-min bike test Tuesday, 5K Thursday, 400 swim Friday. Enter results in Tests.") : null,
      w.startTests ? div("banner banner-info", w.idx === 0 ? "Start tests, week 1: 20-min bike test Tuesday, swim test Friday. Enter results in Tests. They check your setup answers." : "Start tests, week 2: 5K Thursday. Enter the time in Tests.") : null,
      todayLogs.length ? div("today-complete", div("today-complete-header", `✓ Logged: ${todayLogs.map(l => l.type).join(", ")}`)) : null,
      todayDay ? todayDay.sessions.map(s => sessionRow(s)) : p("Rest."),
      btn("Log a workout →", () => setState({ view: "log-workout" }), "btn-log-today"));

    const weekCard = div("card",
      h2(`This week · ${hrs(plan.totalMin)} h planned · ${hrs(comp.doneMin)} h logged`),
      plan.violations.length
        ? div("banner banner-warning", `⚠️ ${plan.violations.length} safety issue(s). Open the week for details.`)
        : div("im-ok", "✓ Safety checks passed"),
      div("im-weekstrip", plan.days.map(d => div(`im-daychip${d.date === today ? " today" : ""}`,
        el("strong", null, d.name),
        d.sessions.filter(s => s.sport !== "rest").map(s => el("span", { className: `im-chip-s${s.intense ? " hard" : ""}${s.long ? " long" : ""}` }, `${SPORT_ICON[s.sport] || ""}${s.minutes ? s.minutes : ""}`))))),
      btn("Full week →", () => setState({ view: "week", imWeekOffset: 0 }), "btn-secondary btn-sm"));

    const stravaOn = !!(typeof STRAVA !== "undefined" && STRAVA.clientId);
    const menu = div("card",
      h2("Training"),
      div("menu",
        btn("Log a workout", () => setState({ view: "log-workout" })),
        btn("Workout history", () => setState({ view: "history" })),
        btn("Tests (swim 400, bike 20-min, 5K)", () => setState({ view: "tests" }), "btn-secondary"),
        btn("Race pacing plan", () => setState({ view: "race-plan" }), "btn-secondary"),
        btn("Post-race review", () => setState({ view: "race-review" }), "btn-secondary"),
        btn("Edit Ironman setup", () => setState({ view: "setup-tri" }), "btn-secondary")),
      div("strava-section",
        el("p", { className: "strava-section-label" }, "Strava"),
        !stravaOn ? el("p", { className: "im-note" }, "Strava isn't set up on this copy yet (needs JB's own Strava API app). Log workouts by hand for now.")
        : state.stravaTokens ? div("strava-connected",
            div("strava-connected-label", div("strava-dot"), el("span", null, "Strava connected")),
            div("strava-connected-actions", btn("Sync workouts →", fetchStravaActivities, "btn-strava-sync"), btn("Disconnect", stravaDisconnect, "btn-link btn-strava-disconnect")))
        : el("a", { href: stravaConnectURL(), className: "btn-strava-connect" }, "Connect with Strava")));

    return div("page im-page",
      el("header", null,
        el("h1", null, `Hi, ${sub.name}`),
        div("header-actions",
          state.user.admin ? btn("Coach view", () => loadCommandCenter(), "btn-small") : null,
          btn("Logout", doLogout, "btn-logout"))),
      errorBanner(),
      div("dashboard-grid",
        div("dash-col", overview, readinessCard(sub), weekCard, weightCard(sub, season, idx)),
        div("dash-col", todayCard, menu, zonesPaces(sub))));
  }

  // ─────────────────────────────────────────────────────────────
  // SEASON TIMELINE
  // ─────────────────────────────────────────────────────────────
  function SeasonPage() {
    const sub = subject();
    const season = seasonOf(sub);
    if (!season || season.error) return div("page", header("Season", sub), p(season?.error || "No setup yet."));
    const idx = nowIdx(season);
    const blocks = [];
    season.weeks.forEach(w => {
      let b = blocks[blocks.length - 1];
      if (!b || b.block !== w.block) { b = { block: w.block, weeks: [] }; blocks.push(b); }
      b.weeks.push(w);
    });
    const t = sub.profile.tri;
    const totalHours = season.weeks.reduce((a, w) => a + w.hours, 0);

    return div("page im-page im-wide",
      header("Season timeline", sub),
      div("card",
        div("im-race-line", el("strong", null, `${t.raceName} · ${fmtDate(t.raceDate, { year: "numeric" })}`),
          !t.raceDateConfirmed ? el("span", { className: "im-tag" }, "date is a guess — edit when announced") : null),
        el("p", { className: "im-note" }, `${season.weeks.length} weeks from ${fmtDate(season.startMon, { year: "numeric" })} (incl. 3 weeks off after). About ${Math.round(totalHours)} hours total. Bars = planned hours per week. Faded bars = easy weeks. Dashed lines = register, half, race. Box = this week.`),
        seasonHistogram(season, idx, { height: 160 }),
        phaseLegend()),
      div("card",
        h2("Phases"),
        el("table", { className: "im-table" },
          el("thead", null, el("tr", null, ["Phase", "Weeks", "Dates", "Hours/wk", "What it's for"].map(x => el("th", null, x)))),
          el("tbody", null, Object.keys(X.PHASES).map(k => {
            const ws = season.weeks.filter(w => w.phase === k);
            if (!ws.length) return null;
            const builds = ws.filter(w => w.hours > 0);
            return el("tr", null,
              el("td", null, el("i", { className: "im-dot", style: { background: PHASE_COLORS[k] } }), X.PHASES[k].label),
              el("td", null, String(ws.length)),
              el("td", null, `${fmtDate(ws[0].weekStart)} – ${fmtDate(ws[ws.length - 1].weekEnd, { year: "2-digit" })}`),
              el("td", null, builds.length ? `${Math.min(...builds.map(w => w.hours))}–${Math.max(...builds.map(w => w.hours))}` : "0"),
              el("td", null, X.PHASES[k].note));
          })))),
      div("card",
        h2("Blocks"),
        el("p", { className: "im-note" }, "Four-week blocks: three build weeks, then one recovery week at about half the hours. Tap a week to open it."),
        div("im-blocks", blocks.map(b => div("im-block",
          el("div", { className: "im-block-h" }, `Block ${b.block}`),
          b.weeks.map(w => {
            const cur = w.idx === idx;
            const chip = el("button", {
              className: `im-wk${cur ? " cur" : ""} im-t-${w.type}`,
              style: { borderLeftColor: PHASE_COLORS[w.phase] },
              title: `${w.phaseLabel} · ${w.typeLabel}`,
              onClick: () => setState({ view: sub.self ? "week" : "coach-week", imWeekOffset: w.idx - idx })
            },
              el("span", { className: "im-wk-d" }, fmtDate(w.weekStart)),
              el("span", { className: "im-wk-t" }, w.typeLabel),
              el("span", { className: "im-wk-h" }, w.hours ? `${w.hours} h` : "—"),
              w.strength.perWeek ? el("span", { className: "im-wk-g" }, `gym ${w.strength.perWeek}×`) : null,
              w.testWeek || w.startTests ? el("span", { className: "im-wk-g" }, "tests") : null,
              w.events.filter(e => e.kind !== "build").map(e => el("span", { className: `im-ev im-ev-${e.kind}` }, e.label)));
            return chip;
          }))))));
  }

  // ─────────────────────────────────────────────────────────────
  // WEEK PLAN
  // ─────────────────────────────────────────────────────────────
  function WeekPage() {
    const sub = subject();
    const season = seasonOf(sub);
    if (!season || season.error) return div("page", header("Week", sub), p(season?.error || "No setup yet."));
    const cur = nowIdx(season);
    const idx = Math.max(0, Math.min(season.weeks.length - 1, cur + (state.imWeekOffset || 0)));
    const w = season.weeks[idx];
    const plan = planFor(season, idx, sub);
    const today = X.todayISO();
    const tri = sub.profile.tri;
    const moves = (tri.moves || {})[w.weekStart] || [];
    const comp = X.weekCompliance(plan, sub.workouts);

    const doMove = async (fromIdx, id, toIdx) => {
      const nt = Object.assign({}, tri, { moves: Object.assign({}, tri.moves || {}, { [w.weekStart]: moves.concat([{ from: fromIdx, id, to: toIdx }]) }) });
      await saveTri(sub, nt); setState({});
    };
    const undo = async () => {
      const m = Object.assign({}, tri.moves || {}); delete m[w.weekStart];
      await saveTri(sub, Object.assign({}, tri, { moves: m })); setState({});
    };
    const go = d => setState({ imWeekOffset: (state.imWeekOffset || 0) + d });

    return div("page im-page im-wide",
      header(`Week ${w.weekNo} of ${season.weeks.length}`, sub),
      div("card",
        div("im-weeknav",
          btn("← Prev", () => go(-1), "btn-secondary btn-sm"),
          div("im-weektitle",
            el("strong", null, `${fmtDate(w.weekStart)} – ${fmtDate(w.weekEnd, { year: "numeric" })}`),
            el("span", null, ` · ${w.phaseLabel} · ${w.typeLabel} · Block ${w.block}`)),
          btn("Next →", () => go(1), "btn-secondary btn-sm")),
        idx !== cur ? btn("Back to this week", () => setState({ imWeekOffset: 0 }), "btn-link") : null,
        div("phase-note", X.PHASES[w.phase].note),
        div("stat-row",
          statBox("Planned", `${hrs(plan.totalMin)} h`),
          statBox("Logged", `${hrs(comp.doneMin)} h`),
          statBox("Gym", w.strength.perWeek ? `${w.strength.perWeek}× ${w.strength.phase}` : "none")),
        w.events.length ? w.events.map(e => div("banner banner-info", `📅 ${e.label} — ${fmtDate(e.date, { weekday: "long" })}`)) : null,
        plan.violations.length
          ? div("banner banner-warning", el("strong", null, "Safety rules broken:"), el("ul", null, plan.violations.map(v => el("li", null, v.msg))))
          : div("im-ok", "✓ Passes all safety rules: no back-to-back hard days, one long workout per day max, no long day next to a hard day, long run split when it gets long."),
        moves.length ? div("im-row", el("span", { className: "im-note" }, `${moves.length} missed workout(s) moved this week.`), btn("Undo moves", undo, "btn-link")) : null),
      div("im-days", plan.days.map(d => {
        const isToday = d.date === today;
        return div(`card im-day${isToday ? " today" : ""}`,
          div("im-day-h", el("strong", null, d.full), el("span", null, fmtDate(d.date))),
          d.sessions.map(s => {
            const row = sessionRow(s);
            if (s.intense && s.sport !== "race") {
              const options = X.makeUpOptions(plan, d.idx, s.id);
              if (options.length) {
                const sel = select(`mv-${s.id}`, [["Missed it? Make it up easy on…", ""], ...options.map(o => [X.DAY_FULL[o], o])], "");
                sel.addEventListener("change", e => { if (e.target.value !== "") doMove(d.idx, s.id, Number(e.target.value)); });
                row.appendChild(div("im-makeup", sel));
              }
            }
            return row;
          }));
      })),
      zonesPaces(sub));
  }

  // ─────────────────────────────────────────────────────────────
  // TESTS
  // ─────────────────────────────────────────────────────────────
  function TestsPage() {
    const sub = subject();
    const t = sub.profile.tri || {};
    const hist = (t.tests || []).slice().reverse();
    const save = async () => {
      const date = val("ts-date") || X.todayISO();
      const s400 = X.parseTime(val("ts-400")), p20 = num("ts-p20"), k5 = X.parseTime(val("ts-5k"));
      const swShort = num("ts-swshort"), walked = val("ts-walked") === "yes", stopped = val("ts-stopped") === "yes", rideDone = val("ts-ride") === "yes";
      if (!s400 && !p20 && !k5 && !swShort && !stopped && !rideDone) return showError("Enter at least one test result.");
      if (s400 && (s400 < 180 || s400 > 1800)) return showError("400 time looks off. Use M:SS, e.g. 8:30.");
      if (k5 && (k5 < 780 || k5 > 3600)) return showError("5K time looks off. Use M:SS, e.g. 27:30.");
      const tests = (t.tests || []).slice();
      const nt = Object.assign({}, t);
      if (s400) { nt.swim400Sec = s400; tests.push({ date, kind: "swim400", value: s400 }); if (nt.swimAbility === "learning" || nt.swimAbility === "basic") nt.swimAbility = "continuous"; }
      if (p20)  { nt.p20 = p20; nt.hasPower = true; tests.push({ date, kind: "p20", value: p20 }); }
      if (k5)   { nt.run5kSec = k5; tests.push({ date, kind: "run5k", value: k5, walked }); }
      if (swShort && !s400) tests.push({ date, kind: "swimShort", value: swShort });
      if (!p20 && (stopped || rideDone)) tests.push({ date, kind: "ride20", stopped });
      else if (p20 && stopped) tests[tests.length - 1].stopped = true;
      nt.tests = tests;
      // Trust but verify: weaker than the setup answers → lower them and re-ramp
      const chk = nt.eval ? X.applyTestCheck(nt) : { tri: nt, changes: [] };
      const out = chk.changes.length ? Object.assign(chk.tri, { testCheck: Object.assign({}, chk.tri.testCheck, { changes: ((t.testCheck || {}).changes || []).concat(chk.tri.testCheck.changes) }) }) : nt;
      setState({ loading: true });
      await saveTri(sub, out);
      setState({ loading: false, error: null });
    };
    const fmtTest = x => x.kind === "p20" ? `Bike 20-min: ${x.value} W${x.stopped ? " (cut short)" : ""}` : x.kind === "ride20" ? `Bike 20-min (no power)${x.stopped ? ": cut short" : ""}`
      : x.kind === "swimShort" ? `Swim: ${x.value} yds non-stop` : x.kind === "swim400" ? `Swim 400: ${X.fmtTime(x.value)}` : `Run 5K: ${X.fmtTime(x.value)}${x.walked ? " (walk breaks)" : ""}`;
    return div("page im-page",
      header("Tests", sub),
      div("card",
        h2("One test per sport"),
        el("ul", null,
          el("li", null, "Swim: 400-yard time trial after a good warm-up. Sets swim paces (easy +15 s, Z1 +10, Z2 +5 per 100)."),
          el("li", null, "Bike: 20 minutes all-out, even. With a power meter, average watts sets interval targets. Without one, bike by HR."),
          el("li", null, "Run: a 5K race or time trial. Sets run interval paces.")),
        el("p", { className: "im-note" }, "Retest in the first build week of each block once intensity starts. Saving updates the plan right away."),
        errorBanner(),
        field("Test date", input({ id: "ts-date", type: "date", value: X.todayISO() })),
        div("field-row",
          field("Swim 400 (M:SS)", input({ id: "ts-400", type: "text", placeholder: t.swim400Sec ? X.fmtTime(t.swim400Sec) : "e.g. 8:30" })),
          field("Bike 20-min (W)", input({ id: "ts-p20", type: "number", placeholder: t.p20 || "e.g. 200" })),
          field("Run 5K (M:SS)", input({ id: "ts-5k", type: "text", placeholder: t.run5kSec ? X.fmtTime(t.run5kSec) : "e.g. 27:30" }))),
        el("p", { className: "im-note" }, "Didn't go to plan? Say so. It's how the plan gets the start right."),
        div("field-row",
          field("Couldn't swim 400 non-stop? Yards you got", input({ id: "ts-swshort", type: "number", min: "0", max: "399", placeholder: "e.g. 150" })),
          field("Walked during the 5K?", select("ts-walked", [["No", "no"], ["Yes", "yes"]], "no"))),
        div("field-row",
          field("Did the 20-min ride test (no power meter)?", select("ts-ride", [["No", "no"], ["Yes", "yes"]], "no")),
          field("Had to stop or back way off in it?", select("ts-stopped", [["No", "no"], ["Yes", "yes"]], "no"))),
        btn("Save results", save)),
      t.testCheck ? div("card", div("banner banner-warning", t.testCheck.msg), el("ul", { className: "im-list" }, t.testCheck.changes.map(c => el("li", null, c.msg))),
        btn("See readiness", () => setState({ view: sub.self ? "readiness" : "coach-readiness" }), "btn-secondary btn-sm")) : null,
      div("card", h2("History"), hist.length ? el("ul", { className: "im-list" }, hist.map(x => el("li", null, `${x.date} · ${fmtTest(x)}`))) : p("No tests yet.")),
      zonesPaces(sub));
  }

  // ─────────────────────────────────────────────────────────────
  // WEIGHT
  // ─────────────────────────────────────────────────────────────
  function WeightPage() {
    const sub = subject();
    const season = seasonOf(sub);
    const idx = season && !season.error ? nowIdx(season) : 0;
    const save = async () => {
      const date = val("wt-date"), lbs = num("wt-lbs");
      if (!date || !lbs) return showError("Enter a date and weight.");
      if (lbs < 80 || lbs > 500) return showError("Weight looks off.");
      const entries = (state.weights || []).filter(e => e.date !== date).concat([{ date, lbs }]).sort((a, b) => a.date < b.date ? -1 : 1);
      setState({ loading: true });
      await db.collection("users").doc(state.user.id).collection("data").doc("weights").set({ entries });
      setState({ weights: entries, loading: false, error: null });
    };
    const list = weightEntries(sub).sort((a, b) => a.date < b.date ? 1 : -1).slice(0, 14);
    return div("page im-page",
      header("Weight", sub),
      sub.self ? div("card",
        h2("Log a weigh-in"),
        el("p", { className: "im-note" }, "Same time, same scale. First thing in the morning is best. Weights from logged workouts count too."),
        errorBanner(),
        div("field-row",
          field("Date", input({ id: "wt-date", type: "date", value: X.todayISO() })),
          field("Weight (lbs)", input({ id: "wt-lbs", type: "number", step: "0.1", placeholder: "e.g. 228.4" }))),
        btn("Save weight", save)) : null,
      weightCard(sub, season, idx),
      div("card", h2("Recent"), list.length ? el("ul", { className: "im-list" }, list.map(e => el("li", null, `${e.date} · ${e.lbs} lbs`))) : p("None yet.")));
  }

  // ─────────────────────────────────────────────────────────────
  // RACE PACING PLAN
  // ─────────────────────────────────────────────────────────────
  let racePlanOpts = null;
  function RacePlanPage() {
    const sub = subject();
    const t = sub.profile.tri || {};
    const o = racePlanOpts || { distance: t.distance === "half" ? "half" : "full", heatF: t.raceHeatF || 80, firstTimer: t.firstTimer !== false };
    const gen = () => {
      racePlanOpts = { distance: val("rp-dist"), heatF: num("rp-heat") ?? 85, firstTimer: val("rp-first") === "yes" };
      setState({});
    };
    const latestWeight = (() => { const e = weightEntries(sub).sort((a, b) => a.date < b.date ? 1 : -1)[0]; return e ? e.lbs : sub.profile.weight; })();
    const plan = X.racePacingPlan({ distance: o.distance, zones: sub.zones && sub.zones.bikeZ1 ? sub.zones : null, hasPower: t.hasPower, p20: t.p20,
      run5kSec: t.run5kSec, swim400Sec: t.swim400Sec, weightLbs: latestWeight, heatF: o.heatF, firstTimer: o.firstTimer, runLoops: o.distance === "full" ? 3 : 2 });
    const raceLabel = o.distance === "full" ? `${t.raceName} · ${fmtDate(t.raceDate, { year: "numeric" })}` : `${t.halfName || "Half"} · ${t.halfDate ? fmtDate(t.halfDate, { year: "numeric" }) : ""}`;
    const sec = (title, lines) => div("card im-rp", h2(title), el("ul", null, lines.map(l => el("li", null, l))));
    const missing = [!sub.zones?.bikeZ1 && "HR zones", !t.swim400Sec && "swim 400", t.hasPower && !t.p20 && "20-min power", !t.run5kSec && "5K"].filter(Boolean);
    return div("page im-page",
      header("Race pacing plan", sub),
      div("card no-print",
        div("field-row",
          field("Race", select("rp-dist", [["Full: " + (t.raceName || "Ironman"), "full"], ["Half: " + (t.halfName || "70.3"), "half"]], o.distance)),
          field("Expected heat (°F)", input({ id: "rp-heat", type: "number", value: o.heatF })),
          field("First time at this distance?", select("rp-first", [["Yes", "yes"], ["No", "no"]], o.firstTimer ? "yes" : "no"))),
        btn("Build plan", gen),
        missing.length ? div("banner banner-info", `Missing: ${missing.join(", ")}. Those numbers stay blank until the test is in.`) : null),
      div("card im-rp-head",
        h2(raceLabel),
        div("stat-row",
          statBox("Bike HR cap", plan.bikeCap ?? "—"),
          statBox("Run HR", plan.runHR ? `${plan.runHR.low}–${plan.runHR.high}` : "—"),
          statBox("Bike watts", plan.watts ?? "HR only"),
          statBox("Run pace", plan.runPace ? `${X.fmtTime(plan.runPace)}/mi` : "—")),
        plan.heatF >= 80 ? el("p", { className: "im-note" }, `Heat allowance at ${plan.heatF}°F: power −${Math.round(plan.heatPowerCut * 100)}%, run pace +${Math.round(plan.heatSlow * 100)}%, HR ceiling +${plan.heatAllow} bpm for drift.`) : null,
        plan.est.total ? el("p", { className: "im-note" }, `Rough finish: ${X.fmtTime(plan.est.total)} (swim ${X.fmtTime(plan.est.swim)}, bike ${X.fmtTime(plan.est.bike)}, run ${X.fmtTime(plan.est.run)}, transitions ${X.fmtTime(plan.est.transitions)}). ${plan.disclaimer}`) : el("p", { className: "im-note" }, plan.disclaimer)),
      sec("Swim", plan.swim), sec("Bike", plan.bike), sec("Run", plan.run),
      btn("Print", () => window.print(), "btn-secondary no-print"));
  }

  // ─────────────────────────────────────────────────────────────
  // POST-RACE REVIEW
  // ─────────────────────────────────────────────────────────────
  let reviewInput = null;
  function RaceReviewPage() {
    const sub = subject();
    const runs = (sub.workouts || []).filter(w => w.type === "Run" && w.splits);
    const ri = reviewInput || { splits: "", hrs: "", cap: "" };
    const run = () => {
      reviewInput = { splits: val("rv-splits"), hrs: val("rv-hrs"), cap: val("rv-cap") };
      setState({});
    };
    const res = ri.splits ? X.reviewRun({ splits: ri.splits, splitHRs: ri.hrs ? ri.hrs.split(/[,\s]+/).map(Number).filter(Boolean) : [], firstTwoCapSec: X.parseTime(ri.cap) }) : null;
    let chart = null;
    if (res && res.ok) {
      const pace = X.parseSplits(ri.splits);
      const hr = ri.hrs ? ri.hrs.split(/[,\s]+/).map(Number).filter(Boolean) : [];
      chart = div(null,
        el("p", { className: "im-note" }, "Pace per mile (higher = slower)"),
        lineChart([{ color: "#b23a12", points: pace.map((y, i) => ({ x: i + 1, y, label: `Mile ${i + 1}: ${X.fmtTime(y)}` })) }], { topLabel: X.fmtTime(Math.max(...pace)), bottomLabel: X.fmtTime(Math.min(...pace)), height: 140 }),
        hr.length === pace.length ? [el("p", { className: "im-note" }, "Heart rate per mile"), lineChart([{ color: "#2f6fbf", points: hr.map((y, i) => ({ x: i + 1, y, label: `Mile ${i + 1}: ${y} bpm` })) }], { height: 120 })] : null);
    }
    return div("page im-page",
      header("Post-race review", sub),
      div("card",
        h2("Run splits"),
        el("p", { className: "im-note" }, "Pick a logged run with splits (Strava imports have them), or paste mile splits and HR per mile."),
        runs.length ? field("From history", select("rv-pick", [["Select a run…", ""], ...runs.map(r => [`${r.date} · ${r.distanceMi || "?"} mi · ${r.notes || ""}`.slice(0, 70), r.id])], "")) : null,
        field("Mile splits (M:SS, comma separated)", el("textarea", { id: "rv-splits", rows: 3, value: ri.splits, placeholder: "8:30, 8:35, 9:40, 9:45, …" })),
        field("HR per mile (optional, same count)", el("textarea", { id: "rv-hrs", rows: 2, value: ri.hrs, placeholder: "140, 141, 136, …" })),
        field("Planned first-2-mile cap (M:SS, optional)", input({ id: "rv-cap", type: "text", value: ri.cap, placeholder: "e.g. 9:00" })),
        btn("Review", run)),
      res ? div("card",
        !res.ok ? p(res.msg) : [
          div(`banner ${res.verdict.level === "bad" ? "banner-warning" : "banner-info"}`, res.verdict.msg),
          res.hrFirstHalf ? el("p", null, `HR halves: ${Math.round(res.hrFirstHalf)} / ${Math.round(res.hrSecondHalf)} bpm.`) : null,
          res.flags.length ? el("ul", null, res.flags.map(f => el("li", { className: "im-flag" }, f.msg))) : el("p", null, "No flags. Clean run."),
          chart,
          el("p", { className: "im-note" }, "Rules: even halves are ideal; a fade over 15 s/mi is a problem. Fast first 2 miles get flagged. Slowing while HR drops points to fueling or stomach, not fitness.")
        ]) : null);
  }
  // wire the history picker (select() has no onChange param)
  document.addEventListener("change", e => {
    if (e.target && e.target.id === "rv-pick") {
      const sub = subject();
      const w = (sub.workouts || []).find(r => String(r.id) === e.target.value);
      if (w) { reviewInput = { splits: w.splits, hrs: (w.splitHRs || []).join(", "), cap: (reviewInput || {}).cap || "" }; setState({}); }
    }
  });

  // ─────────────────────────────────────────────────────────────
  // COACH PANEL (top of the Command Center)
  // ─────────────────────────────────────────────────────────────
  function CoachPanel() {
    const users = (state.allUsers || []).filter(u => !u.admin);
    const open = (u, view) => setState({ coachAthlete: { userId: u.userId, name: u.profile?.name || u.name, profile: u.profile || {}, zones: u.zones, workouts: u.workouts || [], weights: u.weights || [] }, view, imWeekOffset: 0, error: null });

    const addAthlete = async () => {
      const name = val("ca-name"), pw = val("ca-pw");
      if (!name || pw.length < 6) return showError("Name and a password of 6+ characters.");
      if (pw === ADMIN.password) return showError("Pick a different password.");
      setState({ loading: true });
      try {
        const hash = await hashPassword(pw);
        const ex = await db.collection("approvedUsers").where("passwordHash", "==", hash).get();
        if (!ex.empty) { setState({ loading: false, error: "That password is already used." }); return; }
        await db.collection("approvedUsers").add({ name, passwordHash: hash, admin: false, approvedAt: new Date().toISOString(), addedBy: "coach" });
        await loadCommandCenter();
      } catch (e) { setState({ loading: false, error: "Could not add athlete: " + e.message }); }
    };

    const card = u => {
      const name = u.profile?.name || u.name;
      if (!u.profile?.tri) {
        return div("card im-coach-card",
          h3(name),
          p(u.profile?.age ? "Profile started, Ironman setup not done." : "Hasn't logged in yet. Give them their password; setup runs on first login."),
          btn("Set up their season now", () => open(u, "coach-setup"), "btn-secondary btn-sm"));
      }
      const sub = { userId: u.userId, name, profile: u.profile, zones: u.zones, workouts: u.workouts || [], weights: u.weights || [] };
      const season = seasonOf(sub);
      if (!season || season.error) return div("card im-coach-card", h3(name), div("banner banner-warning", season?.error || "Setup broken"), btn("Fix setup", () => open(u, "coach-setup"), "btn-secondary btn-sm"));
      const idx = nowIdx(season), w = season.weeks[idx];
      const plan = planFor(season, idx, sub);
      const comp = X.weekCompliance(plan, sub.workouts);
      const tr = X.weightTrend(weightEntries(sub), { phase: w.phase, goalWeight: u.profile.tri.goalWeight });
      const ev = nextEvent(season);
      const last = (sub.workouts || [])[0];
      const t = u.profile.tri;
      const tests = [t.swim400Sec ? `400 ${X.fmtTime(t.swim400Sec)}` : "no swim test", t.p20 ? `${t.p20} W` : (t.hasPower ? "no bike test" : "no power meter"), t.run5kSec ? `5K ${X.fmtTime(t.run5kSec)}` : "no 5K"].join(" · ");
      return div("card im-coach-card",
        div("im-coach-h", h3(name), el("span", { className: "im-dot-l", style: { background: PHASE_COLORS[w.phase] } }, w.phaseLabel)),
        div("stat-row",
          statBox("Week", `${w.weekNo}/${season.weeks.length}`),
          statBox(w.typeLabel, `${hrs(plan.totalMin)} h`),
          statBox("Logged", `${comp.pct}%`)),
        el("div", { className: "im-bar" }, el("i", { style: { width: Math.min(100, comp.pct) + "%" } })),
        readinessCard(sub, { compact: true }),
        plan.violations.length ? div("flag", `⚠️ ${plan.violations.length} safety issue(s) this week`) : div("im-ok", "✓ Safety checks passed"),
        el("p", { className: "im-note" }, `Race: ${t.raceName}, ${fmtDate(t.raceDate, { year: "numeric" })}${t.raceDateConfirmed ? "" : " (guess)"}${ev ? ` · Next: ${ev.label} in ${daysTo(ev.date)} days` : ""}`),
        el("p", { className: "im-note" }, `Tests: ${tests}`),
        el("p", { className: "im-note" }, last ? `Last workout: ${last.date} · ${last.type} · ${Math.round((last.durationSec || 0) / 60)} min` : "No workouts logged yet."),
        div(`im-w ${tr.status === "warn" ? "flag" : ""}`, `⚖️ ${tr.msg}`),
        seasonHistogram(season, idx, { height: 50 }),
        div("im-actions",
          btn("This week", () => open(u, "coach-week"), "btn-secondary btn-sm"),
          btn("Season", () => open(u, "coach-season"), "btn-secondary btn-sm"),
          btn("Readiness", () => open(u, "coach-readiness"), "btn-secondary btn-sm"),
          btn("Edit setup", () => open(u, "coach-setup"), "btn-secondary btn-sm"),
          btn("Race plan", () => open(u, "coach-race-plan"), "btn-secondary btn-sm"),
          btn("Review", () => open(u, "coach-race-review"), "btn-secondary btn-sm")));
    };

    const backup = () => {
      const blob = new Blob([db.exportJSON()], { type: "application/json" });
      const a = el("a", { href: URL.createObjectURL(blob), download: `ironman-backup-${X.todayISO()}.json` });
      document.body.appendChild(a); a.click(); a.remove();
    };

    return div(null,
      users.length ? div("im-coach-grid", users.map(card)) : div("card", p("No athletes yet. Add Jake and Miguel below.")),
      div("card",
        h2("Add athlete"),
        el("p", { className: "im-note" }, "Pick their password and send it to them yourself. They finish profile, zones and Ironman setup on first login."),
        div("field-row",
          field("Name", input({ id: "ca-name", type: "text", placeholder: "e.g. Jake" })),
          field("Password (6+)", input({ id: "ca-pw", type: "text", placeholder: "their password" }))),
        btn("Add athlete", addAthlete)),
      db.isLocal ? div("card",
        h2("Local data"),
        el("p", { className: "im-note" }, "Running in local mode: data lives in this browser only. Download a backup now and then."),
        btn("Download backup (JSON)", backup, "btn-secondary btn-sm")) : null);
  }

  // Coach-mode views reuse the athlete screens with subject() = the opened athlete
  const views = {
    "setup-tri":         SetupTri,
    "season":            SeasonPage,
    "week":              WeekPage,
    "tests":             TestsPage,
    "weight":            WeightPage,
    "race-plan":         RacePlanPage,
    "race-review":       RaceReviewPage,
    "readiness":         ReadinessPage,
    "coach-readiness":   ReadinessPage,
    "coach-setup":       SetupTri,
    "coach-season":      SeasonPage,
    "coach-week":        WeekPage,
    "coach-race-plan":   RacePlanPage,
    "coach-race-review": RaceReviewPage
  };
  // Athlete-only views need a finished setup
  const needsTri = new Set(["season", "week", "tests", "weight", "race-plan", "race-review", "readiness", "coach-readiness", "coach-season", "coach-week", "coach-race-plan", "coach-race-review"]);
  const guarded = {};
  Object.entries(views).forEach(([k, fn]) => {
    guarded[k] = () => {
      const sub = subject();
      if (needsTri.has(k) && !sub.profile?.tri) return SetupTri();
      return fn();
    };
  });

  window.IMUI = { views: guarded, Dashboard, CoachPanel, _subject: subject };
})();
