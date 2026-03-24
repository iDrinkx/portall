const fetch = require('node-fetch');
const log = require('./logger');
const { UserQueries } = require('./database');
const { XP_SYSTEM } = require('./xp-system');
const {
  getUserStatsFromTautulli,
  getAllUserStatsFromTautulli,
  getMonthlyHoursFromTautulli,
  getTimeBasedSessionCounts,
  isTautulliReady
} = require('./tautulli-direct');
const { refreshUserAchievementState } = require('./achievement-state');
const { getAllWizarrUsers, getAllWizarrUsersDetailed } = require('./wizarr');
const { getConfigValue } = require('./config');

const logCR = log.create('[Classement-Refresh]');
const CLASSEMENT_USER_BATCH_SIZE = 1;

const AppSettingQueriesSafe = {
  get(key, defaultValue = null) {
    try {
      const { AppSettingQueries } = require('./database');
      return AppSettingQueries.get(key, defaultValue);
    } catch (_) {
      return defaultValue;
    }
  }
};

function buildClassementUsersFromDb(dbUsers = []) {
  return dbUsers.map((u) => ({
    username: u.username,
    plexUserId: null,
    email: u.email || null,
    joinedAtTimestamp: u.joinedAt ? Number(u.joinedAt) : null
  }));
}

function buildClassementUsersFromTautulli() {
  const tautulliUsers = getAllUserStatsFromTautulli() || [];
  const seen = new Set();
  const results = [];

  for (const user of tautulliUsers) {
    const username = String(user?.username || '').trim();
    if (!username) continue;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      UserQueries.upsert(username, null, null, null);
    } catch (_) {}

    results.push({
      username,
      plexUserId: user.userId || null,
      email: null,
      joinedAtTimestamp: null
    });
  }

  return results;
}

function chooseBestClassementFallbackUsers() {
  const dbUsers = buildClassementUsersFromDb(UserQueries.getAll() || []);
  const tautulliUsers = buildClassementUsersFromTautulli();

  if (tautulliUsers.length > dbUsers.length) {
    return {
      source: 'tautulli',
      users: tautulliUsers,
      dbCount: dbUsers.length,
      tautulliCount: tautulliUsers.length
    };
  }

  if (dbUsers.length > 0) {
    return {
      source: 'db',
      users: dbUsers,
      dbCount: dbUsers.length,
      tautulliCount: tautulliUsers.length
    };
  }

  return {
    source: 'tautulli',
    users: tautulliUsers,
    dbCount: dbUsers.length,
    tautulliCount: tautulliUsers.length
  };
}

function getPlexCloudToken() {
  const runtimeToken = String(AppSettingQueriesSafe.get('runtime_plex_cloud_token', '') || '').trim();
  if (runtimeToken) return runtimeToken;
  return String(getConfigValue('PLEX_TOKEN', '') || '').trim();
}

async function mapInBatches(items, batchSize, mapper) {
  const results = [];
  const size = Math.max(1, Number(batchSize || 1));
  const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const batchResults = await Promise.all(batch.map(mapper));
    results.push(...batchResults);
    await yieldToEventLoop();
  }

  return results;
}

