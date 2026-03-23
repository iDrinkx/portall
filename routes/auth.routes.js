const express = require("express");
const fetch = require("node-fetch");
const router = express.Router();
const log = require("../utils/logger");
const logAuth = log.create('[Auth]');
const { AppSettingQueries, UserQueries } = require("../utils/database");

const { isUserAuthorized, getAuthorizedServerUsers, getServerOwnerId, getServerMachineId } = require("../utils/plex");
const { checkWizarrAccess } = require("../utils/wizarr");
const { getConfigSections, getConfigValue, getMissingRequiredConfigKeys, isSetupComplete, saveEditableConfig } = require("../utils/config");

function getSafeUserLabel(user) {
  return `user#${user?.id || "unknown"}`;
}

async function fetchWithTimeoutAndRetry(url, options = {}, settings = {}) {
  const timeoutMs = Math.max(1000, Number(settings.timeoutMs || 10000));
  const retries = Math.max(1, Number(settings.retries || 1));
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: ctrl.signal
      });
      clearTimeout(timeout);
      return response;
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;
      const isAbort = err?.name === "AbortError" || /aborted a request/i.test(String(err?.message || ""));
      if (attempt >= retries) break;
      if (!isAbort) {
        await new Promise(r => setTimeout(r, 500));
      } else {
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }

  throw lastError || new Error("Request failed");
}

/**
 * Grab le cookie connect.sid de Seerr via le token Plex.
 * Même logique qu'Organizr sso-functions.php#L335.
 *
 * Approche iframe : le cookie est posé avec domain=.votredomaine.com (parent commun
 * entre portall.votredomaine.com et seerr.votredomaine.com) → le browser l'envoie
 * automatiquement quand l'iframe charge seerr.votredomaine.com.
 */
function getSeerrCookieDomain() {
  const publicUrl = getConfigValue("SEERR_PUBLIC_URL", "");
  if (!publicUrl) return null;
  try {
    const hostname = new URL(publicUrl).hostname; // ex: seerr.votredomaine.com
    const parts = hostname.split(".");
    if (parts.length >= 2) return "." + parts.slice(-2).join("."); // .votredomaine.com
  } catch (e) {}
  return null;
}

