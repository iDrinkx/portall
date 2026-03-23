const cron = require('node-cron');
const fetch = require('node-fetch');
const log = require('./logger');
const { UserQueries } = require('./database');
const { XP_SYSTEM } = require('./xp-system');
const { getUserStatsFromTautulli, getAllUserStatsFromTautulli, isTautulliReady } = require('./tautulli-direct');
const { calculateUserXp } = require('./xp-calculator');  // 🎯 Fonction centralisée XP
const { refreshUserAchievementState, queueBackgroundAchievementRefresh } = require('./achievement-state');
const { getAllWizarrUsers, getAllWizarrUsersDetailed } = require('./wizarr');       // 🔑 Source de vérité
const { getConfigValue } = require('./config');

const logCR = log.create('[Classement-Refresh]');
const CLASSEMENT_REFRESH_CRON = '*/30 * * * *';
const CLASSEMENT_USER_BATCH_SIZE = 4;

let classementCache = {
  data: { byHours: [], byLevel: [] },
  timestamp: null,
  lastRefresh: null
};

let lastValidCache = null; // Cache de secours en cas de corruption
let corruptionCount = 0;    // Compteur de corruptions détectées

function buildClassementUsersFromDb(dbUsers = []) {
  return dbUsers.map(u => ({
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
    const username = String(user?.username || "").trim();
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
      source: "tautulli",
      users: tautulliUsers,
      dbCount: dbUsers.length,
      tautulliCount: tautulliUsers.length
    };
  }

  if (dbUsers.length > 0) {
    return {
      source: "db",
      users: dbUsers,
      dbCount: dbUsers.length,
      tautulliCount: tautulliUsers.length
    };
  }

  return {
    source: "tautulli",
    users: tautulliUsers,
    dbCount: dbUsers.length,
    tautulliCount: tautulliUsers.length
  };
}

function getPlexCloudToken() {
  const runtimeToken = String(AppSettingQueriesSafe.get("runtime_plex_cloud_token", "") || "").trim();
  if (runtimeToken) return runtimeToken;
  return String(getConfigValue('PLEX_TOKEN', '') || '').trim();
}

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

async function mapInBatches(items, batchSize, mapper) {
  const results = [];
  const size = Math.max(1, Number(batchSize || 1));

  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const batchResults = await Promise.all(batch.map(mapper));
    results.push(...batchResults);
  }

  return results;
}

/**
 * 🔍 Valide les données calculées pour détecter les corruptions
 */
function validateCacheData(users, stats) {
  const issues = [];

  // ⚠️ NOTE: joinedAt manquant est OK grâce au fallback intelligent (30/60/120 jours)
  // Donc on ne le compte PAS comme un problème
  // On ne vérifie que si les données CALCULÉES sont cohérentes

  // Vérifier 2: Trop d'utilisateurs sans photos Plex
  const noPhotoCount = users.filter(u => !u.thumb).length;
  if (noPhotoCount > users.length * 0.5) {
    issues.push(`⚠️ ${noPhotoCount}/${users.length} users sans photo (${Math.round(noPhotoCount/users.length*100)}%)`);
  }

  // Vérifier 3: Vérifier la cohérence level/XP pour top users
  const topUsers = users.slice(0, 3);
  topUsers.forEach(user => {
    const expectedLevel = XP_SYSTEM.getLevel(user.totalXp);
    if (expectedLevel !== user.level) {
      issues.push(`⚠️ ${user.username}: level incohérent (level=${user.level}, XP=${user.totalXp} → level ${expectedLevel})`);
    }
  });

  // Vérifier 4: Comparaison avec cache précédent
  if (lastValidCache && lastValidCache.data.byLevel.length > 0) {
    const topUserPrev = lastValidCache.data.byLevel[0];
    const topUserNow = users.find(u => u.username === topUserPrev.username);

    if (topUserNow && topUserNow.level < topUserPrev.level - 5) {
      issues.push(`⚠️ Niveau du top user a baissé drastiquement (${topUserPrev.level} → ${topUserNow.level})`);
    }
  }

  // Vérifier 5: Au moins 1 user avec photo (si Plex est configuré)
  const hasPlexToken = String(getConfigValue('PLEX_TOKEN', '') || '').trim().length > 0;
  if (hasPlexToken && noPhotoCount === users.length) {
    issues.push(`⚠️ Aucune photo Plex trouvée (Plex API probablement inaccessible)`);
  }

  return issues;
}

