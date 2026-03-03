const { AppSettingQueries } = require("./database");

const HTML_KEY = "dashboard_custom_html";
const MODE_KEY = "dashboard_custom_html_mode";

function sanitizeDashboardCustomHtml(input) {
  let html = String(input == null ? "" : input).trim();
  if (!html) return "";

  html = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/<(object|embed|applet|meta|base|form)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(object|embed|applet|meta|base|form)\b[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(["'])[\s\S]*?\1/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*([^\s>]+)/gi, "")
    .replace(/\s+(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, " $1=\"#\"")
    .replace(/\s+srcdoc\s*=\s*(["'])[\s\S]*?\1/gi, "");

  return html;
}

function getDashboardCustomHtmlRaw() {
  return AppSettingQueries.get(HTML_KEY, "") || "";
}

function getDashboardCustomHtmlMode() {
  const mode = String(AppSettingQueries.get(MODE_KEY, "safe") || "safe").trim().toLowerCase();
  return mode === "raw" ? "raw" : "safe";
}

function isDashboardCustomHtmlRawMode() {
  return getDashboardCustomHtmlMode() === "raw";
}

function getDashboardCustomHtml() {
  const raw = getDashboardCustomHtmlRaw();
  return isDashboardCustomHtmlRawMode() ? raw : sanitizeDashboardCustomHtml(raw);
}

function saveDashboardCustomHtml(rawHtml, options = {}) {
  const raw = String(rawHtml == null ? "" : rawHtml);
  const requestedMode = String(options.mode || getDashboardCustomHtmlMode()).trim().toLowerCase();
  const mode = requestedMode === "raw" ? "raw" : "safe";
  if (!raw.trim()) {
    AppSettingQueries.remove(HTML_KEY);
    AppSettingQueries.set(MODE_KEY, mode);
    return { raw: "", rendered: "", sanitized: "", mode };
  }

  AppSettingQueries.set(HTML_KEY, raw);
  AppSettingQueries.set(MODE_KEY, mode);
  const sanitized = sanitizeDashboardCustomHtml(raw);
  return {
    raw,
    rendered: mode === "raw" ? raw : sanitized,
    sanitized,
    mode
  };
}

module.exports = {
  sanitizeDashboardCustomHtml,
  getDashboardCustomHtmlRaw,
  getDashboardCustomHtmlMode,
  isDashboardCustomHtmlRawMode,
  getDashboardCustomHtml,
  saveDashboardCustomHtml
};
