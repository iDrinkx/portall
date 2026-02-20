/**
 * SEERR FULL PROXY
 * ================
 * Proxifie l'intégralité de l'interface Seerr via plex-portal.
 * Seerr n'a pas besoin d'être exposé publiquement.
 *
 * PRÉREQUIS : ajouter BASE_URL=/overseerr-frame dans l'env du conteneur Seerr.
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
   SSO : auth Seerr via token Plex
=============================== */
async function doSeerrAuth(req) {
  const overseerrUrl = (process.env.OVERSEERR_URL || "").replace(/\/$/, "");
  const plexToken    = req.session.plexToken;

  console.log(`[SeerrProxy] doSeerrAuth — OVERSEERR_URL: "${overseerrUrl}", plexToken: ${plexToken ? "présent" : "ABSENT"}`);

  if (!overseerrUrl) {
    console.warn("[SeerrProxy] ❌ OVERSEERR_URL non configuré. Ajoutez-le dans docker-compose.yml");
    return;
  }
  if (!plexToken) {
    console.warn("[SeerrProxy] ❌ plexToken absent de la session. L'utilisateur doit se re-connecter.");
    return;
  }

  try {
    const response = await fetch(`${overseerrUrl}/api/v1/auth/plex`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ authToken: plexToken })
    });

    console.log(`[SeerrProxy] Réponse auth Seerr: HTTP ${response.status}`);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(`[SeerrProxy] ❌ Auth Seerr échouée (${response.status}): ${body.slice(0, 200)}`);
      return;
    }

    const setCookies = response.headers.raw()["set-cookie"] || [];
    if (setCookies.length > 0) {
      req.session.overseerrCookie = setCookies
        .map(c => c.split(";")[0])
        .join("; ");
      console.log(`[SeerrProxy] ✅ Cookie Seerr obtenu: ${req.session.overseerrCookie.slice(0, 60)}...`);
    } else {
      console.warn("[SeerrProxy] ⚠️  Aucun cookie retourné par Seerr après auth");
    }

    const userData = await response.json().catch(() => null);
    if (userData) req.session.overseerrUser = userData;

  } catch (e) {
    console.error("[SeerrProxy] ❌ Erreur réseau lors de l'auth Seerr:", e.message);
    console.error("[SeerrProxy]    → Vérifiez que OVERSEERR_URL est joignable depuis le conteneur plex-portal");
  }
}

/* ===============================
   PAGE /overseerr → iframe wrapper
=============================== */
router.get("/overseerr", requireAuth, async (req, res) => {
  // Authentification SSO automatique si pas encore de cookie Seerr
  if (!req.session.overseerrCookie) {
    await doSeerrAuth(req);
  }

  // Sauvegarde explicite de la session avant de rendre la page
  // (nécessaire pour que le cookie soit disponible dès le premier appel /overseerr-frame/)
  await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));

  res.render("overseerr/iframe", {
    user: req.session.user,
    basePath: req.basePath || "",
    layout: false
  });
});

/* ===============================
   RE-AUTH depuis le proxy (redirect intercepté)
   Seerr redirige parfois vers son login ou app.plex.tv quand le cookie expire.
   On intercepte ça côté proxy et on redirige vers cette route.
=============================== */
router.get("/overseerr-frame-reauth", requireAuth, async (req, res) => {
  console.log("[SeerrProxy] Re-auth demandée (cookie Seerr expiré ou invalide)");
  delete req.session.overseerrCookie;
  delete req.session.overseerrUser;
  await doSeerrAuth(req);
  await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
  res.redirect((req.basePath || "") + "/overseerr-frame/");
});

/* ===============================
   RECONNEXION SSO (appelé par le client JS si besoin)
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
// Lire la cible une seule fois au démarrage — les env vars Docker sont disponibles dès le boot
const seerrTarget = (process.env.OVERSEERR_URL || "http://localhost:5055").replace(/\/$/, "");
console.log(`[SeerrProxy] Cible proxy Seerr: ${seerrTarget}`);

const proxyMiddleware = createProxyMiddleware({
  target: seerrTarget,
  changeOrigin: true,

  // Supprime le préfixe : /overseerr-frame/discover → /discover
  pathRewrite: { "^/overseerr-frame": "" },

  secure: false,
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
        console.log(`[SeerrProxy] → ${req.method} ${req.url} (cookie: ${req.session.overseerrCookie.slice(0, 40)}...)`);
      } else {
        console.warn(`[SeerrProxy] → ${req.method} ${req.url} ⚠️  PAS DE COOKIE — session:`, !!req.session);
      }

      // Corriger le host header
      try {
        const target = new URL(seerrTarget);
        proxyReq.setHeader("Host", target.host);
      } catch (_) {}

      // Supprimer la compression pour simplifier le traitement
      proxyReq.removeHeader("Accept-Encoding");
    },

    /**
     * Après réponse de Seerr :
     * - Intercepter les redirections vers app.plex.tv / page de login Seerr
     *   → les remplacer par une redirection vers notre endpoint de re-auth
     * - Capturer les nouveaux cookies de session si Seerr les renouvelle
     * - Supprimer les headers qui bloqueraient l'iframe (X-Frame-Options, CSP)
     */
    proxyRes: (proxyRes, req, res) => {
      const basePath = req.basePath || "";

      // ── Interception des redirections d'authentification ──────────────────
      // Log toutes les redirections pour diagnostic
      const isRedirect = [301, 302, 303, 307, 308].includes(proxyRes.statusCode);
      if (isRedirect) {
        const location = proxyRes.headers["location"] || "";
        console.log(`[SeerrProxy] Redirect Seerr (${proxyRes.statusCode}): ${location}`);

        // Tout redirect qui ne reste pas sous /overseerr-frame est un redirect d'auth
        // (login Seerr, app.plex.tv, plex.tv/sign-in, /, /login, etc.)
        const staysInProxy = location.startsWith("/overseerr-frame");
        if (!staysInProxy) {
          console.warn(`[SeerrProxy] ⚠️  Redirect hors proxy intercepté (${location}) → re-auth`);
          proxyRes.headers["location"] = `${basePath}/overseerr-frame-reauth`;
        }
      }

      // ── Capture des cookies de session renouvelés par Seerr ──────────────
      const setCookies = proxyRes.headers["set-cookie"];
      if (setCookies && req.session) {
        const sessionCookies = (Array.isArray(setCookies) ? setCookies : [setCookies])
          .map(c => c.split(";")[0])
          .join("; ");
        if (sessionCookies) {
          req.session.overseerrCookie = sessionCookies;
        }
      }

      // ── Supprimer les headers qui bloquent l'iframe ───────────────────────
      delete proxyRes.headers["x-frame-options"];
      delete proxyRes.headers["content-security-policy"];
      delete proxyRes.headers["content-security-policy-report-only"];

      // Ne pas forwarder les Set-Cookie de Seerr au browser
      delete proxyRes.headers["set-cookie"];
    },

    error: (err, req, res) => {
      console.error("[SeerrProxy] Erreur proxy:", err.message);
      if (!res.headersSent) {
        res.status(502).send(`
          <html><body style="background:#0f1117;color:#e2e8f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
            <div style="text-align:center">
              <div style="font-size:3rem;margin-bottom:1rem">⚠️</div>
              <h2 style="margin:0 0 .5rem">Seerr inaccessible</h2>
              <p style="color:#94a3b8">Vérifiez que Seerr est démarré et que OVERSEERR_URL est correctement configuré.</p>
              <p style="color:#64748b;font-size:.75rem;font-family:monospace">Cible : ${seerrTarget}<br>Erreur : ${err.message}</p>
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
