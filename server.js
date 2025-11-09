const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const crypto = require("crypto");
const mongoose = require("mongoose");

// === MODELS ===
const Bot = require("./models/Bot");
const Report = require("./models/Report");

const app = express();

/* ===================== CONFIG ===================== */
const OWNER_ID = process.env.OWNER_ID || "1398750844459024454";
const SESSION_SECRET = process.env.SESSION_SECRET || "super_secret_session";
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ROLE_ID = process.env.DISCORD_ROLE_ID;
const SUPPORT_LINK = "https://discord.gg/b9tS35tkjN";

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const RELEASES_FILE = path.join(DATA_DIR, "releases.json");
const STATS_FILE = path.join(DATA_DIR, "stats.json");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ===================== MONGO ===================== */
mongoose
  .connect(process.env.MONGO_URI || "mongodb://localhost/homeupdate", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ Connecté à MongoDB"))
  .catch((err) => console.error("❌ Erreur MongoDB :", err));

/* ===================== CHIFFREMENT ===================== */
const ENC_KEY = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY, "base64")
  : crypto.randomBytes(32);

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(base64) {
  const buf = Buffer.from(base64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

/* ===================== UTILITAIRES JSON ===================== */
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
app.use(express.static(path.join(__dirname, "public")));
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

/* ===================== MULTER (UPLOAD) ===================== */
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
    if (!file.originalname.toLowerCase().endsWith(".zip")) {
      return cb(new Error("Seuls les fichiers .zip sont acceptés"));
    }
    cb(null, true);
  },
});

/* ===================== HELPERS ===================== */
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

/* ===================== AUTH ===================== */
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

/* ===================== PUBLIC ===================== */
app.get("/", (req, res) => {
  const { totalBots, upToDate, outdated } = getCounters();
  const last = releases.items.find((i) => i.version === releases.latest);
  res.render("index", {
    user: req.user,
    version: releases.latest,
    last,
    date: last ? formatDate(last.createdAt) : "–",
    downloads: stats.downloads || 0,
    totalBots,
    upToDate,
    outdated,
    support: SUPPORT_LINK,
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
    support: SUPPORT_LINK,
  });
});

/* ===================== UPLOAD ===================== */
app.post("/upload", requireOwner, (req, res) => {
  const m = upload.single("zip");
  m(req, res, async (err) => {
    if (err) return res.status(400).send(err.message || "Erreur d’upload");

    const rawVersion = (req.body.version || "").trim();
    const notes = (req.body.notes || "").trim();
    if (!rawVersion) return res.status(400).send("Version manquante.");
    if (!req.file) return res.status(400).send("Aucun fichier ZIP reçu.");

    const version = /^v/i.test(rawVersion) ? rawVersion : "v" + rawVersion;
    const desiredName = `bot-${version}.zip`;
    const currentPath = path.join(UPLOAD_DIR, req.file.filename);
    const targetPath = path.join(UPLOAD_DIR, desiredName);
    if (req.file.filename !== desiredName) fs.renameSync(currentPath, targetPath);

    const createdAt = new Date().toISOString();
    const existingIndex = releases.items.findIndex((r) => r.version === version);
    const record = { version, filename: desiredName, createdAt, notes };
    if (existingIndex >= 0) releases.items[existingIndex] = record;
    else releases.items.push(record);
    releases.latest = version;
    writeJSON(RELEASES_FILE, releases);

    if (WEBHOOK_URL) {
      const webhookBody = {
        content: ROLE_ID ? `<@&${ROLE_ID}>` : null,
        embeds: [
          {
            title: `🆕 Nouvelle version disponible — ${version}`,
            description:
              notes && notes.length
                ? notes
                : "Aucune note de version n’a été fournie.",
            color: 0x6c8cff,
            fields: [
              { name: "Date", value: formatDate(createdAt), inline: true },
              { name: "Téléchargements", value: `${stats.downloads}`, inline: true },
            ],
            footer: { text: "Home Update Panel" },
          },
        ],
      };
      try {
        await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(webhookBody),
        });
        console.log("✅ Webhook envoyé !");
      } catch (e) {
        console.error("❌ Erreur Webhook :", e);
      }
    }

    res.redirect("/dashboard");
  });
});

/* ===================== OWNER BOTS ===================== */
app.get("/owner/bots", requireOwner, async (req, res) => {
  const bots = await Bot.find().sort({ createdAt: -1 });
  res.render("owner_bots", { user: req.user, bots });
});

app.post("/owner/bots/add", requireOwner, async (req, res) => {
  const { name, ownerId, tokenPlain, notes } = req.body;
  const bot = new Bot({
    name,
    ownerId: ownerId || OWNER_ID,
    token: encrypt(tokenPlain),
    meta: { notes },
  });
  await bot.save();
  res.redirect("/owner/bots");
});

/* ===================== API REPORT ===================== */
app.post("/api/report", async (req, res) => {
  const { botId, type, payload } = req.body;
  if (!botId || !type)
    return res.status(400).json({ error: "botId et type requis" });

  const report = new Report({ botId, type, payload });
  await report.save();

  const bot = await Bot.findById(botId);
  if (bot) {
    bot.stats.lastCheck = new Date();
    if (type === "ready") bot.stats.lastReady = new Date();
    if (type === "restart") bot.stats.restarts++;
    if (type === "error") bot.stats.errors++;
    await bot.save();
  }

  res.json({ ok: true });
});

/* ===================== API VERSION ===================== */
app.get("/api/version", (req, res) => {
  const botId = (req.query.bot_id || "unknown").toString();
  const botVersion = (req.query.version || "unknown").toString();

  stats.downloads = (stats.downloads || 0) + 1;
  stats.bots[botId] = { botVersion, lastCheck: new Date().toISOString() };
  writeJSON(STATS_FILE, stats);

  const rec = releases.items.find((r) => r.version === releases.latest);
  const url =
    rec &&
    `${req.protocol}://${req.get("host")}/uploads/${encodeURIComponent(
      rec.filename
    )}`;

  res.json({
    version: releases.latest,
    download: url,
    message: "Dernière version disponible",
  });
});

/* ===================== LANCEMENT ===================== */
app.listen(PORT, () =>
  console.log(`✅ Panel en ligne sur http://localhost:${PORT}`)
);
