const path = require("path");
const { spawn } = require("child_process");
const { ACHIEVEMENTS, areCollectionAchievementsEnabled } = require("./achievements");
const {
  UserQueries,
  UserAchievementQueries,
  AchievementProgressQueries,
  AchievementSnapshotQueries
} = require("./database");
const { getConfigValue } = require("./config");
const { getTautulliStats } = require("./tautulli");
const { getAchievementUnlockDates, evaluateSecretAchievements, isTautulliReady } = require("./tautulli-direct");
const log = require("./logger").create("[Achievement-State]");

const SUCCESS_REFRESH_TTL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BACKGROUND_REFRESH_CLEANUP_MS = 10 * 60 * 1000;

const backgroundRefreshQueue = [];
const backgroundRefreshJobs = new Map();
let backgroundRefreshActiveCount = 0;
const backgroundRefreshWorkerPath = path.join(__dirname, "achievement-refresh-worker.js");

function parseSqliteDateToMs(value) {
  if (!value) return 0;
  const normalized = String(value).trim().replace(" ", "T");
  const withZone = /z$/i.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = Date.parse(withZone);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeJoinedAtSeconds(value) {
  if (!value) return 0;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric >= 1e12 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : 0;
}

function buildAchievementData(stats = {}, joinedAtSeconds = 0) {
  const joinedAtMs = normalizeJoinedAtSeconds(joinedAtSeconds) * 1000;
  return {
    totalHours: Number(stats?.watchStats?.totalHours || stats?.totalHours || 0),
    movieCount: Number(stats?.watchStats?.movieCount || stats?.movieCount || 0),
    episodeCount: Number(stats?.watchStats?.episodeCount || stats?.episodeCount || 0),
    sessionCount: Number(stats?.sessionCount || 0),
    monthlyHours: Number(stats?.monthlyHours || 0),
    nightCount: Number(stats?.nightCount || 0),
    morningCount: Number(stats?.morningCount || 0),
    daysSince: joinedAtMs > 0 ? Math.max(0, Math.floor((Date.now() - joinedAtMs) / DAY_MS)) : 0
  };
}

function buildRenderProgressMap(data, persistedProgressMap = {}) {
  const renderProgress = { ...persistedProgressMap };

  for (const achievement of ACHIEVEMENTS.getAll()) {
    if (achievement.category === "collections" || achievement.category === "secrets" || achievement.isSecret) {
      continue;
    }
    if (typeof achievement.getProgress !== "function") continue;

    const progress = achievement.getProgress(data);
    if (!progress || Number(progress.total || 0) <= 0) continue;

    renderProgress[achievement.id] = {
      current: Number(progress.current || 0),
      total: Number(progress.total || 0)
    };
  }

  return renderProgress;
}

function getDbUserFromSessionUser(sessionUser) {
  const username = String(sessionUser?.username || "").trim();
  if (!username) return null;

  try {
    const dbUser = UserQueries.upsert(
      username,
      sessionUser?.id || null,
      sessionUser?.email || null,
      sessionUser?.joinedAt || sessionUser?.joinedAtTimestamp || null
    );
    if (dbUser?.id) return dbUser;
  } catch (_) {}

  return UserQueries.getByUsername(username) || null;
}

function getBackgroundRefreshKey(sessionUser, dbUser = null) {
  const resolvedDbUser = dbUser || getDbUserFromSessionUser(sessionUser);
  if (resolvedDbUser?.id) return `user:${resolvedDbUser.id}`;
  const username = String(sessionUser?.username || "").trim().toLowerCase();
  return username ? `username:${username}` : null;
}

function scheduleBackgroundJobCleanup(jobKey) {
  const timeout = setTimeout(() => {
    const current = backgroundRefreshJobs.get(jobKey);
    if (current && !current.running && !current.queued) {
      backgroundRefreshJobs.delete(jobKey);
    }
  }, BACKGROUND_REFRESH_CLEANUP_MS);
  if (typeof timeout.unref === "function") timeout.unref();
}

function getBackgroundAchievementRefreshStatus(sessionUser) {
  const dbUser = getDbUserFromSessionUser(sessionUser);
  const key = getBackgroundRefreshKey(sessionUser, dbUser);
  const job = key ? backgroundRefreshJobs.get(key) : null;

  return {
    queued: !!job?.queued,
    running: !!job?.running,
    startedAt: job?.startedAt || null,
    finishedAt: job?.finishedAt || null,
    lastError: job?.lastError || null
  };
}

function pumpBackgroundAchievementRefreshQueue() {
  if (backgroundRefreshActiveCount > 0) return;
  const nextJob = backgroundRefreshQueue.shift();
  if (!nextJob) return;

  const liveJob = backgroundRefreshJobs.get(nextJob.key);
  if (!liveJob || liveJob !== nextJob || !liveJob.queued) {
    setImmediate(pumpBackgroundAchievementRefreshQueue);
    return;
  }

  liveJob.queued = false;
  liveJob.running = true;
  liveJob.startedAt = new Date().toISOString();
  liveJob.finishedAt = null;
  liveJob.lastError = null;
  backgroundRefreshActiveCount += 1;

  let finished = false;
  const finalize = (errorMessage = null) => {
    if (finished) return;
    finished = true;
    if (errorMessage) {
      liveJob.lastError = errorMessage;
      log.warn(`Refresh achievements arrière-plan impossible pour ${liveJob.sessionUser?.username || liveJob.key}: ${errorMessage}`);
    }
    liveJob.running = false;
    liveJob.finishedAt = new Date().toISOString();
    backgroundRefreshActiveCount = Math.max(0, backgroundRefreshActiveCount - 1);
    scheduleBackgroundJobCleanup(liveJob.key);
    setImmediate(pumpBackgroundAchievementRefreshQueue);
  };

  try {
    const child = spawn(process.execPath, [backgroundRefreshWorkerPath, JSON.stringify({
      sessionUser: liveJob.sessionUser,
      options: liveJob.options
    })], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"]
    });

    let stderrBuffer = "";
    child.stderr.on("data", chunk => {
      stderrBuffer += String(chunk || "");
    });

    child.on("error", err => {
      finalize(err?.message || "Erreur worker inconnue");
    });

    child.on("exit", code => {
      if (code === 0) {
        finalize(null);
        return;
      }
      const stderr = stderrBuffer.trim();
      finalize(stderr || `Worker terminé avec code ${code}`);
    });
  } catch (err) {
    finalize(err?.message || "Impossible de lancer le worker");
  }
}

