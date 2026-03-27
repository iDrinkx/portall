const fetch = require('node-fetch');
const log = require('./logger');
const { UserQueries, AchievementSnapshotQueries, mergeUsersByIdentity } = require('./database');
const { XP_SYSTEM } = require('./xp-system');
const {
  getUserStatsFromTautulli,
  getAllUserStatsFromTautulli,
  getMonthlyHoursFromTautulli,
  getTimeBasedSessionCounts,
  isTautulliReady
} = require('./tautulli-direct');
const { refreshUserAchievementState, isSnapshotFullyEvaluated } = require('./achievement-state');
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

function parsePlexTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1e13 ? numeric : Math.floor(numeric / 1000);
  }

  const parsed = new Date(String(value || "")).getTime();
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed / 1000);
  }

  return null;
}

async function fetchCommunityFriendsCreatedAtMap(plexToken) {
  if (!plexToken) {
    return {
      byUsername: {},
      byId: {},
      entries: []
    };
  }

  try {
    const response = await fetch('https://community.plex.tv/api', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://app.plex.tv',
        'Referer': 'https://app.plex.tv/',
        'X-Plex-Client-Identifier': 'portall-app',
        'X-Plex-Platform': 'Node.js',
        'X-Plex-Product': 'portall',
        'X-Plex-Token': plexToken,
        'X-Plex-Version': '1.0.0'
      },
      body: JSON.stringify({
        operationName: 'GetAllFriends',
        query: `
          query GetAllFriends {
            allFriendsV2 {
              user {
                username
                idRaw
              }
              createdAt
            }
          }
        `
      }),
      timeout: 10000
    });

    if (!response.ok) {
      throw new Error(`community.plex.tv → HTTP ${response.status}`);
    }

    const payload = await response.json();
    const rows = Array.isArray(payload?.data?.allFriendsV2) ? payload.data.allFriendsV2 : [];
    const byUsername = {};
    const byId = {};
    const entries = [];

    rows.forEach((entry) => {
      const username = String(entry?.user?.username || '').trim().toLowerCase();
      const idRaw = entry?.user?.idRaw != null ? String(entry.user.idRaw).trim() : '';
      const createdAt = parsePlexTimestamp(entry?.createdAt);
      if (!createdAt) return;

      if (username) byUsername[username] = createdAt;
      if (idRaw) byId[idRaw] = createdAt;
      entries.push({
        username,
        plexId: idRaw || null,
        joinedAtTimestamp: createdAt
      });
    });

    return { byUsername, byId, entries };
  } catch (err) {
    logCR.debug(`Plex community friends lookup failed: ${err.message}`);
    return {
      byUsername: {},
      byId: {},
      entries: []
    };
  }
}

async function fetchCommunityCreatedAtByUsernames(plexToken, usernames = []) {
  const normalizedUsernames = [...new Set(
    usernames
      .map((username) => String(username || '').trim())
      .filter(Boolean)
  )];

  if (!plexToken || normalizedUsernames.length === 0) {
    return {};
  }

  const createdAtByUsername = {};

  await mapInBatches(normalizedUsernames, 5, async (username) => {
    try {
      const response = await fetch('https://community.plex.tv/api', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://app.plex.tv',
          'Referer': 'https://app.plex.tv/',
          'X-Plex-Client-Identifier': 'portall-app',
          'X-Plex-Platform': 'Node.js',
          'X-Plex-Product': 'portall',
          'X-Plex-Token': plexToken,
          'X-Plex-Version': '1.0.0'
        },
        body: JSON.stringify({
          operationName: 'GetUserDetails',
          variables: { username },
          query: `
            query GetUserDetails($username: ID!) {
              userByUsername(username: $username) {
                username
                id
                createdAt
              }
            }
          `
        }),
        timeout: 10000
      });

      if (!response.ok) {
        throw new Error(`community.plex.tv detail -> HTTP ${response.status}`);
      }

      const payload = await response.json();
      const user = payload?.data?.userByUsername;
      const resolvedUsername = String(user?.username || username).trim().toLowerCase();
      const createdAt = parsePlexTimestamp(user?.createdAt);

      if (resolvedUsername && createdAt) {
        createdAtByUsername[resolvedUsername] = createdAt;
      }
    } catch (err) {
      logCR.debug(`Plex community user detail failed for ${username}: ${err.message}`);
    }
  });

  return createdAtByUsername;
}

