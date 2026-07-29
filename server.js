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
const Trash = require("./models/Trash"); // 🔄 Corbeille

const app = express();

/* ===================== CONFIG ===================== */
const OWNER_IDS = process.env.OWNER_ID
  ? process.env.OWNER_ID.split(",")
  : ["1398750844459024454", "924068219025784842"]; // plusieurs IDs ici

const SESSION_SECRET = process.env.SESSION_SECRET || "super_secret_session";
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ROLE_ID = process.env.DISCORD_ROLE_ID;
const SUPPORT_LINK = "https://discord.gg/b9tS35tkjN";

// Clé utilisée par le BOT DISCORD (pas un humain) pour interroger /api/status.
// Mets la même valeur dans le config.js du bot (manager_api_key) et dans les
// variables d'environnement de ce serveur (MANAGER_API_KEY).
const MANAGER_API_KEY = process.env.MANAGER_API_KEY || "changeme";

function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (key && key === MANAGER_API_KEY) return next();
  return res.status(401).json({ error: "Clé API invalide ou manquante." });
}

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

/* ===================== OWNER CHECK ===================== */
function isOwner(req) {
  return req.user && OWNER_IDS.includes(req.user.id);
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

/* ===================== DISCORD API (DM propriétaire) ===================== */
// Envoie un message privé au propriétaire d'un bot, EN UTILISANT LE TOKEN DU BOT LUI-MÊME.
// Ne nécessite aucune action du côté de l'instance (contrairement au restart / à l'update
// qui sont mis en file d'attente et exécutés au prochain heartbeat).
async function sendDiscordDM(token, userId, content) {
  const dmRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!dmRes.ok) {
    throw new Error(`Création du salon DM impossible (${dmRes.status}) : ${await dmRes.text()}`);
  }
  const channel = await dmRes.json();

  const msgRes = await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
  if (!msgRes.ok) {
    throw new Error(`Envoi du message impossible (${msgRes.status}) : ${await msgRes.text()}`);
  }
  return msgRes.json();
}

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
      Math.max(
        0,
        bots.length - bots.filter((b) => b.botVersion === version).length
      ) || 0,
    support: SUPPORT_LINK,
  });
});

/* ===================== DASHBOARD (OWNER) — page unique à onglets ===================== */
app.get("/dashboard", requireOwner, async (req, res) => {
  const stats = await getStatsDoc();
  const releases = await Release.find().sort({ createdAt: -1 });
  const latest = releases[0]?.version || "v1.0";
  const bots = Object.values(stats.bots || {}).filter(Boolean);

  // --- Bots connectés (fusion de l'ancienne page /owner/status) ---
  const liveBots = await getConnectedBots();
  const registered = await Bot.find().sort({ createdAt: -1 }).lean();
  const liveByDiscordId = new Map(liveBots.map((b) => [b.botId, b]));
  const registeredDiscordIds = new Set(
    registered.map((b) => b.discordBotId).filter(Boolean)
  );
  const registeredBots = registered.map((b) => ({
    ...b,
    live: b.discordBotId ? liveByDiscordId.get(b.discordBotId) || null : null,
  }));
  const unregisteredLive = liveBots.filter((b) => !registeredDiscordIds.has(b.botId));

  // --- Corbeille ---
  const trashItems = await Trash.find().sort({ deletedAt: -1 }).lean();

  const tab = ["home", "bots", "update", "trash"].includes(req.query.tab)
    ? req.query.tab
    : "home";

  res.render("dashboard", {
    user: req.user,
    tab,
    latest,
    releases,
    stats,
    totalBots: bots.length,
    upToDate: bots.filter((b) => b.botVersion === latest).length,
    outdated:
      Math.max(
        0,
        bots.length - bots.filter((b) => b.botVersion === latest).length
      ) || 0,
    registeredBots,
    unregisteredLive,
    trashItems,
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
              footer: { text: "AddUpdate Panel" },
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

    res.redirect("/dashboard?tab=update");
  });
});

/* ===================== DOWNLOAD RELEASES ===================== */
app.get("/download/latest", requireOwner, async (req, res) => {
  const r = await Release.findOne().sort({ createdAt: -1 });
  if (!r) return res.status(404).send("Aucune version disponible.");

  const file = path.join(UPLOAD_DIR, r.filename);
  if (!fs.existsSync(file)) {
    return res.status(404).send("Fichier introuvable sur le serveur.");
  }

  res.download(file, r.filename);
});