function queueBackgroundAchievementRefresh(sessionUser, options = {}) {
  const dbUser = getDbUserFromSessionUser(sessionUser);
  const key = getBackgroundRefreshKey(sessionUser, dbUser);
  if (!key) {
    return { queued: false, running: false, started: false };
  }

  const existing = backgroundRefreshJobs.get(key);
  if (existing?.queued || existing?.running) {
    return {
      queued: !!existing.queued,
      running: !!existing.running,
      started: false
    };
  }

  const job = {
    key,
    sessionUser: {
      username: sessionUser?.username || "",
      id: sessionUser?.id || null,
      email: sessionUser?.email || null,
      joinedAt: sessionUser?.joinedAt || null,
      joinedAtTimestamp: sessionUser?.joinedAtTimestamp || null
    },
    options: { ...options },
    queued: true,
    running: false,
    startedAt: null,
    finishedAt: null,
    lastError: null
  };

  backgroundRefreshJobs.set(key, job);
  backgroundRefreshQueue.push(job);
  setImmediate(pumpBackgroundAchievementRefreshQueue);

  return { queued: true, running: false, started: true };
}

async function persistAchievementState(sessionUser, dbUserId, data, options = {}) {
  const username = String(sessionUser?.username || "").trim();
  const joinedAtSeconds = normalizeJoinedAtSeconds(sessionUser?.joinedAtTimestamp || sessionUser?.joinedAt);
  const today = new Date().toLocaleDateString("fr-FR");
  const includeSecretEvaluation = options.includeSecretEvaluation !== false;
  AchievementSnapshotQueries.save(dbUserId, data);

  const userUnlockedMap = dbUserId ? UserAchievementQueries.getForUser(dbUserId) : {};
  const computedDates = getAchievementUnlockDates(username, joinedAtSeconds || null);

  for (const achievement of ACHIEVEMENTS.getAll()) {
    if (userUnlockedMap[achievement.id]) continue;
    if (achievement.isSecret) continue;
    if (achievement.category === "secrets") continue;
    if (achievement.category === "collections") continue;
    if (!achievement.condition(data)) continue;

    const date = computedDates[achievement.id] || today;
    try {
      UserAchievementQueries.unlock(dbUserId, achievement.id, date, "auto");
    } catch (_) {}
  }

  const collectionsEnabled = areCollectionAchievementsEnabled();
  const collectionsToCheck = collectionsEnabled ? ACHIEVEMENTS.collections : [];
  const secretsToCheck = [...collectionsToCheck, ...ACHIEVEMENTS.secrets]
    .filter(achievement => !achievement.isSecret && (!userUnlockedMap[achievement.id] || achievement.revocable))
    .map(achievement => achievement.id);
  const revocableUnlocked = new Set(
    [...collectionsToCheck, ...ACHIEVEMENTS.secrets]
      .filter(achievement => achievement.revocable && userUnlockedMap[achievement.id])
      .map(achievement => achievement.id)
  );

  if (includeSecretEvaluation && secretsToCheck.length > 0 && isTautulliReady()) {
    try {
      const evalResult = await evaluateSecretAchievements(
        username,
        joinedAtSeconds || null,
        secretsToCheck,
        sessionUser?.id || null
      );
      const evalUnlocked = evalResult?.unlocked || {};
      const evalProgress = evalResult?.progress || {};

      for (const [achievementId, date] of Object.entries(evalUnlocked)) {
        try {
          UserAchievementQueries.unlock(dbUserId, achievementId, date, "auto");
        } catch (_) {}
      }

      for (const achievementId of revocableUnlocked) {
        if (evalUnlocked[achievementId]) continue;
        try {
          UserAchievementQueries.revoke(dbUserId, achievementId);
        } catch (_) {}
      }

      for (const [achievementId, progress] of Object.entries(evalProgress)) {
        try {
          AchievementProgressQueries.save(dbUserId, achievementId, progress.current, progress.total);
        } catch (_) {}
      }

      for (const achievementId of secretsToCheck) {
        if (evalProgress[achievementId]) continue;
        try {
          AchievementProgressQueries.remove(dbUserId, achievementId);
        } catch (_) {}
      }
    } catch (err) {
      log.warn(`Refresh secrets/collections impossible pour ${username}: ${err.message}`);
    }
  }

  return { refreshed: true, data };
}

