const express = require("express");
const fetch = require("node-fetch");
const { createProxyMiddleware, responseInterceptor } = require("http-proxy-middleware");
const log = require("../utils/logger");
const { getConfigValue } = require("../utils/config");

const router = express.Router();
const logSeerr = log.create("[Seerr Proxy]");

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect((req.basePath || "") + "/");
  }
  next();
}

function getSeerrUrl() {
  return String(getConfigValue("SEERR_URL", "") || "").trim().replace(/\/$/, "");
}

function getSeerrCookieOptions() {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true"
  };
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasCookie(req, name) {
  const cookieHeader = String(req.headers?.cookie || "");
  return new RegExp(`(?:^|;\\s*)${escapeRegExp(name)}=`).test(cookieHeader);
}

function appendCookieHeader(existingCookieHeader, name, value) {
  const pair = `${name}=${value}`;
  return existingCookieHeader ? `${existingCookieHeader}; ${pair}` : pair;
}

async function fetchSeerrSessionCookie(authToken, username) {
  const seerrUrl = getSeerrUrl();
  if (!seerrUrl) {
    logSeerr.warn("SEERR_URL non configure");
    return null;
  }
  if (!authToken) {
    logSeerr.warn(`Token Plex absent pour ${username}`);
    return null;
  }

  try {
    const response = await fetch(`${seerrUrl}/api/v1/auth/plex`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ authToken })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logSeerr.warn(`SSO Seerr HTTP ${response.status} pour ${username} - ${body.slice(0, 120)}`);
      return null;
    }

    const setCookies = response.headers.raw()["set-cookie"] || [];
    const sidCookie = setCookies.find(cookie => cookie.startsWith("connect.sid="));
    if (!sidCookie) {
      logSeerr.warn(`connect.sid absent pour ${username}`);
      return null;
    }

    return sidCookie.split(";")[0].replace("connect.sid=", "") || null;
  } catch (error) {
    logSeerr.warn(`Erreur SSO Seerr pour ${username}: ${error.message}`);
    return null;
  }
}

async function ensureSeerrSession(req, res, next) {
  if (hasCookie(req, "connect.sid")) return next();

  const authToken = req.session?.plexToken;
  const username = req.session?.user?.username || req.session?.user?.email || "inconnu";
  const rawCookieValue = await fetchSeerrSessionCookie(authToken, username);

  if (!rawCookieValue) return next();

  req.headers.cookie = appendCookieHeader(req.headers.cookie, "connect.sid", rawCookieValue);

  try {
    res.cookie("connect.sid", decodeURIComponent(rawCookieValue), getSeerrCookieOptions());
  } catch (_) {
    res.cookie("connect.sid", rawCookieValue, getSeerrCookieOptions());
  }

  return next();
}

function buildProxyPrefix(req) {
  return `${req.basePath || ""}/seerr`;
}