function mergeCanonicalProfiles(profiles = []) {
  const records = [];
  const indexByKey = new Map();

  const getKeys = (profile) => {
    const keys = [];
    const username = String(profile?.username || '').trim().toLowerCase();
    const email = String(profile?.email || '').trim().toLowerCase();
    const plexId = profile?.plexId != null ? String(profile.plexId).trim() : '';
    if (username) keys.push(`username:${username}`);
    if (email) keys.push(`email:${email}`);
    if (plexId) keys.push(`plexId:${plexId}`);
    const aliases = Array.isArray(profile?.aliases) ? profile.aliases : [];
    aliases.forEach((alias) => {
      const normalized = String(alias || '').trim().toLowerCase();
      if (normalized) keys.push(`username:${normalized}`);
    });
    return [...new Set(keys)];
  };

  const mergeInto = (target, source) => {
    if (!target.username && source.username) target.username = source.username;
    if (!target.email && source.email) target.email = source.email;
    if (!target.plexId && source.plexId != null) target.plexId = source.plexId;
    if (!target.joinedAtTimestamp && source.joinedAtTimestamp) target.joinedAtTimestamp = source.joinedAtTimestamp;
    if (source.thumb && !target.thumb) target.thumb = source.thumb;
    const aliases = new Set([...(target.aliases || []), ...(source.aliases || [])]);
    if (target.username) aliases.add(target.username);
    if (source.username) aliases.add(source.username);
    target.aliases = [...aliases].filter(Boolean);
    return target;
  };

  const reindexRecord = (record, index) => {
    getKeys(record).forEach((key) => indexByKey.set(key, index));
  };

  profiles.forEach((profile) => {
    const keys = getKeys(profile);
    if (!keys.length) return;

    const matchedIndices = [...new Set(keys.map((key) => indexByKey.get(key)).filter((value) => Number.isInteger(value)))];
    let baseIndex = matchedIndices.length ? matchedIndices[0] : -1;

    if (baseIndex === -1) {
      const record = mergeInto({
        username: '',
        email: null,
        plexId: null,
        joinedAtTimestamp: null,
        thumb: null,
        aliases: []
      }, profile);
      records.push(record);
      reindexRecord(record, records.length - 1);
      return;
    }

    const baseRecord = records[baseIndex];
    mergeInto(baseRecord, profile);

    for (const otherIndex of matchedIndices.slice(1)) {
      const other = records[otherIndex];
      if (!other || other === baseRecord) continue;
      mergeInto(baseRecord, other);
      records[otherIndex] = null;
    }

    reindexRecord(baseRecord, baseIndex);
  });

  return records.filter(Boolean).map((record) => ({
    ...record,
    aliases: [...new Set((record.aliases || []).map((alias) => String(alias || '').trim()).filter(Boolean))]
  }));
}

function isLikelyEmail(value) {
  return String(value || '').includes('@');
}

function buildCanonicalProfiles({ plexUsers = [], communityFriends = { byUsername: {}, byId: {} }, wizarrUsers = [], tautulliUsers = [] } = {}) {
  const profiles = [];

  plexUsers.forEach((user) => {
    const username = String(user?.username || '').trim();
    profiles.push({
      username,
      email: user?.email || null,
      plexId: user?.plexId || null,
      joinedAtTimestamp: user?.joinedAtTimestamp || null,
      thumb: user?.thumb || null,
      aliases: [username, user?.title || null]
    });
  });

  (communityFriends.entries || []).forEach((entry) => {
    profiles.push({
      username: String(entry?.username || '').trim(),
      email: null,
      plexId: entry?.plexId || null,
      joinedAtTimestamp: entry?.joinedAtTimestamp || null,
      aliases: [entry?.username || null]
    });
  });

  wizarrUsers.forEach((user) => {
    profiles.push({
      username: String(user?.username || '').trim(),
      email: user?.email || null,
      plexId: user?.plexUserId || null,
      joinedAtTimestamp: null,
      aliases: [user?.username || null]
    });
  });

  tautulliUsers.forEach((user) => {
    const username = String(user?.username || '').trim();
    profiles.push({
      username,
      email: null,
      plexId: user?.userId || null,
      joinedAtTimestamp: null,
      aliases: [username]
    });
  });

  return mergeCanonicalProfiles(profiles);
}

