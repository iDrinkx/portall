const cron = require('node-cron');
const fetch = require('node-fetch');
const log = require('./logger');
const { UserQueries } = require('./database');
const { XP_SYSTEM } = require('./xp-system');
const { getUserStatsFromTautulli, isTautulliReady } = require('./tautulli-direct');
const { calculateUserXp } = require('./xp-calculator');  // 🎯 Fonction centralisée XP
const { getAllWizarrUsers } = require('./wizarr');       // 🔑 Source de vérité

const logCR = log.create('[Classement-Refresh]');

let classementCache = {
  data: { byHours: [], byLevel: [] },
  timestamp: null,
  lastRefresh: null
};

let lastValidCache = null; // Cache de secours en cas de corruption
let corruptionCount = 0;    // Compteur de corruptions détectées

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
  const hasPlexToken = process.env.PLEX_TOKEN && process.env.PLEX_TOKEN.length > 0;
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

    // 🔑 SOURCE PRINCIPALE: Récupérer TOUS les users directement depuis Wizarr API
    // Cela garantit un classement complet même avec une DB vide (après reset)
    let wizarrUsers = await getAllWizarrUsers(process.env.WIZARR_URL, process.env.WIZARR_API_KEY);

    if (wizarrUsers.length > 0) {
      logCR.debug(`📋 ${wizarrUsers.length} users récupérés depuis Wizarr API`);

      // Persister en DB pour garder email + joinedAt (utilisé par le profil)
      for (const wUser of wizarrUsers) {
        try {
          UserQueries.upsert(wUser.username, wUser.plexUserId, wUser.email, wUser.joinedAtTimestamp);
        } catch (_) {}
      }
    } else {
      // Fallback: DB locale si Wizarr non configuré ou inaccessible
      const dbUsers = UserQueries.getAll() || [];
      wizarrUsers = dbUsers.map(u => ({
        username: u.username,
        plexUserId: null,
        email: u.email || null,
        joinedAtTimestamp: u.joinedAt ? Number(u.joinedAt) : null
      }));
      logCR.debug(`📋 Fallback DB: ${wizarrUsers.length} users`);
    }

    if (wizarrUsers.length === 0) {
      logCR.warn('⚠️ Aucun user trouvé (Wizarr non configuré et DB vide)');
      return;
    }

    logCR.debug(`📋 Classement pour ${wizarrUsers.length} users (avec ou sans stats Tautulli)`);

    // Pour chaque user Wizarr, récupérer ses stats Tautulli (0 s'il n'a jamais regardé)
    const statsToUse = wizarrUsers.map(wUser => {
      const tautulliStats = getUserStatsFromTautulli(wUser.username);
      return tautulliStats || {
        username: wUser.username,
        session_count: 0,
        total_duration_seconds: 0,
        last_session_timestamp: null,
        movie_count: 0,
        movie_duration_seconds: 0,
        episode_count: 0,
        episode_duration_seconds: 0,
        music_count: 0,
        music_duration_seconds: 0,
        totalHours: 0,
        _joinedAtTimestamp: wUser.joinedAtTimestamp  // porté depuis Wizarr
      };
    });

    // 📸 Récupérer les thumbs Plex (photos de profil)
    const plexToken = process.env.PLEX_TOKEN || '';
    const thumbMap = {};
    let thumbsFetched = 0;

    // Stratégie 1: API v2 (pour le owner uniquement)
    try {
      const ownerResp = await fetch('https://plex.tv/api/v2/user', {
        headers: { 'X-Plex-Token': plexToken, 'Accept': 'application/json' },
        timeout: 8000
      });
      if (ownerResp.ok) {
        const od = await ownerResp.json();
        if (od.username && od.thumb) {
          thumbMap[od.username.toLowerCase()] = od.thumb;
          thumbsFetched++;
        }
      }
    } catch (err) {
      logCR.debug(`⚠️  Plex API v2 failed: ${err.message}`);
    }

    // Stratégie 2: API XML (pour tous les users partagés)
    try {
      const xmlResp = await fetch('https://plex.tv/api/users', {
        headers: { 'X-Plex-Token': plexToken, 'Accept': 'application/xml' },
        timeout: 10000  // Augmenté pour éviter timeout
      });
      if (xmlResp.ok) {
        const xml = await xmlResp.text();
        // Parser amélioré pour les éléments User du XML Plex
        const userMatches = xml.match(/<User[^>]*>/g) || [];

        userMatches.forEach(tag => {
          // Extraire username et thumb
          const usernameMatch = tag.match(/username="([^"]*)"/i) || tag.match(/title="([^"]*)"/i);
          const thumbMatch = tag.match(/thumb="([^"]*)"/i) || tag.match(/avatar="([^"]*)"/i);

          if (usernameMatch && usernameMatch[1]) {
            const name = usernameMatch[1].toLowerCase();
            if (thumbMatch && thumbMatch[1]) {
              thumbMap[name] = thumbMatch[1];
              thumbsFetched++;
            }
          }
        });
      }
    } catch (err) {
      logCR.debug(`⚠️  Plex API XML failed: ${err.message}`);
    }

    logCR.debug(`📸 Fetched ${thumbsFetched} avatars from Plex`);

    // 🎯 Pré-calculer les données XP pour TOUS les utilisateurs
    // Utilise la MÊME fonction centralisée que le profil pour garantir la cohérence 100%
    const users = await Promise.all(statsToUse.map(async (stats) => {
      const key = (stats.username || '').toLowerCase();
      const thumb = thumbMap[key] || null;

      // Priorité joinedAt: champ porté depuis Wizarr > DB locale
      let joinedAtTs = stats._joinedAtTimestamp || null;
      if (!joinedAtTs) {
        const dbUser = UserQueries.getByUsername(stats.username);
        if (dbUser && dbUser.joinedAt) {
          const ts = Number(dbUser.joinedAt);
          if (!isNaN(ts) && ts > 1e8) {
            joinedAtTs = ts < 1e13 ? ts : Math.floor(ts / 1000);
          }
        }
      }

      logCR.debug(`🎯 Calcul XP ${stats.username}: joinedAtTs=${joinedAtTs}`);

      try {
        // 🎯 Appeler la fonction centralisée (identique au profil)
        const xpData = await calculateUserXp(stats.username, joinedAtTs);
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
    }));

    const byHours = [...users].sort((a, b) => b.totalHours - a.totalHours);
    const byLevel = [...users].sort((a, b) => b.level - a.level || b.totalXp - a.totalXp);

    // 🔍 Valider les données avant de les mettre en cache
    const issues = validateCacheData(users, statsToUse);

    if (issues.length > 0) {
      logCR.warn('⚠️ Problèmes détectés dans les données calculées:');
      issues.forEach(issue => logCR.warn('   ' + issue));
      corruptionCount++;

      // ⚠️ Stratégie agressive: si problèmes critiques, rejeter les données
      // NOTE: 'sans joinedAt' n'est PAS critique grâce au fallback intelligent
      const hasCriticalIssue = issues.some(i =>
        i.includes('incohérent') ||
        i.includes('inaccessible')
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

    // ✅ Si > 30% sans joinedAt → RESET CACHE pour recalcul avec fallback
    // Le fallback dans le cron va utiliser des valeurs intelligentes (30/60/120 jours)
    if (percentMissing > 30) {
      logCR.warn(`⚠️  ${percentMissing.toFixed(1)}% des users sans joinedAt`);
      logCR.warn('   🔧 Réinitialisation du cache pour recalcul automatique');
      logCR.warn('   💡 Fallback intelligent sera utilisé (30/60/120 jours selon heures)');

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
 * Démarre le cron job de refresh (toutes les 5 minutes)
 */
async function startClassementRefreshJob() {
  // Vérifier intégrité au démarrage
  healthCheckAndRepair();

  // Refresh immédiat au démarrage (SYNCHRONE pour éviter une réponse vide)
  await refreshClassementCache();

  // Cron: toutes les 5 minutes
  cron.schedule('*/5 * * * *', () => {
    refreshClassementCache();
  });

  // Nettoyage mensuel de maintenance: réinitialiser le compteur de corruption
  cron.schedule('0 0 1 * *', () => {
    logCR.debug('🧹 Réinitialisation mensuelle du compteur de corruption');
    corruptionCount = 0;
  });

  logCR.info('✅ Cron job classement démarré (toutes les 5 minutes)');
}

module.exports = {
  startClassementRefreshJob,
  getClassementCache,
  refreshClassementCache,
  resetClassementCache,
  healthCheckAndRepair
};
