const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");
const sensitivity = require("./sensitivity");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  console.error("Set ADMIN_PASSWORD to a strong password of at least 12 characters.");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("Set DATABASE_URL to your PostgreSQL connection string.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 5
});

app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const makeKey = () => "NIVOX-" + crypto.randomBytes(6).toString("hex").toUpperCase();

async function adminOnly(req, res, next) {
  const supplied = req.get("x-admin-password") || "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Admin password incorrect." });
  }
  next();
}

// Shared key check used by activation and every premium endpoint (same rules as before).
async function checkKey(rawKey) {
  const key = String(rawKey || "").trim().toUpperCase();
  if (!key) return { status: 400, error: "Enter an activation key." };
  const result = await pool.query("SELECT * FROM keys WHERE key_hash = $1", [hash(key)]);
  const row = result.rows[0];
  if (!row || row.revoked) return { status: 403, error: "Invalid or disabled key." };
  const expiresAt = new Date(row.expires_at).getTime();
  if (Date.now() >= expiresAt) return { status: 403, error: "This key has expired." };
  return { row, expiresAt };
}

app.post("/api/activate", async (req, res) => {
  try {
    const check = await checkKey(req.body.key);
    if (check.error) return res.status(check.status).json({ error: check.error });

    res.json({
      active: true,
      expiresAt: check.expiresAt,
      label: check.row.label,
      features: ["Sensitivity optimiser", "DPI guide", "RAM checker", "Storage checker",
        "Device profile", "FPS and graphics guide", "HUD layout tips"]
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error. Please try again." });
  }
});

// Premium sensitivity engine: computed server-side so it cannot be used without a valid key.
const recent = new Map(); // key id -> request timestamps (per-minute limit protects the database)
function rateLimited(id) {
  const now = Date.now();
  const list = (recent.get(id) || []).filter(t => now - t < 60000);
  if (list.length >= 60) { recent.set(id, list); return true; }
  list.push(now); recent.set(id, list); return false;
}

function premiumRoute(handler) {
  return async (req, res) => {
    try {
      const check = await checkKey(req.body.key);
      if (check.error) return res.status(check.status).json({ error: check.error });
      if (rateLimited(check.row.id)) return res.status(429).json({ error: "Too many requests. Please wait a minute." });
      res.json(await handler(req.body, check.row));
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: "Server error. Please try again." });
    }
  };
}

// Profiles that reached the 90% goal, used to start similar devices from proven values.
async function findCommunity(k) {
  const lo = k.metric * 0.9, hi = k.metric * 1.1;
  const base = "SELECT sliders FROM tuned_profiles WHERE device_type=$1 AND max_slider=$2 AND style=$3 AND fps=$4 AND metric BETWEEN $5 AND $6";
  const args = [k.deviceType, k.max, k.style, k.fps, lo, hi];
  let rows = (await pool.query(base + " AND skill=$7 AND grip=$8 ORDER BY created_at DESC LIMIT 200", [...args, k.skill, k.grip])).rows;
  if (rows.length < 3) rows = (await pool.query(base + " ORDER BY created_at DESC LIMIT 200", args)).rows;
  return sensitivity.summariseCommunity(rows.map(r => r.sliders));
}

async function saveTuned(keyRow, device, tested, sliders) {
  const k = sensitivity.profileKey(device);
  const values = sliders.map((v, i) => (tested.includes(i) ? v : null));
  await pool.query(
    `INSERT INTO tuned_profiles (key_id, device_type, max_slider, style, skill, grip, fps, metric, refresh, model, sliders, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
     ON CONFLICT (key_id, device_type, max_slider, style, skill, grip, fps)
     DO UPDATE SET metric=EXCLUDED.metric, refresh=EXCLUDED.refresh, model=EXCLUDED.model, sliders=EXCLUDED.sliders, created_at=now()`,
    [keyRow.id, k.deviceType, k.max, k.style, k.skill, k.grip, k.fps, k.metric, k.refresh, k.model, JSON.stringify(values)]
  );
}

app.post("/api/sensitivity/generate", premiumRoute(async b => {
  const key = sensitivity.profileKey(b.input); // validates the input
  let community = null;
  try { community = await findCommunity(key); } catch (e) { console.error("community lookup failed", e.message); }
  return sensitivity.generate(b.input, community);
}));

