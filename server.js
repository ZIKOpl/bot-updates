const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();

/* ===================== CONFIG ===================== */

const UPLOAD_DIR = path.join(__dirname, "uploads");
const STATS_FILE = path.join(UPLOAD_DIR, "stats.json");
const VERSION_FILE = path.join(UPLOAD_DIR, "version.txt");

const OWNER_ID = process.env.OWNER_ID;
const SESSION_SECRET = process.env.SESSION_SECRET || "secret_session";
const PORT = process.env.PORT || 3000;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let currentVersion = fs.existsSync(VERSION_FILE)
  ? fs.readFileSync(VERSION_FILE, "utf8").trim()
  : "v1.0";

let stats = fs.existsSync(STATS_FILE)
  ? JSON.parse(fs.readFileSync(STATS_FILE, "utf8"))
  : { downloads: 0, bots: {} };

/* ===================== EXPRESS ===================== */

app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "public")));
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

/* ===================== DISCORD AUTH ===================== */

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

/* ===================== UPLOAD ===================== */

const upload = multer({ dest: UPLOAD_DIR });

app.post("/upload", upload.single("updateZip"), (req, res) => {
  if (!isOwner(req)) return res.status(403).send("Accès refusé");
  const newVersion = (req.body.version || "").trim();
  if (!req.file || !newVersion) return res.status(400).send("Version ou fichier manquant");

  const target = path.join(UPLOAD_DIR, `${newVersion}.zip`);
  fs.renameSync(req.file.path, target);
  currentVersion = newVersion;
  fs.writeFileSync(VERSION_FILE, currentVersion, "utf8");
  res.status(200).send("OK");
});

/* ===================== ROUTES ===================== */

app.get("/", (req, res) => {
  const totalBots = Object.keys(stats.bots).length;
  const upToDate = Object.values(stats.bots).filter(b => b.version === currentVersion).length;
  const outdated = totalBots - upToDate;

  const releases = fs.readdirSync(UPLOAD_DIR)
    .filter(f => f.endsWith(".zip"))
    .map(f => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, f));
      return {
        version: f.replace(".zip", ""),
        size: stat.size,
        date: stat.mtime
      };
    })
    .sort((a, b) => b.date - a.date);

  res.render("index", {
    user: req.user,
    version: currentVersion,
    downloads: stats.downloads || 0,
    totalBots,
    upToDate,
    outdated,
    releases
  });
});

app.get("/dashboard", (req, res) => {
  if (!isOwner(req)) return res.status(403).render("forbidden");
  const releases = fs.readdirSync(UPLOAD_DIR)
    .filter(f => f.endsWith(".zip"))
    .map(f => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, f));
      return {
        version: f.replace(".zip", ""),
        size: stat.size,
        url: `/download/${f}`
      };
    })
    .sort((a, b) => b.size - a.size);

  res.render("dashboard", { user: req.user, version: currentVersion, releases });
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
  });
});

/* ===================== DOWNLOAD ===================== */

app.get("/download/:file", (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).send("Fichier introuvable");
  res.download(filePath);
});

/* ===================== AUTH ===================== */

app.get("/login", passport.authenticate("discord"));
app.get("/callback",
  passport.authenticate("discord", { failureRedirect: "/" }),
  (req, res) => res.redirect("/dashboard")
);
app.get("/logout", (req, res) => req.logout(() => res.redirect("/")));

/* ===================== START ===================== */

app.listen(PORT, () => console.log(`✅ Panel en ligne sur http://localhost:${PORT}`));
