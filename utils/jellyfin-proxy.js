const cookieSignature = require("cookie-signature");
const { getConfigValue } = require("./config");
const { validateTrustedServiceUrl, resolveAndValidateHostname } = require("./network-url");
const { refreshJellyfinSessionAuth, buildJellyfinAuthorizationHeader } = require("./jellyfin-auth");

const PREFIX = "/jellyfin-proxy";
const BLOCKED_UPSTREAM_HEADERS = ["cookie", "authorization", "x-emby-token", "x-mediabrowser-token", "x-mediabrowser-userid", "x-emby-authorization", "proxy-authorization"];
let httpxyPromise;

function getHttpxy() {
  httpxyPromise ||= import("httpxy").then(({ createProxyServer }) => createProxyServer({ ws: true, changeOrigin: true, xfwd: false, proxyTimeout: 15000, cookieDomainRewrite: { "*": "" } }));
  return httpxyPromise;
}

function rewrittenPath(rawUrl) {
  const url = String(rawUrl || "");
  if (!url.startsWith(PREFIX) || (url.length > PREFIX.length && !["/", "?"].includes(url[PREFIX.length]))) return null;
  const value = url.slice(PREFIX.length) || "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /%5c/i.test(value) || /^\/[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  return value;
}

function sanitizeSetCookies(value) {
  const cookies = Array.isArray(value) ? value : (value ? [value] : []);
  return cookies.filter(cookie => !/^portall\.sid=/i.test(cookie)).map(cookie =>
    String(cookie).replace(/;\s*domain=[^;]*/ig, "")
  );
}

function applyAuthHeaders(proxyReq, auth) {
  for (const name of BLOCKED_UPSTREAM_HEADERS) proxyReq.removeHeader(name);
  const token = String(auth?.accessToken || "").trim();
  const userId = String(auth?.userId || "").trim();
  const authorization = buildJellyfinAuthorizationHeader(auth);
  if (token) { proxyReq.setHeader("X-Emby-Token", token); proxyReq.setHeader("X-MediaBrowser-Token", token); }
  if (userId) proxyReq.setHeader("X-MediaBrowser-UserId", userId);
  if (authorization) { proxyReq.setHeader("Authorization", authorization); proxyReq.setHeader("X-Emby-Authorization", authorization); }
}

async function getTarget() {
  const configured = getConfigValue("JELLYFIN_URL", "");
  if (!configured) throw new Error("Jellyfin unavailable");
  const target = validateTrustedServiceUrl(configured);
  await resolveAndValidateHostname(target);
  return target;
}

function storeGet(store, sid) { return new Promise((resolve, reject) => store.get(sid, (err, data) => err ? reject(err) : resolve(data))); }
function storeSet(store, sid, data) { return new Promise((resolve, reject) => store.set(sid, data, err => err ? reject(err) : resolve())); }

async function loadAuthenticatedSessionFromUpgradeRequest(req, { sessionStore, sessionSecret }) {
  const item = String(req.headers.cookie || "").split(/;\s*/).find(v => v.startsWith("portall.sid="));
  if (!item) return null;
  let value;
  try { value = decodeURIComponent(item.slice("portall.sid=".length)); } catch (_) { return null; }
  if (!value.startsWith("s:")) return null;
  const sid = cookieSignature.unsign(value.slice(2), sessionSecret);
  if (!sid) return null;
  const sessionData = await storeGet(sessionStore, sid);
  if (!sessionData?.user || (sessionData.cookie?.expires && new Date(sessionData.cookie.expires).getTime() <= Date.now())) return null;
  return { sid, sessionData };
}

function isAllowedOrigin(origin, configuredAppUrl = getConfigValue("APP_URL", "")) {
  if (!origin) return false;
  try {
    return !!configuredAppUrl && new URL(origin).origin === new URL(configuredAppUrl).origin;
  } catch (_) { return false; }
}

function rejectUpgrade(socket) { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); }

function createJellyfinProxy({ sessionStore, sessionSecret }) {
  let hooked = false;
  async function proxy() {
    const instance = await getHttpxy();
    if (!hooked) {
      hooked = true;
      instance.on("proxyReq", (upstreamReq, req) => applyAuthHeaders(upstreamReq, req.jellyfinProxyAuth));
      instance.on("proxyReqWs", (upstreamReq, req) => applyAuthHeaders(upstreamReq, req.jellyfinProxyAuth));
      instance.on("proxyRes", upstreamRes => { if (upstreamRes.headers["set-cookie"]) upstreamRes.headers["set-cookie"] = sanitizeSetCookies(upstreamRes.headers["set-cookie"]); });
    }
    return instance;
  }
  return {
    async handleHttp(req, res) {
      const path = rewrittenPath(req.originalUrl || req.url);
      if (!path) return res.status(400).send("Invalid Jellyfin path");
      try {
        const target = await getTarget();
        if (!req.session?.jellyfinAuth?.accessToken) {
          const refreshed = await refreshJellyfinSessionAuth(req.session, req.session?.user);
          if (!refreshed.ok) return res.status(401).send("Connexion Jellyfin requise");
        }
        req.jellyfinProxyAuth = req.session.jellyfinAuth;
        const originalUrl = req.url; req.url = path;
        try { await (await proxy()).web(req, res, { target, changeOrigin: true, xfwd: false, proxyTimeout: 15000 }); }
        finally { req.url = originalUrl; delete req.jellyfinProxyAuth; }
      } catch (_) { if (!res.headersSent) res.status(502).send("Bad Gateway"); }
    },
    async handleUpgrade(req, socket, head) {
      if (!rewrittenPath(req.url) || !isAllowedOrigin(req.headers.origin)) return rejectUpgrade(socket);
      try {
        const loaded = await loadAuthenticatedSessionFromUpgradeRequest(req, { sessionStore, sessionSecret });
        if (!loaded) return rejectUpgrade(socket);
        if (!loaded.sessionData.jellyfinAuth?.accessToken) {
          const refreshed = await refreshJellyfinSessionAuth(loaded.sessionData, loaded.sessionData.user);
          if (!refreshed.ok) return rejectUpgrade(socket);
          await storeSet(sessionStore, loaded.sid, loaded.sessionData);
        }
        const target = await getTarget();
        req.jellyfinProxyAuth = loaded.sessionData.jellyfinAuth;
        const originalUrl = req.url; req.url = rewrittenPath(req.url);
        try { await (await proxy()).ws(req, socket, { target, changeOrigin: true, xfwd: false, proxyTimeout: 15000 }, head); }
        finally { req.url = originalUrl; delete req.jellyfinProxyAuth; }
      } catch (_) { if (!socket.destroyed) socket.destroy(); }
    }
  };
}

module.exports = { createJellyfinProxy, loadAuthenticatedSessionFromUpgradeRequest, rewrittenPath, sanitizeSetCookies, applyAuthHeaders, isAllowedOrigin };
