const test = require("node:test");
const assert = require("node:assert");
const { generate, calibrate } = require("../sensitivity");

const phone = { deviceType: "android", screenInches: 6.7, screenWidthPx: 1080, screenHeightPx: 2400, refreshHz: 120, touchSamplingHz: 240, inGameFps: 60, ramGb: 6, grip: "3", style: "drag", skill: "intermediate" };
const vals = r => r.sliders.map(s => s.value);

test("all values stay inside Free Fire's 0-100 range for every device type/style", () => {
  for (const deviceType of ["android", "ios", "tablet", "emulator"])
    for (const style of ["drag", "onetap", "balanced", "precise"])
      for (const skill of ["beginner", "intermediate", "advanced"]) {
        const r = generate({ ...phone, deviceType, style, skill, mouseDpi: 1600 });
        assert.strictEqual(r.sliders.length, 6);
        r.sliders.forEach(s => assert.ok(Number.isInteger(s.value) && s.value >= 0 && s.value <= 100));
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
