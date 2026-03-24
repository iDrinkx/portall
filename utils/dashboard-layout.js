const { AppSettingQueries } = require("./database");

const SETTING_KEY = "dashboard_layout_config";

function toLayoutId(type, value) {
  return `${type}:${value}`;
}

function getDashboardLayoutConfig() {
  const raw = AppSettingQueries.get(SETTING_KEY, "");
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(item => ({
        id: String(item?.id || "").trim(),
        enabled: item?.enabled !== false
      }))
      .filter(item => item.id);
  } catch (_) {
    return [];
  }
}

function saveDashboardLayoutConfig(items = []) {
  const normalized = items
    .map(item => ({
      id: String(item?.id || "").trim(),
      enabled: item?.enabled !== false
    }))
    .filter(item => item.id);

  AppSettingQueries.set(SETTING_KEY, JSON.stringify(normalized));
  return normalized;
}

function buildDashboardLayoutItems({
  builtinItems = [],
  sectionItems = [],
  customCards = [],
  htmlBlocks = [],
  t = null
}) {
  const translate = typeof t === "function" ? t : (key => key);
  const items = [];

  builtinItems.forEach(item => {
    items.push({
      id: toLayoutId("builtin", item.key),
      type: "builtin",
      refKey: item.key,
      label: item.label,
      description: item.description,
      enabled: item.enabled !== false,
      category: translate("settings.dashboardLayout.category.builtin")
    });
  });

  sectionItems.forEach(item => {
    items.push({
      id: toLayoutId("section", item.key),
      type: "section",
      refKey: item.key,
      label: item.label,
      description: item.description,
      enabled: item.enabled !== false,
      category: translate("settings.dashboardLayout.category.section")
    });
  });

  customCards.forEach(card => {
    items.push({
      id: toLayoutId("custom", card.id),
      type: "custom",
      refKey: String(card.id),
      label: card.title || card.label || `Carte ${card.id}`,
      description: card.description || card.label || "",
      enabled: true,
      category: translate("settings.dashboardLayout.category.custom")
    });
  });

  htmlBlocks.forEach((block, index) => {
    const preview = String(block?.html || block?.raw || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    items.push({
      id: toLayoutId("html", block.id || `block-${index + 1}`),
      type: "html",
      refKey: block.id || `block-${index + 1}`,
      label: translate("settings.dashboardLayout.htmlBlockLabel", { index: index + 1 }),
      description: preview || translate("settings.dashboardLayout.htmlBlockEmpty"),
      enabled: true,
      category: translate("settings.dashboardLayout.category.html")
    });
  });

  const byId = new Map(items.map(item => [item.id, item]));
  const savedConfig = getDashboardLayoutConfig();
  const seen = new Set();
  const ordered = [];

  savedConfig.forEach(savedItem => {
    const item = byId.get(savedItem.id);
    if (!item || seen.has(savedItem.id)) return;
    ordered.push({ ...item, enabled: savedItem.enabled });
    seen.add(savedItem.id);
  });

  items.forEach(item => {
    if (seen.has(item.id)) return;
    ordered.push({ ...item });
    seen.add(item.id);
  });

  return ordered;
}

module.exports = {
  buildDashboardLayoutItems,
  getDashboardLayoutConfig,
  saveDashboardLayoutConfig
};
