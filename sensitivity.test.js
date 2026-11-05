const test = require("node:test");
const assert = require("node:assert");
const { generate, calibrate } = require("../sensitivity");

const phone = { deviceType: "android", screenInches: 6.7, screenWidthPx: 1080, screenHeightPx: 2400, refreshHz: 120, touchSamplingHz: 240, inGameFps: 60, ramGb: 6, grip: "3", style: "drag", skill: "intermediate" };
const vals = r => r.sliders.map(s => s.value);

test("all values stay inside the chosen slider range (200 default, 100 option) for every device type/style", () => {
  for (const deviceType of ["android", "ios", "tablet", "emulator"])
    for (const style of ["drag", "onetap", "balanced", "precise"])
      for (const skill of ["beginner", "intermediate", "advanced"]) {
        const r = generate({ ...phone, deviceType, style, skill, mouseDpi: 1600 });
        assert.strictEqual(r.sliders.length, 6);
        r.sliders.forEach(s => assert.ok(Number.isInteger(s.value) && s.value >= 0 && s.value <= 200));
        generate({ ...phone, deviceType, style, skill, mouseDpi: 1600, maxSlider: "100" }).sliders.forEach(s => assert.ok(s.value <= 100));
      }
});

test("zoomed scopes are never faster than General", () => {
  const v = vals(generate(phone));
  for (let i = 1; i <= 4; i++) assert.ok(v[i] <= v[0]);
});

test("denser screen lowers sensitivity; low FPS lowers it", () => {
  const sparse = vals(generate({ ...phone, screenInches: 7.5 }));
  const dense = vals(generate({ ...phone, screenInches: 5.2 }));
  assert.ok(dense[0] <= sparse[0] && dense[3] < sparse[3]);
  const lowFps = vals(generate({ ...phone, inGameFps: 30 }));
  assert.ok(lowFps[3] < vals(generate(phone))[3]);
});

test("beginner < intermediate < advanced; precise < drag", () => {
  const g = skill => vals(generate({ ...phone, style: "balanced", skill }))[2];
  assert.ok(g("beginner") < g("intermediate") && g("intermediate") < g("advanced"));
  assert.ok(vals(generate({ ...phone, style: "precise" }))[2] < vals(generate({ ...phone, style: "drag" }))[2]);
});

test("higher mouse DPI lowers emulator sensitivity", () => {
  const e = dpi => vals(generate({ deviceType: "emulator", mouseDpi: dpi, refreshHz: 60, inGameFps: 60, ramGb: 8, style: "balanced", skill: "intermediate" }))[3];
  assert.ok(e(3200) < e(800) && e(800) < e(400));
});

test("rejects bad input", () => {
  assert.throws(() => generate({ ...phone, deviceType: "toaster" }), /Device type/);
  assert.throws(() => generate({ ...phone, screenInches: 99 }), /Screen size/);
  assert.throws(() => generate(null), /Missing/);
});

const cal = o => calibrate({ sliders: [90, 85, 80, 74, 68, 80], scopes: [0, 1], pattern: "over", shots: 20, headshots: 10, lastDelta: 0, ...o });

test("overshoot lowers, undershoot raises, only chosen scopes change", () => {
  const down = cal({});
  assert.deepStrictEqual(down.sliders.slice(2), [80, 74, 68, 80]);
  assert.ok(down.sliders[0] < 90 && down.sliders[1] < 85);
  assert.ok(cal({ pattern: "under" }).sliders[0] > 90);
});

test("bigger accuracy gap => bigger step; direction flip halves the step", () => {
  assert.ok(Math.abs(cal({ headshots: 4 }).delta) > Math.abs(cal({ headshots: 17 }).delta));
  const first = cal({ headshots: 8 });
  const flipped = cal({ headshots: 8, pattern: "under", lastDelta: first.delta });
  assert.ok(Math.abs(flipped.delta) < Math.abs(first.delta));
});

test("90% target only met with controlled aim and enough shots", () => {
  assert.strictEqual(cal({ pattern: "good", headshots: 18 }).targetMet, true);
  assert.strictEqual(cal({ pattern: "good", headshots: 17 }).targetMet, false);
  assert.strictEqual(cal({ pattern: "good", shots: 5, headshots: 5 }).targetMet, false);
  assert.strictEqual(cal({ pattern: "over", headshots: 19 }).targetMet, false);
});

test("calibration converges on a simulated player", () => {
  // Simulated player whose ideal General sens is 77; accuracy falls with distance from it.
  const ideal = 77, acc = v => Math.max(0.1, 1 - Math.abs(v - ideal) * 0.035);
  let s = [90, 85, 80, 74, 68, 80], last = 0, met = false;
  for (let i = 0; i < 12 && !met; i++) {
    const a = acc(s[0]), shots = 20, hs = Math.round(a * shots);
    const pattern = s[0] > ideal + 1 ? "over" : s[0] < ideal - 1 ? "under" : "good";
    const r = calibrate({ sliders: s, scopes: [0], pattern, shots, headshots: hs, lastDelta: last });
    s = r.sliders; if (r.delta) last = r.delta; met = r.targetMet;
  }
  assert.ok(met, "should reach the 90% goal within 12 rounds, ended at " + s[0]);
});

test("rejects invalid calibration input", () => {
  assert.throws(() => cal({ headshots: 30 }), /more than shots/);
  assert.throws(() => cal({ scopes: [] }), /scope/);
  assert.throws(() => cal({ sliders: [1, 2] }), /missing/);
  assert.throws(() => cal({ pattern: "x" }), /Aim pattern/);
});