function buildSeerrNavbarMarkup(req) {
  const basePath = req.basePath || "";
  const isAdmin = !!req.session?.user?.isAdmin;

  return `
<div id="plex-portal-seerr-navbar" style="position:sticky;top:0;z-index:2147483647;height:72px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;background:#111;border-bottom:1px solid rgba(255,255,255,.08);box-sizing:border-box;">
  <a data-portal-link="1" href="${basePath}/dashboard" style="display:flex;align-items:center;text-decoration:none;">
    <img data-portal-asset="1" src="${basePath}/logo.png" alt="Portal" style="height:44px;width:auto;max-width:128px;object-fit:contain;display:block;filter:drop-shadow(0 0 6px rgba(0,0,0,.5));">
  </a>
  <div style="display:flex;align-items:center;gap:30px;height:100%;overflow-x:auto;">
    <a data-portal-link="1" href="${basePath}/dashboard" style="color:rgba(255,255,255,.95);text-decoration:none;font-weight:600;font-size:15px;white-space:nowrap;">Dashboard</a>
    <a data-portal-link="1" href="${basePath}/profil" style="color:rgba(229,160,13,.9);text-decoration:none;font-weight:600;font-size:15px;white-space:nowrap;">Profil</a>
    <a data-portal-link="1" href="${basePath}/classement" style="color:rgba(59,130,246,.9);text-decoration:none;font-weight:600;font-size:15px;white-space:nowrap;">Classement</a>
    <a data-portal-link="1" href="${basePath}/mes-stats" style="color:rgba(16,185,129,.9);text-decoration:none;font-weight:600;font-size:15px;white-space:nowrap;">Statistiques</a>
    <a data-portal-link="1" href="${basePath}/seerr" style="color:rgba(109,73,171,.95);text-decoration:none;font-weight:600;font-size:15px;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;">Demandes <img data-portal-asset="1" src="${basePath}/img/seerr-icon.svg" alt="Seerr" style="width:16px;height:16px;object-fit:contain;border-radius:4px;"></a>
    <a data-portal-link="1" href="${basePath}/calendrier" style="color:rgba(239,68,68,.9);text-decoration:none;font-weight:600;font-size:15px;white-space:nowrap;">Calendrier</a>
    ${isAdmin ? `<a data-portal-link="1" href="${basePath}/parametres" style="color:rgba(203,213,225,.92);text-decoration:none;font-weight:600;font-size:15px;white-space:nowrap;">Parametres</a>` : ""}
  </div>
  <div style="display:flex;align-items:center;gap:18px;">
    <a data-portal-link="1" href="${basePath}/logout" style="display:inline-flex;align-items:center;justify-content:center;padding:12px 22px;border-radius:14px;border:1px solid rgba(241,163,64,.38);background:linear-gradient(135deg, rgba(190,116,34,.92), rgba(120,76,24,.9));color:#fff5e6;text-decoration:none;font-weight:700;white-space:nowrap;box-shadow:0 16px 28px rgba(84,39,11,.35);">Deconnexion</a>
  </div>
</div>
<div id="plex-portal-seerr-content">`;
}

function applySeerrForwardedHeaders(proxyReq, req) {
  proxyReq.setHeader("X-Forwarded-Prefix", buildProxyPrefix(req));
  proxyReq.setHeader("X-Forwarded-Host", req.get("host") || "");
  proxyReq.setHeader("X-Forwarded-Proto", req.protocol || "http");
  proxyReq.setHeader("X-Forwarded-Uri", req.originalUrl || req.url || "/");
}

const SEERR_APP_PATH_PREFIXES = [
  "/requests",
  "/discover",
  "/movies",
  "/movie",
  "/tv",
  "/show",
  "/search",
  "/library",
  "/collections",
  "/collection",
  "/settings",
  "/users",
  "/user",
  "/watchlist",
  "/blocklist",
  "/issue",
  "/issues",
  "/admin",
  "/media",
  "/person",
  "/studio",
  "/network",
  "/company"
];