app.post("/api/sensitivity/drill", premiumRoute(b => sensitivity.drill(b.input)));
app.post("/api/sensitivity/calibrate", premiumRoute(async (b, keyRow) => {
  const result = sensitivity.calibrate(b.input);
  // Record the FIRST test of a freshly generated profile (before any calibration change) so real starting accuracy can be measured.
  const ev0 = b.input.evidence || {};
  if (!Number(ev0.rounds) && b.input.device && Number(b.input.shots) >= 10) {
    try {
      const k = sensitivity.profileKey(b.input.device);
      await pool.query(
        `INSERT INTO first_tests (key_id, device_type, max_slider, style, skill, source, drill, shots, headshots, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT DO NOTHING`,
        [keyRow.id, k.deviceType, k.max, k.style, k.skill, Number(ev0.communityN) >= 3 ? "community" : "model", !!ev0.drill,
          Math.round(Number(b.input.shots)), Math.round(Number(b.input.headshots))]);
    } catch (e) { if (e.status !== 400) console.error("save first test failed", e.message); }
  }
  // Only confirmed successes (two passing 20+ shot tests in a row) that look plausible feed community data.
  const i = b.input;
  if (result.confirmed && i.device && Number(i.shots) >= 20) {
    try {
      const tested = i.scopes.map(Number);
      if (sensitivity.plausible(i.device, tested, result.sliders)) await saveTuned(keyRow, i.device, tested, result.sliders);
    }
    catch (e) { if (e.status !== 400) console.error("save tuned profile failed", e.message); }
  }
  return result;
}));

app.get("/api/admin/stats", adminOnly, async (req, res) => {
  try {
    const result = await pool.query("SELECT source, drill, shots, headshots FROM first_tests ORDER BY created_at DESC LIMIT 5000");
    res.json(sensitivity.summariseFirstTests(result.rows));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load stats." });
  }
});

app.post("/api/admin/keys", adminOnly, async (req, res) => {
  try {
    const hours = Number(req.body.hours);
    const label = String(req.body.label || "").slice(0, 60);
    if (!Number.isFinite(hours) || hours < 1 || hours > 8760) {
      return res.status(400).json({ error: "Duration must be from 1 hour to 8760 hours (one year)." });
    }

    const key = makeKey();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Math.floor(hours * 60 * 60 * 1000));
    await pool.query(
      "INSERT INTO keys (key_hash, label, created_at, expires_at) VALUES ($1, $2, $3, $4)",
      [hash(key), label, now, expiresAt]
    );
    res.json({ key, createdAt: now.getTime(), expiresAt: expiresAt.getTime() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not create key." });
  }
});

app.get("/api/admin/keys", adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, label, created_at, expires_at, revoked FROM keys ORDER BY id DESC"
    );
    res.json(result.rows.map(r => ({
      ...r,
      created_at: new Date(r.created_at).getTime(),
      expires_at: new Date(r.expires_at).getTime()
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load keys." });
  }
});

app.post("/api/admin/keys/:id/revoke", adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE keys SET revoked = TRUE WHERE id = $1 RETURNING id", [Number(req.params.id)]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Key not found." });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not disable key." });
  }
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS keys (
      id BIGSERIAL PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      label TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tuned_profiles (
      key_id BIGINT NOT NULL,
      device_type TEXT NOT NULL,
      max_slider INT NOT NULL,
      style TEXT NOT NULL,
      skill TEXT NOT NULL,
      grip TEXT NOT NULL,
      fps INT NOT NULL,
      metric REAL NOT NULL,
      refresh INT,
      model TEXT DEFAULT '',
      sliders JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (key_id, device_type, max_slider, style, skill, grip, fps)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS first_tests (
      key_id BIGINT NOT NULL,
      device_type TEXT NOT NULL,
      max_slider INT NOT NULL,
      style TEXT NOT NULL,
      skill TEXT NOT NULL,
      source TEXT NOT NULL,
      drill BOOLEAN NOT NULL,
      shots INT NOT NULL CHECK (shots BETWEEN 10 AND 500),
      headshots INT NOT NULL CHECK (headshots BETWEEN 0 AND 500),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (key_id, device_type, max_slider, style, skill, source, drill)
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS tuned_lookup ON tuned_profiles (device_type, max_slider, style, fps, metric)");
  app.listen(PORT, "0.0.0.0", () => console.log(`NivØx Premium listening on ${PORT}`));
}
start().catch(err => {
  console.error("Database connection failed:", err);
  process.exit(1);
});