async function enrichCanonicalProfilesWithCommunityDetails(canonicalProfiles = [], plexToken = '') {
  const unresolvedUsernames = canonicalProfiles
    .filter((profile) => !profile?.joinedAtTimestamp)
    .map((profile) => profile?.username)
    .filter((username) => username && !isLikelyEmail(username));

  if (unresolvedUsernames.length === 0) {
    return { enrichedProfiles: canonicalProfiles, resolvedCount: 0 };
  }

  const createdAtByUsername = await fetchCommunityCreatedAtByUsernames(plexToken, unresolvedUsernames);
  let resolvedCount = 0;

  const enrichedProfiles = canonicalProfiles.map((profile) => {
    if (profile?.joinedAtTimestamp) {
      return profile;
    }

    const keys = [profile?.username, ...(profile?.aliases || [])]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);

    const joinedAtTimestamp = keys
      .map((key) => createdAtByUsername[key] || null)
      .find((value) => Number.isFinite(value) && value > 0);

    if (!joinedAtTimestamp) {
      return profile;
    }

    resolvedCount++;
    return {
      ...profile,
      joinedAtTimestamp
    };
  });

  return {
    enrichedProfiles,
    resolvedCount
  };
}

function reconcileUsersWithCanonicalProfiles(canonicalProfiles = [], dbUsers = []) {
  if (!canonicalProfiles.length) {
    return { reconciledProfiles: 0, enrichedUsers: 0, orphanUsers: dbUsers };
  }

  const canonicalByEmail = new Map();
  const canonicalByPlexId = new Map();
  const canonicalByUsername = new Map();

  canonicalProfiles.forEach((profile) => {
    const email = String(profile?.email || '').trim().toLowerCase();
    const plexId = profile?.plexId != null ? String(profile.plexId).trim() : '';
    const aliases = [profile?.username, ...(profile?.aliases || [])];
    if (email) canonicalByEmail.set(email, profile);
    if (plexId) canonicalByPlexId.set(plexId, profile);
    aliases.forEach((alias) => {
      const normalized = String(alias || '').trim().toLowerCase();
      if (normalized) canonicalByUsername.set(normalized, profile);
    });
  });

  let reconciledProfiles = 0;
  let enrichedUsers = 0;
  const orphanUsers = [];

  dbUsers.forEach((dbUser) => {
    const email = String(dbUser?.email || '').trim().toLowerCase();
    const plexId = dbUser?.plexId != null ? String(dbUser.plexId).trim() : '';
    const username = String(dbUser?.username || '').trim().toLowerCase();
    const profile = canonicalByEmail.get(email) || canonicalByPlexId.get(plexId) || canonicalByUsername.get(username) || null;

    if (!profile) {
      orphanUsers.push(dbUser);
      return;
    }

    const aliases = new Set([dbUser.username, profile.username, ...(profile.aliases || [])]);
    aliases.forEach((alias) => {
      if (!alias) return;
      if (isLikelyEmail(alias) && String(alias).trim().toLowerCase() !== username) return;
      try {
        const updated = UserQueries.upsert(
          alias,
          profile.plexId || dbUser.plexId || null,
          profile.email || dbUser.email || null,
          profile.joinedAtTimestamp || dbUser.joinedAt || null
        );
        if (updated && (updated.plexId || updated.email || updated.joinedAt)) {
          enrichedUsers++;
        }
      } catch (_) {}
    });
    reconciledProfiles++;
  });

  try {
    mergeUsersByIdentity();
  } catch (_) {}

  return {
    reconciledProfiles,
    enrichedUsers,
    orphanUsers
  };
}

