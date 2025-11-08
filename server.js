const express = require("express");
const session = require("express-session");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 10000;

// Configuration Express
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(bodyParser.urlencoded({ extended: true }));

// Session (utile pour simuler une auth)
app.use(
  session({
    secret: "updatepanel_secret",
    resave: false,
    saveUninitialized: true,
  })
);

// Chemins importants
const releasesDir = path.join(__dirname, "releases");
const versionFile = path.join(__dirname, "version.txt");

// Vérifie le dossier des releases
if (!fs.existsSync(releasesDir)) fs.mkdirSync(releasesDir);

// Simule un rôle admin (à améliorer avec vrai login Discord plus tard)
const ADMIN_PASSWORD = process.env.ADMIN_PASS || "zikopanel";

// Middleware d'authentification simple
function isAuthenticated(req, res, next) {
  if (req.session.loggedIn) return next();
  return res.render("forbidden");
}

// Route de login (simple)
app.get("/login", (req, res) => {
  res.send(`
    <form method="post" action="/login" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;">
      <h2>Connexion Admin</h2>
      <input type="password" name="password" placeholder="Mot de passe" style="padding:10px;margin:10px;width:250px;">
      <button type="submit" style="padding:10px 20px;">Se connecter</button>
    </form>
  `);
});

app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    return res.redirect("/dashboard");
  }
  res.send("❌ Mot de passe incorrect.");
});

// Déconnexion
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// === PAGE PRINCIPALE ===
app.get("/", (req, res) => {
  const version = fs.existsSync(versionFile)
    ? fs.readFileSync(versionFile, "utf8").trim()
    : "v1.0";

  // Charge les releases
  let releases = [];
  if (fs.existsSync(releasesDir)) {
    releases = fs
      .readdirSync(releasesDir)
      .filter((f) => f.endsWith(".zip"))
      .map((f) => {
        const filePath = path.join(releasesDir, f);
        const stats = fs.statSync(filePath);
        return {
          version: f.replace(".zip", ""),
          size: stats.size,
          date: stats.mtime,
        };
      });
  }

  // Statistiques basiques
  const upToDate = 8;
  const outdated = 2;

  // Dernière release
  const latest = releases[releases.length - 1];
  const date = latest
    ? new Date(latest.date).toLocaleString("fr-FR")
    : "Inconnue";

  const downloads = Math.floor(Math.random() * 500);

  res.render("index", {
    version,
    upToDate,
    outdated,
    date,
    downloads,
  });
});

// === DASHBOARD ===
app.get("/dashboard", isAuthenticated, (req, res) => {
  const version = fs.existsSync(versionFile)
    ? fs.readFileSync(versionFile, "utf8").trim()
    : "v1.0";

  let releases = [];
  if (fs.existsSync(releasesDir)) {
    releases = fs
      .readdirSync(releasesDir)
      .filter((f) => f.endsWith(".zip"))
      .map((f) => {
        const filePath = path.join(releasesDir, f);
        const stats = fs.statSync(filePath);
        return {
          version: f.replace(".zip", ""),
          size: stats.size,
          date: stats.mtime,
        };
      });
  }

  res.render("dashboard", { version, releases });
});

// === UPLOAD NOUVELLE VERSION ===
const upload = multer({ dest: "uploads/" });

app.post("/upload", isAuthenticated, upload.single("file"), (req, res) => {
  if (!req.file || !req.body.version) {
    return res.status(400).send("Fichier ou version manquant.");
  }

  const version = req.body.version.startsWith("v")
    ? req.body.version
    : "v" + req.body.version;
  const destPath = path.join(releasesDir, `${version}.zip`);

  fs.renameSync(req.file.path, destPath);
  fs.writeFileSync(versionFile, version);

  console.log(`✅ Nouvelle version ${version} enregistrée.`);
  res.status(200).send("Upload terminé !");
});

// === API VERSION POUR LES BOTS ===
app.get("/api/version", (req, res) => {
  const version = fs.existsSync(versionFile)
    ? fs.readFileSync(versionFile, "utf8").trim()
    : "v1.0";

  const latestZip = path.join(releasesDir, `${version}.zip`);
  if (!fs.existsSync(latestZip))
    return res.status(404).json({ error: "Aucune version trouvée" });

  const download = `https://${req.hostname}/releases/${version}.zip`;

  res.json({ version, download });
});

// === PAGE 403 (accès refusé) ===
app.get("/forbidden", (req, res) => res.render("forbidden"));

// === LANCEMENT DU SERVEUR ===
app.listen(PORT, () => {
  console.log(`✅ Panel en ligne sur http://localhost:${PORT}`);
});
