const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();

/* ===================== CONFIG ===================== */
const PORT = process.env.PORT || 3000;
const OWNER_ID = process.env.OWNER_ID; // Ton ID Discord ici
const SESSION_SECRET = process.env.SESSION_SECRET || "super_secret_session";

// Dossiers et fichiers
const UPLOAD_DIR = path.join(__dirname, "uploads");
const VERSION_FILE = path.join(__dirname, "version.txt");
const STATS_FILE = path.join(__dirname, "stats.json");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Charger la version actuelle
let currentVersion = "v1";
if (fs.existsSync(VERSION_FILE)) {
  currentVersion = fs.readFileSync(VERSION_FILE, "utf8").trim();
}

// Charger les stats
let stats = { downloads: 0, bots: {}, perDay: {} };
if (fs.existsSync(STATS_FILE)) {
  try {
    stats = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
  } catch {
    stats = { downloads: 0, bots: {}, perDay: {} };
  }
}

/* ===================== EXPRESS CONFIG ===================== */
app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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
      callbackURL: process.env.CALLBACK_URL, // ex: https://bot-updates.onrender.com/callback
      scope: ["identify"],
    },
    (accessToken, refreshToken, profile, done) => done(null, profile)
  )
);

function isOwner(req) {
  return req.user && req.user.id === OWNER_ID;
}

/* ===================== MULTER (UPLOAD ZIP) ===================== */
const upload = multer({ dest: UPLOAD_DIR });

/* ===================== AUTH ROUTES ===================== */
app.get("/login", passport.authenticate("discord"));
app.get(
  "/callback",
  passport.authenticate("discord", { failureRedirect: "/" }),
  (req, res) => res.redirect("/dashboard")
);
app.get("/logout", (req, res) => {
  req.logout(() => res.redirect("/"));
});

/* ===================== PAGE PUBLIQUE ===================== */
app.get("/", (req, res) => {
  const totalBots = Object.keys(stats.bots).length;
  const upToDate = Object.values(stats.bots).filter(
    (b) => b.version === currentVersion
  ).length;
  const outdated = totalBots - upToDate;

  // Créer des stats journalières (7 derniers jours)
  const days = [];
  const values = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push(key);
    values.push(stats.perDay?.[key] || 0);
  }

  res.render("index", {
    user: req.user,
    isOwner: isOwner(req),
    version: currentVersion,
    totalBots,
    upToDate,
    outdated,
    chartLabels: JSON.stringify(days),
    chartValues: JSON.stringify(values),
  });
});

/* ===================== DASHBOARD ===================== */
app.get("/dashboard", (req, res) => {
  if (!req.user) return res.redirect("/login");
  if (!isOwner(req)) return res.render("forbidden");

  const days = [];
  const values = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push(key);
    values.push(stats.perDay?.[key] || 0);
  }

  res.render("dashboard", {
    user: req.user,
    isOwner: true,
    version: currentVersion,
    stats,
    chartLabels: JSON.stringify(days),
    chartValues: JSON.stringify(values),
  });
});

/* ===================== UPLOAD NOUVELLE VERSION ===================== */
app.post("/upload", upload.single("updateZip"), (req, res) => {
  if (!isOwner(req)) return res.status(403).send("Forbidden");

  const newVersion = (req.body.version || "").trim();
  if (!req.file || !newVersion)
    return res.status(400).send("Version manquante ou fichier absent");

  const targetPath = path.join(UPLOAD_DIR, `${newVersion}.zip`);
  fs.renameSync(req.file.path, targetPath);

  // Met à jour la version actuelle
  currentVersion = newVersion;
  fs.writeFileSync(VERSION_FILE, currentVersion, "utf8");
  console.log(`✅ Nouvelle version uploadée : ${newVersion}`);

  res.redirect("/dashboard");
});

/* ===================== API VERSION (pour les bots) ===================== */
app.get("/api/version", (req, res) => {
  const botId = req.query.bot_id || "unknown";
  const botVersion = req.query.version || "unknown";

  stats.downloads++;
  stats.bots[botId] = { version: botVersion, lastCheck: new Date().toISOString() };

  // Enregistrer stats journalières
  const today = new Date().toISOString().slice(0, 10);
  stats.perDay[today] = (stats.perDay[today] || 0) + 1;

  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));

  const downloadUrl = `${req.protocol}://${req.get("host")}/download/${currentVersion}.zip`;

  res.json({
    version: currentVersion,
    download: downloadUrl,
    message: "Dernière version disponible",
  });
});

/* ===================== DOWNLOAD ZIP ===================== */
app.get("/download/:file", (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).send("Fichier introuvable");
  res.download(filePath);
});

/* ===================== START ===================== */
app.listen(PORT, () => {
  console.log(`✅ Panel de mise à jour lancé sur le port ${PORT}`);
});