function buildWizarrIdentitySet(wizarrUsers = []) {
  const usernames = new Set();
  const emails = new Set();
  const plexIds = new Set();

  (Array.isArray(wizarrUsers) ? wizarrUsers : []).forEach((user) => {
    const username = String(user?.username || '').trim().toLowerCase();
    const email = String(user?.email || '').trim().toLowerCase();
    const plexId = user?.plexUserId != null ? String(user.plexUserId).trim() : '';
    if (username) usernames.add(username);
    if (email) emails.add(email);
    if (plexId) plexIds.add(plexId);
  });

  return { usernames, emails, plexIds };
}

function buildProtectedIdentitySet(profiles = []) {
  const usernames = new Set();
  const emails = new Set();
  const plexIds = new Set();

  (Array.isArray(profiles) ? profiles : []).forEach((profile) => {
    const username = String(profile?.username || '').trim().toLowerCase();
    const email = String(profile?.email || '').trim().toLowerCase();
    const plexId = profile?.plexId != null ? String(profile.plexId).trim() : '';
    if (username) usernames.add(username);
    if (email) emails.add(email);
    if (plexId) plexIds.add(plexId);
    (profile?.aliases || []).forEach((alias) => {
      const normalized = String(alias || '').trim().toLowerCase();
      if (normalized) usernames.add(normalized);
    });
  });

  return { usernames, emails, plexIds };
}

