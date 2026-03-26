const fetch = require("node-fetch");

const DEFAULT_API_BASE_URL = "https://api.uptimerobot.com/v3";
const CACHE_TTL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const cache = new Map();

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function buildAuthHeader(apiKey) {
  return `Bearer ${String(apiKey || "").trim()}`;
}

function parseRobotTime(value) {
  if (value == null || value === "") return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number") {
    const asMs = value > 1e12 ? value : value * 1000;
    const date = new Date(asMs);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const raw = String(value || "").trim();
  if (!raw) return null;

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return parseRobotTime(numeric);
  }

  const normalized = raw.replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pickFirst(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return null;
}

function normalizeTagColor(rawColor, tagName = "") {
  const color = String(rawColor || "").trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) {
    return color;
  }

  const tagMap = {
    portall: "#2563eb",
    plex: "#fb923c",
    seerr: "#7c3aed",
    overseerr: "#7c3aed",
    komga: "#10b981",
    jellyfin: "#06b6d4",
    romm: "#ef4444"
  };

  return tagMap[String(tagName || "").trim().toLowerCase()] || "#3b82f6";
}

function mapTags(tags) {
  if (!tags) return [];
  const source = Array.isArray(tags) ? tags : Object.values(tags);

  return source
    .map((tag) => {
      if (tag == null) return null;
      if (typeof tag === "string") {
        const name = tag.trim();
        return name ? { name, color: normalizeTagColor("", name) } : null;
      }

      const name = String(tag.name || tag.label || tag.value || "").trim();
      if (!name) return null;
      return {
        name,
        color: normalizeTagColor(tag.color || tag.colour || "", name)
      };
    })
    .filter(Boolean);
}

function buildEmptyHistoryBars(maxBars = 60) {
  return Array.from({ length: maxBars }, () => ({
    status: { code: -1, key: "unknown", label: "Unknown", className: "unknown" },
    time: null
  }));
}

function isMaintenanceWindowActive(windowData) {
  const now = Date.now();
  const statusValue = String(
    pickFirst(windowData, ["status", "state", "current_status", "window_status", "windowStatus"]) || ""
  ).trim().toLowerCase();

  if (statusValue && ["active", "running", "in_progress", "ongoing"].includes(statusValue)) {
    return true;
  }

  const start = parseRobotTime(pickFirst(windowData, ["start_time", "startTime", "starts_at", "startsAt"]));
  const end = parseRobotTime(pickFirst(windowData, ["end_time", "endTime", "ends_at", "endsAt"]));

  if (start && end) {
    return start.getTime() <= now && now <= end.getTime();
  }

  return false;
}

function normalizeRobotStatus(rawStatus, isMaintenance) {
  if (isMaintenance) {
    return { code: 3, key: "maintenance", label: "Maintenance", className: "maintenance" };
  }

  const normalized = String(rawStatus == null ? "" : rawStatus).trim().toLowerCase();
  if (["up", "online", "operational", "ok", "healthy"].includes(normalized)) {
    return { code: 1, key: "up", label: "Operational", className: "operational" };
  }
  if (["maintenance", "paused"].includes(normalized)) {
    return { code: 3, key: "maintenance", label: "Maintenance", className: "maintenance" };
  }
  if (["pending", "checking", "unknown", "not checked yet"].includes(normalized)) {
    return { code: 2, key: "pending", label: "Pending", className: "pending" };
  }
  if (["down", "offline", "error", "failed"].includes(normalized)) {
    return { code: 0, key: "down", label: "Down", className: "down" };
  }

  const numeric = Number(rawStatus);
  if (Number.isFinite(numeric)) {
    if (numeric === 2) return { code: 1, key: "up", label: "Operational", className: "operational" };
    if (numeric === 1 || numeric === 0) return { code: 2, key: "pending", label: "Pending", className: "pending" };
    if (numeric === 8 || numeric === 9) return { code: 0, key: "down", label: "Down", className: "down" };
  }

  return { code: -1, key: "unknown", label: "Unknown", className: "unknown" };
}

async function fetchJson(url, apiKey) {
  const response = await fetch(url, {
    method: "GET",
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      Accept: "application/json",
      Authorization: buildAuthHeader(apiKey)
    }
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null;
  }

  if (!response.ok) {
    const rateLimitRemaining = response.headers.get("X-RateLimit-Remaining");
    const retryAfter = response.headers.get("Retry-After");
    const message = data?.error?.message || data?.message || text || `HTTP ${response.status}`;
    const extra = [
      rateLimitRemaining != null ? `remaining=${rateLimitRemaining}` : null,
      retryAfter != null ? `retry-after=${retryAfter}s` : null
    ].filter(Boolean).join(" ");
    throw new Error(extra ? `${message} (${extra})` : message);
  }

  return data;
}

function extractCollection(payload, preferredKeys = []) {
  if (!payload) return [];

  for (const key of preferredKeys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = extractCollection(value, preferredKeys);
      if (nested.length) return nested;
    }
  }

  if (Array.isArray(payload)) return payload;

  if (payload.data && typeof payload.data === "object") {
    const nested = extractCollection(payload.data, preferredKeys);
    if (nested.length) return nested;
  }

  return [];
}

function buildMaintenanceLookup(windows) {
  const lookup = new Set();

  windows.filter(isMaintenanceWindowActive).forEach((windowData) => {
    const ids = []
      .concat(pickFirst(windowData, ["monitor_ids", "monitorIds"]) || [])
      .concat(pickFirst(windowData, ["monitors"]) || []);

    ids.forEach((entry) => {
      if (entry == null) return;
      if (typeof entry === "object") {
        const id = pickFirst(entry, ["id", "monitor_id", "monitorId"]);
        if (id != null) lookup.add(String(id));
        return;
      }
      lookup.add(String(entry));
    });
  });

  return lookup;
}

