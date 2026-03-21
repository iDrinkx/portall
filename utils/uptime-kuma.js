const { io } = require("socket.io-client");

const CACHE_TTL_MS = 5 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const STATUS_DURATION_LOOKBACK_HOURS = 24 * 30;
const KUMA_TIME_ZONE = "Europe/Paris";
const cache = new Map();

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function getTimeZoneOffsetMs(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, part.value])
  );

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return asUtc - date.getTime();
}

function parseKumaTime(value) {
  if (value == null || value === "") return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number") {
    const asMs = value > 1e12 ? value : value * 1000;
    const date = new Date(asMs);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const hasExplicitZone = /(?:[zZ]|[+\-]\d{2}:?\d{2})$/.test(raw);
  const normalized = raw.replace(" ", "T");

  if (hasExplicitZone) {
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    const [, year, month, day, hour, minute, second = "00"] = match;
    const utcGuess = new Date(Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ));
    const offsetMs = getTimeZoneOffsetMs(utcGuess, KUMA_TIME_ZONE);
    const parsed = new Date(utcGuess.getTime() - offsetMs);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const fallback = new Date(normalized);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
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
  const time = parseKumaTime(timeValue);

  return {
    status: Number(entry.status),
    ping: entry.ping,
    message: entry.msg || entry.message || "",
    important: entry.important === true,
    time: time && !Number.isNaN(time.getTime()) ? time.toISOString() : null
  };
}

function normalizeHeartbeatCollection(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.map(normalizeHeartbeatEntry).filter(Boolean);
  }

  if (typeof value === "object") {
    return Object.values(value)
      .flatMap(item => normalizeHeartbeatCollection(item))
      .filter(Boolean);
  }

  return [];
}

function sortHeartbeatsByTime(history = []) {
  return history
    .filter(Boolean)
    .slice()
    .sort((a, b) => {
      const timeA = a?.time ? Date.parse(a.time) : 0;
      const timeB = b?.time ? Date.parse(b.time) : 0;
      return timeA - timeB;
    });
}

function mergeHeartbeats(...groups) {
  const merged = sortHeartbeatsByTime(groups.flat().filter(Boolean));
  const deduped = [];

  for (const entry of merged) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.time === entry.time && previous.status === entry.status) {
      continue;
    }
    deduped.push(entry);
  }

  return deduped;
}

function buildHistoryBars(history, maxBars = 60) {
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

  const namedMap = {
    blue: "#3b82f6",
    orange: "#fb923c",
    red: "#ef4444",
    green: "#10b981",
    yellow: "#f59e0b",
    purple: "#7c3aed",
    pink: "#ec4899",
    cyan: "#06b6d4",
    teal: "#14b8a6"
  };
  const named = color.toLowerCase();
  if (namedMap[named]) return namedMap[named];

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
  return Array.isArray(tags)
    ? tags
        .map(tag => {
          const name = String(tag?.name || tag?.label || tag || "").trim();
          if (!name) return null;
          return { name, color: normalizeTagColor(tag?.color, name) };
        })
        .filter(Boolean)
    : [];
}

function getLatestHeartbeat(history) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]) return history[i];
  }
  return null;
}

function getStatusChangedAt(history) {
  const normalizedHistory = sortHeartbeatsByTime(history);
  const latestHeartbeat = getLatestHeartbeat(normalizedHistory);
  if (!latestHeartbeat) return null;

  let changedAt = latestHeartbeat.time || null;
  for (let i = normalizedHistory.length - 2; i >= 0; i -= 1) {
    const entry = normalizedHistory[i];
    if (!entry) continue;
    if (Number(entry.status) !== Number(latestHeartbeat.status)) {
      break;
    }
    changedAt = entry.time || changedAt;
  }

  return changedAt;
}

function createSocketClient(baseUrl) {
  return io(baseUrl, {
    transports: ["websocket", "polling"],
    reconnection: false,
    timeout: REQUEST_TIMEOUT_MS
  });
}

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error || "Socket connection failed")));
    };
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
      socket.off("error", onError);
    };

    socket.once("connect", onConnect);
    socket.once("connect_error", onError);
    socket.once("error", onError);
  });
}

function emitAsync(socket, eventName, ...args) {
  return new Promise((resolve, reject) => {
    socket.timeout(REQUEST_TIMEOUT_MS).emit(eventName, ...args, (err, ...responses) => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err || `Socket event ${eventName} failed`)));
        return;
      }
      resolve(responses.length <= 1 ? responses[0] : responses);
    });
  });
}

