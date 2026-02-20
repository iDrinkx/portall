const express = require("express");
const fetch = require("node-fetch");
const router = express.Router();
const log = require("../utils/logger");
const logAuth = log.create('[Auth]');

const { isUserAuthorized } = require("../utils/plex");

/**
 * Grab le cookie connect.sid de Seerr via le token Plex.
 * Même logique qu'Organizr sso-functions.php#L335.
 *
 * Approche iframe : le cookie est posé avec domain=.idrinktv.ovh (parent commun
 * entre plex-portal.idrinktv.ovh et overseerr.idrinktv.ovh) → le browser l'envoie
 * automatiquement quand l'iframe charge overseerr.idrinktv.ovh.
 */
function getSeerrCookieDomain() {
  const publicUrl = process.env.SEERR_PUBLIC_URL || "";
  if (!publicUrl) return null;
  try {
    const hostname = new URL(publicUrl).hostname; // ex: overseerr.idrinktv.ovh
    const parts = hostname.split(".");
    if (parts.length >= 2) return "." + parts.slice(-2).join("."); // .idrinktv.ovh
  } catch (e) {}
  return null;
}

async function grabSeerrCookie(authToken, res) {
  const seerrUrl = (process.env.SEERR_URL || "").replace(/\/$/, "");
  if (!seerrUrl || !authToken) return;
  try {
    const r = await fetch(`${seerrUrl}/api/v1/auth/plex`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ authToken })
    });
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

  const response = await fetch("https://plex.tv/api/v2/pins?strong=true", {
    method: "POST",
    headers: {
      "X-Plex-Client-Identifier": "plex-portal-app",
      "X-Plex-Product": "Plex Portal",
      "Accept": "application/json"
    }
  });

  const data = await response.json();

  req.session.pinId = data.id;

  // Construire l'URL de callback automatiquement
  const forwardUrl = req.appUrl + "/auth-complete";

  res.redirect(
    `https://app.plex.tv/auth#?clientID=plex-portal-app&code=${data.code}&forwardUrl=${encodeURIComponent(forwardUrl)}`
  );
});

router.get("/auth-complete", async (req, res) => {

  if (!req.session.pinId) return res.redirect(req.basePath + "/");

  let authToken = null;

  for (let i = 0; i < 10; i++) {
    const response = await fetch(
      `https://plex.tv/api/v2/pins/${req.session.pinId}`,
      {
        headers: {
          "X-Plex-Client-Identifier": "plex-portal-app",
          "Accept": "application/json"
        }
      }
    );

    const data = await response.json();

    if (data.authToken) {
      authToken = data.authToken;
      break;
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  if (!authToken) return res.redirect(req.basePath + "/");

  const account = await fetch("https://plex.tv/api/v2/user", {
    headers: {
      "X-Plex-Token": authToken,
      "Accept": "application/json"
    }
  });

  const user = await account.json();

  logAuth.info(`Connexion: ${user.username} <${user.email}> (ID ${user.id})`);

  // Vérifier que l'utilisateur a accès au serveur Plex Dark TV
  // - Si PLEX_URL/PLEX_TOKEN ne sont pas configurés → on laisse passer (fail-open)
  // - Si Plex est injoignable → on laisse passer avec warning (évite un lock-out lors d'un redémarrage)
  // - Si Plex répond mais l'utilisateur est absent → accès refusé
  let authorized = true;
  if (process.env.PLEX_URL && process.env.PLEX_TOKEN) {
    try {
      const result = await isUserAuthorized(
        user.id,
        process.env.PLEX_URL,
        process.env.PLEX_TOKEN
      );
      if (result === false) {
        logAuth.warn(`Accès refusé — ${user.username} (${user.id}) absent du serveur`);
        authorized = false;
      }
    } catch (authErr) {
      // Plex injoignable → fail-open, on laisse passer
      logAuth.warn(`Vérification serveur impossible (${authErr.message}) — accès accordé par défaut`);
    }
  } else {
    logAuth.warn("PLEX_URL ou PLEX_TOKEN manquant — vérification d'accès ignorée");
  }

  if (!authorized) {
    return res.redirect((req.basePath || "") + "/?error=unauthorized");
  }

  logAuth.info(`✅ Connecté: ${user.username} (${user.id})`);

  req.session.user = user;
  req.session.user.joinedAtTimestamp = user.joinedAt;
  req.session.plexToken = authToken;
  delete req.session.pinId;

  // Grab le cookie Seerr immédiatement au login (same as Organizr)
  // Le cookie connect.sid est posé en cross-subdomain → l'iframe overseerr.idrinktv.ovh
  // est authentifiée automatiquement sans que l'utilisateur ait à se re-connecter.
  await grabSeerrCookie(authToken, res);

  res.redirect(req.basePath + "/dashboard");
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect(req.basePath + "/");
  });
});

module.exports = router;