async function buildClassementSnapshot(options = {}) {
  const includeSecretEvaluation = options.includeSecretEvaluation === true;
  const startTime = Date.now();

  if (!isTautulliReady()) {
    return {
      skipped: true,
      reason: 'tautulli_not_ready'
    };
  }

  const plexToken = getPlexCloudToken();
  const thumbMap = {};
  const plexJoinedAtMap = {};
  const emailToUsername = {};
  let thumbsFetched = 0;

  try {
    const ownerResp = await fetch('https://plex.tv/api/v2/user', {
      headers: { 'X-Plex-Token': plexToken, Accept: 'application/json' },
      timeout: 8000
    });
    if (ownerResp.ok) {
      const od = await ownerResp.json();
      if (od.username) {
        const ownerKey = od.username.toLowerCase();
        if (od.thumb) {
          thumbMap[ownerKey] = od.thumb;
          thumbsFetched++;
        }
        const ownerTs = Number(od.joinedAt || od.joined_at || 0);
        if (ownerTs > 0) plexJoinedAtMap[ownerKey] = ownerTs;
        if (od.email) emailToUsername[od.email.toLowerCase()] = od.username;
      }
    } else {
      logCR.debug(`Plex API v2 cloud token refuse: HTTP ${ownerResp.status}`);
    }
  } catch (err) {
    logCR.debug(`Plex API v2 failed: ${err.message}`);
  }

  try {
    const xmlResp = await fetch('https://plex.tv/api/users', {
      headers: { 'X-Plex-Token': plexToken, Accept: 'application/xml' },
      timeout: 10000
    });
    if (xmlResp.ok) {
      const xml = await xmlResp.text();
      const userBlocks = xml.match(/<User\b[\s\S]*?<\/User>/gi) || [];
      const selfClosingUsers = xml.match(/<User\b[^>]*\/>/gi) || [];
      const allUserEntries = userBlocks.length ? userBlocks : selfClosingUsers;

      allUserEntries.forEach((block) => {
        const openTagMatch = block.match(/<User\b([^>]*)>/i) || block.match(/<User\b([^>]*)\/>/i);
        const source = openTagMatch?.[1] ? `${openTagMatch[1]} ${block}` : block;
        const usernameMatch = source.match(/username="([^"]*)"/i) || source.match(/title="([^"]*)"/i);
        const thumbMatch = source.match(/thumb="([^"]*)"/i) || source.match(/avatar="([^"]*)"/i) || source.match(/photo="([^"]*)"/i);
        const joinedAtMatch = source.match(/joined_at="([^"]*)"/i);
        const emailMatch = source.match(/\bemail="([^"]*)"/i);

        if (usernameMatch?.[1]) {
          const rawUsername = usernameMatch[1];
          const name = rawUsername.toLowerCase();
          if (thumbMatch?.[1]) {
            thumbMap[name] = thumbMatch[1];
            thumbsFetched++;
          }
          if (joinedAtMatch?.[1]) {
            const ts = Number(joinedAtMatch[1]);
            if (ts > 0) plexJoinedAtMap[name] = ts;
          }
          if (emailMatch?.[1]) {
            emailToUsername[emailMatch[1].toLowerCase()] = rawUsername;
          }
        }
      });
    } else {
      logCR.debug(`Plex API XML cloud token refuse: HTTP ${xmlResp.status}`);
    }
  } catch (err) {
    logCR.debug(`Plex API XML failed: ${err.message}`);
  }

  logCR.debug(`Plex: ${thumbsFetched} avatars, ${Object.keys(plexJoinedAtMap).length} joined_at, ${Object.keys(emailToUsername).length} emails=>username`);

  const wizarrUrl = String(getConfigValue('WIZARR_URL', '') || '').trim();
  const wizarrApiKey = String(getConfigValue('WIZARR_API_KEY', '') || '').trim();
  const wizarrConfigured = !!(wizarrUrl && wizarrApiKey);
  let wizarrUsers = [];

  if (wizarrConfigured) {
    const wizarrResult = await getAllWizarrUsersDetailed(wizarrUrl, wizarrApiKey);
    wizarrUsers = wizarrResult.users || [];
    if (!wizarrUsers.length) {
      logCR.warn(`Wizarr indisponible/vide pour classement - ${wizarrResult.reason || 'raison inconnue'}`);
    } else {
      logCR.debug(`Wizarr classement: ${wizarrUsers.length} users via ${wizarrResult.source}`);
    }
  } else {
    logCR.debug('Wizarr desactive - classement sans source Wizarr');
    wizarrUsers = await getAllWizarrUsers(wizarrUrl, wizarrApiKey);
  }
  const hadInitialWizarrUsers = wizarrUsers.length > 0;

  if (wizarrUsers.length > 0) {
    const now = Date.now();
    wizarrUsers = wizarrUsers.filter((u) => {
      if (!u) return false;
      if (!u.expires) return true;
      const ts = new Date(u.expires).getTime();
      return Number.isFinite(ts) && ts > now;
    });

    const seenWizarrEmails = new Set();
    wizarrUsers = wizarrUsers.filter((u) => {
      if (u.email) {
        const emailKey = u.email.toLowerCase();
        if (seenWizarrEmails.has(emailKey)) return false;
        seenWizarrEmails.add(emailKey);
      }
      return true;
    });

    logCR.debug(`${wizarrUsers.length} users Wizarr (apres dedup email)`);
    for (const wUser of wizarrUsers) {
      try {
        const plexName = (wUser.email && emailToUsername[wUser.email.toLowerCase()]) || wUser.username;
        UserQueries.upsert(plexName, wUser.plexUserId, wUser.email, null);
      } catch (_) {}
    }
  } else if (!wizarrConfigured) {
    const dbUsers = UserQueries.getAll() || [];
    wizarrUsers = buildClassementUsersFromDb(dbUsers);
    logCR.debug(`[Classement-Refresh] Fallback DB: ${wizarrUsers.length} users`);
    if (wizarrUsers.length === 0) {
      wizarrUsers = buildClassementUsersFromTautulli();
      if (wizarrUsers.length > 0) {
        logCR.warn(`Wizarr non configure et DB vide, fallback Tautulli (${wizarrUsers.length} users)`);
      }
    }
  } else {
    const dbUsers = UserQueries.getAll() || [];
    if (dbUsers.length > 0) {
      wizarrUsers = buildClassementUsersFromDb(dbUsers);
      logCR.warn(`Wizarr vide, fallback DB de secours (${wizarrUsers.length} users)`);
    } else {
      wizarrUsers = buildClassementUsersFromTautulli();
      if (wizarrUsers.length > 0) {
        logCR.warn(`Wizarr vide, fallback Tautulli (${wizarrUsers.length} users)`);
      } else {
        wizarrUsers = [];
        logCR.warn('Wizarr vide, DB locale vide et Tautulli sans utilisateurs');
      }
    }
  }

  if (!hadInitialWizarrUsers) {
    const fallback = chooseBestClassementFallbackUsers();
    if (fallback.source === 'tautulli' && fallback.tautulliCount > wizarrUsers.length) {
      wizarrUsers = fallback.users;
      logCR.warn(`Fallback classement remplace par Tautulli (${fallback.tautulliCount} users, DB=${fallback.dbCount})`);
    }
  }

  if (wizarrUsers.length === 0) {
    return {
      skipped: true,
      reason: 'no_users'
    };
  }

  const statsToUse = wizarrUsers.map((wUser) => {
    const plexUsername = (wUser.email && emailToUsername[wUser.email.toLowerCase()]) || wUser.username;

    if (plexUsername !== wUser.username) {
      logCR.debug(`Correlation email: ${wUser.username} -> ${plexUsername} (via ${wUser.email})`);
    }

    const tautulliStats = getUserStatsFromTautulli(plexUsername);
    if (tautulliStats) {
      return { ...tautulliStats, username: plexUsername };
    }
    return {
      username: plexUsername,
      session_count: 0,
      total_duration_seconds: 0,
      last_session_timestamp: null,
      movie_count: 0,
      movie_duration_seconds: 0,
      episode_count: 0,
      episode_duration_seconds: 0,
      music_count: 0,
      music_duration_seconds: 0,
      totalHours: 0
    };
  });

  const seenUsernames = new Set();
  const statsFiltered = statsToUse.filter((stats) => {
    const key = stats.username.toLowerCase();
    if (key.includes('@')) {
      logCR.debug(`Skip email-as-username: ${stats.username}`);
      return false;
    }
    if (seenUsernames.has(key)) {
      logCR.debug(`Skip doublon: ${stats.username}`);
      return false;
    }
    seenUsernames.add(key);
    return true;
  });

  logCR.debug(`Classement: ${statsFiltered.length} users (${statsToUse.length - statsFiltered.length} doublons/emails filtres, ${statsFiltered.filter((s) => s.totalHours > 0).length} avec stats Tautulli)`);

  const users = await mapInBatches(statsFiltered, CLASSEMENT_USER_BATCH_SIZE, async (stats) => {
    const key = (stats.username || '').toLowerCase();
    const thumb = thumbMap[key] || null;
    const wizarrUser = wizarrUsers.find((entry) => String(entry?.username || '').trim().toLowerCase() === key)
      || wizarrUsers.find((entry) => String(entry?.email || '').trim().toLowerCase() && emailToUsername[String(entry.email || '').trim().toLowerCase()]?.toLowerCase() === key)
      || null;

    let joinedAtTs = plexJoinedAtMap[key] || null;
    if (!joinedAtTs) {
      const dbUser = UserQueries.getByUsername(stats.username);
      if (dbUser && dbUser.joinedAt) {
        const ts = Number(dbUser.joinedAt);
        if (!Number.isNaN(ts) && ts > 1e8) {
          joinedAtTs = ts < 1e13 ? ts : Math.floor(ts / 1000);
        }
      }
    }

    if (plexJoinedAtMap[key]) {
      try {
        UserQueries.upsert(stats.username, null, null, plexJoinedAtMap[key]);
      } catch (_) {}
    }

    logCR.debug(`XP ${stats.username}: joinedAtTs=${joinedAtTs} src=${plexJoinedAtMap[key] ? 'plex' : joinedAtTs ? 'db' : 'fallback'}`);

    try {
      const monthlyHours = Number(getMonthlyHoursFromTautulli(stats.username) || 0);
      const { nightCount, morningCount } = getTimeBasedSessionCounts(stats.username);
      const statsHint = {
        totalHours: Number(stats.totalHours ?? 0),
        sessionCount: Number(stats.sessionCount ?? stats.session_count ?? 0),
        movieCount: Number(stats.movieCount ?? stats.movie_count ?? 0),
        episodeCount: Number(stats.episodeCount ?? stats.episode_count ?? 0),
        monthlyHours,
        nightCount: Number(nightCount || 0),
        morningCount: Number(morningCount || 0)
      };
      const progressionState = await refreshUserAchievementState({
        username: stats.username,
        id: wizarrUser?.plexUserId || stats.userId || null,
        email: wizarrUser?.email || null,
        joinedAtTimestamp: joinedAtTs || null
      }, {
        precomputedStats: statsHint,
        includeSecretEvaluation
      });
      const snapshot = progressionState?.snapshot || {};
      const rank = snapshot.rank || XP_SYSTEM.getRankByLevel(snapshot.level || 1);

      return {
        username: stats.username,
        thumb,
        totalHours: Number(snapshot.totalHours || stats.totalHours || 0),
        totalXp: Number(snapshot.totalXp || 0),
        level: Number(snapshot.level || 1),
        rank,
        badgeCount: Number(snapshot.badgeCount || 0)
      };
    } catch (err) {
      logCR.error(`Erreur XP pour ${stats.username}: ${err.message}`);
      return {
        username: stats.username,
        thumb,
        totalHours: stats.totalHours || 0,
        totalXp: 0,
        level: 1,
        rank: XP_SYSTEM.getRankByLevel(1),
        badgeCount: 0
      };
    }
  });

  return {
    skipped: false,
    users,
    durationMs: Date.now() - startTime
  };
}

module.exports = {
  buildClassementSnapshot
};