async function recomputeUserAchievementState(sessionUser, dbUserId, options = {}) {
  const username = String(sessionUser?.username || "").trim();
  const joinedAtSeconds = normalizeJoinedAtSeconds(sessionUser?.joinedAtTimestamp || sessionUser?.joinedAt);
  const stats = await getTautulliStats(
    username,
    getConfigValue("TAUTULLI_URL", ""),
    getConfigValue("TAUTULLI_API_KEY", ""),
    sessionUser?.id || null,
    getConfigValue("PLEX_URL", ""),
    getConfigValue("PLEX_TOKEN", ""),
    joinedAtSeconds || null
  );

  if (!stats) {
    log.warn(`Refresh ignore pour ${username}: stats Tautulli indisponibles`);
    return { refreshed: false, data: null };
  }

  const data = buildAchievementData(stats, joinedAtSeconds);
  return persistAchievementState(sessionUser, dbUserId, data, options);
}

async function refreshUserAchievementState(sessionUser, options = {}) {
  const dbUser = getDbUserFromSessionUser(sessionUser);
  const dbUserId = dbUser?.id || null;
  if (!dbUserId) {
    return {
      dbUserId: null,
      data: buildAchievementData({}, sessionUser?.joinedAtTimestamp || sessionUser?.joinedAt || 0),
      userUnlockedMap: {},
      progressMap: {},
      snapshot: null,
      renderProgressMap: {},
      refreshed: false
    };
  }

  const joinedAtSeconds = normalizeJoinedAtSeconds(sessionUser?.joinedAtTimestamp || sessionUser?.joinedAt);
  const precomputedStats = options.precomputedStats || null;
  const refreshResult = precomputedStats
    ? await persistAchievementState(
        sessionUser,
        dbUserId,
        buildAchievementData(precomputedStats, joinedAtSeconds),
        options
      )
    : await recomputeUserAchievementState(sessionUser, dbUserId, options);

  const snapshot = AchievementSnapshotQueries.getForUser(dbUserId);
  const userUnlockedMap = UserAchievementQueries.getForUser(dbUserId);
  const progressMap = AchievementProgressQueries.getForUser(dbUserId);
  const data = buildAchievementData(snapshot || {}, sessionUser?.joinedAtTimestamp || sessionUser?.joinedAt || 0);
  const renderProgressMap = buildRenderProgressMap(data, progressMap);

  return {
    dbUserId,
    data,
    userUnlockedMap,
    progressMap,
    snapshot,
    renderProgressMap,
    refreshed: !!refreshResult?.refreshed
  };
}

