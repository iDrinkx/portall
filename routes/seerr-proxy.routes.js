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

function getSeerrCookieDomain() {
  const publicUrl = String(getConfigValue("SEERR_PUBLIC_URL", "") || "").trim();
  if (!publicUrl) return null;
  try {
    const hostname = new URL(publicUrl).hostname;
    const parts = hostname.split(".");
    if (parts.length >= 2) return "." + parts.slice(-2).join(".");
  } catch (_) {}
  return null;
}

function getSeerrCookieOptions() {
  const cookieOpts = {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true"
  };
  const cookieDomain = getSeerrCookieDomain();
  if (cookieDomain) cookieOpts.domain = cookieDomain;
  return cookieOpts;
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

function rewriteHtmlForProxy(htmlBuffer, req) {
  const html = htmlBuffer.toString("utf8");
  const proxyPrefix = buildProxyPrefix(req);
  const proxyPrefixEscaped = proxyPrefix.replace(/"/g, "&quot;");
  const baseHref = `${proxyPrefix}/`;
  const dashboardUrl = `${req.basePath || ""}/dashboard`;
  const topbarMarkup = `
<div id="plex-portal-seerr-topbar">
  <button type="button" id="plex-portal-seerr-back">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fill-rule="evenodd" d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06z"/>
    </svg>
    Retour
  </button>
</div>`;
  const clientPatch = `
<base href="${baseHref}">
<style>
  :root { --plex-portal-seerr-topbar-height: 44px; }
  html { min-height: 100%; background: #0f1117; }
  body {
    min-height: 100vh;
    padding-top: var(--plex-portal-seerr-topbar-height) !important;
    box-sizing: border-box;
  }
  #plex-portal-seerr-topbar {
    position: fixed;
    inset: 0 0 auto 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    gap: 12px;
    height: var(--plex-portal-seerr-topbar-height);
    padding: 0 16px;
    background: #161b22;
    border-bottom: 1px solid #30363d;
  }
  #plex-portal-seerr-back {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: #c9d1d9;
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

  wrapHistory("pushState");
  wrapHistory("replaceState");

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

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return originalOpen.call(this, method, normalize(url), ...rest);
  };

  const originalAssign = window.location.assign.bind(window.location);
  const originalReplace = window.location.replace.bind(window.location);
  window.location.assign = function(url) {
    return originalAssign(normalize(url));
  };
  window.location.replace = function(url) {
    return originalReplace(normalize(url));
  };

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
    document.querySelectorAll('a[href]').forEach((anchor) => {
      const href = anchor.getAttribute('href');
      if (!href) return;
      const url = absolutize(href);
      if (!url || url.origin !== location.origin) return;
      if (!url.pathname.startsWith("/") || url.pathname.startsWith(prefix + "/")) return;
      anchor.setAttribute('href', normalize(url.pathname + url.search + url.hash));
    });
  };

  const bindBackButton = () => {
    const backBtn = document.getElementById("plex-portal-seerr-back");
    if (!backBtn || backBtn.dataset.bound === "1") return;
    backBtn.dataset.bound = "1";
    backBtn.addEventListener("click", () => {
      if (document.referrer && document.referrer.startsWith(location.origin)) {
        history.back();
        return;
      }
      location.href = dashboardUrl;
    });
  };

  bindBackButton();
  rewriteAnchors();
  document.addEventListener("DOMContentLoaded", bindBackButton);
  document.addEventListener("DOMContentLoaded", rewriteAnchors);
  const observer = new MutationObserver(() => rewriteAnchors());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
</script>`;

  const withHeadPatch = html.includes("</head>")
    ? html.replace("</head>", `${clientPatch}</head>`)
    : `${clientPatch}${html}`;
  const withTopbar = withHeadPatch.includes("<body")
    ? withHeadPatch.replace(/<body([^>]*)>/i, `<body$1>${topbarMarkup}`)
    : `${topbarMarkup}${withHeadPatch}`;

  return withTopbar
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

router.use("/seerr", requireAuth, (req, res, next) => {
  if (!getSeerrUrl()) {
    return res.status(503).send("Seerr non configure cote serveur");
  }
  return next();
});

router.use("/seerr", requireAuth, ensureSeerrSession, seerrProxy);

module.exports = router;
