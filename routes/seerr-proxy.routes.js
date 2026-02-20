/**
 * SEERR IFRAME ROUTE
 * ==================
 * Affiche Overseerr dans une iframe full-page.
 *
 * Auth SSO (Organizr style) :
 *   Au login, auth.routes.js  grabSeerrCookie() récupère le connect.sid de Seerr
 *   et le pose dans le browser avec domain=.idrinktv.ovh (parent commun entre
 *   plex-portal.idrinktv.ovh et overseerr.idrinktv.ovh).
 *   Le browser l'envoie automatiquement quand l'iframe charge overseerr.idrinktv.ovh  SSO.
 *
 * Config requise :
 *   OVERSEERR_URL        = URL interne (pour l'API auth au login)
 *   OVERSEERR_PUBLIC_URL = URL publique HTTPS (src de l'iframe)
 */

const express = require("express");
const router  = express.Router();

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect((req.basePath || "") + "/");
  }
  next();
}

const overseerrPublicUrl = (process.env.OVERSEERR_PUBLIC_URL || "").replace(/\/$/, "");

router.get("/overseerr", requireAuth, (req, res) => {
  if (!overseerrPublicUrl) {
    return res.status(503).send(`
      <html><body style="background:#0f1117;color:#e2e8f0;font-family:sans-serif;
        display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center">
          <div style="font-size:3rem"></div>
          <h2>OVERSEERR_PUBLIC_URL non configuré</h2>
          <p style="color:#94a3b8">Ajoutez cette variable d'env dans votre docker-compose.yml</p>
          <code style="color:#64748b">OVERSEERR_PUBLIC_URL: "https://overseerr.votredomaine.com"</code>
        </div>
      </body></html>
    `);
  }
  // Rendu sans layout (page standalone full-screen)
  res.render("overseerr/index", { layout: false, overseerrPublicUrl });
});

module.exports = router;