async function getUserAchievementState(sessionUser, options = {}) {
  const maxAgeMs = Number(options.maxAgeMs || SUCCESS_REFRESH_TTL_MS);
  const forceRefresh = !!options.forceRefresh;
  const skipRefresh = !!options.skipRefresh;
  const dbUser = getDbUserFromSessionUser(sessionUser);
  const dbUserId = dbUser?.id || null;

  if (!dbUserId) {
    return {
      dbUserId: null,
      data: buildAchievementData({}, sessionUser?.joinedAtTimestamp || sessionUser?.joinedAt || 0),
      userUnlockedMap: {},
      progressMap: {},
      snapshot: null,
      renderProgressMap: {},
      refreshed: false,
      stale: true
    };
  }

  let snapshot = AchievementSnapshotQueries.getForUser(dbUserId);
  let refreshed = false;
  const snapshotAgeMs = snapshot?.updatedAt ? Math.max(0, Date.now() - parseSqliteDateToMs(snapshot.updatedAt)) : Infinity;
  const stale = !snapshot || snapshotAgeMs > maxAgeMs;

  if (!skipRefresh && (forceRefresh || stale)) {
    const refreshResult = await recomputeUserAchievementState(sessionUser, dbUserId, options);
    refreshed = !!refreshResult.refreshed;
    snapshot = AchievementSnapshotQueries.getForUser(dbUserId) || snapshot;
  }

  const userUnlockedMap = UserAchievementQueries.getForUser(dbUserId);
  const progressMap = AchievementProgressQueries.getForUser(dbUserId);
  const data = buildAchievementData(snapshot || {}, sessionUser?.joinedAtTimestamp || sessionUser?.joinedAt || 0);
  const renderProgressMap = buildRenderProgressMap(data, progressMap);

  return {
    dbUserId,
    data,
    userUnlockedMap,
    progressMap,
    renderProgressMap,
    snapshot,
    refreshed,
    stale,
    needsRefresh: stale && !forceRefresh
  };
}

module.exports = {
  SUCCESS_REFRESH_TTL_MS,
  buildAchievementData,
  buildRenderProgressMap,
  getUserAchievementState,
  refreshUserAchievementState,
  queueBackgroundAchievementRefresh,
  getBackgroundAchievementRefreshStatus
};
