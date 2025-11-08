// server.js
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();

/* ===================== CONFIG ===================== */
// ▶ IMPORTANT Render: ajoute un Disk persistant monté sur /data
const UPLOAD_DIR   = process.env.UPLOAD_DIR || "/data/uploads";
const DATA_DIR     = process.env.DATA_DIR   || "/data";
const OWNER_ID     = process.env.OWNER_ID || ""; // Ton ID Discord
const SESSION_SECRET = process.env.SESSION_SECRET || "super_secret_session";
const PORT = process.env.PORT || 3000;

// Fichiers de persistance
const VERSION_FILE = path.join(DATA_DIR, "version.txt");
const STATS_FILE   = path.join(DATA_DIR, "stats.json");

// Valeur par défaut
let currentVersion = "v1.0";

// Crée arborescence nécessaire
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR,   { recursive: true });

// Charge version si existe
if (fs.existsSync(VERSION_FILE)) {
  currentVersion = fs.readFileSync(VERSION_FILE, "utf8").trim() || currentVersion;
} else {
  fs.writeFileSync(VERSION_FILE, currentVersion, "utf8");
}

// Charge stats si existe
let stats = { downloads: 0, checks: 0, bots: {}, releases: [] };
try {
  if (fs.existsSync(STATS_FILE)) {
    stats = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
  } else {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  }
} catch {
  // si cassé, on repart propre
  stats = { downloads: 0, checks: 0, bots: {}, releases: [] };
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

/* ===================== APP ===================== */
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/public", express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { sameSite: "lax", secure: false }
  })
);

/* ===================== AUTH (Discord) ===================== */
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((u, done) => done(null, u));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(
  new DiscordStrategy(
    {
      clientID: process.env.DISCORD_CLIENT_ID || "",
      clientSecret: process.env.DISCORD_CLIENT_SECRET || "",
      callbackURL: process.env.CALLBACK_URL || "http://localhost:3000/callback",
      scope: ["identify"]
    },
    (accessToken, refreshToken, profile, done) => done(null, profile)
  )
);

const upload = multer({ dest: UPLOAD_DIR });

function isOwner(req) {
  return req.user && req.user.id === OWNER_ID;
}

function absoluteBase(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

function downloadURL(req, version) {
  // Fichier renommé en bot-<version>.zip
  return `${absoluteBase(req)}/download/bot-${encodeURIComponent(version)}.zip`;
}

function saveStats() {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

/* ===================== ROUTES AUTH ===================== */
app.get("/login", passport.authenticate("discord"));
app.get(
  "/callback",
  passport.authenticate("discord", { failureRedirect: "/" }),
  (req, res) => res.redirect("/dashboard")
);
app.get("/logout", (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    res.redirect("/");
  });
});

/* ===================== PAGES ===================== */
app.get("/", (req, res) => {
  const totalBots = Object.keys(stats.bots).length;
  const upToDate = Object.values(stats.bots).filter(b => b.lastVersion === currentVersion).length;
  const outdated = Math.max(0, totalBots - upToDate);

  res.render("index", {
    user: req.user,
    version: currentVersion,
    downloads: stats.downloads,
    checks: stats.checks,
    totalBots,
    upToDate,
    outdated,
    releases: stats.releases.slice().reverse().slice(0, 8), // dernières versions
  });
});

app.get("/dashboard", (req, res) => {
  if (!isOwner(req)) return res.status(403).render("forbidden", { user: req.user });

  // liste les zips présents
  const files = fs.readdirSync(UPLOAD_DIR).filter(f => f.endsWith(".zip"));
  const mapped = files.map(name => {
    const version = name.replace(/^bot-(.+)\.zip$/, "$1");
    return {
      name,
      version,
      size: fs.statSync(path.join(UPLOAD_DIR, name)).size,
      url: `/download/${encodeURIComponent(name)}`
    };
  }).sort((a,b) => a.version.localeCompare(b.version, undefined, { numeric: true }));

  res.render("dashboard", {
    user: req.user,
    version: currentVersion,
    files: mapped,
    releases: stats.releases.slice().reverse(),
  });
});

/* ===================== UPLOAD (OWNER) ===================== */
app.post("/upload", upload.single("updateZip"), (req, res) => {
  if (!isOwner(req)) return res.status(403).send("Forbidden");

  const newVersion = (req.body.version || "").trim();
  if (!req.file) return res.status(400).send("Aucun fichier");
  if (!newVersion) return res.status(400).send("Version manquante");

  // Renomme le fichier en bot-<version>.zip
  const safe = `bot-${newVersion}.zip`;
  const target = path.join(UPLOAD_DIR, safe);

  fs.renameSync(req.file.path, target);

  // Met à jour la version courante
  currentVersion = newVersion;
  fs.writeFileSync(VERSION_FILE, currentVersion, "utf8");

  // Ajoute dans l'historique des releases
  const release = {
    version: newVersion,
    date: new Date().toISOString(),
    file: safe,
    size: fs.statSync(target).size
  };
  // évite doublons
  stats.releases = stats.releases.filter(r => r.version !== newVersion);
  stats.releases.push(release);
  saveStats();

  res.redirect("/dashboard");
});

/* ===================== API BOTS ===================== */
// Retourne la dernière version + lien de download
app.get("/api/version", (req, res) => {
  const botId = req.query.bot_id || "unknown";
  const botVersion = req.query.version || "unknown";

  stats.checks++;
  stats.bots[botId] = {
    lastSeen: new Date().toISOString(),
    lastVersion: botVersion
  };
  saveStats();

  res.json({
    version: currentVersion,
    download: downloadURL(req, currentVersion),
    message: "Dernière version disponible"
  });
});

// Check rapide: à jour ou pas (sans lien)
app.get("/api/check", (req, res) => {
  const botVersion = req.query.version || "unknown";
  const upToDate = botVersion === currentVersion;
  stats.checks++;
  saveStats();

  res.json({ upToDate, latest: currentVersion });
});

// Liste des releases
app.get("/api/releases", (req, res) => {
  res.json(stats.releases.sort((a,b) => a.version.localeCompare(b.version, undefined, { numeric: true })));
});

/* ===================== DOWNLOAD ===================== */
app.get("/download/:file", (req, res) => {
  const file = req.params.file;
  const filePath = path.join(UPLOAD_DIR, file);
  if (!file.endsWith(".zip")) return res.status(400).send("Format invalide");
  if (!fs.existsSync(filePath)) return res.status(404).send("Fichier introuvable");

  stats.downloads++;
  saveStats();

  res.download(filePath);
});

/* ===================== START ===================== */
app.listen(PORT, () => {
  console.log(`✅ Update panel en ligne → http://localhost:${PORT}`);
});