function waitForInitialSnapshot(socket, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const snapshot = {
      monitorList: null,
      heartbeatList: null,
      info: null,
      uptimeById: {}
    };

    const maybeResolve = () => {
      if (snapshot.monitorList && snapshot.heartbeatList) {
        cleanup();
        resolve(snapshot);
      }
    };

    const onMonitorList = (payload) => {
      snapshot.monitorList = payload;
      maybeResolve();
    };
    const onHeartbeatList = (payload) => {
      snapshot.heartbeatList = payload;
      maybeResolve();
    };
    const onInfo = (payload) => {
      snapshot.info = payload;
    };
    const onUptime = (payload) => {
      const monitorID = payload?.monitorID ?? payload?.monitorId ?? payload?.id;
      const periodKey = String(payload?.periodKey || "");
      const percentage = Number(payload?.percentage);
      if (monitorID == null || !periodKey || !Number.isFinite(percentage)) return;
      if (!snapshot.uptimeById[String(monitorID)]) {
        snapshot.uptimeById[String(monitorID)] = {};
      }
      snapshot.uptimeById[String(monitorID)][periodKey] = percentage;
    };
    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error || "Uptime Kuma snapshot failed")));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while waiting for Uptime Kuma initial data"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("monitorList", onMonitorList);
      socket.off("heartbeatList", onHeartbeatList);
      socket.off("info", onInfo);
      socket.off("uptime", onUptime);
      socket.off("connect_error", onError);
      socket.off("error", onError);
    };

    socket.on("monitorList", onMonitorList);
    socket.on("heartbeatList", onHeartbeatList);
    socket.on("info", onInfo);
    socket.on("uptime", onUptime);
    socket.on("connect_error", onError);
    socket.on("error", onError);
  });
}

function toMonitorArray(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value
      .flatMap(item => {
        if (!item) return [];
        if (Array.isArray(item)) return toMonitorArray(item);
        if (typeof item === "object" && !("name" in item) && !("id" in item) && !("type" in item)) {
          return toMonitorArray(item.monitorList || item.monitors || item.data || item.rows || item.list || item);
        }
        return [item];
      })
      .filter(item => item && typeof item === "object");
  }

  if (typeof value === "object") {
    if (value.monitorList || value.monitors || value.data || value.rows || value.list) {
      return toMonitorArray(value.monitorList || value.monitors || value.data || value.rows || value.list);
    }

    return Object.values(value)
      .filter(item => item && typeof item === "object");
  }

  return [];
}

function normalizeMonitorRecord(monitor, index) {
  if (!monitor || typeof monitor !== "object") return null;

  const id = monitor.id ?? monitor.monitorID ?? monitor.monitorId ?? monitor.monitorID;
  const name = String(monitor.name || monitor.title || "").trim();

  if (id == null && !name) return null;

  return {
    ...monitor,
    id: id != null ? id : `monitor-${index}`,
    name: name || `Monitor ${id != null ? id : index + 1}`
  };
}

