const { rateLimit } = require("express-rate-limit");

function createLimiter(windowMs, limit) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests. Please try again later." }
  });
}

module.exports = {
  authLimiter: createLimiter(15 * 60 * 1000, 12),
  setupLimiter: createLimiter(15 * 60 * 1000, 10),
  sensitiveApiLimiter: createLimiter(60 * 1000, 30)
};
