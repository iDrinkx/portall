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
  const dashboardUrl = `${req.basePath || ""}/dashboard`;
  const clientPatch = `
<base href="${baseHref}">
<style>
  :root { --plex-portal-seerr-topbar-height: 44px; }
  html, body { min-height: 100%; background: #0f1117; }
  body { box-sizing: border-box; overflow-x: hidden; }
  #plex-portal-seerr-topbar {
    display: flex;
    align-items: center;
    gap: 12px;
    z-index: 2147483647;
    height: var(--plex-portal-seerr-topbar-height);
    padding: 0 16px;
    background: #161b22;
    border-bottom: 1px solid #30363d;
  }
  #plex-portal-seerr-content {
    min-height: calc(100vh - var(--plex-portal-seerr-topbar-height));
  }
  #plex-portal-seerr-back {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: #c9d1d9;
    text-decoration: none;
    font-size: 0.85rem;
    font-weight: 500;
    padding: 5px 12px;
    border-radius: 6px;
    border: 1px solid #30363d;
    background: #21262d;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  #plex-portal-seerr-back:hover {
    background: #30363d;
    border-color: #8b949e;
    color: #f0f6fc;
  }
  #plex-portal-seerr-back svg { flex-shrink: 0; }
  @media (max-width: 768px) {
    :root { --plex-portal-seerr-topbar-height: 36px; }
    #plex-portal-seerr-topbar { padding: 0 10px; }
    #plex-portal-seerr-back { font-size: 0.78rem; padding: 4px 9px; }
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
      if (anchor.id === 'plex-portal-seerr-back') return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      const url = absolutize(href);
      if (!url || url.origin !== location.origin) return;
      if (!url.pathname.startsWith("/") || url.pathname.startsWith(prefix + "/")) return;
      anchor.setAttribute('href', normalize(url.pathname + url.search + url.hash));
    });
  };

  const ensureTopbar = () => {
    if (!document.body) return;
    if (document.getElementById("plex-portal-seerr-topbar")) return;

    const topbar = document.createElement("div");
    topbar.id = "plex-portal-seerr-topbar";
    topbar.innerHTML = [
      '<a href="' + dashboardUrl + '" id="plex-portal-seerr-back">',
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">',
      '<path fill-rule="evenodd" d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06z"/>',
      '</svg>',
      'Retour au portail',
      '</a>'
    ].join("");

    const content = document.createElement("div");
    content.id = "plex-portal-seerr-content";

    while (document.body.firstChild) {
      content.appendChild(document.body.firstChild);
    }

    document.body.appendChild(topbar);
    document.body.appendChild(content);
  };

  const boot = () => {
    ensureTopbar();
    rewriteAnchors();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  try {
    const observer = new MutationObserver(() => {
      ensureTopbar();
      rewriteAnchors();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
})();
</script>`;

  const withHeadPatch = html.includes("</head>")
    ? html.replace("</head>", `${clientPatch}</head>`)
    : `${clientPatch}${html}`;

  return withHeadPatch
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
  onProxyReq(proxyReq, req) {
    proxyReq.setHeader("X-Forwarded-Prefix", buildProxyPrefix(req));
    proxyReq.setHeader("X-Forwarded-Host", req.get("host") || "");
    proxyReq.setHeader("X-Forwarded-Proto", req.protocol || "http");
    proxyReq.setHeader("X-Forwarded-Uri", req.originalUrl || req.url || "/");
  },
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

router.get(/^\/seerr$/, requireAuth, ensureSeerrSession, (req, res) => {
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  return res.redirect(302, `${req.basePath || ""}/seerr/${query}`);
});

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
