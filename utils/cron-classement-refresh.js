const cron = require('node-cron');
const fetch = require('node-fetch');
const log = require('./logger');
const { UserAchievementQueries, UserQueries } = require('./database');
const { ACHIEVEMENTS } = require('./achievements');
const { XP_SYSTEM } = require('./xp-system');
const { getAllUserStatsFromTautulli, isTautulliReady } = require('./tautulli-direct');

const logCR = log.create('[Classement-Refresh]');

let classementCache = {
  data: { byHours: [], byLevel: [] },
  timestamp: null,
  lastRefresh: null
};

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

    const tautulliStats = getAllUserStatsFromTautulli();
    if (!tautulliStats || tautulliStats.length === 0) {
      logCR.warn('Aucune stats Tautulli trouvées');
      return;
    }

    // Récupérer les thumbs Plex
    const plexToken = process.env.PLEX_TOKEN || '';
    const thumbMap = {};

    try {
      const ownerResp = await fetch('https://plex.tv/api/v2/user', {
        headers: { 'X-Plex-Token': plexToken, 'Accept': 'application/json' },
        timeout: 6000
      });
      if (ownerResp.ok) {
        const od = await ownerResp.json();
        if (od.username && od.thumb) thumbMap[od.username.toLowerCase()] = od.thumb;
      }
    } catch (_) {}

    try {
      const xmlResp = await fetch('https://plex.tv/api/users', {
        headers: { 'X-Plex-Token': plexToken, 'Accept': 'application/xml' },
        timeout: 6000
      });
      if (xmlResp.ok) {
        const xml = await xmlResp.text();
        const blockRe = /<User\s[\s\S]*?(?:\/>|<\/User>)/g;
        const attrRe = /(\w+)="([^"]*)"/g;
        let bm;
        while ((bm = blockRe.exec(xml)) !== null) {
          const openTag = bm[0].match(/<User\s([^>]+)/);
          if (!openTag) continue;
          const attrs = {};
          let am;
          attrRe.lastIndex = 0;
          while ((am = attrRe.exec(openTag[1])) !== null) attrs[am[1]] = am[2];
          const name = (attrs.title || attrs.username || '').toLowerCase();
          if (name && attrs.thumb) thumbMap[name] = attrs.thumb;
        }
      }
    } catch (_) {}

    // Pré-calculer les données XP pour tous les utilisateurs
    const XP_M = { HOURS: 10, ANCIENNETE: 1.5 };
    const now = Date.now();
    const allAchievements = ACHIEVEMENTS.getAll();
    const achievementXpMap = Object.fromEntries(allAchievements.map(a => [a.id, a.xp || 0]));

    const users = tautulliStats.map(stats => {
      const key = (stats.username || '').toLowerCase();
      const dbUser = UserQueries.getByUsername(stats.username) || null;

      let badgeCount = 0;
      let achievementsXp = 0;
      if (dbUser) {
        try {
          const unlockedMap = UserAchievementQueries.getForUser(dbUser.id);
          badgeCount = Object.keys(unlockedMap).length;
          achievementsXp = Object.keys(unlockedMap).reduce((sum, id) => sum + (achievementXpMap[id] || 0), 0);
        } catch (err) {
          logCR.error(`Error getting achievements for ${key}: ${err.message}`);
        }
      }

      let daysJoined = 0;
      if (dbUser && dbUser.joinedAt) {
        const ts = Number(dbUser.joinedAt);
        const ms = !isNaN(ts) && ts > 1e8 ? ts * 1000 : new Date(dbUser.joinedAt).getTime();
        if (!isNaN(ms)) daysJoined = Math.max(0, Math.floor((now - ms) / 86400000));
      }

      const totalHours = stats.totalHours || 0;
      const totalXp = Math.round(totalHours * XP_M.HOURS) + achievementsXp + Math.round(daysJoined * XP_M.ANCIENNETE);
      const level = XP_SYSTEM.getLevel(totalXp);
      const rank = XP_SYSTEM.getRankByLevel(level);
      const thumb = thumbMap[key] || null;

      return {
        username: stats.username,
        thumb,
        totalHours,
        totalXp,
        level,
        rank: { name: rank.name, icon: rank.icon, color: rank.color, bgColor: rank.bgColor, borderColor: rank.borderColor },
        badgeCount
      };
    });

    const byHours = [...users].sort((a, b) => b.totalHours - a.totalHours);
    const byLevel = [...users].sort((a, b) => b.level - a.level || b.totalXp - a.totalXp);

    // Mettre en cache avec timestamp
    classementCache = {
      data: { byHours, byLevel },
      timestamp: Date.now(),
      lastRefresh: new Date().toISOString()
    };

    const duration = Date.now() - startTime;
    logCR.debug(`✅ Classement refreshé en ${duration}ms (${users.length} users)`);
  } catch (err) {
    logCR.error(`Error refreshing classement: ${err.message}`);
  }
}

/**
 * Retourne le cache du classement
 */
function getClassementCache() {
  return classementCache;
}

/**
 * Démarre le cron job de refresh (toutes les 5 minutes)
 */
function startClassementRefreshJob() {
  // Refresh immédiat au démarrage
  refreshClassementCache();

  // Cron: toutes les 5 minutes
  cron.schedule('*/5 * * * *', () => {
    refreshClassementCache();
  });

  logCR.info('✅ Cron job classement démarré (toutes les 5 minutes)');
}

module.exports = {
  startClassementRefreshJob,
  getClassementCache,
  refreshClassementCache
};
