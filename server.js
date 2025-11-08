const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const app = express();

const OWNER_ID = process.env.OWNER_ID; // ton ID Discord
const SESSION_SECRET = process.env.SESSION_SECRET || "super_secret_session";
const PORT = process.env.PORT || 3000;

const VERSION_FILE = path.join(__dirname, "version.txt");
const RELEASES_DIR = path.join(__dirname, "releases");

if (!fs.existsSync(RELEASES_DIR)) fs.mkdirSync(RELEASES_DIR);

let currentVersion = fs.existsSync(VERSION_FILE)
  ? fs.readFileSync(VERSION_FILE, "utf8").trim()
  : "v1";

// === Express setup ===
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

// === Passport Discord Auth ===
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

// === Auth routes ===
app.get("/login", passport.authenticate("discord"));
app.get(
  "/callback",
  passport.authenticate("discord", { failureRedirect: "/" }),
  (req, res) => res.redirect("/dashboard")
);
app.get("/logout", (req, res) => req.logout(() => res.redirect("/")));

// === Public page ===
app.get("/", (req, res) => {
  res.render("index", { version: currentVersion, user: req.user });
});

// === Dashboard ===
app.get("/dashboard", (req, res) => {
  if (!isOwner(req)) return res.status(403).render("forbidden");
  const files = fs.readdirSync(RELEASES_DIR).filter(f => f.endsWith(".zip"));
  res.render("dashboard", { user: req.user, version: currentVersion, files });
});

// === Upload System ===
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, RELEASES_DIR),
  filename: (req, file, cb) => {
    const version = "v" + Date.now().toString().slice(-5);
    const fileName = `bot-${version}.zip`;
    cb(null, fileName);
    fs.writeFileSync(VERSION_FILE, version);
    currentVersion = version;
  },
});
const upload = multer({ storage });

app.post("/upload", upload.single("file"), (req, res) => {
  if (!isOwner(req)) return res.status(403).send("Forbidden");
  res.redirect("/dashboard");
});

// === Serve releases ===
app.use("/releases", express.static(RELEASES_DIR));

// === API for bot ===
app.get("/api/version", (req, res) => {
  const version = currentVersion;
  const download = `${req.protocol}://${req.get("host")}/releases/bot-${version}.zip`;
  res.json({ version, download });
});

app.listen(PORT, () =>
  console.log(`✅ Update panel en ligne → http://localhost:${PORT}`)
);
