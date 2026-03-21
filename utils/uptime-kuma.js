const fetch = require("node-fetch");

const CACHE_TTL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const cache = new Map();

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeSlug(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const statusIndex = parts.findIndex(part => part.toLowerCase() === "status");
    if (statusIndex >= 0 && parts[statusIndex + 1]) {
      return String(parts[statusIndex + 1]).trim();
    }
    if (parts.length > 0) {
      return String(parts[parts.length - 1]).trim();
    }
  } catch (_) {}

  const cleaned = raw.replace(/^\/+|\/+$/g, "");
  const statusMatch = cleaned.match(/(?:^|\/)status\/([^/]+)$/i);
  if (statusMatch && statusMatch[1]) {
    return String(statusMatch[1]).trim();
  }

  return cleaned;
}

function withTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}

function getMonitorStatusMeta(statusCode) {
  switch (Number(statusCode)) {
    case 1:
      return { code: 1, key: "up", label: "Operational", className: "operational" };
    case 3:
      return { code: 3, key: "maintenance", label: "Maintenance", className: "maintenance" };
    case 2:
      return { code: 2, key: "pending", label: "Pending", className: "pending" };
    case 0:
    default:
      return { code: 0, key: "down", label: "Down", className: "down" };
  }
}

function normalizeHeartbeatEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const timeValue = entry.time || entry.date || entry.created_at || entry.createdAt || null;
  const time = timeValue ? new Date(timeValue) : null;

  return {
    status: Number(entry.status),
    ping: entry.ping,
    message: entry.msg || entry.message || "",
    time: time && !Number.isNaN(time.getTime()) ? time.toISOString() : null
  };
}

function getLatestHeartbeat(history) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]) return history[i];
  }
  return null;
}

function buildHistoryBars(history, maxBars = 20) {
  const normalized = history.slice(-maxBars).map(entry => ({
    status: getMonitorStatusMeta(entry.status),
    time: entry.time
  }));

  while (normalized.length < maxBars) {
    normalized.unshift({
      status: { code: -1, key: "unknown", label: "Unknown", className: "unknown" },
      time: null
    });
  }

  return normalized;
}

function normalizeTagColor(rawColor, tagName = "") {
  const color = String(rawColor || "").trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) {
    return color;
  }

  const named = color.toLowerCase();
  const namedMap = {
    blue: "#3b82f6",
    orange: "#fb923c",
    red: "#ef4444",
    green: "#10b981",
    yellow: "#f59e0b",
    purple: "#8b5cf6",
    pink: "#ec4899",
    cyan: "#06b6d4",
    teal: "#14b8a6",
    lime: "#84cc16",
    indigo: "#6366f1",
    gray: "#64748b",
    grey: "#64748b"
  };
  if (namedMap[named]) return namedMap[named];

  const tagKey = String(tagName || "").trim().toLowerCase();
  const tagMap = {
    portall: "#2563eb",
    plex: "#fb923c",
    seerr: "#7c3aed",
    overseerr: "#7c3aed",
    komga: "#10b981",
    jellyfin: "#06b6d4",
    romm: "#ef4444"
  };
  return tagMap[tagKey] || "#3b82f6";
}

async function fetchStatusPageData(baseUrl, slug) {
  const [pageRes, heartbeatRes] = await Promise.all([
    withTimeout(`${baseUrl}/api/status-page/${encodeURIComponent(slug)}`, {
      headers: { Accept: "application/json" }
    }),
    withTimeout(`${baseUrl}/api/status-page/heartbeat/${encodeURIComponent(slug)}`, {
      headers: { Accept: "application/json" }
    })
  ]);

  if (!pageRes.ok) {
    throw new Error(`Uptime Kuma status page HTTP ${pageRes.status}`);
  }
  if (!heartbeatRes.ok) {
    throw new Error(`Uptime Kuma heartbeat HTTP ${heartbeatRes.status}`);
  }

  const [pageData, heartbeatData] = await Promise.all([pageRes.json(), heartbeatRes.json()]);
  return { pageData, heartbeatData };
}