async function grabSeerrCookie(authToken, res) {
  const seerrUrl = getConfigValue("SEERR_URL", "").replace(/\/$/, "");
  if (!seerrUrl || !authToken) return;
  if (res.headersSent) return;
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

function ensureSetupComplete(req, res, next) {
  if (isSetupComplete()) return next();
  return res.redirect((req.basePath || "") + "/setup");
}

router.get("/setup", (req, res) => {
  if (isSetupComplete()) {
    return res.redirect((req.basePath || "") + "/");
  }

  res.render("setup", {
    layout: false,
    basePath: req.basePath || "",
    configSections: getConfigSections(),
    missingKeys: getMissingRequiredConfigKeys(),
    error: req.query.error || null
  });
});

router.post("/api/setup", (req, res) => {
  if (isSetupComplete()) {
    return res.status(403).json({ error: "Setup déjà terminé" });
  }

  saveEditableConfig(req.body || {}, { markSetupComplete: true });
  const missingKeys = getMissingRequiredConfigKeys();
  if (missingKeys.length > 0) {
    return res.status(400).json({
      error: "Configuration incomplète",
      missingKeys
    });
  }

  return res.json({ success: true, redirectTo: (req.basePath || "") + "/" });
});

router.get("/login", ensureSetupComplete, async (req, res) => {
  try {
    const response = await fetchWithTimeoutAndRetry("https://plex.tv/api/v2/pins?strong=true", {
      method: "POST",
      headers: {
        "X-Plex-Client-Identifier": "portall-app",
        "X-Plex-Product": "portall",
        "Accept": "application/json"
      }
    }, {
      timeoutMs: 20000,
      retries: 2
    });

    const data = await response.json();
    req.session.pinId = data.id;

    const forwardUrl = req.appUrl + "/auth-complete";
    res.redirect(
      `https://app.plex.tv/auth#?clientID=portall-app&code=${data.code}&forwardUrl=${encodeURIComponent(forwardUrl)}`
    );
  } catch (err) {
    logAuth.error("Impossible d'initier l'auth Plex:", err.message);
    res.redirect(req.basePath + "/?error=plex_unavailable");
  }
});

router.get("/auth-complete", ensureSetupComplete, async (req, res) => {

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
        { headers: { "X-Plex-Client-Identifier": "portall-app", "Accept": "application/json" }, signal: ctrl.signal }
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

  logAuth.info(`Connexion Plex reussie pour ${getSafeUserLabel(user)}`);

  // ── Vérification accès serveur (Plex) ──────────────────────────────────────────────
  // Plex est BLOQUANT (obligatoire pour le login)
  let authorizedByPlex = true;
  let isAdmin = false;
  const plexUrl = getConfigValue("PLEX_URL", "");
  const configuredPlexToken = String(getConfigValue("PLEX_TOKEN", "") || "").trim();
  const runtimePlexToken = String(AppSettingQueries.get("runtime_plex_cloud_token", "") || "").trim();
  const persistedAdminUserId = String(AppSettingQueries.get("admin_user_id", "") || "").trim();
  const adminLookupToken = String(runtimePlexToken || configuredPlexToken || "").trim();
  const plexServerToken = String(configuredPlexToken || runtimePlexToken || authToken || "").trim();

  if (persistedAdminUserId && Number(persistedAdminUserId) === Number(user.id)) {
    isAdmin = true;
  }

  if (plexUrl && adminLookupToken) {
    try {
      const userId = parseInt(user.id);
      const [ownerId, machineId] = await Promise.all([
        getServerOwnerId(adminLookupToken),
        getServerMachineId(plexUrl, plexServerToken)
      ]);

      if (ownerId && ownerId === userId) {
        isAdmin = true;
        logAuth.info(`Proprietaire du serveur detecte pour user#${userId}`);
      } else {
        const authorizedUsers = await getAuthorizedServerUsers(adminLookupToken, machineId);
        if (!authorizedUsers.some(u => u.id === userId)) {
          logAuth.warn(`Acces Plex refuse pour user#${userId}`);
          authorizedByPlex = false;
        }
      }
    } catch (authErr) {
      logAuth.warn(`Vérification Plex impossible (${authErr.message}) — accès accordé par défaut`);
    }
  } else if (plexUrl && !isAdmin) {
    logAuth.warn("Aucun token admin Plex disponible pour verifier les acces serveur — acces accorde par defaut");
  }

  if (!authorizedByPlex) {
    return res.redirect((req.basePath || "") + "/?error=unauthorized");
  }

  if (persistedAdminUserId) {
    if (Number(persistedAdminUserId) === Number(user.id)) {
      isAdmin = true;
    }
  } else {
    AppSettingQueries.set("admin_user_id", String(user.id));
    isAdmin = true;
    logAuth.warn(`Aucun admin persiste — ${getSafeUserLabel(user)} defini comme admin principal`);
  }

  logAuth.info(`Session ouverte pour ${getSafeUserLabel(user)}`);

  req.session.user = user;
  req.session.user.joinedAtTimestamp = user.joinedAt;
  req.session.user.isAdmin = isAdmin;
  req.session.plexToken = authToken;
  delete req.session.pinId;

  if (isAdmin && authToken) {
    try {
      AppSettingQueries.set("runtime_plex_cloud_token", authToken);
      logAuth.info(`Token Plex cloud mis a jour pour l'admin (${getSafeUserLabel(user)})`);
    } catch (err) {
      logAuth.warn(`Impossible de persister le token Plex cloud: ${err.message}`);
    }
  }

  // 💾 Sauvegarder joinedAtTimestamp dans la DB pour cohérence XP/niveau avec classement
  try {
    UserQueries.upsert(
      user.username,
      user.id || null,
      user.email || null,
      user.joinedAt || null  // Timestamp Unix ou ISO string
    );
    logAuth.debug(`✅ User sauvegardé en DB avec joinedAt=${user.joinedAt}`);
  } catch (err) {
    logAuth.warn(`⚠️  Erreur sauvegarde DB: ${err.message}`);
  }

  // Poser le cookie Seerr avant le redirect pour éviter "headers already sent"
  try {
    await grabSeerrCookie(authToken, res);
  } catch (err) {
    logAuth.warn(`Seerr SSO — ${err.message}`);
  }

  res.redirect(req.basePath + "/dashboard");

  // ── Vérifications en ARRIÈRE-PLAN (ne bloquent pas le login) ────────────────────────
  // L'admin Plex est autorisé par définition et ne dépend pas de Wizarr.
  if (!isAdmin) {
    checkWizarrAccess(user, getConfigValue("WIZARR_URL", ""), getConfigValue("WIZARR_API_KEY", ""))
      .then(wizarrCheck => {
        if (!wizarrCheck.authorized) {
          logAuth.warn(`Accès Wizarr refusé — ${user.username}: ${wizarrCheck.reason}`);
        }
      })
      .catch(err => {
        logAuth.warn(`Vérification Wizarr échouée — ${err.message}`);
      });
  } else {
    logAuth.info(`Vérification Wizarr ignorée pour admin Plex (${getSafeUserLabel(user)})`);
  }

  if (isAdmin) {
    try {
      const { refreshClassementCache } = require("../utils/cron-classement-refresh");
      refreshClassementCache().catch(err => {
        logAuth.warn(`Refresh classement post-login admin échoué: ${err.message}`);
      });
    } catch (err) {
      logAuth.warn(`Impossible de lancer le refresh classement post-login: ${err.message}`);
    }
  }
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect(req.basePath + "/");
  });
});

module.exports = router;
