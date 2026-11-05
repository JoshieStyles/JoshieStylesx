"use strict";
/**
 * NivØx sensitivity engine.
 *
 * Free Fire's in-game sliders run 0-200 on current versions (0-100 on older ones; selectable) for: General, Red Dot, 2x, 4x, AWM/Sniper, Free Look.
 *
 * generate()  -> device-aware starting profile. Raw aim speed depends on how many pixels the thumb
 *                crosses per centimetre (screen PPI), frame rate, touch sampling and grip, so each
 *                is converted into a documented adjustment. Every adjustment is returned in
 *                `factors` so the user can see why the numbers moved.
 * calibrate() -> closed-loop tuning from the user's own Training Ground result (aim pattern plus
 *                headshots out of shots). Step size scales with the gap to the 90 % goal and halves
 *                whenever the direction flips, so values converge instead of oscillating.
 *
 * Nothing here can guarantee a hit rate: sliders only remove the "settings" part of the error.
 * The 90 % figure is therefore a measured target (calibrate() reports it), not a promise.
 */

const SCOPES = ["General", "Red Dot", "2× Scope", "4× Scope", "AWM / Sniper", "Free Look"];
const TARGET_ACCURACY = 0.9;
const DEFAULT_MAX = 200;
const ALLOWED_MAX = ["100", "200"];
// How strongly each scope reacts to a device-wide adjustment (zoomed scopes need smaller moves).
const SCOPE_WEIGHT = [1, 1, 0.8, 0.7, 0.6, 0.8];

// Reference profiles for a ~400 PPI, 60 FPS, 120 Hz-touch, 3-finger, intermediate player.
const STYLE_BASE = {
  drag:     [96, 92, 88, 82, 74, 82],
  onetap:   [90, 86, 82, 76, 70, 80],
  balanced: [88, 84, 80, 74, 68, 80],
  precise:  [76, 72, 68, 62, 56, 72]
};
const STYLE_LABEL = { drag: "Drag headshots", onetap: "One-tap", balanced: "Balanced", precise: "Precise / control" };

const DEVICE_TYPES = ["android", "ios", "tablet", "emulator"];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sign = n => (n > 0 ? 1 : n < 0 ? -1 : 0);

