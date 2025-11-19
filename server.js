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
const Release = require("./models/Release");
const Stat = require("./models/Stat");
const Bot = require("./models/Bot");
const Report = require("./models/Report");

const app = express();

/* ===================== CONFIG ===================== */
const OWNER_IDS = process.env.OWNER_ID
    ? process.env.OWNER_ID.split(",")
    : ["1398750844459024454", "924068219025784842"];
const SESSION_SECRET = process.env.SESSION_SECRET || "super_secret_session";
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ROLE_ID = process.env.DISCORD_ROLE_ID;
const SUPPORT_LINK = "https://discord.gg/b9tS35tkjN";

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ===================== MONGO ===================== */
mongoose
  .connect(process.env.MONGO_URI)
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

/* ===================== MULTER (UPLOAD .zip) ===================== */
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
async function getStatsDoc() {
  let s = await Stat.findOne();
  if (!s) s = await Stat.create({ downloads: 0, bots: {} });
  return s;
}

/* ===================== AUTH ===================== */
app.get("/login", passport.authenticate("discord"));
app.get(
  "/callback",
  passport.authenticate("discord", { failureRedirect: "/forbidden" }),
  (req, res) => res.redirect("/dashboard")
);
app.get("/logout", (req, res, next) => {
  req.logout(function (err) {
    if (err) return next(err);
    res.redirect("/");
  });
});
app.get("/forbidden", (req, res) =>
  res.status(403).render("forbidden", { user: req.user })
);

/* ===================== PAGES PUBLIQUES ===================== */
app.get("/", async (req, res) => {
  const stats = await getStatsDoc();
  const latest = await Release.findOne().sort({ createdAt: -1 });
  const version = latest?.version || "v1.0";
  const bots = Object.values(stats.bots || {}).filter(Boolean);

  res.render("index", {
    user: req.user,
    version,
    last: latest || null,
    date: latest ? formatDate(latest.createdAt) : "–",
    downloads: stats.downloads || 0,
    totalBots: bots.length,
    upToDate: bots.filter((b) => b.botVersion === version).length,
    outdated:
      Math.max(0, bots.length - bots.filter((b) => b.botVersion === version).length) || 0,
    support: SUPPORT_LINK,
  });
});

/* ===================== DASHBOARD (OWNER) ===================== */
app.get("/dashboard", requireOwner, async (req, res) => {
  const stats = await getStatsDoc();
  const releases = await Release.find().sort({ createdAt: -1 });
  const latest = releases[0]?.version || "v1.0";
  const bots = Object.values(stats.bots || {}).filter(Boolean);

  res.render("dashboard", {
    user: req.user,
    latest,
    releases,
    stats,
    totalBots: bots.length,
    upToDate: bots.filter((b) => b.botVersion === latest).length,
    outdated:
      Math.max(0, bots.length - bots.filter((b) => b.botVersion === latest).length) || 0,
    support: SUPPORT_LINK,
  });
});

/* ===================== UPLOAD RELEASE ===================== */
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

    await Release.findOneAndUpdate(
      { version },
      { version, filename: desiredName, notes },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (WEBHOOK_URL) {
      try {
        const stats = await getStatsDoc();
        const webhookBody = {
          content: ROLE_ID ? `<@&${ROLE_ID}>` : null,
          embeds: [
            {
              title: `🆕 Nouvelle version — ${version}`,
              description:
                notes?.length ? notes : "Aucune note de version n’a été fournie.",
              color: 0x6c8cff,
              fields: [
                {
                  name: "Date",
                  value: formatDate(new Date().toISOString()),
                  inline: true,
                },
                {
                  name: "Téléchargements",
                  value: `${stats.downloads || 0}`,
                  inline: true,
                },
              ],
              footer: { text: "Home Update Panel" },
            },
          ],
        };
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

/* ===================== OWNER : GESTION DES BOTS ===================== */
app.get("/owner/bots", requireOwner, async (req, res) => {
  const bots = await Bot.find().sort({ createdAt: -1 }).lean();
  res.render("owner_bots", { user: req.user, bots, support: SUPPORT_LINK });
});

app.post("/owner/bots/add", requireOwner, async (req, res) => {
  const { name, ownerId, tokenPlain, notes } = req.body;
  if (!name || !tokenPlain) return res.status(400).send("Nom et token requis.");

  await Bot.create({
    name,
    ownerId: ownerId || OWNER_ID,
    token: encrypt(tokenPlain),
    meta: { notes: notes || "" },
    stats: { restarts: 0, errors: 0 },
  });

  res.redirect("/owner/bots");
});

app.post("/owner/bots/:id/delete", requireOwner, async (req, res) => {
  const { id } = req.params;
  const bot = await Bot.findById(id);
  if (!bot) return res.status(404).send("Bot introuvable.");

  await Bot.deleteOne({ _id: id });
  await Report.deleteMany({ botId: id });

  console.log(`🗑️ Bot supprimé : ${bot.name}`);
  res.redirect("/owner/bots");
});

app.get("/owner/bots/:id/decrypt", requireOwner, async (req, res) => {
  const { id } = req.params;
  const b = await Bot.findById(id);
  if (!b) return res.status(404).send("Bot introuvable.");
  return res.json({
    token: decrypt(b.token),
    name: b.name,
  });
});

/* ===================== API : REPORTS ===================== */
app.post("/api/report", async (req, res) => {
  const { botId, type, payload } = req.body;
  if (!botId || !type) return res.status(400).json({ error: "botId et type requis" });

  await Report.create({ botId, type, payload });
  const bot = await Bot.findById(botId);
  if (bot) {
    const stats = bot.stats || {};
    stats.lastCheck = new Date();
    if (type === "ready") stats.lastReady = new Date();
    if (type === "restart") stats.restarts = (stats.restarts || 0) + 1;
    if (type === "error") stats.errors = (stats.errors || 0) + 1;
    bot.stats = stats;
    await bot.save();
  }

  res.json({ ok: true });
});

/* ===================== API : VERSION ===================== */
app.get("/api/version", async (req, res) => {
  const botId = (req.query.bot_id || "unknown").toString();
  const botVersion = (req.query.version || "unknown").toString();
  const stats = await getStatsDoc();

  stats.downloads = (stats.downloads || 0) + 1;
  stats.bots = stats.bots || {};
  stats.bots[botId] = { botVersion, lastCheck: new Date().toISOString() };
  await stats.save();

  const latest = await Release.findOne().sort({ createdAt: -1 });
  const url =
    latest &&
    `${req.protocol}://${req.get("host")}/uploads/${encodeURIComponent(latest.filename)}`;

  res.json({
    version: latest?.version || "v1.0",
    download: url || null,
    message: "Dernière version disponible",
  });
});

/* ===================== START ===================== */
app.listen(PORT, () =>
  console.log(`✅ Panel en ligne sur http://localhost:${PORT}`)
);