function durationSecondsToIso(seconds) {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return new Date(Date.now() - (numeric * 1000)).toISOString();
}

function buildNormalizedStatus({ baseUrl, monitorsPayload, maintenancePayload }) {
  const monitors = extractCollection(monitorsPayload, ["monitors", "items", "data"]);
  const maintenanceWindows = extractCollection(maintenancePayload, ["maintenance_windows", "maintenanceWindows", "items", "data"]);
  const activeMaintenanceIds = buildMaintenanceLookup(maintenanceWindows);

  const services = [];
  let latestUpdatedAt = null;

  monitors.forEach((monitor, index) => {
    if (!monitor || typeof monitor !== "object") return;

    const id = String(pickFirst(monitor, ["id", "monitor_id", "monitorId"]) ?? index);
    const name = String(pickFirst(monitor, ["friendly_name", "name", "label"]) || `Monitor ${id}`).trim();
    const statusChangedAt = parseRobotTime(pickFirst(monitor, [
      "status_changed_at",
      "statusChangedAt",
      "last_status_change",
      "lastStatusChange",
      "last_checked_at",
      "lastCheckedAt"
    ])) || parseRobotTime(pickFirst(monitor, ["createDateTime", "create_datetime"])) || parseRobotTime(durationSecondsToIso(pickFirst(monitor, ["currentStateDuration", "current_state_duration"])));
    const latestTime = parseRobotTime(pickFirst(monitor, [
      "updated_at",
      "updatedAt",
      "last_checked_at",
      "lastCheckedAt",
      "checked_at",
      "checkedAt"
    ]));
    const monitorMaintenanceWindows = extractCollection(
      pickFirst(monitor, ["maintenanceWindows", "maintenance_windows"]),
      ["maintenance_windows", "maintenanceWindows", "items", "data"]
    );
    const isMaintenance = activeMaintenanceIds.has(id) || monitorMaintenanceWindows.some(isMaintenanceWindowActive);
    const status = normalizeRobotStatus(
      pickFirst(monitor, ["status", "status_name", "statusName", "monitor_status", "monitorStatus"]),
      isMaintenance
    );

    if (latestTime && (!latestUpdatedAt || latestTime > latestUpdatedAt)) {
      latestUpdatedAt = latestTime;
    }

    services.push({
      id,
      name,
      group: "Services",
      status,
      uptimePercent: Number(pickFirst(monitor, ["uptime", "uptime_ratio", "uptimeRatio", "all_time_uptime_ratio"])),
      latestMessage: String(
        pickFirst(monitor, ["last_error_message", "lastErrorMessage", "monitoring_message", "monitoringMessage", "response_message", "responseMessage", "url"]) || ""
      ),
      latestPing: pickFirst(monitor, ["average_response_time", "averageResponseTime", "response_time", "responseTime"]),
      latestTime: latestTime ? latestTime.toISOString() : null,
      statusChangedAt: statusChangedAt ? statusChangedAt.toISOString() : null,
      tags: mapTags(pickFirst(monitor, ["tags", "tag_list", "tagList"])),
      history: buildEmptyHistoryBars(60)
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
    title: "UptimeRobot",
    sourceUrl: baseUrl,
    description: "",
    services,
    summary,
    overall: summary.total > 0 && summary.down === 0 && summary.pending === 0 && summary.maintenance === 0
      ? "operational"
      : (summary.total > 0 && summary.down === 0 && summary.pending === 0 && summary.maintenance > 0
          ? "maintenance"
          : (summary.total > 0 ? "issues" : "unknown")),
    lastUpdatedAt: latestUpdatedAt ? latestUpdatedAt.toISOString() : null,
    fetchedAt: new Date().toISOString(),
    refreshIntervalMs: REFRESH_INTERVAL_MS
  };
}

async function getPublicStatusPageSummary({ apiBaseUrl = "", apiKey = "" }) {
  const normalizedApiBaseUrl = normalizeBaseUrl(apiBaseUrl) || DEFAULT_API_BASE_URL;
  const normalizedApiKey = String(apiKey || "").trim();

  if (!normalizedApiKey) {
    return { enabled: false, services: [], summary: { total: 0, up: 0, down: 0, maintenance: 0, pending: 0 } };
  }

  const cacheKey = `${normalizedApiBaseUrl}::${normalizedApiKey.slice(0, 12)}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);

  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }

  try {
    const monitorsPayload = await fetchJson(`${normalizedApiBaseUrl}/monitors`, normalizedApiKey);
    let maintenancePayload = null;
    try {
      maintenancePayload = await fetchJson(`${normalizedApiBaseUrl}/maintenance-windows`, normalizedApiKey);
    } catch (_) {
      maintenancePayload = null;
    }

    const normalized = buildNormalizedStatus({
      baseUrl: normalizedApiBaseUrl,
      monitorsPayload,
      maintenancePayload
    });

    const value = {
      enabled: true,
      privateError: null,
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
        privateError: error.message
      };
    }

    return {
      enabled: true,
      sourceUrl: normalizedApiBaseUrl,
      title: "UptimeRobot",
      description: "",
      services: [],
      summary: { total: 0, up: 0, down: 0, maintenance: 0, pending: 0 },
      overall: "unknown",
      lastUpdatedAt: null,
      fetchedAt: new Date().toISOString(),
      refreshIntervalMs: REFRESH_INTERVAL_MS,
      privateError: error.message
    };
  }
}

module.exports = {
  DEFAULT_API_BASE_URL,
  getPublicStatusPageSummary
};
