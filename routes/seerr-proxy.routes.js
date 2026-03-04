/**
 * SEERR IFRAME ROUTE
 * ==================
 * Affiche Seerr dans une iframe full-page.
 *
 * Auth SSO (Organizr style) :
 *   Au login, auth.routes.js  grabSeerrCookie() r�cup�re le connect.sid de Seerr
 *   et le pose dans le browser avec domain=.votredomaine.com (parent commun entre
 *   plex-portal.votredomaine.com et seerr.votredomaine.com).
 *   Le browser l'envoie automatiquement quand l'iframe charge seerr.votredomaine.com  SSO.
 *
 * Config requise :
 *   SEERR_URL        = URL interne (pour l'API auth au login)
 *   SEERR_PUBLIC_URL = URL publique HTTPS (src de l'iframe)
 */

const express = require("express");
const fetch   = require("node-fetch");
const router  = express.Router();
const log = require("../utils/logger");
const { getConfigValue } = require("../utils/config");
const logSSO = log.create('[Seerr SSO]');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect((req.basePath || "") + "/");
  }
  next();
}

function getSeerrCookieDomain() {
  const publicUrl = getConfigValue("SEERR_PUBLIC_URL", "");
  if (!publicUrl) return null;
  try {
    const hostname = new URL(publicUrl).hostname;
    const parts = hostname.split(".");
    if (parts.length >= 2) return "." + parts.slice(-2).join(".");
  } catch (e) {}
  return null;
}

async function grabSeerrCookie(authToken, res, username) {
  const seerrUrl = getConfigValue("SEERR_URL", "").replace(/\/$/, "");
  if (!seerrUrl) { logSSO.warn('SEERR_URL non configuré'); return false; }
  if (!authToken) { logSSO.warn(`Token absent pour ${username} — reconnexion requise`); return false; }
  try {
    const r = await fetch(`${seerrUrl}/api/v1/auth/plex`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ authToken })
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      logSSO.warn(`HTTP ${r.status} pour ${username} — ${body.slice(0, 120)}`);
      return false;
    }
    const setCookies = r.headers.raw()["set-cookie"] || [];
    const sidCookie = setCookies.find(c => c.startsWith("connect.sid="));
    if (sidCookie) {
      const value = sidCookie.split(";")[0].replace("connect.sid=", "");
      const cookieDomain = getSeerrCookieDomain();
      const cookieOpts = { path: "/", httpOnly: true, sameSite: "lax", secure: true };
      if (cookieDomain) cookieOpts.domain = cookieDomain;
      res.cookie("connect.sid", decodeURIComponent(value), cookieOpts);
      logSSO.info(`Cookie rafraîchi pour ${username} (domain=${cookieDomain || "courant"})`);
      return true;
    }
    logSSO.warn(`connect.sid absent pour ${username}`);
    return false;
  } catch (e) {
    logSSO.warn(`Erreur pour ${username}:`, e.message);
    return false;
  }
}

router.get("/seerr", requireAuth, async (req, res) => {
  const seerrPublicUrl = getConfigValue("SEERR_PUBLIC_URL", "").replace(/\/$/, "");
  if (!seerrPublicUrl) {
    return res.status(503).send(`
      <html><body style="background:#0f1117;color:#e2e8f0;font-family:sans-serif;
        display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center">
          <div style="font-size:3rem"></div>
          <h2>SEERR_PUBLIC_URL non configuré</h2>
          <p style="color:#94a3b8">Renseignez l'URL publique Seerr dans Parametres &gt; Connexions</p>
          <code style="color:#64748b">Champ attendu : URL Seerr publique</code>
        </div>
      </body></html>
    `);
  }

  // Rafraîchir le cookie Seerr à chaque visite — gère les cas :
  //  - premier passage après un redémarrage serveur
  //  - session Seerr expirée sans que la session portail soit expirée
  const plexToken = req.session.plexToken;
  const username  = req.session.user?.username || req.session.user?.email || "inconnu";
  await grabSeerrCookie(plexToken, res, username);

  // Rendu sans layout (page standalone full-screen)
  res.render("seerr/index", {
    layout: false,
    seerrPublicUrl,
    locale: res.locals.locale || "fr",
    basePath: req.basePath || "",
    siteTitle: res.locals.siteTitle || "Plex-Portal"
  });
});

module.exports = router;
