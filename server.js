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
function premiumRoute(handler) {
  return async (req, res) => {
    try {
      const check = await checkKey(req.body.key);
      if (check.error) return res.status(check.status).json({ error: check.error });
      res.json(handler(req.body));
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: "Server error. Please try again." });
    }
  };
}
app.post("/api/sensitivity/generate", premiumRoute(b => sensitivity.generate(b.input)));
app.post("/api/sensitivity/calibrate", premiumRoute(b => sensitivity.calibrate(b.input)));

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
  app.listen(PORT, "0.0.0.0", () => console.log(`NivØx Premium listening on ${PORT}`));
}
start().catch(err => {
  console.error("Database connection failed:", err);
  process.exit(1);
});