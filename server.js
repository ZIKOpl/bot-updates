const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const fs = require("fs");
const path = require("path");

const app = express();

/* ===================== CONFIG ===================== */

const OWNER_ID = process.env.OWNER_ID; // ton ID Discord
const SESSION_SECRET = process.env.SESSION_SECRET || "super_secret_session";
const PORT = process.env.PORT || 3000;
const GITHUB_USER = "ZIKOpl"; // ton compte GitHub
const GITHUB_REPO = "bot-updates"; // nom du repo

// version courante (modifiable dans le dashboard)
const VERSION_FILE = path.join(__dirname, "version.txt");
let currentVersion = process.env.CURRENT_VERSION || "v1";
if (fs.existsSync(VERSION_FILE)) {
  currentVersion = fs.readFileSync(VERSION_FILE, "utf8").trim();
}

/* ===================== STATS ===================== */
const STATS_FILE = path.join(__dirname, "stats.json");
let stats = { downloads: 0, bots: {} };
if (fs.existsSync(STATS_FILE)) {
  stats = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
}

/* ===================== EXPRESS CONFIG ===================== */

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
      callbackURL: process.env.CALLBACK_URL, // ex: https://bot-updates.onrender.com/callback
      scope: ["identify"],
    },
    (accessToken, refreshToken, profile, done) => done(null, profile)
  )
);

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

/* ===================== PAGE PUBLIQUE ===================== */

app.get("/", (req, res) => {
  const totalBots = Object.keys(stats.bots).length;
  const upToDate = Object.values(stats.bots).filter(
    (b) => b.botVersion === currentVersion
  ).length;
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

/* ===================== DASHBOARD ===================== */

app.get("/dashboard", (req, res) => {
  if (!isOwner(req)) return res.status(403).render("forbidden");
  res.render("dashboard", { user: req.user, version: currentVersion, stats });
});

app.post("/setversion", (req, res) => {
  if (!isOwner(req)) return res.status(403).send("Forbidden");
  const newVersion = (req.body.version || "").trim();
  if (!newVersion) return res.status(400).send("Version manquante");
  currentVersion = newVersion;
  fs.writeFileSync(VERSION_FILE, currentVersion, "utf8");
  console.log(`✅ Version mise à jour : ${currentVersion}`);
  res.redirect("/dashboard");
});

/* ===================== API PUBLIQUE ===================== */

app.get("/api/version", (req, res) => {
  const botId = req.query.bot_id || "unknown";
  const botVersion = req.query.version || "unknown";

  stats.downloads++;
  stats.bots[botId] = {
    botVersion,
    latestVersion: currentVersion,
    lastCheck: new Date().toISOString(),
  };
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));

  const downloadURL = `https://cdn.jsdelivr.net/gh/${GITHUB_USER}/${GITHUB_REPO}@main/releases/${currentVersion}/bot-${currentVersion}.zip`;

  res.json({
    version: currentVersion,
    download: downloadURL,
    message: "Dernière version disponible",
  });
});

/* ===================== START ===================== */

app.listen(PORT, () => {
  console.log(`✅ Update site running on port ${PORT}`);
  console.log(`🌐 Version actuelle : ${currentVersion}`);
});
