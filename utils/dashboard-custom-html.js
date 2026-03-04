const { AppSettingQueries } = require("./database");

const HTML_KEY = "dashboard_custom_html";
const MODE_KEY = "dashboard_custom_html_mode";

function normalizeHtmlBlock(rawBlock, index = 0) {
  const html = String(rawBlock?.html == null ? rawBlock == null ? "" : rawBlock : rawBlock.html).trim();
  const id = String(rawBlock?.id || `block-${index + 1}`).trim() || `block-${index + 1}`;
  const position = String(rawBlock?.position || "below").trim().toLowerCase() === "above" ? "above" : "below";
  return { id, html, position };
}

function parseDashboardCustomHtmlBlocks(rawValue) {
  const raw = String(rawValue == null ? "" : rawValue);
  if (!raw.trim()) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((block, index) => normalizeHtmlBlock(block, index))
        .filter(block => block.html);
    }
  } catch (_) {}

  return [{ id: "block-1", html: raw.trim() }];
}

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

function getDashboardCustomHtmlBlocksRaw() {
  return parseDashboardCustomHtmlBlocks(getDashboardCustomHtmlRaw());
}

function getDashboardCustomHtmlMode() {
  const mode = String(AppSettingQueries.get(MODE_KEY, "safe") || "safe").trim().toLowerCase();
  return mode === "raw" ? "raw" : "safe";
}

function isDashboardCustomHtmlRawMode() {
  return getDashboardCustomHtmlMode() === "raw";
}

function getDashboardCustomHtml() {
  return getDashboardCustomHtmlBlocks()
    .map(block => block.rendered)
    .filter(Boolean)
    .join("\n");
}

function getDashboardCustomHtmlBlocks() {
  const rawBlocks = getDashboardCustomHtmlBlocksRaw();
  const rawMode = isDashboardCustomHtmlRawMode();
  return rawBlocks.map(block => {
    const sanitized = sanitizeDashboardCustomHtml(block.html);
    return {
      id: block.id,
      position: block.position,
      raw: block.html,
      sanitized,
      rendered: rawMode ? block.html : sanitized
    };
  });
}

function saveDashboardCustomHtml(rawHtml, options = {}) {
  const requestedMode = String(options.mode || getDashboardCustomHtmlMode()).trim().toLowerCase();
  const mode = requestedMode === "raw" ? "raw" : "safe";
  const rawBlocks = Array.isArray(options.blocks)
    ? options.blocks.map((block, index) => normalizeHtmlBlock(block, index)).filter(block => block.html)
    : parseDashboardCustomHtmlBlocks(rawHtml);

  if (!rawBlocks.length) {
    AppSettingQueries.remove(HTML_KEY);
    AppSettingQueries.set(MODE_KEY, mode);
    return { raw: "", blocks: [], rendered: "", sanitized: "", mode };
  }

  const serializedRaw = JSON.stringify(rawBlocks);
  AppSettingQueries.set(HTML_KEY, serializedRaw);
  AppSettingQueries.set(MODE_KEY, mode);
  const blocks = rawBlocks.map(block => {
    const sanitized = sanitizeDashboardCustomHtml(block.html);
    return {
      id: block.id,
      position: block.position,
      raw: block.html,
      sanitized,
      rendered: mode === "raw" ? block.html : sanitized
    };
  });
  const rendered = blocks.map(block => block.rendered).filter(Boolean).join("\n");
  const sanitized = blocks.map(block => block.sanitized).filter(Boolean).join("\n");
  return {
    raw: serializedRaw,
    blocks,
    rendered,
    sanitized,
    mode
  };
}

module.exports = {
  sanitizeDashboardCustomHtml,
  getDashboardCustomHtmlRaw,
  getDashboardCustomHtmlBlocksRaw,
  getDashboardCustomHtmlMode,
  isDashboardCustomHtmlRawMode,
  getDashboardCustomHtmlBlocks,
  getDashboardCustomHtml,
  saveDashboardCustomHtml
};
