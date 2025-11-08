// =========================
//  IMPORTS & CONFIG
// =========================
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;

const app = express();

// =========================
//  VARIABLES D'ENVIRONNEMENT
// =========================
const OWNER_ID = process.env.OWNER_ID; // Ton ID Discord (toi seul accès admin)
const SESSION_SECRET = process.env.SESSION_SECRET || "super_secret_session";
const PORT = process.env.PORT || 3000;

// Ces deux variables sont définies dans Render
const BOT_VERSION = process.env.BOT_VERSION || "v1";
const BOT_DOWNLOAD_URL = process.env.BOT_DOWNLOAD_URL || "https://cdn.jsdelivr.net/gh/ZIKOpl/bot-updates@main/releases/v1/bot-v1.zip";

// =========================
//  APP & AUTH
// =========================
app.set("view engine", "ejs");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: "lax",
      secure: false,
    },
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
      callbackURL: process.env.CALLBACK_URL, // ex: https://ton-site.onrender.com/callback
      scope: ["identify"],
    },
    (accessToken, refreshToken, profile, done) => done(null, profile)
  )
);

// =========================
//  HELPERS
// =========================
function isOwner(req) {
  return req.user && req.user.id === OWNER_ID;
}

// =========================
//  ROUTES AUTH DISCORD
// =========================
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

// =========================
//  PAGES
// =========================
app.get("/", (req, res) => {
  res.render("index", {
    version: BOT_VERSION,
    user: req.user,
  });
});

app.get("/dashboard", (req, res) => {
  if (!isOwner(req)) return res.status(403).render("forbidden");

  res.render("dashboard", {
    user: req.user,
    version: BOT_VERSION,
    downloadUrl: BOT_DOWNLOAD_URL,
  });
});

// =========================
//  API PUBLIQUE (bots)
// =========================
app.get("/api/version", (req, res) => {
  res.json({
    version: BOT_VERSION,
    url: BOT_DOWNLOAD_URL,
    message: "Dernière version disponible",
  });
});

// =========================
//  LANCEMENT DU SERVEUR
// =========================
app.listen(PORT, () => {
  console.log(`✅ Update site listening on port ${PORT}`);
  console.log(`🌐 Version actuelle : ${BOT_VERSION}`);
  console.log(`📦 Fichier : ${BOT_DOWNLOAD_URL}`);
});
