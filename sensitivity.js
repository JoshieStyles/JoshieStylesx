"use strict";
/**
 * NivØx sensitivity engine.
 *
 * Free Fire's in-game sliders run 0-100 for: General, Red Dot, 2x, 4x, AWM/Sniper, Free Look.
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
const MAX_SLIDER = 100;
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
  const grip = oneOf(raw.grip, "Finger layout", ["2", "3", "4", "5"], "3");

  const out = {
    type, isMouse, style, skill, grip,
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

function generate(raw) {
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
    if (raw > MAX_SLIDER + 0.5) saturated.push(name);
    return { name, value: clamp(Math.round(raw), 0, MAX_SLIDER) };
  });

  const notes = [];
  if (saturated.length) {
    notes.push(`${saturated.join(", ")} would need more than the in-game maximum of 100 on this device, so it is capped. ` +
      "If aim still feels slow, use longer swipes or raise the 'General' value only after the calibration step.");
  }
  if (d.fps <= 35) notes.push("Low in-game FPS is the biggest accuracy limiter on this device. Use Smooth graphics before tuning further.");
  if (!d.isMouse && d.touchAssumed) notes.push("Touch sampling rate was estimated from your refresh rate. Enter the real value (from the phone's spec sheet) for a tighter profile.");
  notes.push("These are starting values from a device model. Run the Training Ground calibration below: it uses your real hit rate to fine-tune each scope toward the 90% goal.");

  return {
    sliders,
    factors,
    notes,
    target: TARGET_ACCURACY,
    summary: {
      device: d.model || (d.isMouse ? "PC emulator" : d.type),
      type: d.type,
      style: STYLE_LABEL[d.style],
      ppi: d.isMouse ? null : Math.round(d.ppi),
      fps: d.fps,
      refresh: d.refresh
    }
  };
}

function calibrate(raw) {
  if (!raw || typeof raw !== "object") throw bad("Missing calibration data.");
  if (!Array.isArray(raw.sliders) || raw.sliders.length !== SCOPES.length) throw bad("Current sensitivity values are missing.");
  const sliders = raw.sliders.map((v, i) => num(v, SCOPES[i], 0, MAX_SLIDER));
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
  scopes.forEach(i => { next[i] = clamp(next[i] + delta, 0, MAX_SLIDER); });
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

  return { sliders: next, delta, accuracy, targetMet, target: TARGET_ACCURACY, message };
}

module.exports = { generate, calibrate, SCOPES, TARGET_ACCURACY };