/**
 * Pré-calcule et cache les données du classement
 */
async function refreshClassementCache() {
  try {
    logCR.debug('🔄 Refresh classement en cours...');
    const startTime = Date.now();

    if (!isTautulliReady()) {
      logCR.warn('Tautulli pas prêt, skip refresh');
      return;
    }

    // ══════════════════════════════════════════════════════════════════
    // ÉTAPE 1: Plex XML en premier — construit les 3 maps de référence
    //   thumbMap         : username → avatar URL
    //   plexJoinedAtMap  : username → joined_at (secondes Unix)
    //   emailToUsername  : email    → plex username  ← pont Wizarr→Tautulli
    // ══════════════════════════════════════════════════════════════════
    const plexToken = getPlexCloudToken();
    const thumbMap        = {};
    const plexJoinedAtMap = {};
    const emailToUsername = {};  // 🔗 Corrélation email → plex username (fiable)
    let thumbsFetched = 0;

    // API v2 : owner uniquement
    try {
      const ownerResp = await fetch('https://plex.tv/api/v2/user', {
        headers: { 'X-Plex-Token': plexToken, 'Accept': 'application/json' },
        timeout: 8000
      });
      if (ownerResp.ok) {
        const od = await ownerResp.json();
        if (od.username) {
          const ownerKey = od.username.toLowerCase();
          if (od.thumb) { thumbMap[ownerKey] = od.thumb; thumbsFetched++; }
          const ownerTs = Number(od.joinedAt || od.joined_at || 0);
          if (ownerTs > 0) plexJoinedAtMap[ownerKey] = ownerTs;
          if (od.email) emailToUsername[od.email.toLowerCase()] = od.username;
        }
      } else {
        logCR.debug(`⚠️  Plex API v2 cloud token refusé: HTTP ${ownerResp.status}`);
      }
    } catch (err) {
      logCR.debug(`⚠️  Plex API v2 failed: ${err.message}`);
    }

    // API XML : tous les users partagés (thumb + joined_at + email)
    try {
      const xmlResp = await fetch('https://plex.tv/api/users', {
        headers: { 'X-Plex-Token': plexToken, 'Accept': 'application/xml' },
        timeout: 10000
      });
      if (xmlResp.ok) {
        const xml = await xmlResp.text();
        const userBlocks = xml.match(/<User\b[\s\S]*?<\/User>/gi) || [];
        const selfClosingUsers = xml.match(/<User\b[^>]*\/>/gi) || [];
        const allUserEntries = userBlocks.length ? userBlocks : selfClosingUsers;

        allUserEntries.forEach(block => {
          const openTagMatch = block.match(/<User\b([^>]*)>/i) || block.match(/<User\b([^>]*)\/>/i);
          const source = openTagMatch?.[1] ? `${openTagMatch[1]} ${block}` : block;
          const usernameMatch = source.match(/username="([^"]*)"/i) || source.match(/title="([^"]*)"/i);
          const thumbMatch    = source.match(/thumb="([^"]*)"/i)    || source.match(/avatar="([^"]*)"/i) || source.match(/photo="([^"]*)"/i);
          const joinedAtMatch = source.match(/joined_at="([^"]*)"/i);
          const emailMatch    = source.match(/\bemail="([^"]*)"/i);

          if (usernameMatch?.[1]) {
            const rawUsername = usernameMatch[1];
            const name = rawUsername.toLowerCase();
            if (thumbMatch?.[1])    { thumbMap[name] = thumbMatch[1]; thumbsFetched++; }
            if (joinedAtMatch?.[1]) { const ts = Number(joinedAtMatch[1]); if (ts > 0) plexJoinedAtMap[name] = ts; }
            if (emailMatch?.[1])    { emailToUsername[emailMatch[1].toLowerCase()] = rawUsername; }
          }
        });
      } else {
        logCR.debug(`⚠️  Plex API XML cloud token refusé: HTTP ${xmlResp.status}`);
      }
    } catch (err) {
      logCR.debug(`⚠️  Plex API XML failed: ${err.message}`);
    }

    logCR.debug(`📸 Plex: ${thumbsFetched} avatars, ${Object.keys(plexJoinedAtMap).length} joined_at, ${Object.keys(emailToUsername).length} emails→username`);

    // ══════════════════════════════════════════════════════════════════
    // ÉTAPE 2: Récupérer les users Wizarr, puis persister en DB
    // Wizarr sert ici de source pour la liste des users actifs, pas pour joinedAt.
    // ══════════════════════════════════════════════════════════════════
    const wizarrUrl = String(getConfigValue('WIZARR_URL', '') || '').trim();
    const wizarrApiKey = String(getConfigValue('WIZARR_API_KEY', '') || '').trim();
    const wizarrConfigured = !!(wizarrUrl && wizarrApiKey);
    let wizarrUsers = [];
    if (wizarrConfigured) {
      const wizarrResult = await getAllWizarrUsersDetailed(wizarrUrl, wizarrApiKey);
      wizarrUsers = wizarrResult.users || [];
      if (!wizarrUsers.length) {
        logCR.warn(`Wizarr indisponible/vide pour classement — ${wizarrResult.reason || 'raison inconnue'}`);
      } else {
        logCR.debug(`📋 Wizarr classement: ${wizarrUsers.length} users via ${wizarrResult.source}`);
      }
    } else {
      logCR.debug('Wizarr désactivé — classement sans source Wizarr');
      wizarrUsers = await getAllWizarrUsers(wizarrUrl, wizarrApiKey);
    }
    const hadInitialWizarrUsers = wizarrUsers.length > 0;

    if (wizarrUsers.length > 0) {
      // Garder uniquement les utilisateurs actifs (abonnement illimité ou non expiré)
      const now = Date.now();
      wizarrUsers = wizarrUsers.filter(u => {
        if (!u) return false;
        if (!u.expires) return true;
        const ts = new Date(u.expires).getTime();
        return Number.isFinite(ts) && ts > now;
      });

      // 🔧 Dédupliquer par email avant tout traitement (garder 1 entrée par email)
      const seenWizarrEmails = new Set();
      wizarrUsers = wizarrUsers.filter(u => {
        if (u.email) {
          const emailKey = u.email.toLowerCase();
          if (seenWizarrEmails.has(emailKey)) return false;
          seenWizarrEmails.add(emailKey);
        }
        return true;
      });

      logCR.debug(`📋 ${wizarrUsers.length} users Wizarr (après dédup email)`);
      for (const wUser of wizarrUsers) {
        try {
          // Résoudre le vrai username Plex via email avant de persister
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
          logCR.warn(`Wizarr non configuré et DB vide, fallback Tautulli (${wizarrUsers.length} users)`);
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
      if (fallback.source === "tautulli" && fallback.tautulliCount > wizarrUsers.length) {
        wizarrUsers = fallback.users;
        logCR.warn(`Fallback classement remplacé par Tautulli (${fallback.tautulliCount} users, DB=${fallback.dbCount})`);
      }
    }

    if (wizarrUsers.length === 0) {
      logCR.warn('Aucun user trouve pour le refresh classement');
      return;
    }

    // ══════════════════════════════════════════════════════════════════
    // ÉTAPE 3: Corrélation email→username pour Tautulli
    //   Wizarr email → emailToUsername → plexUsername → Tautulli stats
    //   Si email inconnu du Plex XML → fallback sur wUser.username
    // ══════════════════════════════════════════════════════════════════
    const statsToUse = wizarrUsers.map(wUser => {
      // 🔗 Corrélation fiable: email Wizarr → username Plex (même identifiant que Tautulli)
      const plexUsername = (wUser.email && emailToUsername[wUser.email.toLowerCase()])
        || wUser.username;

      if (plexUsername !== wUser.username) {
        logCR.debug(`🔗 Corrélation email: ${wUser.username} → ${plexUsername} (via ${wUser.email})`);
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

    // 🔧 Dédupliquer par username résolu + filtrer les emails-comme-username
    const seenUsernames = new Set();
    const statsFiltered = statsToUse.filter(stats => {
      const key = stats.username.toLowerCase();
      if (key.includes('@')) {
        logCR.debug(`⏭️  Skip email-as-username: ${stats.username}`);
        return false;
      }
      if (seenUsernames.has(key)) {
        logCR.debug(`⏭️  Skip doublon: ${stats.username}`);
        return false;
      }
      seenUsernames.add(key);
      return true;
    });

    logCR.debug(`📋 Classement: ${statsFiltered.length} users (${statsToUse.length - statsFiltered.length} doublons/emails filtrés, ${statsFiltered.filter(s => s.totalHours > 0).length} avec stats Tautulli)`);

    // 🎯 Pré-calculer les données XP pour TOUS les utilisateurs
    // Utilise la MÊME fonction centralisée que le profil pour garantir la cohérence 100%
    const users = await mapInBatches(statsFiltered, CLASSEMENT_USER_BATCH_SIZE, async (stats) => {
      const key = (stats.username || '').toLowerCase();
      const thumb = thumbMap[key] || null;
      const wizarrUser = wizarrUsers.find(entry => String(entry?.username || '').trim().toLowerCase() === key)
        || wizarrUsers.find(entry => String(entry?.email || '').trim().toLowerCase() && emailToUsername[String(entry.email || '').trim().toLowerCase()]?.toLowerCase() === key)
        || null;

      // Priorité joinedAt: Plex XML (= même source que profil) > DB > calculateUserXp fallback
      let joinedAtTs = plexJoinedAtMap[key] || null;
      if (!joinedAtTs) {
        const dbUser = UserQueries.getByUsername(stats.username);
        if (dbUser && dbUser.joinedAt) {
          const ts = Number(dbUser.joinedAt);
          if (!isNaN(ts) && ts > 1e8) {
            joinedAtTs = ts < 1e13 ? ts : Math.floor(ts / 1000);
          }
        }
      }

      // Si Plex nous donne joinedAt, le persister en DB pour les prochains démarrages.
      if (plexJoinedAtMap[key]) {
        try {
          UserQueries.upsert(stats.username, null, null, plexJoinedAtMap[key]);
        } catch (_) {}
      }

      logCR.debug(`🎯 XP ${stats.username}: joinedAtTs=${joinedAtTs} src=${plexJoinedAtMap[key]?'plex':joinedAtTs?'db':'fallback'}`);

      try {
        // 🎯 Appeler la fonction centralisée avec heures DB directes (rapide, pas d'appel HTTP)
        const statsHint = {
          totalHours: Number(stats.totalHours ?? 0),
          sessionCount: Number(stats.sessionCount ?? stats.session_count ?? 0),
          movieCount: Number(stats.movieCount ?? stats.movie_count ?? 0),
          episodeCount: Number(stats.episodeCount ?? stats.episode_count ?? 0),
          monthlyHours: Number(stats.monthlyHours ?? 0),
          nightCount: Number(stats.nightCount ?? 0),
          morningCount: Number(stats.morningCount ?? 0)
        };
        await refreshUserAchievementState({
          username: stats.username,
          id: wizarrUser?.plexUserId || stats.userId || null,
          email: wizarrUser?.email || null,
          joinedAtTimestamp: joinedAtTs || null
        }, {
          precomputedStats: statsHint,
          includeSecretEvaluation: false
        });
        queueBackgroundAchievementRefresh({
          username: stats.username,
          id: wizarrUser?.plexUserId || stats.userId || null,
          email: wizarrUser?.email || null,
          joinedAtTimestamp: joinedAtTs || null
        }, {
          precomputedStats: statsHint,
          includeSecretEvaluation: true
        });
        const xpData = await calculateUserXp(stats.username, joinedAtTs, stats.totalHours ?? null, statsHint);
        logCR.debug(`✅ ${stats.username}: XP=${xpData.totalXp}, level=${xpData.level}, hours=${xpData.totalHours}`);

        return {
          username: stats.username,
          thumb,
          totalHours: xpData.totalHours,
          totalXp: xpData.totalXp,
          level: xpData.level,
          rank: xpData.rank,
          badgeCount: xpData.badgeCount
        };
      } catch (err) {
        logCR.error(`⚠️  Erreur XP pour ${stats.username}: ${err.message}`);
        // Fallback: user avec données minimales
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

    const byHours = [...users].sort((a, b) => b.totalHours - a.totalHours);
    const byLevel = [...users].sort((a, b) => b.level - a.level || b.totalXp - a.totalXp);

    // 🔍 Valider les données avant de les mettre en cache
    const issues = validateCacheData(users, statsFiltered);

    if (issues.length > 0) {
      logCR.warn('⚠️ Problèmes détectés dans les données calculées:');
      issues.forEach(issue => logCR.warn('   ' + issue));
      corruptionCount++;

      const hasOnlyPhotoIssues = issues.every(i =>
        i.includes('sans photo') || i.includes('Aucune photo Plex trouvée')
      );
      if (hasOnlyPhotoIssues) {
        logCR.warn('ℹ️ Absence de photos Plex détectée - le classement continue sans avatars');
      }

      // ⚠️ Stratégie: seuls les problèmes de cohérence des niveaux/XP doivent
      // bloquer le cache. L'absence de photos Plex ne doit plus casser le classement.
      // NOTE: 'sans joinedAt' n'est PAS critique grâce au fallback intelligent
      const hasCriticalIssue = issues.some(i =>
        i.includes('incohérent')
      );

      if (hasCriticalIssue) {
        logCR.warn('🚨 Problème CRITIQUE détecté - rejet des données');
        if (lastValidCache && lastValidCache.data.byLevel.length > 0) {
          logCR.warn('   🔄 Utilisation du cache précédent valide');
          classementCache = {
            ...lastValidCache,
            timestamp: Date.now(),
            lastRefresh: new Date().toISOString()
          };
          const duration = Date.now() - startTime;
          logCR.info(`✅ Cache restauré en ${duration}ms`);
          return;
        } else {
          logCR.warn('   ⚠️  Pas de cache précédent - attente prochain calcul');
          return;
        }
      }

      // Si corruption répétée même pour petits problèmes (2+ fois), utiliser cache précédent
      if (corruptionCount >= 2 && lastValidCache) {
        logCR.warn(`🔄 Corruption répétée (${corruptionCount}x), utilisation du cache précédent`);
        classementCache = {
          ...lastValidCache,
          timestamp: Date.now(),
          lastRefresh: new Date().toISOString()
        };
        const duration = Date.now() - startTime;
        logCR.info(`✅ Cache restauré en ${duration}ms`);
        return;
      }
    } else {
      corruptionCount = 0; // Réinitialiser si OK
    }

    // Mettre en cache avec timestamp
    const newCache = {
      data: { byHours, byLevel },
      timestamp: Date.now(),
      lastRefresh: new Date().toISOString()
    };

    classementCache = newCache;
    lastValidCache = { data: { byHours: [...byHours], byLevel: [...byLevel] } }; // Sauvegarder comme backup

    const duration = Date.now() - startTime;
    logCR.debug(`✅ Classement refreshé en ${duration}ms (${users.length} users)`);
  } catch (err) {
    logCR.error(`Error refreshing classement: ${err.message}`);
  }
}

/**
 * 🔄 Force une réinitialisation complète du cache
 * Utile pour debug ou réparation manuelle
 */
async function resetClassementCache() {
  logCR.warn('🔄 Réinitialisation forcée du cache classement...');
  classementCache = {
    data: { byHours: [], byLevel: [] },
    timestamp: null,
    lastRefresh: null
  };
  lastValidCache = null;
  corruptionCount = 0;

  // Forcer un recalcul immédiat
  await refreshClassementCache();
  logCR.info('✅ Cache réinitialisé et recalculé');
}

/**
 * Retourne le cache du classement
 */
function getClassementCache() {
  return classementCache;
}

/**
 * 🔧 Vérifie et répare le cache au démarrage si nécessaire
 * Auto-réparation complète sans intervention manuelle
 */
function healthCheckAndRepair() {
  try {
    logCR.debug('🔧 Vérification intégrité au démarrage...');

    const allUsers = UserQueries.getAll();
    if (!allUsers || allUsers.length === 0) {
      logCR.debug('✅ Aucun utilisateur en DB, vérification OK');
      return;
    }

    const usersWithoutJoinedAt = allUsers.filter(u => !u.joinedAt).length;
    const percentMissing = (usersWithoutJoinedAt / allUsers.length) * 100;
    const hasPlexToken = String(getConfigValue('PLEX_TOKEN', '') || '').trim().length > 0;

    // ✅ Si > 30% sans joinedAt → RESET CACHE pour recalcul avec fallback
    // Le fallback dans le cron va utiliser des valeurs intelligentes (30/60/120 jours)
    if (percentMissing > 30) {
      if (hasPlexToken) {
        logCR.info(`ℹ️  ${percentMissing.toFixed(1)}% des users sans joinedAt en DB — Plex servira de source au refresh`);
        logCR.info('   🔄 Backfill automatique des dates Plex vers la DB en cours de refresh');
      } else {
        logCR.warn(`⚠️  ${percentMissing.toFixed(1)}% des users sans joinedAt`);
        logCR.warn('   💡 Fallback intelligent sera utilisé (30/60/120 jours selon heures)');
      }
      logCR.warn('   🔧 Réinitialisation du cache pour recalcul automatique');

      // Réinitialiser complètement le cache
      classementCache = {
        data: { byHours: [], byLevel: [] },
        timestamp: null,
        lastRefresh: null
      };
      lastValidCache = null;
      corruptionCount = 0;

      logCR.info('✅ Cache réinitialisé - recalcul immédiat au prochain refresh');
      return;
    }

    logCR.info('✅ Vérification intégrité OK - données cohérentes');
  } catch (err) {
    logCR.warn('⚠️  Erreur lors de la vérification:', err.message);
  }
}

/**
 * Démarre le cron job de refresh
 */
async function startClassementRefreshJob() {
  // Vérifier intégrité au démarrage
  healthCheckAndRepair();

  // Refresh immédiat au démarrage (SYNCHRONE pour éviter une réponse vide)
  await refreshClassementCache();

  // Cron: toutes les 30 minutes
  cron.schedule(CLASSEMENT_REFRESH_CRON, () => {
    refreshClassementCache();
  });

  // Nettoyage mensuel de maintenance: réinitialiser le compteur de corruption
  cron.schedule('0 0 1 * *', () => {
    logCR.debug('🧹 Réinitialisation mensuelle du compteur de corruption');
    corruptionCount = 0;
  });

  logCR.info('✅ Cron job classement démarré (toutes les 30 minutes)');
}

module.exports = {
  startClassementRefreshJob,
  getClassementCache,
  refreshClassementCache,
  resetClassementCache,
  healthCheckAndRepair
};