async function fetchPrivateMonitorData(baseUrl, username, password) {
  const socket = createSocketClient(baseUrl);

  try {
    await waitForConnect(socket);

    const snapshotPromise = waitForInitialSnapshot(socket, REQUEST_TIMEOUT_MS);
    const loginResponse = await emitAsync(socket, "login", { username, password, token: "" });
    if (!loginResponse || loginResponse.ok !== true) {
      throw new Error(loginResponse?.msg || "Uptime Kuma login failed");
    }

    let monitorListResponse = null;
    let heartbeatListResponse = null;
    let uptimeById = {};
    try {
      const snapshot = await snapshotPromise;
      monitorListResponse = snapshot.monitorList;
      heartbeatListResponse = snapshot.heartbeatList;
      uptimeById = snapshot.uptimeById || {};
    } catch (_) {
      monitorListResponse = await emitAsync(socket, "getMonitorList");
    }

    const monitors = toMonitorArray(monitorListResponse)
      .map(normalizeMonitorRecord)
      .filter(Boolean)
      .filter(monitor => monitor.active !== false)
      .sort((a, b) => {
        const weightA = Number.isFinite(Number(a.weight)) ? Number(a.weight) : Number.MAX_SAFE_INTEGER;
        const weightB = Number.isFinite(Number(b.weight)) ? Number(b.weight) : Number.MAX_SAFE_INTEGER;
        if (weightA !== weightB) return weightA - weightB;
        const idA = Number.isFinite(Number(a.id)) ? Number(a.id) : Number.MAX_SAFE_INTEGER;
        const idB = Number.isFinite(Number(b.id)) ? Number(b.id) : Number.MAX_SAFE_INTEGER;
        return idA - idB;
      });

    if (monitors.length === 0) {
      throw new Error("Uptime Kuma monitor list is empty or has an unexpected format");
    }

    const beatEntries = await Promise.all(monitors.map(async monitor => {
      const monitorId = monitor?.id;
      if (monitorId == null) return null;

      const heartbeatKey = String(monitorId);
      const pushedHeartbeatList = heartbeatListResponse && typeof heartbeatListResponse === "object"
        ? heartbeatListResponse[heartbeatKey]
        : null;
      const normalizedPushed = normalizeHeartbeatCollection(pushedHeartbeatList);

      try {
        const response = await emitAsync(socket, "getMonitorBeats", Number(monitorId), STATUS_DURATION_LOOKBACK_HOURS);
        const raw = Array.isArray(response) ? response : (response?.data || response?.beats || []);
        const normalizedRaw = raw.map(normalizeHeartbeatEntry).filter(Boolean);
        if (normalizedRaw.length > 0 || normalizedPushed.length > 0) {
          return [String(monitorId), mergeHeartbeats(normalizedRaw, normalizedPushed)];
        }
      } catch (_) {
        // Fall back to the pushed snapshot if the detailed beats query fails.
      }

      if (normalizedPushed.length > 0) {
        return [heartbeatKey, normalizedPushed];
      }

      return [String(monitorId), []];
    }));

    return {
      monitors,
      beatsById: Object.fromEntries(beatEntries.filter(Boolean)),
      uptimeById
    };
  } finally {
    socket.close();
  }
}

function buildNormalizedStatus(privateData = {}) {
  const monitors = Array.isArray(privateData.monitors) ? privateData.monitors : [];
  const beatsById = privateData.beatsById && typeof privateData.beatsById === "object"
    ? privateData.beatsById
    : {};
  const uptimeById = privateData.uptimeById && typeof privateData.uptimeById === "object"
    ? privateData.uptimeById
    : {};

  const services = [];
  let latestUpdatedAt = null;

  monitors.forEach((monitor, index) => {
    const id = String(monitor?.id ?? index);
    const history = sortHeartbeatsByTime(Array.isArray(beatsById[id]) ? beatsById[id] : []);
    const latestHeartbeat = getLatestHeartbeat(history);
    const statusChangedAt = getStatusChangedAt(history);
    const statusMeta = getMonitorStatusMeta(latestHeartbeat ? latestHeartbeat.status : monitor?.active ? 2 : 0);
    const uptimeEntry = uptimeById[id] || {};
    const uptimeValue = Number(
      uptimeEntry["24"] ??
      uptimeEntry["24h"] ??
      uptimeEntry["720"] ??
      monitor?.uptime ??
      monitor?.upside ??
      monitor?.availability
    );

    if (latestHeartbeat?.time && (!latestUpdatedAt || latestHeartbeat.time > latestUpdatedAt)) {
      latestUpdatedAt = latestHeartbeat.time;
    }

    services.push({
      id,
      name: String(monitor?.name || `Monitor ${id}`),
      group: "Services",
      status: statusMeta,
      uptimePercent: Number.isFinite(uptimeValue) ? uptimeValue : null,
      latestMessage: latestHeartbeat?.message || "",
      latestPing: latestHeartbeat?.ping ?? null,
      latestTime: latestHeartbeat?.time || null,
      statusChangedAt,
      tags: mapTags(monitor?.tags),
      history: buildHistoryBars(history, 60)
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
    title: "Uptime Kuma",
    description: "",
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

async function getPublicStatusPageSummary({ baseUrl, username = "", password = "" }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  if (!normalizedBaseUrl || !username || !password) {
    return { enabled: false, services: [], summary: { total: 0, up: 0, down: 0, maintenance: 0, pending: 0 } };
  }

  const cacheKey = `${normalizedBaseUrl}::${username}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);

  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }

  try {
    const privateData = await fetchPrivateMonitorData(normalizedBaseUrl, username, password);
    const normalized = buildNormalizedStatus(privateData);
    const value = {
      enabled: true,
      sourceUrl: normalizedBaseUrl,
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
      sourceUrl: normalizedBaseUrl,
      title: "Uptime Kuma",
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
  getPublicStatusPageSummary
};
