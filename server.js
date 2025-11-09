// server.js
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();

/* ===================== CONFIG ===================== */
const OWNER_ID = process.env.OWNER_ID || "1398750844459024454";
const SESSION_SECRET = process.env.SESSION_SECRET || "super_secret_session";
const PORT = process.env.PORT || 3000;

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const DISCORD_ROLE_ID = process.env.DISCORD_ROLE_ID || ""; // rôle “Acheteurs”
const DISCORD_OBSOLETE_PING = process.env.DISCORD_OBSOLETE_PING === "1"; // ping obsolètes sur API/version

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const RELEASES_FILE = path.join(DATA_DIR, "releases.json");
const STATS_FILE = path.join(DATA_DIR, "stats.json");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  return fallback;
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

/**
 * releases: {
 *   latest: "v1.0",
 *   items: [ { version, filename, createdAt, notes } ]
 * }
 */
let releases = readJSON(RELEASES_FILE, { latest: "v1.0", items: [] });
/**
 * stats: {
 *   downloads: number,
 *   bots: {
 *     [botId]: { botVersion, lastCheck, lastNotifiedForVersion? }
 *   }
 * }
 */
let stats = readJSON(STATS_FILE, { downloads: 0, bots: {} });

/* ===================== EXPRESS / EJS ===================== */
app.set("view engine", "ejs");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public"))); // CSS + images
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
      callbackURL: process.env.CALLBACK_URL, // ex: https://ton-service.onrender.com/callback
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
function panelUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

/* ===================== WEBHOOKS ===================== */
async function sendReleaseWebhook({ req, version, notes, filename, createdAt }) {
  if (!DISCORD_WEBHOOK_URL) return;

  const content = DISCORD_ROLE_ID ? `<@&${DISCORD_ROLE_ID}>` : "";
  const urlDashboard = `${panelUrl(req)}/dashboard`;
  const embed = {
    title: `🆕 Nouvelle version disponible — ${version}`,
    description:
      notes && notes.trim().length
        ? notes.trim()
        : "Aucune note fournie pour cette version.",
    color: 0x6c8cff,
    thumbnail: { url: `${panelUrl(req)}/logo.png` },
    fields: [
      { name: "📦 Fichier", value: filename, inline: true },
      { name: "📅 Publiée le", value: formatDate(createdAt), inline: true },
    ],
    footer: { text: "Home Update Panel" },
  };
  const components = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: "Voir le Dashboard",
          url: urlDashboard,
        },
      ],
    },
  ];

  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        allowed_mentions: {
          parse: [],
          roles: DISCORD_ROLE_ID ? [DISCORD_ROLE_ID] : [],
        },
        embeds: [embed],
        components,
      }),
    });
  } catch (e) {
    // on ignore les erreurs webhook pour ne pas casser l’upload
  }
}

async function sendObsoleteWebhook({ req, botId, botVersion, latest }) {
  if (!DISCORD_WEBHOOK_URL || !DISCORD_OBSOLETE_PING) return;

  const already = stats.bots?.[botId]?.lastNotifiedForVersion;
  if (already === latest) return; // évite spam : déjà notifié pour cette version

  const content = DISCORD_ROLE_ID ? `<@&${DISCORD_ROLE_ID}>` : "";
  const urlDashboard = `${panelUrl(req)}/dashboard`;
  const embed = {
    title: `⚠️ Bot obsolète détecté`,
    description: `Un bot a contacté l’API avec une version **${botVersion}** alors que la dernière est **${latest}**.`,
    color: 0xffc107,
    fields: [
      { name: "Bot ID", value: botId, inline: true },
      { name: "Version bot", value: botVersion, inline: true },
      { name: "Dernière version", value: latest, inline: true },
    ],
    footer: { text: "Home Update Panel" },
  };
  const components = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: "Voir le Dashboard",
          url: urlDashboard,
        },
      ],
    },
  ];

  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        allowed_mentions: {
          parse: [],
          roles: DISCORD_ROLE_ID ? [DISCORD_ROLE_ID] : [],
        },
        embeds: [embed],
        components,
      }),
    });
    // marque comme notifié pour cette “latest”
    stats.bots[botId] = {
      ...(stats.bots[botId] || {}),
      lastNotifiedForVersion: latest,
    };
    writeJSON(STATS_FILE, stats);
  } catch (e) {}
}

/* ===================== AUTH ===================== */
app.get("/login", passport.authenticate("discord"));
app.get(
  "/callback",
  passport.authenticate("discord", { failureRedirect: "/forbidden" }),
  (req, res) => res.redirect("/dashboard")
);
app.get("/logout", (req, res) => {
  req.logout(() => res.redirect("/"));
});
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
  });
});

/* ===================== UPLOAD ===================== */
app.post("/upload", requireOwner, (req, res) => {
  const m = upload.single("zip");
  m(req, res, async (err) => {
    if (err) {
      return res.status(400).send(err.message || "Erreur d’upload");
    }
    const rawVersion = (req.body.version || "").trim();
    const notes = (req.body.notes || "").trim();
    if (!rawVersion) return res.status(400).send("Version manquante.");
    if (!req.file) return res.status(400).send("Aucun fichier ZIP reçu.");

    const version = /^v/i.test(rawVersion) ? rawVersion : "v" + rawVersion;

    const desiredName = `bot-${version}.zip`;
    const currentPath = path.join(UPLOAD_DIR, req.file.filename);
    const targetPath = path.join(UPLOAD_DIR, desiredName);
    if (req.file.filename !== desiredName) {
      try {
        fs.renameSync(currentPath, targetPath);
      } catch (e) {
        return res.status(500).send("Impossible de renommer le fichier.");
      }
    }

    const createdAt = new Date().toISOString();
    const existingIndex = releases.items.findIndex((r) => r.version === version);
    const record = { version, filename: desiredName, createdAt, notes };
    if (existingIndex >= 0) releases.items[existingIndex] = record;
    else releases.items.push(record);
    releases.latest = version;
    writeJSON(RELEASES_FILE, releases);

    // webhook release
    await sendReleaseWebhook({
      req,
      version,
      notes,
      filename: desiredName,
      createdAt,
    });

    return res.redirect("/dashboard");
  });
});

/* ===================== API POUR LES BOTS ===================== */
app.get("/api/version", async (req, res) => {
  const botId = (req.query.bot_id || "unknown").toString();
  const botVersion = (req.query.version || "unknown").toString();

  stats.downloads = (stats.downloads || 0) + 1;
  stats.bots[botId] = {
    ...(stats.bots[botId] || {}),
    botVersion,
    lastCheck: new Date().toISOString(),
  };
  writeJSON(STATS_FILE, stats);

  const rec = releases.items.find((r) => r.version === releases.latest);
  const url =
    rec &&
    `${req.protocol}://${req.get("host")}/uploads/${encodeURIComponent(
      rec.filename
    )}`;

  // ping obsolète si activé et version différente
  if (DISCORD_OBSOLETE_PING && botVersion && releases.latest && botVersion !== releases.latest) {
    await sendObsoleteWebhook({
      req,
      botId,
      botVersion,
      latest: releases.latest,
    });
  }

  res.json({
    version: releases.latest,
    download: url,
    message: "Dernière version disponible",
  });
});

/* ===================== START ===================== */
app.listen(PORT, () => {
  console.log(`✅ Panel en ligne sur http://localhost:${PORT}`);
});
