const { AppSettingQueries } = require("./database");

const SETTING_KEY = "dashboard_section_items";

const DASHBOARD_SECTION_DEFINITIONS = [
  {
    key: "uptime-kuma",
    labelKey: "settings.dashboardSections.uptimeKuma.label",
    descriptionKey: "settings.dashboardSections.uptimeKuma.description"
  },
  {
    key: "server-stats",
    labelKey: "settings.dashboardSections.serverStats.label",
    descriptionKey: "settings.dashboardSections.serverStats.description"
  }
];

function getDefaultDashboardSectionConfig() {
  return DASHBOARD_SECTION_DEFINITIONS.map((item, index) => ({
    key: item.key,
    enabled: item.key === "server-stats"
      ? AppSettingQueries.getBool("dashboard_server_stats_enabled", true)
      : true,
    position: "above",
    order: index
  }));
}

function normalizePosition(value) {
  return String(value || "").trim().toLowerCase() === "below" ? "below" : "above";
}

function normalizeConfig(input) {
  const defaults = getDefaultDashboardSectionConfig();
  const byKey = new Map();

  if (Array.isArray(input)) {
    input.forEach((rawItem, index) => {
      const key = String(rawItem?.key || "").trim();
      if (!key) return;
      byKey.set(key, {
        key,
        enabled: rawItem?.enabled !== false,
        position: normalizePosition(rawItem?.position),
        order: Number.isFinite(Number(rawItem?.order)) ? Number(rawItem.order) : index
      });
    });
  }

  return DASHBOARD_SECTION_DEFINITIONS
    .map((definition, index) => {
      const existing = byKey.get(definition.key);
      if (!existing) return { ...defaults[index] };
      return {
        key: definition.key,
        enabled: existing.enabled !== false,
        position: existing.position,
        order: Number.isFinite(existing.order) ? existing.order : index
      };
    })
    .sort((a, b) => a.order - b.order)
    .map((item, index) => ({ ...item, order: index }));
}

function getDashboardSectionConfig() {
  const raw = AppSettingQueries.get(SETTING_KEY, "");
  if (!raw) return getDefaultDashboardSectionConfig();

  try {
    return normalizeConfig(JSON.parse(raw));
  } catch (_) {
    return getDefaultDashboardSectionConfig();
  }
}

function saveDashboardSectionConfig(items) {
  const normalized = normalizeConfig(items);
  AppSettingQueries.set(SETTING_KEY, JSON.stringify(normalized));
  return normalized;
}

function getDashboardSectionAdminItems(t = null) {
  const configMap = new Map(getDashboardSectionConfig().map(item => [item.key, item]));
  const translate = typeof t === "function" ? t : (key => key);

  return DASHBOARD_SECTION_DEFINITIONS
    .map((definition, index) => {
      const config = configMap.get(definition.key) || { position: "above", order: index };
      return {
        key: definition.key,
        label: translate(definition.labelKey),
        description: translate(definition.descriptionKey),
        enabled: config.enabled !== false,
        position: normalizePosition(config.position),
        order: Number.isFinite(config.order) ? config.order : index
      };
    })
    .sort((a, b) => a.order - b.order)
    .map((item, index) => ({ ...item, order: index }));
}

module.exports = {
  DASHBOARD_SECTION_DEFINITIONS,
  getDashboardSectionConfig,
  getDashboardSectionAdminItems,
  saveDashboardSectionConfig
};
