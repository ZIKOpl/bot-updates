const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const app = express();

/* ===================== CONFIG ===================== */
const OWNER_ID = process.env.OWNER_ID || "1398750844459024454";
const SESSION_SECRET = process.env.SESSION_SECRET || "super_secret_session";
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ROLE_ID = process.env.DISCORD_ROLE_ID;

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

    // --- 🔔 Webhook Discord : nouvelle release ---
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
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 5,
                label: "Accéder à la mise à jour",
                url: `${req.protocol}://${req.get("host")}/uploads/${encodeURIComponent(
                  desiredName
                )}`,
              },
            ],
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

/* ===================== DELETE RELEASE ===================== */
app.post("/delete/:version", requireOwner, (req, res) => {
  const version = req.params.version;
  const release = releases.items.find((r) => r.version === version);
  if (!release) return res.status(404).send("Version introuvable.");

  const filePath = path.join(UPLOAD_DIR, release.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  releases.items = releases.items.filter((r) => r.version !== version);
  if (releases.latest === version && releases.items.length) {
    releases.latest = releases.items[0].version;
  }
  writeJSON(RELEASES_FILE, releases);
  console.log(`🗑️ Release ${version} supprimée`);
  res.redirect("/dashboard");
});

/* ===================== REVERT RELEASE ===================== */
app.post("/releases/:version/revert", requireOwner, async (req, res) => {
  const version = req.params.version;
  const release = releases.items.find((r) => r.version === version);
  if (!release) return res.json({ ok: false, error: "Version introuvable." });

  releases.latest = version;
  writeJSON(RELEASES_FILE, releases);

  // Webhook revert
  if (WEBHOOK_URL) {
    const webhookBody = {
      content: ROLE_ID ? `<@&${ROLE_ID}>` : null,
      embeds: [
        {
          title: `🔁 Reversion effectuée — ${version}`,
          description: "L’ancienne version est redevenue la version active.",
          color: 0xffb347,
          footer: { text: "Home Update Panel" },
          timestamp: new Date().toISOString(),
        },
      ],
    };
    try {
      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(webhookBody),
      });
      console.log("♻️ Reversion annoncée sur Discord");
    } catch (e) {
      console.error("❌ Erreur Webhook revert :", e);
    }
  }

  res.json({ ok: true });
});

/* ===================== API POUR LES BOTS ===================== */
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

app.listen(PORT, () =>
  console.log(`✅ Panel en ligne sur http://localhost:${PORT}`)
);