function pruneUsersNotInWizarrSourceOfTruth(dbUsers = [], wizarrUsers = [], protectedProfiles = []) {
  const wizarrIdentity = buildWizarrIdentitySet(wizarrUsers);
  const protectedIdentity = buildProtectedIdentitySet(protectedProfiles);
  const usersToDelete = [];

  (Array.isArray(dbUsers) ? dbUsers : []).forEach((dbUser) => {
    const username = String(dbUser?.username || '').trim().toLowerCase();
    const email = String(dbUser?.email || '').trim().toLowerCase();
    const plexId = dbUser?.plexId != null ? String(dbUser.plexId).trim() : '';

    const isProtected =
      protectedIdentity.usernames.has(username) ||
      (email && protectedIdentity.emails.has(email)) ||
      (plexId && protectedIdentity.plexIds.has(plexId));

    if (isProtected) {
      return;
    }

    const isInWizarr =
      wizarrIdentity.usernames.has(username) ||
      (email && wizarrIdentity.emails.has(email)) ||
      (plexId && wizarrIdentity.plexIds.has(plexId));

    if (!isInWizarr) {
      usersToDelete.push(dbUser);
    }
  });

  const deletedCount = UserQueries.deleteByIds(usersToDelete.map((user) => user.id));
  return {
    deletedCount,
    deletedUsers: usersToDelete
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
  const plexJoinedAtById = {};
  const emailToUsername = {};
  const plexIdToUsername = {};
  const plexUsers = [];
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
        const ownerTs = parsePlexTimestamp(od.joinedAt || od.joined_at || od.createdAt || od.created_at);
        if (ownerTs > 0) plexJoinedAtMap[ownerKey] = ownerTs;
        if (od.email) emailToUsername[od.email.toLowerCase()] = od.username;
        if (od.id != null) {
          plexIdToUsername[String(od.id)] = od.username;
          if (ownerTs > 0) plexJoinedAtById[String(od.id)] = ownerTs;
        }
        plexUsers.push({
          username: od.username,
          title: od.friendlyName || od.username,
          email: od.email || null,
          plexId: od.id || null,
          joinedAtTimestamp: ownerTs || null,
          thumb: od.thumb || null
        });
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
        const idMatch = source.match(/\bid="([^"]*)"/i) || source.match(/\buserID="([^"]*)"/i) || source.match(/\buserId="([^"]*)"/i);
        const usernameMatch = source.match(/username="([^"]*)"/i) || source.match(/title="([^"]*)"/i);
        const thumbMatch = source.match(/thumb="([^"]*)"/i) || source.match(/avatar="([^"]*)"/i) || source.match(/photo="([^"]*)"/i);
        const joinedAtMatch =
          source.match(/\bjoined_at="([^"]*)"/i) ||
          source.match(/\bjoinedAt="([^"]*)"/i) ||
          source.match(/\bcreated_at="([^"]*)"/i) ||
          source.match(/\bcreatedAt="([^"]*)"/i);
        const emailMatch = source.match(/\bemail="([^"]*)"/i);

        if (usernameMatch?.[1]) {
          const rawUsername = usernameMatch[1];
          const name = rawUsername.toLowerCase();
          if (thumbMatch?.[1]) {
            thumbMap[name] = thumbMatch[1];
            thumbsFetched++;
          }
          if (joinedAtMatch?.[1]) {
            const ts = parsePlexTimestamp(joinedAtMatch[1]);
            if (ts > 0) plexJoinedAtMap[name] = ts;
          }
          if (emailMatch?.[1]) {
            emailToUsername[emailMatch[1].toLowerCase()] = rawUsername;
          }
          if (idMatch?.[1]) {
            const idKey = String(idMatch[1]).trim();
            if (idKey) {
              plexIdToUsername[idKey] = rawUsername;
              if (plexJoinedAtMap[name]) {
                plexJoinedAtById[idKey] = plexJoinedAtMap[name];
              }
            }
          }
          plexUsers.push({
            username: rawUsername,
            title: usernameMatch?.[1] || rawUsername,
            email: emailMatch?.[1] || null,
            plexId: idMatch?.[1] || null,
            joinedAtTimestamp: plexJoinedAtMap[name] || null,
            thumb: thumbMatch?.[1] || null
          });
        }
      });
    } else {
      logCR.debug(`Plex API XML cloud token refuse: HTTP ${xmlResp.status}`);
    }
  } catch (err) {
    logCR.debug(`Plex API XML failed: ${err.message}`);
  }

  const communityFriends = await fetchCommunityFriendsCreatedAtMap(plexToken);
  for (const [username, createdAt] of Object.entries(communityFriends.byUsername || {})) {
    if (username && createdAt && !plexJoinedAtMap[username]) {
      plexJoinedAtMap[username] = createdAt;
    }
  }
  for (const [idRaw, createdAt] of Object.entries(communityFriends.byId || {})) {
    if (idRaw && createdAt && !plexJoinedAtById[idRaw]) {
      plexJoinedAtById[idRaw] = createdAt;
    }
  }

  logCR.debug(`Plex: ${thumbsFetched} avatars, ${Object.keys(plexJoinedAtMap).length} joined_at/createdAt, ${Object.keys(emailToUsername).length} emails=>username, ${Object.keys(plexIdToUsername).length} ids=>username`);

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
        const plexUserIdKey = wUser.plexUserId != null ? String(wUser.plexUserId) : "";
        const plexName =
          (wUser.email && emailToUsername[wUser.email.toLowerCase()]) ||
          (plexUserIdKey && plexIdToUsername[plexUserIdKey]) ||
          wUser.username;
        const joinedAtTs =
          plexJoinedAtMap[String(plexName || "").toLowerCase()] ||
          (wUser.email ? plexJoinedAtMap[String(emailToUsername[wUser.email.toLowerCase()] || "").toLowerCase()] : null) ||
          (plexUserIdKey ? plexJoinedAtById[plexUserIdKey] : null) ||
          null;
        UserQueries.upsert(plexName, wUser.plexUserId, wUser.email, joinedAtTs);
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

  const tautulliUsers = getAllUserStatsFromTautulli() || [];
  const dbUsersBeforeReconcile = UserQueries.getAll() || [];
  const initialCanonicalProfiles = buildCanonicalProfiles({
    plexUsers,
    communityFriends,
    wizarrUsers,
    tautulliUsers
  });
  const canonicalEnrichment = await enrichCanonicalProfilesWithCommunityDetails(initialCanonicalProfiles, plexToken);
  const canonicalProfiles = canonicalEnrichment.enrichedProfiles;
  const reconciliation = reconcileUsersWithCanonicalProfiles(canonicalProfiles, dbUsersBeforeReconcile);
  logCR.info(`Reconciliation identites: ${canonicalProfiles.length} profils canoniques, ${canonicalEnrichment.resolvedCount} joinedAt recuperes via detail user, ${reconciliation.reconciledProfiles} users DB rapproches, ${reconciliation.orphanUsers.length} orphelins restants`);
  if (reconciliation.orphanUsers.length > 0) {
    const sample = reconciliation.orphanUsers.slice(0, 10).map((user) => user.username).join(', ');
    logCR.debug(`Orphelins (sample): ${sample}`);
  }

  if (wizarrConfigured && hadInitialWizarrUsers) {
    const dbUsersAfterReconcile = UserQueries.getAll() || [];
    const protectedProfiles = plexUsers.length > 0 ? [plexUsers[0]] : [];
    const pruning = pruneUsersNotInWizarrSourceOfTruth(dbUsersAfterReconcile, wizarrUsers, protectedProfiles);
    if (pruning.deletedCount > 0) {
      logCR.warn(`Purge source de verite Wizarr: ${pruning.deletedCount} user(s) hors Wizarr supprimes de la DB`);
      const sample = pruning.deletedUsers.slice(0, 10).map((user) => user.username).join(', ');
      if (sample) {
        logCR.debug(`Supprimes hors Wizarr (sample): ${sample}`);
      }
    }
  }

  const statsToUse = wizarrUsers.map((wUser) => {
    const plexUserIdKey = wUser.plexUserId != null ? String(wUser.plexUserId) : "";
    const plexUsername =
      (wUser.email && emailToUsername[wUser.email.toLowerCase()]) ||
      (plexUserIdKey && plexIdToUsername[plexUserIdKey]) ||
      wUser.username;

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

    const sourcePlexIdKey = wizarrUser?.plexUserId != null
      ? String(wizarrUser.plexUserId)
      : (stats.userId != null ? String(stats.userId) : "");

    let joinedAtTs =
      plexJoinedAtMap[key] ||
      (sourcePlexIdKey ? plexJoinedAtById[sourcePlexIdKey] : null) ||
      (wizarrUser?.email ? plexJoinedAtMap[String(emailToUsername[String(wizarrUser.email).toLowerCase()] || "").toLowerCase()] : null) ||
      null;
    if (!joinedAtTs) {
      const dbUser = UserQueries.getByUsername(stats.username);
      if (dbUser && dbUser.joinedAt) {
        const ts = Number(dbUser.joinedAt);
        if (!Number.isNaN(ts) && ts > 1e8) {
          joinedAtTs = ts < 1e13 ? ts : Math.floor(ts / 1000);
        }
      }
    }

    if (joinedAtTs) {
      try {
        UserQueries.upsert(stats.username, wizarrUser?.plexUserId || stats.userId || null, wizarrUser?.email || null, joinedAtTs);
      } catch (_) {}
    }

    logCR.debug(`XP ${stats.username}: joinedAtTs=${joinedAtTs} src=${(plexJoinedAtMap[key] || (sourcePlexIdKey && plexJoinedAtById[sourcePlexIdKey])) ? 'plex' : joinedAtTs ? 'db' : 'fallback'}`);

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
      const dbUser = UserQueries.getByUsername(stats.username);
      const existingSnapshot = dbUser?.id ? AchievementSnapshotQueries.getForUser(dbUser.id) : null;
      const shouldForceFullEvaluation = includeSecretEvaluation || !isSnapshotFullyEvaluated(existingSnapshot);
      const progressionState = await refreshUserAchievementState({
        username: stats.username,
        id: wizarrUser?.plexUserId || stats.userId || null,
        email: wizarrUser?.email || null,
        joinedAtTimestamp: joinedAtTs || null
      }, {
        precomputedStats: statsHint,
        includeSecretEvaluation: shouldForceFullEvaluation
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
