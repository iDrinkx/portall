const { AppSettingQueries } = require("./database");

const SETTING_KEY = "dashboard_builtin_items";

const DASHBOARD_BUILTIN_DEFINITIONS = [
  {
    key: "profil",
    cardClass: "hero-card-profil",
    route: "/profil",
    cardLabel: "Mon Profil",
    cardTitle: "Profil",
    cardDescription: "Statistiques · Badges · Historique",
    navLabel: "Profil",
    navClass: "nav-link-profil",
    cardKind: "profile"
  },
  {
    key: "classement",
    cardClass: "hero-card-classement",
    iconClass: "hero-icon--classement",
    route: "/classement",
    cardLabel: "Communaute",
    cardTitle: "Classement",
    cardDescription: "Membres · Niveaux · Heures",
    navLabel: "Classement",
    navClass: "nav-link-classement",
    cardKind: "emoji",
    icon: "🏆"
  },
  {
    key: "mes-stats",
    cardClass: "hero-card-stats",
    iconClass: "hero-icon--stats",
    route: "/mes-stats",
    cardLabel: "Visionnage",
    cardTitle: "Statistiques",
    cardDescription: "Genres · Top contenus · Activite",
    navLabel: "Statistiques",
    navClass: "nav-link-stats",
    cardKind: "emoji",
    icon: "📊"
  },
  {
    key: "seerr",
    cardClass: "hero-card-demandes",
    iconClass: "hero-icon--seerr",
    route: "/seerr",
    cardLabel: "Demandes de Contenu",
    cardTitle: "Seerr",
    cardDescription: "Demander films & series",
    navLabel: "Demandes",
    navClass: "nav-link-demandes",
    cardKind: "image",
    iconSrc: "/img/seerr-icon.svg",
    iconAlt: "Seerr"
  },
  {
    key: "calendrier",
    cardClass: "hero-card-calendrier",
    iconClass: "hero-icon--calendrier",
    route: "/calendrier",
    cardLabel: "Sorties a venir",
    cardTitle: "Calendrier",
    cardDescription: "Films · Series · Disponibilite",
    navLabel: "Calendrier",
    navClass: "nav-link-calendrier",
    cardKind: "emoji",
    icon: "📅"
  }
];

function getDefaultDashboardBuiltinConfig() {
  return DASHBOARD_BUILTIN_DEFINITIONS.map((item, index) => ({
    key: item.key,
    enabled: true,
    order: index
  }));
}

function normalizeConfig(input) {
  const defaults = getDefaultDashboardBuiltinConfig();
  const byKey = new Map();

  if (Array.isArray(input)) {
    input.forEach((rawItem, index) => {
      const key = String(rawItem?.key || "").trim();
      if (!key) return;
      byKey.set(key, {
        key,
        enabled: rawItem?.enabled !== false,
        order: Number.isFinite(Number(rawItem?.order)) ? Number(rawItem.order) : index
      });
    });
  }

  return DASHBOARD_BUILTIN_DEFINITIONS
    .map((definition, index) => {
      const existing = byKey.get(definition.key);
      if (!existing) return { ...defaults[index] };
      return {
        key: definition.key,
        enabled: existing.enabled !== false,
        order: Number.isFinite(existing.order) ? existing.order : index
      };
    })
    .sort((a, b) => a.order - b.order)
    .map((item, index) => ({ ...item, order: index }));
}

function getDashboardBuiltinConfig() {
  const raw = AppSettingQueries.get(SETTING_KEY, "");
  if (!raw) return getDefaultDashboardBuiltinConfig();

  try {
    return normalizeConfig(JSON.parse(raw));
  } catch (_) {
    return getDefaultDashboardBuiltinConfig();
  }
}

function saveDashboardBuiltinConfig(items) {
  const normalized = normalizeConfig(items);
  AppSettingQueries.set(SETTING_KEY, JSON.stringify(normalized));
  return normalized;
}

function getDashboardBuiltinAdminItems(t = null) {
  const configMap = new Map(getDashboardBuiltinConfig().map(item => [item.key, item]));
  const translate = typeof t === "function" ? t : (key => key);

  return DASHBOARD_BUILTIN_DEFINITIONS
    .map((definition, index) => {
      const config = configMap.get(definition.key) || { enabled: true, order: index };
      return {
        key: definition.key,
        label: translate(`dashboardBuiltins.${definition.key}.label`),
        description: translate(`dashboardBuiltins.${definition.key}.description`),
        enabled: config.enabled !== false,
        order: Number.isFinite(config.order) ? config.order : index
      };
    })
    .sort((a, b) => a.order - b.order)
    .map((item, index) => ({ ...item, order: index }));
}

function buildDashboardBuiltinCards(user, basePath = "", t = null) {
  const configMap = new Map(getDashboardBuiltinConfig().map(item => [item.key, item]));
  const translate = typeof t === "function" ? t : (key => key);

  return DASHBOARD_BUILTIN_DEFINITIONS
    .map((definition, index) => {
      const config = configMap.get(definition.key) || { enabled: true, order: index };
      return {
        ...definition,
        enabled: config.enabled !== false,
        order: Number.isFinite(config.order) ? config.order : index
      };
    })
    .filter(item => item.enabled)
    .sort((a, b) => a.order - b.order)
    .map(item => ({
      key: item.key,
      href: `${basePath}${item.route}`,
      className: item.cardClass,
      label: translate(`dashboardBuiltins.${item.key}.cardLabel`),
      title: item.cardKind === "profile" ? (user?.username || translate(`dashboardBuiltins.${item.key}.title`)) : translate(`dashboardBuiltins.${item.key}.title`),
      description: translate(`dashboardBuiltins.${item.key}.description`),
      kind: item.cardKind,
      iconClass: item.iconClass || "",
      icon: item.icon || "",
      iconSrc: item.iconSrc ? `${basePath}${item.iconSrc}` : "",
      iconAlt: item.iconAlt || ""
    }));
}

function buildDashboardNavItems(basePath = "", t = null) {
  const configMap = new Map(getDashboardBuiltinConfig().map(item => [item.key, item]));
  const translate = typeof t === "function" ? t : (key => key);

  return DASHBOARD_BUILTIN_DEFINITIONS
    .map((definition, index) => {
      const config = configMap.get(definition.key) || { enabled: true, order: index };
      return {
        ...definition,
        enabled: config.enabled !== false,
        order: Number.isFinite(config.order) ? config.order : index
      };
    })
    .filter(item => item.enabled)
    .sort((a, b) => a.order - b.order)
    .map(item => ({
      key: item.key,
      href: `${basePath}${item.route}`,
      label: translate(`dashboardBuiltins.${item.key}.label`),
      className: item.navClass,
      kind: item.cardKind,
      icon: item.icon || "",
      iconSrc: item.iconSrc ? `${basePath}${item.iconSrc}` : "",
      iconAlt: item.iconAlt || ""
    }));
}

module.exports = {
  DASHBOARD_BUILTIN_DEFINITIONS,
  getDashboardBuiltinAdminItems,
  getDashboardBuiltinConfig,
  saveDashboardBuiltinConfig,
  buildDashboardBuiltinCards,
  buildDashboardNavItems
};
