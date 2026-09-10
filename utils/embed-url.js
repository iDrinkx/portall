function normalizeEmbedUrl(value, basePath = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) return `${basePath}${raw}`;
  try {
    const parsed = new URL(raw);
    return /^https?:$/.test(parsed.protocol) ? parsed.toString() : "";
  } catch (_) {
    return "";
  }
}

module.exports = { normalizeEmbedUrl };
