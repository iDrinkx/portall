/**
 * SEERR FULL PROXY
 * ================
 * Proxifie l'intégralité de l'interface Seerr via plex-portal.
 * Seerr n'a pas besoin d'être exposé publiquement.
 *
 * PRÉREQUIS : ajouter dans le docker-compose de Seerr :
 *   environment:
 *     BASE_URL: /overseerr-frame
 *
 * Flux : Browser → GET /overseerr-frame/* → plex-portal (cookie injection) → Seerr interne
 */

const express = require("express");
const router  = express.Router();
const { createProxyMiddleware } = require("http-proxy-middleware");
const fetch = require("node-fetch");

/* ===============================
   AUTH GUARD
=============================== */
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect((req.basePath || "") + "/");
  next();
}

/* ===============================
   PAGE /overseerr → iframe wrapper
=============================== */
router.get("/overseerr", requireAuth, async (req, res) => {
  // Authentification SSO automatique si pas encore de cookie Seerr
  if (!req.session.overseerrCookie) {
    await doSeerrAuth(req);
  }
  res.render("overseerr/iframe", {
    user: req.session.user,
    basePath: req.basePath || "",
    layout: false
  });
});

/* ===============================
   SSO : auth Seerr via token Plex
=============================== */
async function doSeerrAuth(req) {
  const overseerrUrl = (process.env.OVERSEERR_URL || "").replace(/\/$/, "");
  const plexToken    = req.session.plexToken;
  if (!overseerrUrl || !plexToken) return;

  try {
    const res = await fetch(`${overseerrUrl}/api/v1/auth/plex`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ authToken: plexToken })
    });

    if (!res.ok) return;

    const setCookies = res.headers.raw()["set-cookie"] || [];
    if (setCookies.length > 0) {
      // Garder toutes les valeurs de cookie (connect.sid, etc.)
      req.session.overseerrCookie = setCookies
        .map(c => c.split(";")[0])
        .join("; ");
    }

    const userData = await res.json().catch(() => null);
    if (userData) req.session.overseerrUser = userData;

    console.log("[SeerrProxy] ✅ Cookie de session Seerr obtenu");
  } catch (e) {
    console.warn("[SeerrProxy] ⚠️  Auth Seerr échouée:", e.message);
  }
}

/* ===============================
   RECONNEXION SSO (appelé par le client si 401)
=============================== */
router.post("/overseerr-reauth", requireAuth, async (req, res) => {
  delete req.session.overseerrCookie;
  delete req.session.overseerrUser;
  await doSeerrAuth(req);
  res.json({ ok: !!req.session.overseerrCookie });
});

/* ===============================
   PROXY MIDDLEWARE
   Tous les appels sous /overseerr-frame/* sont forwarded vers Seerr
   avec injection automatique du cookie de session.
=============================== */
const seerrTarget = (process.env.OVERSEERR_URL || "http://localhost:5055").replace(/\/$/, "");

const proxyMiddleware = createProxyMiddleware({
  target: seerrTarget,
  changeOrigin: true,

  // Supprime le préfixe : /overseerr-frame/discover → /discover
  pathRewrite: { "^/overseerr-frame": "" },

  // Désactiver la vérification SSL si Seerr est en HTTP interne
  secure: false,

  // Timeouts généreux pour les grosses requêtes
  proxyTimeout: 30000,
  timeout: 30000,

  on: {
    /**
     * Avant d'envoyer la requête à Seerr :
     * - Injecter le cookie de session Seerr
     * - Nettoyer les headers problématiques
     */
    proxyReq: (proxyReq, req) => {
      // Injecter le cookie de session Seerr
      if (req.session?.overseerrCookie) {
        proxyReq.setHeader("Cookie", req.session.overseerrCookie);
      }

      // Corriger le host header (important pour Seerr qui peut vérifier l'origine)
      const target = new URL(seerrTarget);
      proxyReq.setHeader("Host", target.host);

      // Supprimer les headers de compression pour simplifier le traitement
      proxyReq.removeHeader("Accept-Encoding");
    },

    /**
     * Après réponse de Seerr :
     * - Capturer les nouveaux cookies de session si Seerr les renouvelle
     * - Supprimer les headers qui bloqueraient l'iframe (X-Frame-Options, CSP)
     */
    proxyRes: (proxyRes, req, res) => {
      // Capturer les cookies de session Seerr mis à jour
      const setCookies = proxyRes.headers["set-cookie"];
      if (setCookies && req.session) {
        const sessionCookies = (Array.isArray(setCookies) ? setCookies : [setCookies])
          .map(c => c.split(";")[0])
          .join("; ");
        if (sessionCookies) {
          req.session.overseerrCookie = sessionCookies;
        }
      }

      // Supprimer les headers qui empêcheraient l'affichage en iframe
      delete proxyRes.headers["x-frame-options"];
      delete proxyRes.headers["content-security-policy"];
      delete proxyRes.headers["content-security-policy-report-only"];

      // Ne pas forwarder les Set-Cookie de Seerr au browser
      // (on gère les cookies côté serveur uniquement)
      delete proxyRes.headers["set-cookie"];
    },

    error: (err, req, res) => {
      console.error("[SeerrProxy] Erreur:", err.message);
      if (!res.headersSent) {
        res.status(502).send(`
          <html><body style="background:#0f1117;color:#e2e8f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
            <div style="text-align:center">
              <div style="font-size:48px;margin-bottom:16px">⚠️</div>
              <h2>Seerr inaccessible</h2>
              <p style="color:#94a3b8">Vérifiez que Seerr est démarré et que OVERSEERR_URL est correctement configuré.</p>
              <p style="color:#64748b;font-size:12px;font-family:monospace">Cible : ${seerrTarget}<br>Erreur : ${err.message}</p>
            </div>
          </body></html>
        `);
      }
    }
  }
});

// Appliquer l'auth guard puis le proxy pour tous les appels /overseerr-frame/*
router.use("/overseerr-frame", requireAuth, proxyMiddleware);

module.exports = router;
