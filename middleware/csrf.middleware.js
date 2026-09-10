const crypto = require("crypto");

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function ensureCsrfToken(req, res, next) {
  if (!req.session) return next();
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("base64url");
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireCsrfToken(req, res, next) {
  if (req.path === "/api/setup" || req.path === "/api/setup/diagnostics") return next();
  if (!UNSAFE_METHODS.has(req.method) || !req.session?.user) return next();
  if (secureEqual(req.get("X-CSRF-Token"), req.session.csrfToken)) return next();
  return res.status(403).json({ error: "Invalid request token" });
}

module.exports = { ensureCsrfToken, requireCsrfToken };
