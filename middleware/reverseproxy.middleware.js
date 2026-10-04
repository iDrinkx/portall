/**
 * Middleware pour détecter et configurer automatiquement
 * le comportement de l'app si elle est derrière un reverse proxy
 */

function normalizePublicAppUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return "";
    return url.toString().replace(/\/$/, "");
  } catch (_) {
    return "";
  }
}

function reverseProxyMiddleware(req, res, next) {
  const socketProtocol = req.socket?.encrypted ? "https" : "http";
  const trustedForwardedHeaders = req.protocol !== socketProtocol || (req.ips || []).length > 0;
  // ============================================
  // Détecter les headers du reverse proxy
  // ============================================
  
  // En-têtes envoyés automatiquement par les reverse proxies
  const forwarded = {
    proto: trustedForwardedHeaders ? (req.headers['x-forwarded-proto'] || req.protocol) : req.protocol,
    host: trustedForwardedHeaders ? (req.headers['x-forwarded-host'] || req.get('host')) : req.get('host'),
    prefix: trustedForwardedHeaders ? (req.headers['x-forwarded-prefix'] || '') : '',
    originalUri: trustedForwardedHeaders ? (req.headers['x-original-uri'] || '') : ''
  };

  // ============================================
  // Déterminer le BASE_PATH
  // ============================================
  
  let basePath = '';

  // 1. D'abord, vérifié env var (override manuel)
  if (process.env.BASE_PATH) {
    basePath = process.env.BASE_PATH;
  }
  // 2. Sinon, utiliser X-Forwarded-Prefix (envoyé par ngx proxy manager, etc)
  else if (forwarded.prefix) {
    basePath = forwarded.prefix;
  }

  basePath = String(basePath || "").trim();
  if (!/^\/(?!\/)[^\\\r\n]*$/.test(basePath)) basePath = "";
  if (basePath.length > 1) basePath = basePath.replace(/\/+$/, "");

  // ============================================
  // Construire l'URL publique pour Plex callback
  // ============================================
  
  let appUrl = normalizePublicAppUrl(process.env.APP_URL);

  if (!appUrl) {
    // A Plex callback is security-sensitive. In production it must never be
    // derived from a client-controlled Host/X-Forwarded-Host header.
    if (process.env.NODE_ENV !== "production") {
      appUrl = normalizePublicAppUrl(`${forwarded.proto}://${forwarded.host}${basePath}`);
    }
  }

  // ============================================
  // Stocker dans les locales et le contexte requis
  // ============================================

  // Pour les vues (EJS)
  res.locals.basePath = basePath;
  res.locals.appUrl = appUrl;

  // Pour le code backend (accessible via req)
  req.basePath = basePath;
  req.appUrl = appUrl;
  req.isReverseProxy = !!forwarded.prefix || forwarded.proto !== req.protocol;

  // Debug
  if (process.env.DEBUG === 'true') {
    console.log('🔍 Reverse Proxy Detection:');
    console.log(`   basePath: "${basePath}"`);
    console.log(`   appUrl: "${appUrl}"`);
    console.log(`   isReverseProxy: ${req.isReverseProxy}`);
  }

  next();
}

module.exports = reverseProxyMiddleware;
module.exports.normalizePublicAppUrl = normalizePublicAppUrl;
