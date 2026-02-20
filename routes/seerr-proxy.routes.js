/**
 * SEERR PROXY
 * ===========
 * Proxifie l'interface Seerr via plex-portal.
 *
 * Auth SSO : le cookie connect.sid est posé dans le browser au moment du login
 * (auth.routes.js → grabSeerrCookie), exactement comme Organizr sso-functions.php#L335.
 * Le browser l'envoie automatiquement à toutes les requêtes /overseerr-frame/*.
 *
 * Prérequis Seerr : BASE_URL=/overseerr-frame dans les variables d'env du conteneur.
 */

const express = require("express");
const router  = express.Router();
const { createProxyMiddleware } = require("http-proxy-middleware");

/* ===============================
   AUTH GUARD
=============================== */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect((req.basePath || "") + "/");
  }
  next();
}

/* ===============================
   PAGE /overseerr → redirect vers le proxy
   Le cookie connect.sid a déjà été posé dans le browser au login.
=============================== */
router.get("/overseerr", requireAuth, (req, res) => {
  res.redirect((req.basePath || "") + "/overseerr-frame/");
});

/* ===============================
   RE-AUTH : cookie Seerr expiré
   On redirige vers /overseerr qui relancera grabSeerrCookie via /login
=============================== */
router.get("/overseerr-frame-reauth", requireAuth, (req, res) => {
  console.log("[SeerrProxy] Cookie Seerr expiré — effacement et redirection login");
  res.clearCookie("connect.sid", { path: (req.basePath || "") + "/overseerr-frame" });
  res.redirect((req.basePath || "") + "/");
});

/* ===============================
   PROXY
   Express Router strip "/overseerr-frame" de req.url → on le remet via pathRewrite.
   Le browser envoie connect.sid automatiquement (posé au login) → Seerr authentifie.
=============================== */
const seerrTarget = (process.env.OVERSEERR_URL || "http://localhost:5055").replace(/\/$/, "");
console.log(`[SeerrProxy] Cible: ${seerrTarget}`);

/* ---------------------------------------------------------------
   Proxy principal : /overseerr-frame/*
   Express Router strip le préfixe "/overseerr-frame" de req.url,
   donc on le remet via pathRewrite pour que Seerr (BASE_URL=/overseerr-frame)
   reçoive le bon chemin.
--------------------------------------------------------------- */
const proxyMiddleware = createProxyMiddleware({
  target: seerrTarget,
  changeOrigin: true,
  pathRewrite: (path) => "/overseerr-frame" + path,
  secure: false,
  proxyTimeout: 30000,
  timeout: 30000,
  on: {
    proxyReq: (proxyReq) => {
      proxyReq.removeHeader("Accept-Encoding");
    },
    proxyRes: (proxyRes, req) => {
      delete proxyRes.headers["x-frame-options"];
      delete proxyRes.headers["content-security-policy"];
      delete proxyRes.headers["content-security-policy-report-only"];

      // Intercepter les redirects hors proxy (cookie expiré)
      const isRedirect = [301, 302, 303, 307, 308].includes(proxyRes.statusCode);
      if (isRedirect) {
        const location = proxyRes.headers["location"] || "";
        if (!location.startsWith("/overseerr-frame")) {
          console.warn(`[SeerrProxy] Redirect auth intercepté (${location}) → re-auth`);
          proxyRes.headers["location"] = (req.basePath || "") + "/overseerr-frame-reauth";
        }
      }
    },
    error: (err, req, res) => {
      if (!res.headersSent) {
        res.status(502).send(`<html><body style="background:#0f1117;color:#e2e8f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:3rem">⚠️</div><h2>Seerr inaccessible</h2><p style="color:#94a3b8">Vérifiez que OVERSEERR_URL est configuré et que Seerr est démarré.</p><p style="color:#64748b;font-size:.75rem;font-family:monospace">${seerrTarget} — ${err.message}</p></div></body></html>`);
      }
    }
  }
});

router.use("/overseerr-frame", requireAuth, proxyMiddleware);

/* ---------------------------------------------------------------
   Proxy assets Next.js : /_next/*, /site.webmanifest, /favicon-*.png, /logo_full.svg
   Next.js inscrit ces chemins dans le HTML au moment du build, SANS préfixe BASE_URL.
   Le browser les demande donc à la racine de plex-portal → on les redirige vers Seerr.
   Pas de pathRewrite : le chemin reste identique (Seerr les sert à /_next/... aussi).
   Pas de garde auth : ce sont des assets statiques publics.
--------------------------------------------------------------- */
const staticProxyMiddleware = createProxyMiddleware({
  target: seerrTarget,
  changeOrigin: true,
  secure: false,
  proxyTimeout: 30000,
  timeout: 30000,
  on: {
    proxyReq: (proxyReq) => {
      proxyReq.removeHeader("Accept-Encoding");
    },
    error: (err, req, res) => {
      if (!res.headersSent) res.status(502).send("Seerr asset unavailable");
    }
  }
});

router.use("/_next", staticProxyMiddleware);
router.use("/site.webmanifest", staticProxyMiddleware);
router.get("/favicon-16x16.png", staticProxyMiddleware);
router.get("/favicon-32x32.png", staticProxyMiddleware);
router.get("/logo_full.svg", staticProxyMiddleware);

module.exports = router;