function buildNormalizedStatus(pageData = {}, heartbeatData = {}) {
  const groups = Array.isArray(pageData.publicGroupList)
    ? pageData.publicGroupList
    : (Array.isArray(pageData.monitorList)
        ? [{ name: pageData.title || "Services", monitorList: pageData.monitorList }]
        : []);
  const heartbeatList = heartbeatData.heartbeatList && typeof heartbeatData.heartbeatList === "object"
    ? heartbeatData.heartbeatList
    : {};
  const uptimeList = heartbeatData.uptimeList && typeof heartbeatData.uptimeList === "object"
    ? heartbeatData.uptimeList
    : {};

  const services = [];
  let latestUpdatedAt = null;

  groups.forEach((group, groupIndex) => {
    const monitors = Array.isArray(group.monitorList) ? group.monitorList : [];
    monitors.forEach((monitor, monitorIndex) => {
      const id = String(
        monitor.id ??
        monitor.monitorID ??
        monitor.monitorId ??
        `${groupIndex}-${monitorIndex}`
      );
      const rawHistory = Array.isArray(heartbeatList[id]) ? heartbeatList[id] : [];
      const normalizedHistory = rawHistory
        .map(normalizeHeartbeatEntry)
        .filter(Boolean);
      const latestHeartbeat = getLatestHeartbeat(normalizedHistory);
      const statusMeta = getMonitorStatusMeta(latestHeartbeat ? latestHeartbeat.status : 0);
      const uptimeValue = Number(uptimeList[id]);
      const tags = Array.isArray(monitor.tags)
        ? monitor.tags
            .map(tag => {
              const name = String(tag?.name || tag?.label || tag || "").trim();
              if (!name) return null;
              return {
                name,
                color: normalizeTagColor(tag?.color, name)
              };
            })
            .filter(Boolean)
        : [];

      if (latestHeartbeat?.time && (!latestUpdatedAt || latestHeartbeat.time > latestUpdatedAt)) {
        latestUpdatedAt = latestHeartbeat.time;
      }

      services.push({
        id,
        name: String(monitor.name || monitor.title || `Monitor ${id}`),
        group: String(group.name || pageData.title || "Services"),
        status: statusMeta,
        uptimePercent: Number.isFinite(uptimeValue) ? uptimeValue : null,
        latestMessage: latestHeartbeat?.message || "",
        latestPing: latestHeartbeat?.ping ?? null,
        latestTime: latestHeartbeat?.time || null,
        tags,
        history: buildHistoryBars(normalizedHistory, 60)
      });
    });
  });

  const summary = services.reduce((acc, service) => {
    acc.total += 1;
    if (service.status.key === "up") acc.up += 1;
    else if (service.status.key === "maintenance") acc.maintenance += 1;
    else if (service.status.key === "pending") acc.pending += 1;
    else acc.down += 1;
    return acc;
  }, { total: 0, up: 0, down: 0, maintenance: 0, pending: 0 });

  return {
    title: String(pageData.title || pageData.config?.title || "Status"),
    description: String(pageData.description || pageData.config?.description || "").trim(),
    services,
    summary,
    overall: summary.total > 0 && summary.down === 0 && summary.pending === 0 && summary.maintenance === 0
      ? "operational"
      : (summary.total > 0 ? "issues" : "unknown"),
    lastUpdatedAt: latestUpdatedAt,
    fetchedAt: new Date().toISOString(),
    refreshIntervalMs: REFRESH_INTERVAL_MS
  };
}

async function getPublicStatusPageSummary({ baseUrl, slug }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedSlug = normalizeSlug(slug);

  if (!normalizedBaseUrl || !normalizedSlug) {
    return { enabled: false, services: [], summary: { total: 0, up: 0, down: 0, maintenance: 0, pending: 0 } };
  }

  const cacheKey = `${normalizedBaseUrl}::${normalizedSlug}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);

  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }

  try {
    const { pageData, heartbeatData } = await fetchStatusPageData(normalizedBaseUrl, normalizedSlug);
    const normalized = buildNormalizedStatus(pageData, heartbeatData);
    const value = {
      enabled: true,
      sourceUrl: normalizedBaseUrl,
      slug: normalizedSlug,
      ...normalized
    };
    cache.set(cacheKey, { timestamp: now, value });
    return value;
  } catch (error) {
    if (cached) {
      return {
        ...cached.value,
        cached: true,
        stale: true,
        error: error.message
      };
    }

    return {
      enabled: true,
      sourceUrl: normalizedBaseUrl,
      slug: normalizedSlug,
      title: "Status",
      description: "",
      services: [],
      summary: { total: 0, up: 0, down: 0, maintenance: 0, pending: 0 },
      overall: "unknown",
      lastUpdatedAt: null,
      fetchedAt: new Date().toISOString(),
      error: error.message
    };
  }
}

module.exports = {
  getPublicStatusPageSummary
};
