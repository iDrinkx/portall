const express = require("express");
const fetch = require("node-fetch");
const { createProxyMiddleware, responseInterceptor } = require("http-proxy-middleware");
const log = require("../utils/logger");
const { getConfigValue } = require("../utils/config");
const { buildDashboardNavItems } = require("../utils/dashboard-builtins");
const { getSiteLanguage, createTranslator } = require("../utils/i18n");

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

    const rawValue = sidCookie.split(";")[0].replace("connect.sid=", "");
    return rawValue || null;
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

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildSeerrNavbarMarkup(req) {
  const basePath = req.basePath || "";
  const locale = getSiteLanguage();
  const t = createTranslator(locale);
  const items = buildDashboardNavItems(basePath, t);

  const navLinks = [
    `<a href="${basePath}/dashboard" class="nav-link nav-link-dashboard">${escapeHtml(t("nav.dashboard"))}&nbsp;🏠</a>`,
    ...items.map((item) => {
      const icon = item.kind === "image"
        ? `<img src="${basePath}${item.iconSrc}" alt="${escapeHtml(item.iconAlt || item.label || "")}" class="nav-seerr-logo">`
        : item.kind === "profile"
          ? "👤"
          : escapeHtml(item.icon || "");
      return `<a href="${escapeHtml(item.href)}" class="nav-link ${escapeHtml(item.className || "")}">${escapeHtml(item.label)}&nbsp;${icon}</a>`;
    })
  ];

  if (req.session?.user?.isAdmin) {
    navLinks.push(`<a href="${basePath}/parametres" class="nav-link nav-link-settings">${escapeHtml(t("nav.settings"))}&nbsp;⚙️</a>`);
  }

  return `
<nav class="plex-portal-seerr-navbar">
  <a href="${basePath}/dashboard" class="plex-portal-seerr-brand">
    <img class="plex-portal-seerr-brand-logo" src="${basePath}/logo.png" alt="Portal">
  </a>
  <div class="plex-portal-seerr-nav-center">
    ${navLinks.join("")}
  </div>
  <div class="plex-portal-seerr-nav-right">
    <a class="plex-portal-seerr-logout" href="${basePath}/logout">${escapeHtml(t("nav.logout"))}</a>
  </div>
</nav>
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
  const html = htmlBuffer.toString("utf8");
  const proxyPrefix = buildProxyPrefix(req);
  const proxyPrefixEscaped = proxyPrefix.replace(/"/g, "&quot;");
  const baseHref = `${proxyPrefix}/`;
  const portalNavbarMarkup = buildSeerrNavbarMarkup(req);
  const clientPatch = `
<base href="${baseHref}">
<style>
  :root {
    --plex-portal-seerr-nav-height: 72px;
    --plex-portal-seerr-line: rgba(255,255,255,0.08);
  }
  html, body { min-height: 100%; background: #0f1117; }
  body { box-sizing: border-box; overflow-x: hidden; }
  .plex-portal-seerr-navbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    z-index: 2147483647;
    height: var(--plex-portal-seerr-nav-height);
    min-height: var(--plex-portal-seerr-nav-height);
    max-height: var(--plex-portal-seerr-nav-height);
    padding: 0 24px;
    background: #111;
    border-bottom: 1px solid var(--plex-portal-seerr-line);
    box-sizing: border-box;
  }
  #plex-portal-seerr-content {
    min-height: calc(100vh - var(--plex-portal-seerr-nav-height));
  }
  .plex-portal-seerr-brand {
    display: flex;
    align-items: center;
    height: 100%;
    text-decoration: none;
    min-width: 0;
  }
  .plex-portal-seerr-brand-logo {
    height: 44px;
    width: auto;
    max-width: 128px;
    object-fit: contain;
    display: block;
    filter: drop-shadow(0 0 6px rgba(0,0,0,.5));
  }
  .plex-portal-seerr-nav-center,
  .plex-portal-seerr-nav-right {
    display: flex;
    align-items: center;
    height: 100%;
  }
  .plex-portal-seerr-nav-center {
    gap: 30px;
  }
  .plex-portal-seerr-nav-right {
    gap: 18px;
  }
  .plex-portal-seerr-navbar .nav-link {
    display: inline-flex;
    align-items: center;
    height: 100%;
    line-height: 1;
    color: #bbb;
    text-decoration: none;
    font-weight: 600;
    font-size: 15px;
    position: relative;
    transition: 0.2s ease;
  }
  .plex-portal-seerr-navbar .nav-link:hover { color: #fff; }
  .plex-portal-seerr-navbar .nav-link::after {
    content: "";
    position: absolute;
    bottom: 16px;
    left: 0;
    width: 0%;
    height: 2px;
    transition: width 0.2s ease;
  }
  .plex-portal-seerr-navbar .nav-link:hover::after { width: 100%; }
  .plex-portal-seerr-navbar .nav-link-dashboard { color: rgba(255, 255, 255, 0.95); }
  .plex-portal-seerr-navbar .nav-link-dashboard:hover { color: #ffffff; }
  .plex-portal-seerr-navbar .nav-link-dashboard::after { background: #ffffff; }
  .plex-portal-seerr-navbar .nav-link-profil { color: rgba(229, 160, 13, 0.9); }
  .plex-portal-seerr-navbar .nav-link-profil:hover { color: #ffcc40; }
  .plex-portal-seerr-navbar .nav-link-profil::after { background: #e5a00d; }
  .plex-portal-seerr-navbar .nav-link-classement { color: rgba(59, 130, 246, 0.9); }
  .plex-portal-seerr-navbar .nav-link-classement:hover { color: #7db8ff; }
  .plex-portal-seerr-navbar .nav-link-classement::after { background: #3B82F6; }
  .plex-portal-seerr-navbar .nav-link-stats { color: rgba(16, 185, 129, 0.9); }
  .plex-portal-seerr-navbar .nav-link-stats:hover { color: #34d399; }
  .plex-portal-seerr-navbar .nav-link-stats::after { background: #10b981; }
  .plex-portal-seerr-navbar .nav-link-demandes { color: rgba(109, 73, 171, 0.9); }
  .plex-portal-seerr-navbar .nav-link-demandes:hover { color: #b48cf0; }
  .plex-portal-seerr-navbar .nav-link-demandes::after { background: #6d49ab; }
  .plex-portal-seerr-navbar .nav-link-calendrier { color: rgba(239, 68, 68, 0.9); }
  .plex-portal-seerr-navbar .nav-link-calendrier:hover { color: #f87171; }
  .plex-portal-seerr-navbar .nav-link-calendrier::after { background: #ef4444; }
  .plex-portal-seerr-navbar .nav-link-settings { color: rgba(203, 213, 225, 0.92); }
  .plex-portal-seerr-navbar .nav-link-settings:hover { color: #e2e8f0; }
  .plex-portal-seerr-navbar .nav-link-settings::after { background: #cbd5e1; }
  .plex-portal-seerr-logout {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px 22px;
    border-radius: 14px;
    border: 1px solid rgba(241, 163, 64, 0.38);
    background: linear-gradient(135deg, rgba(190, 116, 34, 0.92), rgba(120, 76, 24, 0.9));
    color: #fff5e6;
    text-decoration: none;
    font-weight: 700;
    box-shadow: 0 16px 28px rgba(84, 39, 11, 0.35);
  }
  .nav-seerr-logo {
    width: 16px;
    height: 16px;
    object-fit: contain;
    vertical-align: middle;
    margin-right: 2px;
    margin-bottom: 2px;
    border-radius: 4px;
  }
  @media (max-width: 768px) {
    :root { --plex-portal-seerr-nav-height: 60px; }
    .plex-portal-seerr-navbar { padding: 0 12px; }
    .plex-portal-seerr-nav-center { gap: 16px; overflow-x: auto; }
    .plex-portal-seerr-navbar .nav-link { font-size: 13px; white-space: nowrap; }
    .plex-portal-seerr-brand-logo { height: 36px; max-width: 100px; }
    .plex-portal-seerr-logout { padding: 9px 14px; font-size: 13px; }
  }
</style>
<script>
(() => {
  const prefix = ${JSON.stringify(proxyPrefix)};
  const dashboardUrl = ${JSON.stringify(dashboardUrl)};
  const normalize = (url) => {
    if (typeof url !== "string") return url;
    if (!url.startsWith("/") || url.startsWith("//") || url.startsWith(prefix + "/")) return url;
    return prefix + url;
  };
  const absolutize = (url) => {
    try {
      return new URL(url, location.origin);
    } catch (_) {
      return null;
    }
  };

  const wrapHistory = (method) => {
    const original = history[method];
    history[method] = function(state, title, url) {
      return original.call(this, state, title, normalize(url));
    };
  };

  try { wrapHistory("pushState"); } catch (_) {}
  try { wrapHistory("replaceState"); } catch (_) {}

  try {
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
      if (typeof input === "string") {
        return originalFetch.call(this, normalize(input), init);
      }
      if (input instanceof Request) {
        return originalFetch.call(this, new Request(normalize(input.url), input), init);
      }
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
    const anchor = event.target.closest && event.target.closest("a[href^='/']");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith(prefix + "/")) return;
    event.preventDefault();
    event.stopPropagation();
    location.href = normalize(href);
  }, true);

  document.addEventListener("click", (event) => {
    const anchor = event.target.closest && event.target.closest("a[href]");
    if (!anchor) return;
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
    if (!document.body) return;
    document.querySelectorAll('a[href]').forEach((anchor) => {
      const href = anchor.getAttribute('href');
      if (!href) return;
      const url = absolutize(href);
      if (!url || url.origin !== location.origin) return;
      if (!url.pathname.startsWith("/") || url.pathname.startsWith(prefix + "/")) return;
      anchor.setAttribute('href', normalize(url.pathname + url.search + url.hash));
    });
  };

  const boot = () => {
    rewriteAnchors();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  try {
    const observer = new MutationObserver(() => {
      rewriteAnchors();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
})();
</script>`;

  const withHeadPatch = html.includes("</head>")
    ? html.replace("</head>", `${clientPatch}</head>`)
    : `${clientPatch}${html}`;

  const withNavbar = withHeadPatch.includes("<body")
    ? withHeadPatch
      .replace(/<body([^>]*)>/i, `<body$1>${portalNavbarMarkup}`)
      .replace(/<\/body>/i, `</div></body>`)
    : `${portalNavbarMarkup}${withHeadPatch}`;

  return withNavbar
    .replace(/(href|src|action)=("|')\/(?!\/)/gi, `$1=$2${proxyPrefixEscaped}/`)
    .replace(/(["'])\/_next\//g, `$1${proxyPrefix}/_next/`)
    .replace(/(["'])\/images\//g, `$1${proxyPrefix}/images/`)
    .replace(/(["'])\/api\/v1\//g, `$1${proxyPrefix}/api/v1/`);
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
router.get("/sw.js", requireAuth, ensureSeerrSession, seerrRootAssetProxy);
router.get("/manifest.json", requireAuth, ensureSeerrSession, seerrRootAssetProxy);

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
