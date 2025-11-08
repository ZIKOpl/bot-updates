const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const app = express();

/* ===================== CONFIG ===================== */
const OWNER_ID = process.env.OWNER_ID;
const SESSION_SECRET = process.env.SESSION_SECRET || "super_secret_session";
const PORT = process.env.PORT || 3000;

const VERSION_FILE = path.join(__dirname, "version.txt");
const RELEASES_DIR = path.join(__dirname, "releases");
if (!fs.existsSync(RELEASES_DIR)) fs.mkdirSync(RELEASES_DIR);

// Lecture de la version actuelle
let currentVersion = "v1.0";
if (fs.existsSync(VERSION_FILE)) {
  currentVersion = fs.readFileSync(VERSION_FILE, "utf8").trim();
}

/* ===================== EXPRESS ===================== */
app.set("view engine", "ejs");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
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

/* ===================== ROUTES ===================== */
app.get("/login", passport.authenticate("discord"));
app.get(
  "/callback",
  passport.authenticate("discord", { failureRedirect: "/" }),
  (req, res) => res.redirect("/dashboard")
);
app.get("/logout", (req, res) => req.logout(() => res.redirect("/")));

app.get("/", (req, res) => {
  res.render("index", { version: currentVersion, user: req.user });
});

app.get("/dashboard", (req, res) => {
  if (!isOwner(req)) return res.status(403).render("forbidden");
  const files = fs.readdirSync(RELEASES_DIR).filter(f => f.endsWith(".zip"));
  res.render("dashboard", { user: req.user, version: currentVersion, files });
});

/* ===================== VERSION MANAGEMENT ===================== */

function incrementMinor(version) {
  const match = version.match(/v(\d+)\.(\d+)/);
  if (!match) return "v1.0";
  let major = parseInt(match[1]);
  let minor = parseInt(match[2]);

  if (minor < 9) minor++;
  else {
    major++;
    minor = 0;
  }
  return `v${major}.${minor}`;
}

function incrementMajor(version) {
  const match = version.match(/v(\d+)\.(\d+)/);
  if (!match) return "v1.0";
  let major = parseInt(match[1]);
  major++;
  return `v${major}.0`;
}

/* ===================== UPLOAD ===================== */

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, RELEASES_DIR),
  filename: (req, file, cb) => {
    const newVersion = incrementMinor(currentVersion);
    const fileName = `bot-${newVersion}.zip`;
    currentVersion = newVersion;
    fs.writeFileSync(VERSION_FILE, newVersion, "utf8");
    cb(null, fileName);
  },
});
const upload = multer({ storage });

app.post("/upload", upload.single("file"), (req, res) => {
  if (!isOwner(req)) return res.status(403).send("Forbidden");
  res.redirect("/dashboard");
});

app.post("/newmajor", (req, res) => {
  if (!isOwner(req)) return res.status(403).send("Forbidden");
  currentVersion = incrementMajor(currentVersion);
  fs.writeFileSync(VERSION_FILE, currentVersion, "utf8");
  res.redirect("/dashboard");
});

/* ===================== STATIC & API ===================== */

app.use("/releases", express.static(RELEASES_DIR));

app.get("/api/version", (req, res) => {
  const version = currentVersion;
  const download = `${req.protocol}://${req.get("host")}/releases/bot-${version}.zip`;
  res.json({ version, download });
});

/* ===================== START ===================== */

app.listen(PORT, () => {
  console.log(`✅ Panel en ligne sur le port ${PORT}`);
  console.log(`🌐 Version actuelle : ${currentVersion}`);
});