function bad(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

function num(value, name, lo, hi, fallback) {
  if (value === undefined || value === null || value === "") {
    if (fallback === undefined) throw bad(`${name} is required.`);
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < lo || n > hi) throw bad(`${name} must be between ${lo} and ${hi}.`);
  return n;
}

function oneOf(value, name, allowed, fallback) {
  const v = value === undefined || value === null || value === "" ? fallback : String(value);
  if (!allowed.includes(v)) throw bad(`${name} must be one of: ${allowed.join(", ")}.`);
  return v;
}

function normaliseInput(raw) {
  if (!raw || typeof raw !== "object") throw bad("Missing device details.");
  const type = oneOf(raw.deviceType, "Device type", DEVICE_TYPES, "android");
  const isMouse = type === "emulator";
  const style = oneOf(raw.style, "Play style", Object.keys(STYLE_BASE), "balanced");
  const skill = oneOf(raw.skill, "Skill level", ["beginner", "intermediate", "advanced"], "intermediate");
  const maxSlider = Number(oneOf(raw.maxSlider, "Slider maximum", ALLOWED_MAX, String(DEFAULT_MAX)));
  const grip = oneOf(raw.grip, "Finger layout", ["2", "3", "4", "5"], "3");

  const given = k => raw[k] !== undefined && raw[k] !== null && raw[k] !== "";
  const checks = isMouse
    ? [given("mouseDpi"), given("model"), given("refreshHz")]
    : [given("screenInches"), given("touchSamplingHz"), given("model"), given("screenWidthPx") && given("screenHeightPx")];
  const out = {
    completeness: checks.filter(Boolean).length / checks.length,
    type, isMouse, style, skill, grip, maxSlider,
    model: String(raw.model || "").slice(0, 60),
    fps: num(raw.inGameFps, "In-game FPS", 20, 144, 60),
    ram: num(raw.ramGb, "RAM", 1, 64, 4)
  };

  if (isMouse) {
    out.mouseDpi = num(raw.mouseDpi, "Mouse DPI", 100, 32000, 800);
    out.refresh = num(raw.refreshHz, "Display refresh rate", 30, 360, 60);
  } else {
    const width = num(raw.screenWidthPx, "Screen width (px)", 300, 6000, 1080);
    const height = num(raw.screenHeightPx, "Screen height (px)", 300, 6000, 2400);
    out.screenInches = num(raw.screenInches, "Screen size (inches)", 3, 15, type === "tablet" ? 10 : 6.5);
    out.inchesAssumed = raw.screenInches === undefined || raw.screenInches === null || raw.screenInches === "";
    out.ppi = clamp(Math.hypot(width, height) / out.screenInches, 150, 700);
    out.refresh = num(raw.refreshHz, "Screen refresh rate", 30, 360, 60);
    const touchDefault = out.refresh >= 120 ? 240 : 120;
    out.touchHz = num(raw.touchSamplingHz, "Touch sampling rate", 30, 2000, touchDefault);
    out.touchAssumed = raw.touchSamplingHz === undefined || raw.touchSamplingHz === null || raw.touchSamplingHz === "";
  }
  return out;
}

function pct(m) {
  const p = Math.round((m - 1) * 100);
  return (p > 0 ? "+" : "") + p + "%";
}
function pts(n) {
  return (n > 0 ? "+" : "") + n + " pts";
}

const round1 = n => Math.round(n * 10) / 10;

/**
 * Reliability score /10 — how much real evidence backs a profile. NOT a hit-rate prediction.
 * model baseline 3 + device detail completeness (0-2) + community data (0-2.5)
 * + personal aim drill (1.5) + calibration rounds (0.5 / 1) + verified 90% (2). Capped at 10.
 */
function reliability(e) {
  const completeness = clamp(Number(e.completeness) || 0, 0, 1);
  const n = Math.max(0, Number(e.communityN) || 0);
  const rounds = Math.max(0, Math.floor(Number(e.rounds) || 0));
  const parts = [
    { label: "Device model baseline", pts: 3 },
    { label: "Device details entered", pts: round1(2 * completeness), max: 2 },
    { label: `Community data${n >= 3 ? ` (${n} similar players)` : ""}`, pts: n >= 3 ? round1(1 + 1.5 * Math.min(1, Math.log(n / 3) / Math.log(10))) : 0, max: 2.5 },
    { label: "Personal aim drill", pts: e.drill ? 1.5 : 0, max: 1.5 },
    { label: "Training Ground calibration rounds", pts: rounds >= 2 ? 1 : rounds >= 1 ? 0.5 : 0, max: 1 },
    { label: "90% headshots verified by you", pts: e.targetMet ? 2 : 0, max: 2 }
  ];
  const score = round1(Math.min(10, parts.reduce((a, p) => a + p.pts, 0)));
  const next = [];
  if (completeness < 1) next.push("Fill in screen size, touch sampling rate, resolution and model for a tighter starting profile (up to +2).");
  if (!e.drill) next.push("Run the aim drill (+1.5).");
  if (rounds < 2) next.push("Run Training Ground calibration rounds (+0.5 to +1).");
  if (!e.targetMet) next.push("Reach 90% headshots in a 20-shot test with controlled aim (+2).");
  return { score, parts, next };
}

/**
 * Personal aim-drill fit. The browser drill moves a crosshair by (drag distance x General/100) and
 * records, per trial, how far past (+) or short of (-) the target the player stopped as a fraction of
 * the distance. A consistent bias means the profile is too fast / too slow for this player's hands.
 */
function drill(raw) {
  if (!raw || typeof raw !== "object") throw bad("Missing drill data.");
  const max = Number(oneOf(raw.maxSlider, "Slider maximum", ALLOWED_MAX, String(DEFAULT_MAX)));
  if (!Array.isArray(raw.sliders) || raw.sliders.length !== SCOPES.length) throw bad("Current sensitivity values are missing.");
  const sliders = raw.sliders.map((v, i) => num(v, SCOPES[i], 0, max));
  const d = raw.drill || {};
  const trials = Math.round(num(d.trials, "Drill trials", 6, 60));
  const bias = num(d.medianOvershoot, "Overshoot", -1, 3);
  const hitRate = num(d.hitRate, "Drill hit rate", 0, 1);
  let delta = Math.abs(bias) < 0.06 ? 0 : clamp(Math.round(-bias * 30), -8, 8);
  if (hitRate < 0.5) delta -= 2;           // very imprecise: favour control
  delta = clamp(delta, -10, 8);
  const next = sliders.map((v, i) => clamp(Math.round(v + delta * SCOPE_WEIGHT[i]), 0, max));
  const tendency = Math.abs(bias) < 0.06 ? "balanced" : bias > 0 ? "overshoot" : "undershoot";
  const message = delta === 0
    ? `Drill: ${Math.round(hitRate * 100)}% on target, aim tendency ${tendency}. No change needed.`
    : `Drill: ${Math.round(hitRate * 100)}% on target, you tend to ${tendency === "balanced" ? "lose precision" : tendency} (${Math.round(bias * 100)}% of distance). ${delta < 0 ? "Lowered" : "Raised"} your values by up to ${Math.abs(delta)} (zoomed scopes change less).`;

  let completeness = 0.5;
  try { completeness = normaliseInput(raw.device).completeness; } catch (e) { /* device optional here */ }
  const ev = raw.evidence || {};
  return { sliders: next, max, delta, tendency, message,
    reliability: reliability({ completeness, communityN: ev.communityN, drill: true, rounds: ev.rounds, targetMet: !!ev.targetMet }) };
}

const median = arr => { const a = arr.slice().sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

// Normalised key used to store / look up profiles that reached the 90% goal on a similar device.
function profileKey(raw) {
  const d = normaliseInput(raw);
  return { deviceType: d.type, max: d.maxSlider, style: d.style, skill: d.skill, grip: d.isMouse ? "-" : d.grip,
    fps: d.fps, completeness: d.completeness, metric: Math.round((d.isMouse ? d.mouseDpi : d.ppi) * 10) / 10, refresh: d.refresh, model: d.model };
}

// rows: arrays of 6 slider values (null = scope not tested). Returns per-scope medians.
function summariseCommunity(rows) {
  const medians = SCOPES.map((_, i) => {
    const v = rows.map(r => r[i]).filter(x => Number.isFinite(x));
    return v.length >= 3 ? Math.round(median(v)) : null;
  });
  return { n: rows.length, medians };
}

function generate(raw, community) {
  const d = normaliseInput(raw);
  const base = STYLE_BASE[d.style].slice();
  const factors = [];
  let mult = 1;
  let add = 0;

  factors.push({ label: `Play style: ${STYLE_LABEL[d.style]}`, effect: "base profile" });

  // 1) Physical aim-speed normalisation: more pixels per cm of thumb travel => faster aim at equal slider.
  if (d.isMouse) {
    mult = clamp(Math.pow(800 / d.mouseDpi, 0.5), 0.7, 1.15);
    factors.push({ label: `Mouse DPI ${d.mouseDpi}`, effect: `${pct(mult)} (reference 800 DPI)` });
  } else {
    mult = clamp(Math.pow(400 / d.ppi, 0.4), 0.85, 1.12);
    const src = d.inchesAssumed ? ` (screen size assumed ${d.screenInches}″ — enter yours for better accuracy)` : "";
    factors.push({ label: `Screen density ≈ ${Math.round(d.ppi)} PPI${src}`, effect: `${pct(mult)} (reference 400 PPI)` });
  }

  const addFactor = (label, value) => {
    if (value === 0) return;
    add += value;
    factors.push({ label, effect: pts(value) });
  };

  // 2) Frame rate: low FPS delays visual feedback, which causes overshoot when dragging fast.
  addFactor(`In-game FPS ${d.fps}`, d.fps <= 35 ? -6 : d.fps < 75 ? 0 : d.fps < 100 ? 2 : 3);

  if (!d.isMouse) {
    // 3) Display and touch pipeline.
    addFactor(`Screen refresh ${d.refresh} Hz`, d.refresh < 75 ? -2 : d.refresh < 100 ? 0 : 2);
    const touchLabel = `Touch sampling ${d.touchHz} Hz${d.touchAssumed ? " (estimated)" : ""}`;
    addFactor(touchLabel, d.touchHz <= 120 ? -2 : d.touchHz < 300 ? 0 : 2);
    // 4) Screen size: big screens need longer swipes for the same turn.
    addFactor(`Screen size ${d.screenInches}″`, d.screenInches >= 7 ? 3 : d.screenInches < 5.5 ? -2 : 0);
    // 5) Grip.
    addFactor(`${d.grip}-finger layout`, d.grip === "2" ? 3 : d.grip === "3" ? 0 : -3);
  }

  // 6) Player skill and stability.
  addFactor(`Skill: ${d.skill}`, d.skill === "beginner" ? -8 : d.skill === "advanced" ? 3 : 0);
  addFactor(`RAM ${d.ram} GB`, d.ram <= 3 ? -3 : 0);

  const saturated = [];
  const sliders = SCOPES.map((name, i) => {
    const raw = base[i] * mult + add * SCOPE_WEIGHT[i];
    if (raw > d.maxSlider + 0.5) saturated.push(name);
    return { name, value: clamp(Math.round(raw), 0, d.maxSlider) };
  });

  let confidence = "model";
  if (community && community.n >= 3 && community.medians.some(m => m !== null)) {
    const w = Math.min(0.8, community.n / (community.n + 6));
    sliders.forEach((sl, i) => {
      const m = community.medians[i];
      if (m !== null) sl.value = clamp(Math.round(sl.value * (1 - w) + m * w), 0, d.maxSlider);
    });
    confidence = "community";
    factors.push({ label: `Community data: ${community.n} players on similar devices reached the 90% goal`, effect: `${Math.round(w * 100)}% weight` });
  }

  const notes = [];
  if (saturated.length) {
    notes.push(`${saturated.join(", ")} would need more than the in-game maximum of ${d.maxSlider} on this device, so it is capped. ` +
      "If aim still feels slow, use longer swipes or raise the 'General' value only after the calibration step.");
  }
  if (d.fps <= 35) notes.push("Low in-game FPS is the biggest accuracy limiter on this device. Use Smooth graphics before tuning further.");
  if (!d.isMouse && d.touchAssumed) notes.push("Touch sampling rate was estimated from your refresh rate. Enter the real value (from the phone's spec sheet) for a tighter profile.");
  notes.push(confidence === "community"
    ? "Starting values are blended with profiles that real players on similar devices tuned to 90%. Still run the Training Ground calibration below to fit your own aim."
    : "No proven profiles exist yet for a device like yours, so these are model estimates. Run the Training Ground calibration below: your result also helps future players with similar devices.");

  return {
    sliders,
    factors,
    notes,
    target: TARGET_ACCURACY,
    confidence,
    communitySamples: community ? community.n : 0,
    reliability: reliability({ completeness: d.completeness, communityN: confidence === "community" ? community.n : 0, drill: false, rounds: 0, targetMet: false }),
    summary: {
      device: d.model || (d.isMouse ? "PC emulator" : d.type),
      type: d.type,
      style: STYLE_LABEL[d.style],
      ppi: d.isMouse ? null : Math.round(d.ppi),
      fps: d.fps,
      refresh: d.refresh,
      max: d.maxSlider
    }
  };
}

function calibrate(raw) {
  if (!raw || typeof raw !== "object") throw bad("Missing calibration data.");
  if (!Array.isArray(raw.sliders) || raw.sliders.length !== SCOPES.length) throw bad("Current sensitivity values are missing.");
  const max = Number(oneOf(raw.maxSlider, "Slider maximum", ALLOWED_MAX, String(DEFAULT_MAX)));
  const sliders = raw.sliders.map((v, i) => num(v, SCOPES[i], 0, max));
  const scopes = Array.isArray(raw.scopes) ? [...new Set(raw.scopes.map(Number))] : [];
  if (!scopes.length || scopes.some(i => !Number.isInteger(i) || i < 0 || i >= SCOPES.length)) throw bad("Choose which scope you tested.");
  const pattern = oneOf(raw.pattern, "Aim pattern", ["over", "under", "shaky", "good"]);
  const shots = Math.round(num(raw.shots, "Shots fired", 1, 500));
  const headshots = Math.round(num(raw.headshots, "Headshots", 0, 500));
  if (headshots > shots) throw bad("Headshots cannot be more than shots fired.");
  const lastDelta = Math.round(num(raw.lastDelta, "Previous change", -20, 20, 0));

  const accuracy = headshots / shots;
  const gap = Math.max(0, TARGET_ACCURACY - accuracy);
  const targetMet = shots >= 10 && accuracy >= TARGET_ACCURACY && pattern === "good";

  let delta = 0;
  let message;
  if (pattern !== "good") {
    const dir = pattern === "under" ? 1 : -1;
    let mag = clamp(Math.round(2 + gap * 12), 2, 8);
    if (pattern === "shaky") mag = Math.max(1, Math.round(mag / 2));
    if (lastDelta !== 0 && sign(lastDelta) !== dir) mag = Math.max(1, Math.floor(mag / 2)); // direction flipped: bisect
    delta = dir * mag;
  }

  const next = sliders.slice();
  scopes.forEach(i => { next[i] = clamp(next[i] + delta, 0, max); });
  const names = scopes.map(i => SCOPES[i]).join(", ");
  const accText = `${Math.round(accuracy * 100)}% (${headshots}/${shots})`;

  if (targetMet) {
    message = `Target reached: ${accText} headshots with controlled aim. Keep these values for ${names}, then confirm with a second 20-shot test.`;
  } else if (pattern === "good") {
    message = shots < 10
      ? `Aim feels right, but ${shots} shots is too few to judge. Fire at least 10–20 and enter the result.`
      : `Aim pattern is fine but accuracy is ${accText}, below the 90% goal. Sensitivity is no longer the main limiter: practise the same drill, check ping/FPS, and retest. No change made.`;
  } else {
    message = `${accText} accuracy. ${delta < 0 ? "Lowered" : "Raised"} ${names} by ${Math.abs(delta)}. Retest the same weapon and distance.`;
  }

  let completeness = 0.5;
  try { completeness = normaliseInput(raw.device).completeness; } catch (e) { /* device optional here */ }
  const ev = raw.evidence || {};
  const rel = reliability({ completeness, communityN: ev.communityN, drill: !!ev.drill, rounds: (Number(ev.rounds) || 0) + 1, targetMet: targetMet || !!ev.targetMet });
  return { sliders: next, max, delta, accuracy, targetMet, target: TARGET_ACCURACY, message, reliability: rel };
}

module.exports = { generate, calibrate, drill, reliability, profileKey, summariseCommunity, SCOPES, TARGET_ACCURACY };