app.get("/download/:version", requireOwner, async (req, res) => {
  const { version } = req.params;
  const r = await Release.findOne({ version });
  if (!r) return res.status(404).send("Version introuvable");

  const file = path.join(UPLOAD_DIR, r.filename);
  if (!fs.existsSync(file)) {
    return res.status(404).send("Fichier introuvable sur le serveur.");
  }

  res.download(file, r.filename);
});

/* ===================== CORBEILLE / DELETE / REVERT ===================== */

// Suppression logique : envoi dans Trash, mais on ne supprime pas le ZIP
app.post("/delete/:version", requireOwner, async (req, res) => {
  const { version } = req.params;

  const release = await Release.findOne({ version });
  if (!release) return res.status(404).send("Version introuvable");

  await Trash.create({
    version: release.version,
    filename: release.filename,
    notes: release.notes || "",
  });

  await Release.deleteOne({ version });

  console.log(`🗑️ Version envoyée à la corbeille : ${version}`);
  res.redirect("/dashboard?tab=update");
});

// Revenir sur une version : on change juste son createdAt pour la repasser en "dernière"
app.post("/revert/:version", requireOwner, async (req, res) => {
  const { version } = req.params;

  const r = await Release.findOne({ version });
  if (!r) return res.status(404).send("Version introuvable");

  r.createdAt = new Date();
  await r.save();

  console.log(`🔁 Version revert : ${version}`);
  res.redirect("/dashboard?tab=update");
});

// Ancienne page corbeille -> onglet unique
app.get("/trash", requireOwner, (req, res) => res.redirect("/dashboard?tab=trash"));

// Restaurer une release depuis la corbeille
app.post("/trash/restore/:id", requireOwner, async (req, res) => {
  const { id } = req.params;
  const item = await Trash.findById(id);
  if (!item) return res.status(404).send("Élément introuvable");

  // Si une release avec cette version existe déjà, on la remplace
  await Release.findOneAndUpdate(
    { version: item.version },
    {
      version: item.version,
      filename: item.filename,
      notes: item.notes || "",
      createdAt: new Date(),
    },
    { upsert: true }
  );

  await Trash.deleteOne({ _id: id });

  console.log(`♻️ Version restaurée depuis la corbeille : ${item.version}`);
  res.redirect("/dashboard?tab=trash");
});

// Suppression définitive + suppression du ZIP si présent
app.post("/trash/delete/:id", requireOwner, async (req, res) => {
  const { id } = req.params;
  const item = await Trash.findById(id);
  if (!item) return res.status(404).send("Élément introuvable");

  const filePath = path.join(UPLOAD_DIR, item.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    console.log(`🗑️ Fichier supprimé définitivement : ${item.filename}`);
  }

  await Trash.deleteOne({ _id: id });

  res.redirect("/dashboard?tab=trash");
});

/* ===================== BOTS CONNECTÉS (live status) ===================== */
const ONLINE_THRESHOLD_MS = 90 * 1000; // le bot ping toutes les 20s, 90s = tolérant

async function getConnectedBots() {
  const stats = await getStatsDoc();
  return Object.entries(stats.bots || {})
    .filter(([id]) => id !== "unknown")
    .map(([botId, data]) => {
      const lastCheckMs = data.lastCheck ? new Date(data.lastCheck).getTime() : 0;
      return {
        botId,
        tag: data.tag || null,
        botVersion: data.botVersion || "Inconnue",
        startedAt: data.startedAt || null,
        lastCheck: data.lastCheck || null,
        online: Date.now() - lastCheckMs < ONLINE_THRESHOLD_MS,
      };
    })
    .sort((a, b) => Number(b.online) - Number(a.online));
}

// Ancienne page "Bots connectés" -> onglet unique du dashboard
app.get("/owner/status", requireOwner, (req, res) => res.redirect("/dashboard?tab=bots"));
app.get("/owner/bots", requireOwner, (req, res) => res.redirect("/dashboard?tab=bots"));

// API JSON (le bot Discord l'appelle avec le header x-api-key)
app.get("/api/status", requireApiKey, async (req, res) => {
  const bots = await getConnectedBots();
  res.json({ bots });
});