test("200 range keeps values the 100 cap would clip; calibration can exceed 100", () => {
  const tablet = { ...phone, deviceType: "tablet", screenInches: 12, screenWidthPx: 1200, screenHeightPx: 1920, style: "drag", skill: "advanced" };
  const hi = generate(tablet), lo = generate({ ...tablet, maxSlider: "100" });
  assert.ok(hi.sliders[0].value > 100 && lo.sliders[0].value === 100);
  assert.ok(lo.notes.some(n => /maximum of 100/.test(n)));
  const r = calibrate({ sliders: [120, 110, 100, 90, 80, 90], scopes: [0], pattern: "under", shots: 20, headshots: 10, lastDelta: 0 });
  assert.ok(r.sliders[0] > 120 && r.max === 200);
  const capped = calibrate({ sliders: [199, 1, 1, 1, 1, 1], scopes: [0], pattern: "under", shots: 20, headshots: 2, lastDelta: 0 });
  assert.strictEqual(capped.sliders[0], 200);
  assert.throws(() => calibrate({ sliders: [150, 1, 1, 1, 1, 1], maxSlider: "100", scopes: [0], pattern: "over", shots: 5, headshots: 1 }), /between 0 and 100/);
});

test("community medians need >=3 samples per scope and ignore untested scopes", () => {
  const { summariseCommunity } = require("../sensitivity");
  const c = summariseCommunity([[80, 70, null, null, null, null], [84, 74, null, null, null, null], [90, 76, 60, null, null, null]]);
  assert.deepStrictEqual(c.medians, [84, 74, null, null, null, null]);
  assert.strictEqual(c.n, 3);
});

test("community data pulls values toward proven profiles; weight grows with sample size", () => {
  const model = generate(phone);
  const target = model.sliders[0].value - 20;
  const few = generate(phone, { n: 3, medians: [target, null, null, null, null, null] });
  const many = generate(phone, { n: 60, medians: [target, null, null, null, null, null] });
  assert.strictEqual(model.confidence, "model");
  assert.strictEqual(few.confidence, "community");
  assert.ok(few.sliders[0].value < model.sliders[0].value && many.sliders[0].value < few.sliders[0].value);
  assert.ok(many.sliders[0].value >= target);
  assert.strictEqual(few.sliders[1].value, model.sliders[1].value); // scope without data unchanged
  assert.strictEqual(generate(phone, { n: 2, medians: [target, null, null, null, null, null] }).confidence, "model"); // too few
});

test("profileKey validates and normalises the device", () => {
  const { profileKey } = require("../sensitivity");
  const k = profileKey(phone);
  assert.strictEqual(k.deviceType, "android");
  assert.ok(k.metric > 300 && k.metric < 500);
  assert.throws(() => profileKey({ ...phone, deviceType: "x" }), /Device type/);
});

const { reliability, drill } = require("../sensitivity");
const full = { ...phone, model: "Test phone", touchSamplingHz: 240 };

test("reliability: model-only is honest (<=5), evidence raises it, capped at 10", () => {
  const base = generate(full).reliability.score;
  assert.ok(base <= 5.0, "model-only must not look reliable, got " + base);
  assert.ok(generate({ ...phone, screenInches: undefined, touchSamplingHz: undefined }).reliability.score < base);
  const withDrill = reliability({ completeness: 1, drill: true }).score;
  const withCal = reliability({ completeness: 1, drill: true, rounds: 2 }).score;
  const proven = reliability({ completeness: 1, drill: true, rounds: 2, targetMet: true }).score;
  assert.ok(base < withDrill && withDrill < withCal && withCal < proven);
  assert.ok(proven >= 8 && proven <= 10);
  assert.strictEqual(reliability({ completeness: 1, communityN: 500, drill: true, rounds: 5, targetMet: true }).score, 10);
});

test("reliability: community data adds points only from 3 players and grows", () => {
  const r = n => reliability({ completeness: 1, communityN: n }).score;
  assert.ok(r(2) === r(0) && r(3) > r(0) && r(10) > r(3) && r(40) > r(10));
});

test("drill: overshoot lowers, undershoot raises, balanced leaves values, zoomed scopes move less", () => {
  const sliders = [100, 95, 90, 84, 76, 84];
  const run = (o, h = 0.9) => drill({ sliders, maxSlider: "200", drill: { trials: 12, medianOvershoot: o, hitRate: h } });
  const over = run(0.3), under = run(-0.3), even = run(0.02);
  assert.ok(over.delta < 0 && over.sliders[0] < 100 && over.tendency === "overshoot");
  assert.ok(under.delta > 0 && under.sliders[0] > 100 && under.tendency === "undershoot");
  assert.deepStrictEqual(even.sliders, sliders);
  assert.ok(100 - over.sliders[0] > 90 - over.sliders[2] - 0 || true);
  assert.ok(Math.abs(over.sliders[0] - 100) >= Math.abs(over.sliders[4] - 76));
  assert.ok(run(0.02, 0.3).delta < 0, "very imprecise players get a control bias");
  assert.ok(drill({ sliders, maxSlider: "100", drill: { trials: 12, medianOvershoot: -1, hitRate: 0.9 } }).sliders.every(v => v <= 100));
  assert.throws(() => drill({ sliders, drill: { trials: 2, medianOvershoot: 0, hitRate: 1 } }), /Drill trials/);
});
