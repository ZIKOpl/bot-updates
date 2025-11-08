const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();

/* ===================== CONFIG ===================== */

const UPLOAD_DIR = process.env.UPLOAD_DIR || "/data/uploads";
const STATS_FILE = path.join(UPLOAD_DIR, "stats.json");
const OWNER_ID = process.env.OWNER_ID; // ton ID Discord
const SESSION_SECRET = process.env.SESSION_SECRET || "super_secret_session";
const PORT = process.env.PORT || 3000;
let currentVersion = process.env.INIT_VERSION || "v1";

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ===================== STATS ===================== */
let stats = { downloads: 0, bots: {} };
try {
  if (fs.existsSync(STATS_FILE)) {
    stats = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
  }
} catch {
  stats = { downloads: 0, bots: {} };
}

/* ===================== AUTH ===================== */

app.set("view engine", "ejs");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { sameSite: "lax", secure: false },
  })
);

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

const upload = multer({ dest: UPLOAD_DIR });
function isOwner(req) {
  return req.user && req.user.id === OWNER_ID;
}

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

/* ===================== PUBLIC PAGE ===================== */

app.get("/", (req, res) => {
  const totalBots = Object.keys(stats.bots).length;
  const upToDate = Object.values(stats.bots).filter(b => b.version === currentVersion).length;
  const outdated = totalBots - upToDate;

  res.render("index", {
    version: currentVersion,
    downloads: stats.downloads,
    totalBots,
    upToDate,
    outdated,
    user: req.user,
  });
});

/* ===================== ADMIN DASHBOARD ===================== */

app.get("/dashboard", (req, res) => {
  if (!isOwner(req)) return res.status(403).render("forbidden");
  const files = fs.readdirSync(UPLOAD_DIR).filter(f => f.endsWith(".zip"));
  res.render("dashboard", { user: req.user, version: currentVersion, files, stats });
});

/* ===================== UPLOAD ===================== */

app.post("/upload", upload.single("updateZip"), (req, res) => {
  if (!isOwner(req)) return res.status(403).send("Forbidden");
  const newVersion = (req.body.version || "").trim();
  if (!req.file || !newVersion) return res.status(400).send("Version manquante ou fichier absent");

  const target = path.join(UPLOAD_DIR, `${newVersion}.zip`);
  fs.renameSync(req.file.path, target);
  currentVersion = newVersion;
  fs.writeFileSync(path.join(UPLOAD_DIR, "version.txt"), currentVersion, "utf8");
  res.redirect("/dashboard");
});

/* ===================== API VERSION ===================== */

app.get("/api/version", (req, res) => {
  const botId = req.query.bot_id || "unknown";
  const botVersion = req.query.version || "unknown";

  stats.downloads++;
  stats.bots[botId] = { version: botVersion, lastCheck: new Date().toISOString() };
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));

  res.json({
    version: currentVersion,
    download: `https://cdn.jsdelivr.net/gh/ZIKOpl/bot-updates@main/releases/${currentVersion}/bot-${currentVersion}.zip`,
    message: "Dernière version disponible",
  });
});

/* ===================== DOWNLOAD ===================== */

app.get("/download/:file", (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).send("Fichier introuvable");
  res.download(filePath);
});

/* ===================== START ===================== */

app.listen(PORT, () => {
  console.log(`✅ Update site listening on port ${PORT}`);
});