/* ===================== AUTO-ENREGISTREMENT (appelé PAR le bot, pas par l'owner) =====================
   Le bot s'enregistre lui-même dès son démarrage (voir source/events/manager/connection.js côté bot).
   Il n'y a donc plus d'ajout manuel depuis le site : dès qu'une instance démarre avec un token valide
   dans son config.js, elle apparaît ici et est immédiatement pilotable. */
app.post("/api/bots/register", requireApiKey, async (req, res) => {
  const { discordBotId, tag, token, ownerId, name, notes } = req.body || {};
  if (!discordBotId || !token) {
    return res.status(400).json({ error: "discordBotId et token requis." });
  }

  const update = {
    name: name || tag || discordBotId,
    discordBotId,
    token: encrypt(token),
  };
  if (ownerId) update.ownerId = ownerId;
  if (notes) update.meta = { notes };

  const bot = await Bot.findOneAndUpdate(
    { discordBotId },
    { $set: update, $setOnInsert: { stats: { restarts: 0, errors: 0 } } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`🔗 Bot auto-enregistré : ${bot.name} (${discordBotId})`);
  res.json({ ok: true, id: bot._id });
});

/* ===================== OWNER : GESTION DES BOTS (fiches + actions à distance) ===================== */
app.post("/owner/bots/:id/delete", requireOwner, async (req, res) => {
  const { id } = req.params;
  const bot = await Bot.findById(id);
  if (!bot) return res.status(404).send("Bot introuvable.");

  await Bot.deleteOne({ _id: id });
  await Report.deleteMany({ botId: id });

  console.log(`🗑️ Bot supprimé : ${bot.name}`);
  res.redirect("/dashboard?tab=bots");
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

// Redémarrage à distance : mis en file d'attente, récupéré par l'instance au prochain
// heartbeat (/api/ping). Nécessite que le bot ait bien renseigné son discordBotId ici
// ET qu'il vérifie le champ "command" reçu en réponse de /api/ping côté code du bot.
app.post("/owner/bots/:id/restart", requireOwner, async (req, res) => {
  const bot = await Bot.findById(req.params.id);
  if (!bot) return res.status(404).send("Bot introuvable.");
  if (!bot.discordBotId) {
    return res
      .status(400)
      .send("Aucun ID Discord de bot renseigné : impossible de cibler l'instance en direct.");
  }

  bot.pendingCommand = { type: "restart", payload: "", requestedAt: new Date() };
  await bot.save();

  console.log(`🔁 Redémarrage demandé pour : ${bot.name}`);
  res.redirect("/dashboard?tab=bots");
});

// Mise à jour forcée à distance : même principe que le restart, la commande "update"
// est délivrée à l'instance à son prochain heartbeat.
app.post("/owner/bots/:id/force-update", requireOwner, async (req, res) => {
  const bot = await Bot.findById(req.params.id);
  if (!bot) return res.status(404).send("Bot introuvable.");
  if (!bot.discordBotId) {
    return res
      .status(400)
      .send("Aucun ID Discord de bot renseigné : impossible de cibler l'instance en direct.");
  }

  bot.pendingCommand = { type: "update", payload: "", requestedAt: new Date() };
  await bot.save();

  console.log(`⬆️ Mise à jour forcée demandée pour : ${bot.name}`);
  res.redirect("/dashboard?tab=bots");
});

// Message privé envoyé PAR le bot À son propriétaire (utilise le token du bot, envoi immédiat)
app.post("/owner/bots/:id/message", requireOwner, async (req, res) => {
  const bot = await Bot.findById(req.params.id);
  if (!bot) return res.status(404).send("Bot introuvable.");

  const message = (req.body.message || "").trim();
  if (!message) return res.status(400).send("Message vide.");
  if (!bot.ownerId) return res.status(400).send("Aucun propriétaire associé à ce bot.");

  try {
    const token = decrypt(bot.token);
    await sendDiscordDM(token, bot.ownerId, message);
    console.log(`✉️ Message privé envoyé par ${bot.name} à ${bot.ownerId}`);
    res.redirect("/dashboard?tab=bots");
  } catch (e) {
    console.error("❌ Erreur envoi DM :", e.message);
    res.status(500).send("Erreur lors de l'envoi du message : " + e.message);
  }
});

/* ===================== API : REPORTS ===================== */
app.post("/api/report", async (req, res) => {
  const { botId, type, payload } = req.body;
  if (!botId || !type)
    return res.status(400).json({ error: "botId et type requis" });

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

// Poll côté navigateur (dashboard) pour afficher les popups de mise à jour/redémarrage
app.get("/api/reports/recent", requireOwner, async (req, res) => {
  const sinceId = req.query.sinceId;
  const query = {};
  if (sinceId && /^[a-f0-9]{24}$/i.test(sinceId)) {
    query._id = { $gt: sinceId };
  } else {
    query.createdAt = { $gte: new Date(Date.now() - 60 * 1000) };
  }

  const reports = await Report.find(query).sort({ createdAt: 1 }).limit(50).lean();
  const botIds = [...new Set(reports.map((r) => String(r.botId || "")))].filter(Boolean);
  const botsById = new Map(
    (await Bot.find({ _id: { $in: botIds } }).select("name").lean()).map((b) => [String(b._id), b.name])
  );

  res.json({
    reports: reports.map((r) => ({
      id: r._id,
      botId: r.botId,
      botName: botsById.get(String(r.botId)) || "Bot",
      type: r.type,
      payload: r.payload || {},
      createdAt: r.createdAt,
    })),
  });
});

async function upsertBotStatus(stats, botId, botVersion, tag, startedAtRaw) {
  stats.bots = stats.bots || {};
  const existing = stats.bots[botId] || {};
  stats.bots[botId] = {
    botVersion: botVersion || existing.botVersion || "unknown",
    tag: tag || existing.tag || null,
    startedAt: startedAtRaw ? new Date(startedAtRaw).toISOString() : existing.startedAt || null,
    lastCheck: new Date().toISOString(),
  };
  stats.markModified("bots"); // nécessaire car "bots" est un champ Mixed
}

/* ===================== API : HEARTBEAT (statut, sans compter de download) ===================== */
app.get("/api/ping", async (req, res) => {
  const botId = (req.query.bot_id || "unknown").toString();
  const botVersion = req.query.version ? req.query.version.toString() : undefined;
  const tag = req.query.tag ? req.query.tag.toString() : undefined;
  const startedAtRaw = req.query.started_at ? Number(req.query.started_at) : null;

  const stats = await getStatsDoc();
  await upsertBotStatus(stats, botId, botVersion, tag, startedAtRaw);
  await stats.save();

  // Y a-t-il une commande à distance en attente pour ce bot (redémarrage / mise à jour) ?
  // Le bot doit vérifier ce champ à chaque heartbeat et agir en conséquence.
  let command = null;
  if (botId && botId !== "unknown") {
    const registered = await Bot.findOne({ discordBotId: botId });
    if (registered?.pendingCommand?.type) {
      command = {
        type: registered.pendingCommand.type,
        payload: registered.pendingCommand.payload || null,
      };
      registered.pendingCommand = { type: null, payload: "", requestedAt: null };
      await registered.save();
    }
  }

  res.json({ ok: true, command });
});

/* ===================== API : VERSION ===================== */
app.get("/api/version", async (req, res) => {
  const botId = (req.query.bot_id || "unknown").toString();
  const botVersion = (req.query.version || "unknown").toString();
  const tag = req.query.tag ? req.query.tag.toString() : undefined;
  const startedAtRaw = req.query.started_at ? Number(req.query.started_at) : null;
  const stats = await getStatsDoc();

  stats.downloads = (stats.downloads || 0) + 1;
  await upsertBotStatus(stats, botId, botVersion, tag, startedAtRaw);
  await stats.save();

  const latest = await Release.findOne().sort({ createdAt: -1 });
  const url =
    latest &&
    `${req.protocol}://${req.get("host")}/uploads/${encodeURIComponent(
      latest.filename
    )}`;

  // 🔧 Met à jour aussi les stats du Bot s'il existe (pour l'onglet "Bots connectés")
  if (botId && botId !== "unknown") {
    try {
      const b = await Bot.findOne({ discordBotId: botId });
      if (b) {
        const s = b.stats || {};
        s.botVersion = botVersion;
        s.lastCheck = new Date();
        b.stats = s;
        await b.save();
      }
    } catch (e) {
      console.warn("Bot introuvable pour mise à jour de version :", e.message);
    }
  }

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