function isSeerrAppPath(pathname) {
  const path = String(pathname || "");
  return SEERR_APP_PATH_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

function rewriteHtmlForProxy(htmlBuffer, req) {
  try {
    const html = htmlBuffer.toString("utf8");
    const proxyPrefix = buildProxyPrefix(req);
    const navbarMarkup = buildSeerrNavbarMarkup(req);
    const clientPatch = `
<base href="${proxyPrefix}/">
<style>
  html, body { min-height: 100%; background: #0f1117; }
  body { box-sizing: border-box; overflow-x: hidden; }
  #plex-portal-seerr-content {
    min-height: calc(100vh - 72px);
    padding-top: 72px;
    box-sizing: border-box;
  }
  @media (max-width: 768px) {
    #plex-portal-seerr-navbar {
      height: auto !important;
      min-height: 60px;
      padding: 10px 12px !important;
      gap: 12px;
      flex-wrap: wrap;
    }
    #plex-portal-seerr-content {
      min-height: calc(100vh - 60px);
      padding-top: 60px;
    }
  }
</style>
<script>
(() => {
  const prefix = ${JSON.stringify(proxyPrefix)};
  const normalize = (url) => {
    if (typeof url !== "string") return url;
    if (!url.startsWith("/") || url.startsWith("//") || url.startsWith(prefix + "/")) return url;
    return prefix + url;
  };
  const absolutize = (url) => {
    try { return new URL(url, location.origin); } catch (_) { return null; }
  };

  try {
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
      if (typeof input === "string") return originalFetch.call(this, normalize(input), init);
      if (input instanceof Request) return originalFetch.call(this, new Request(normalize(input.url), input), init);
      return originalFetch.call(this, input, init);
    };
  } catch (_) {}

  try {
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      return originalOpen.call(this, method, normalize(url), ...rest);
    };
  } catch (_) {}

  document.addEventListener("click", (event) => {
    const anchor = event.target.closest && event.target.closest("a[href]");
    if (!anchor) return;
    if (anchor.hasAttribute("data-portal-link")) return;
    const href = anchor.getAttribute("href");
    if (!href) return;
    const url = absolutize(href);
    if (!url || url.origin !== location.origin) return;
    if (!url.pathname.startsWith("/") || url.pathname.startsWith(prefix + "/")) return;
    event.preventDefault();
    event.stopPropagation();
    location.href = normalize(url.pathname + url.search + url.hash);
  }, true);

  const rewriteAnchors = () => {
    document.querySelectorAll("a[href]").forEach((anchor) => {
      if (anchor.hasAttribute("data-portal-link")) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      const url = absolutize(href);
      if (!url || url.origin !== location.origin) return;
      if (!url.pathname.startsWith("/") || url.pathname.startsWith(prefix + "/")) return;
      anchor.setAttribute("href", normalize(url.pathname + url.search + url.hash));
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", rewriteAnchors, { once: true });
  } else {
    rewriteAnchors();
  }

  try {
    const observer = new MutationObserver(() => rewriteAnchors());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
})();
</script>`;

    const withHeadPatch = html.includes("</head>")
      ? html.replace("</head>", `${clientPatch}</head>`)
      : `${clientPatch}${html}`;

    const withNavbar = withHeadPatch.includes("<body")
      ? withHeadPatch
        .replace(/<body([^>]*)>/i, `<body$1>${navbarMarkup}`)
        .replace(/<\/body>/i, `</div></body>`)
      : `${navbarMarkup}${withHeadPatch}`;

    return withNavbar
      .replace(/(href|src|action)=("|')\/(?!\/)/gi, `$1=$2${proxyPrefix}/`)
      .replace(/(["'])\/_next\//g, `$1${proxyPrefix}/_next/`)
      .replace(/(["'])\/images\//g, `$1${proxyPrefix}/images/`)
      .replace(/(["'])\/api\/v1\//g, `$1${proxyPrefix}/api/v1/`)
      .replace(/(href|src)=("|')\/seerr\/dashboard(["'])/gi, `$1=$2/dashboard$3`)
      .replace(/(href|src)=("|')\/seerr\/profil(["'])/gi, `$1=$2/profil$3`)
      .replace(/(href|src)=("|')\/seerr\/classement(["'])/gi, `$1=$2/classement$3`)
      .replace(/(href|src)=("|')\/seerr\/mes-stats(["'])/gi, `$1=$2/mes-stats$3`)
      .replace(/(href|src)=("|')\/seerr\/calendrier(["'])/gi, `$1=$2/calendrier$3`)
      .replace(/(href|src)=("|')\/seerr\/parametres(["'])/gi, `$1=$2/parametres$3`)
      .replace(/(href|src)=("|')\/seerr\/logout(["'])/gi, `$1=$2/logout$3`)
      .replace(/(href|src)=("|')\/seerr\/logo\.png(["'])/gi, `$1=$2/logo.png$3`)
      .replace(/(href|src)=("|')\/seerr\/img\/seerr-icon\.svg(["'])/gi, `$1=$2/img/seerr-icon.svg$3`);
  } catch (error) {
    logSeerr.error(`Erreur rewriteHtmlForProxy: ${error.message}`);
    return htmlBuffer;
  }
}

const seerrProxy = createProxyMiddleware({
  target: "http://127.0.0.1",
  changeOrigin: true,
  ws: true,
  selfHandleResponse: true,
  router() {
    return getSeerrUrl();
  },
  pathRewrite(path) {
    return path.replace(/^\/seerr/, "") || "/";
  },
  cookieDomainRewrite: { "*": "" },
  onProxyReq: applySeerrForwardedHeaders,
  onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
    const proxyPrefix = buildProxyPrefix(req);
    const location = proxyRes.headers.location;
    if (location) {
      const seerrUrl = getSeerrUrl();
      if (location.startsWith("/")) {
        res.setHeader("location", `${proxyPrefix}${location}`);
      } else if (seerrUrl && location.startsWith(seerrUrl)) {
        res.setHeader("location", `${proxyPrefix}${location.slice(seerrUrl.length)}`);
      }
    }

    const contentType = String(proxyRes.headers["content-type"] || "");
    if (contentType.includes("text/html")) {
      return rewriteHtmlForProxy(responseBuffer, req);
    }

    return responseBuffer;
  })
});

const seerrRootAssetProxy = createProxyMiddleware({
  target: "http://127.0.0.1",
  changeOrigin: true,
  ws: true,
  router() {
    return getSeerrUrl();
  },
  cookieDomainRewrite: { "*": "" },
  onProxyReq: applySeerrForwardedHeaders
});

router.get(/^\/seerr$/, requireAuth, ensureSeerrSession, (req, res) => {
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  return res.redirect(302, `${req.basePath || ""}/seerr/${query}`);
});

router.use("/_next", requireAuth, ensureSeerrSession, seerrRootAssetProxy);
router.use("/api/v1", requireAuth, ensureSeerrSession, seerrRootAssetProxy);
router.use("/images", requireAuth, ensureSeerrSession, seerrRootAssetProxy);
router.get("/sw.js", requireAuth, ensureSeerrSession, seerrRootAssetProxy);
router.get("/manifest.json", requireAuth, ensureSeerrSession, seerrRootAssetProxy);
router.get("/site.webmanifest", requireAuth, ensureSeerrSession, seerrRootAssetProxy);
router.get("/logo_full.svg", requireAuth, ensureSeerrSession, seerrRootAssetProxy);
router.get("/favicon.ico", requireAuth, ensureSeerrSession, seerrRootAssetProxy);
router.get("/apple-touch-icon.png", requireAuth, ensureSeerrSession, seerrRootAssetProxy);
router.get("/android-chrome-192x192.png", requireAuth, ensureSeerrSession, seerrRootAssetProxy);
router.get("/android-chrome-512x512.png", requireAuth, ensureSeerrSession, seerrRootAssetProxy);

router.use((req, res, next) => {
  const path = req.path || "/";
  if (!req.session || !req.session.user) return next();

  const referer = String(req.get("referer") || "");
  const expectedPrefix = `${req.protocol}://${req.get("host")}${req.basePath || ""}/seerr`;
  if (!referer.startsWith(expectedPrefix)) return next();

  if (path === "/") {
    return ensureSeerrSession(req, res, () => (
      res.redirect(302, `${req.basePath || ""}/seerr/`)
    ));
  }

  if (path.startsWith("/seerr")) return next();
  if (!isSeerrAppPath(path)) return next();

  return ensureSeerrSession(req, res, () => (
    res.redirect(302, `${req.basePath || ""}/seerr${req.originalUrl || path}`)
  ));
});

router.use("/seerr", requireAuth, (req, res, next) => {
  if (!getSeerrUrl()) {
    return res.status(503).send("Seerr non configure cote serveur");
  }
  return next();
});

router.use("/seerr", requireAuth, ensureSeerrSession, seerrProxy);

module.exports = router;
