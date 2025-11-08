const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();

/* ===================== CONFIG ===================== */

const OWNER_ID = process.env.OWNER_ID || "1398750844459024454"; 
const SESSION_SECRET = process.env.SESSION_SECRET || "super_secret_session";
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const RELEASES_FILE = path.join(DATA_DIR, "releases.json");
const STATS_FILE = path.join(DATA_DIR, "stats.json");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  return fallback;
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

let releases = readJSON(RELEASES_FILE, { latest: "v1.0", items: [] });
let stats = readJSON(STATS_FILE, { downloads: 0, bots: {} });

/* ===================== EXPRESS / EJS ===================== */
app.set("view engine", "ejs");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ Public + Uploads
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOAD_DIR));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { sameSite: "lax", secure: false },
  })
);

/* ===================== PASSPORT DISCORD ===================== */

app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser((u, done) => done(null, u));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(
  new DiscordStrategy(
    {
      clientID: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
      callbackURL: process.env.CALLBACK_URL,
      scope: ["identify"],
    },
    (accessToken, refreshToken, profile, done) => done(null, profile)
  )
);

function isOwner(req) {
  return req.user && req.user.id === OWNER_ID;
}
function requireOwner(req, res, next) {
  if (isOwner(req)) return next();
  return res.status(403).render("forbidden", { user: req.user });
}

/* ===================== MULTER ===================== */

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const v = (req.body.version || "").trim();
    const safeV = v.replace(/[^\w.\-]/g, "_");
    cb(null, `bot-${safeV}.zip`);
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith(".zip"))
      return cb(new Error("Seuls les fichiers .zip sont acceptés"));
    cb(null, true);
  },
});

/* ===================== ROUTES ===================== */

app.get("/login", passport.authenticate("discord"));
app.get(
  "/callback",
  passport.authenticate("discord", { failureRedirect: "/forbidden" }),
  (req, res) => res.redirect("/dashboard")
);
app.get("/logout", (req, res) => req.logout(() => res.redirect("/")));
app.get("/forbidden", (req, res) =>
  res.status(403).render("forbidden", { user: req.user })
);

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString("fr-FR", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso || "";
  }
}
function getCounters() {
  const totalBots = Object.keys(stats.bots).length;
  const upToDate = Object.values(stats.bots).filter(
    (b) => b.botVersion === releases.latest
  ).length;
  const outdated = Math.max(0, totalBots - upToDate);
  return { totalBots, upToDate, outdated };
}

/* ===================== INDEX ===================== */
app.get("/", (req, res) => {
  const { totalBots, upToDate, outdated } = getCounters();
  const last = releases.items.find((i) => i.version === releases.latest);
  res.render("index", {
    user: req.user,
    version: releases.latest,
    date: last ? formatDate(last.createdAt) : "–",
    downloads: stats.downloads || 0,
    totalBots,
    upToDate,
    outdated,
  });
});

/* ===================== DASHBOARD ===================== */
app.get("/dashboard", requireOwner, (req, res) => {
  const { totalBots, upToDate, outdated } = getCounters();
  const rel = [...releases.items].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.render("dashboard", {
    user: req.user,
    latest: releases.latest,
    releases: rel,
    stats,
    totalBots,
    upToDate,
    outdated,
  });
});

/* ===================== UPLOAD ===================== */
app.post("/upload", requireOwner, (req, res) => {
  upload.single("zip")(req, res, (err) => {
    if (err) return res.status(400).send(err.message);
    const version = "v" + (req.body.version || "").replace(/^v/i, "");
    if (!req.file) return res.status(400).send("Aucun fichier reçu.");

    const filename = `bot-${version}.zip`;
    fs.renameSync(req.file.path, path.join(UPLOAD_DIR, filename));
    const createdAt = new Date().toISOString();

    const record = { version, filename, createdAt };
    const index = releases.items.findIndex((r) => r.version === version);
    if (index >= 0) releases.items[index] = record;
    else releases.items.push(record);
    releases.latest = version;
    writeJSON(RELEASES_FILE, releases);

    res.redirect("/dashboard");
  });
});

/* ===================== API ===================== */
app.get("/api/version", (req, res) => {
  const botId = req.query.bot_id || "unknown";
  const botVersion = req.query.version || "unknown";
  stats.downloads++;
  stats.bots[botId] = { botVersion, lastCheck: new Date().toISOString() };
  writeJSON(STATS_FILE, stats);

  const rec = releases.items.find((r) => r.version === releases.latest);
  res.json({
    version: releases.latest,
    download: rec
      ? `${req.protocol}://${req.get("host")}/uploads/${encodeURIComponent(
          rec.filename
        )}`
      : null,
  });
});

/* ===================== START ===================== */
app.listen(PORT, () =>
  console.log(`✅ Panel en ligne sur http://localhost:${PORT}`)
);
