function safeJsonForScript(value) {
  return JSON.stringify(value == null ? null : value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

module.exports = { safeJsonForScript };
