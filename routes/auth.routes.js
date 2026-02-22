const express = require("express");
const fetch = require("node-fetch");
const router = express.Router();
const log = require("../utils/logger");
const logAuth = log.create('[Auth]');

const { isUserAuthorized, getAuthorizedServerUsers, getServerOwnerId, getServerMachineId } = require("../utils/plex");
const { checkWizarrAccess } = require("../utils/wizarr");

/**
 * Grab le cookie connect.sid de Seerr via le token Plex.
 * Même logique qu'Organizr sso-functions.php#L335.
 *
 * Approche iframe : le cookie est posé avec domain=.votredomaine.com (parent commun
 * entre plex-portal.votredomaine.com et seerr.votredomaine.com) → le browser l'envoie
 * automatiquement quand l'iframe charge seerr.votredomaine.com.
 */
function getSeerrCookieDomain() {
  const publicUrl = process.env.SEERR_PUBLIC_URL || "";
  if (!publicUrl) return null;
  try {
    const hostname = new URL(publicUrl).hostname; // ex: seerr.votredomaine.com
    const parts = hostname.split(".");
    if (parts.length >= 2) return "." + parts.slice(-2).join("."); // .votredomaine.com
  } catch (e) {}
  return null;
}

async function grabSeerrCookie(authToken, res) {
  const seerrUrl = (process.env.SEERR_URL || "").replace(/\/$/, "");
  if (!seerrUrl || !authToken) return;
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${seerrUrl}/api/v1/auth/plex`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ authToken }),
      signal: ctrl.signal
    });
    clearTimeout(timeout);
    if (!r.ok) {
      logAuth.warn(`Seerr SSO échoué: HTTP ${r.status}`);
      return;
    }
    const setCookies = r.headers.raw()["set-cookie"] || [];
    const sidCookie = setCookies.find(c => c.startsWith("connect.sid="));
    if (sidCookie) {
      const value = sidCookie.split(";")[0].replace("connect.sid=", "");
      const cookieDomain = getSeerrCookieDomain();
      const cookieOpts = {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: true  // HTTPS requis pour cross-subdomain
      };
      if (cookieDomain) cookieOpts.domain = cookieDomain;
      res.cookie("connect.sid", decodeURIComponent(value), cookieOpts);
      logAuth.info(`SSO cookie Seerr posé (domain=${cookieDomain || "courant"})`);
    } else {
      logAuth.warn("Seerr n'a pas retourné de connect.sid");
    }
  } catch (e) {
    logAuth.warn("Erreur grab cookie Seerr:", e.message);
  }
}

router.get("/login", async (req, res) => {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8000);
    const response = await fetch("https://plex.tv/api/v2/pins?strong=true", {
      method: "POST",
      headers: {
        "X-Plex-Client-Identifier": "plex-portal-app",
        "X-Plex-Product": "Plex Portal",
        "Accept": "application/json"
      },
      signal: ctrl.signal
    });
    clearTimeout(timeout);

    const data = await response.json();
    req.session.pinId = data.id;

    const forwardUrl = req.appUrl + "/auth-complete";
    res.redirect(
      `https://app.plex.tv/auth#?clientID=plex-portal-app&code=${data.code}&forwardUrl=${encodeURIComponent(forwardUrl)}`
    );
  } catch (err) {
    logAuth.error("Impossible d'initier l'auth Plex:", err.message);
    res.redirect(req.basePath + "/?error=plex_unavailable");
  }
});

router.get("/auth-complete", async (req, res) => {

  if (!req.session.pinId) return res.redirect(req.basePath + "/");

  let authToken = null;

  // Polling du token Plex — première tentative sans délai, puis 800 ms entre chaque essai
  try {
    for (let i = 0; i < 12; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 800));

      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5000);
      const response = await fetch(
        `https://plex.tv/api/v2/pins/${req.session.pinId}`,
        { headers: { "X-Plex-Client-Identifier": "plex-portal-app", "Accept": "application/json" }, signal: ctrl.signal }
      );
      clearTimeout(timeout);

      const data = await response.json();
      if (data.authToken) { authToken = data.authToken; break; }
    }
  } catch (err) {
    logAuth.error("Erreur polling pins Plex:", err.message);
  }

  if (!authToken) return res.redirect(req.basePath + "/");

  let user;
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8000);
    const account = await fetch("https://plex.tv/api/v2/user", {
      headers: { "X-Plex-Token": authToken, "Accept": "application/json" },
      signal: ctrl.signal
    });
    clearTimeout(timeout);
    user = await account.json();
  } catch (err) {
    logAuth.error("Impossible de récupérer le profil Plex:", err.message);
    return res.redirect(req.basePath + "/?error=plex_unavailable");
  }

  logAuth.info(`Connexion: ${user.username} <${user.email}> (ID ${user.id})`);

  // ── Vérification accès serveur (Plex) ─────────────────────────────────────────────
  // On lance en parallèle ownerId (mis en cache dès le 1er login) et machineId
  // (mis en cache dès le 1er login) pendant que le profil vient d'être récupéré.
  // Après le 1er login : ownerId + machineId = instantané (cache mémoire).
  // La liste des utilisateurs autorisés est le seul appel réseau restant.
  let authorizedByPlex = true;
  if (process.env.PLEX_URL && process.env.PLEX_TOKEN) {
    try {
      const userId = parseInt(user.id);

      // 1) Récupérer (ou lire dans le cache) ownerId + machineId en parallèle
      const [ownerId, machineId] = await Promise.all([
        getServerOwnerId(process.env.PLEX_TOKEN),
        getServerMachineId(process.env.PLEX_URL, process.env.PLEX_TOKEN)
      ]);

      if (ownerId && ownerId === userId) {
        // C'est l'admin — aucun appel réseau supplémentaire
        logAuth.info(`User ${userId} — propriétaire du serveur`);
      } else {
        // 2) Seul appel réseau restant : liste des utilisateurs autorisés
        const authorizedUsers = await getAuthorizedServerUsers(process.env.PLEX_TOKEN, machineId);
        if (!authorizedUsers.some(u => u.id === userId)) {
          logAuth.warn(`Accès refusé — ${user.username} (${userId}) absent du serveur`);
          authorizedByPlex = false;
        }
      }
    } catch (authErr) {
      logAuth.warn(`Vérification serveur impossible (${authErr.message}) — accès accordé par défaut`);
    }
  } else {
    logAuth.warn("PLEX_URL ou PLEX_TOKEN manquant — vérification d'accès ignorée");
  }

  if (!authorizedByPlex) {
    return res.redirect((req.basePath || "") + "/?error=unauthorized");
  }

  // ── Vérification accès Wizarr ──────────────────────────────────────────────────────
  // Vérifie que l'utilisateur a un abonnement actif chez Wizarr
  const wizarrCheck = await checkWizarrAccess(user, process.env.WIZARR_URL, process.env.WIZARR_API_KEY);
  if (!wizarrCheck.authorized) {
    logAuth.warn(`Accès Wizarr refusé — ${user.username}: ${wizarrCheck.reason}`);
    return res.redirect((req.basePath || "") + "/?error=wizarr_access_denied");
  }

  // 2) Cookie SSO Seerr — seulement si autorisé
  await grabSeerrCookie(authToken, res);

  logAuth.info(`✅ Connecté: ${user.username} (${user.id})`);

  req.session.user = user;
  req.session.user.joinedAtTimestamp = user.joinedAt;
  req.session.plexToken = authToken;
  delete req.session.pinId;

  res.redirect(req.basePath + "/dashboard");
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect(req.basePath + "/");
  });
});

module.exports = router;
