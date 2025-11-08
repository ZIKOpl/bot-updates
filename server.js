const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();

/* =======================
   CONFIG
======================= */

// IMPORTANT : sur Render, le FS est éphémère => ajoute un "Disk" persistant
// et monte-le sur /data (Render > Disks). On stocke les zips dans /data/uploads.
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/data/uploads";
const OWNER_ID = process.env.OWNER_ID; // Ton ID Discord
const SESSION_SECRET = process.env.SESSION_SECRET || "super_secret_session";
const PORT = process.env.PORT || 3000;

// version courante en mémoire (tu peux aussi la stocker dans un fichier /data/version.txt)
let currentVersion = process.env.INIT_VERSION || "v1";

// crée le dossier d'uploads s'il n'existe pas
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* =======================
   APP & AUTH
======================= */

app.set("view engine", "ejs");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      // sur Render, derrière proxy
      sameSite: "lax",
      secure: false
    }
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
      scope: ["identify"]
    },
    (accessToken, refreshToken, profile, done) => done(null, profile)
  )
);

const upload = multer({ dest: UPLOAD_DIR });

/* =======================
   HELPERS
======================= */

function isOwner(req) {
  return req.user && req.user.id === OWNER_ID;
}

function absoluteDownloadURL(req, version) {
  // Si tu as défini PUBLIC_BASE_URL (ex: https://bot-updates.onrender.com), on l’utilise
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}/download/${encodeURIComponent(version)}.zip`;
}

/* =======================
   ROUTES AUTH
======================= */

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

/* =======================
   PAGES
======================= */

app.get("/", (req, res) => {
  res.render("index", { version: currentVersion, user: req.user });
});

app.get("/dashboard", (req, res) => {
  if (!isOwner(req)) return res.status(403).render("forbidden");

  // liste les zips présents
  const files = fs
    .readdirSync(UPLOAD_DIR)
    .filter(f => f.endsWith(".zip"))
    .map(f => ({
      name: f,
      path: `/download/${f}`,
      version: f.replace(/\.zip$/, "")
    }));

  res.render("dashboard", {
    user: req.user,
    version: currentVersion,
    files
  });
});

/* =======================
   API UPLOAD (admin)
======================= */

app.post("/upload", upload.single("updateZip"), (req, res) => {
  if (!isOwner(req)) return res.status(403).send("Forbidden");

  const file = req.file;
  const newVersion = (req.body.version || "").trim();
  if (!file) return res.status(400).send("Aucun fichier uploadé");
  if (!newVersion) return res.status(400).send("Version manquante");

  // renomme correctement: vX.zip
  const target = path.join(UPLOAD_DIR, `${newVersion}.zip`);
  fs.renameSync(file.path, target);

  currentVersion = newVersion;

  // (Optionnel) Persister la version dans un fichier
  try {
    fs.writeFileSync(path.join(UPLOAD_DIR, "version.txt"), currentVersion, "utf8");
  } catch {}

  res.redirect("/dashboard");
});

/* =======================
   API PUBLIQUE (bots)
======================= */

app.get("/api/version", (req, res) => {
  res.json({
    version: currentVersion,
    download: absoluteDownloadURL(req, currentVersion),
    message: "Dernière version disponible"
  });
});

/* =======================
   TÉLÉCHARGEMENT ZIP
======================= */

app.get("/download/:file", (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.file);
  if (!filePath.endsWith(".zip")) return res.status(400).send("Format invalide");
  if (!fs.existsSync(filePath)) return res.status(404).send("Fichier introuvable");

  res.download(filePath);
});

/* ======================= */

app.listen(PORT, () => {
  console.log(`✅ Update site listening on :${PORT}`);
});
