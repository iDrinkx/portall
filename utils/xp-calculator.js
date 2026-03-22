/**
 * 🎯 Fonction centralisée pour calculer le XP/niveau d'un utilisateur
 * Utilisée par le profil ET le classement pour garantir la cohérence
 *
 * Formule XP:
 *   totalXp = (heures * 10) + (achievements XP) + (days * 1.5)
 */

const { getTautulliStats } = require("./tautulli");
const { XP_SYSTEM } = require("./xp-system");
const { ACHIEVEMENTS, getAchievementXp } = require("./achievements");
const { UserAchievementQueries, UserQueries, AchievementProgressQueries } = require("./database");
const { getConfigValue } = require("./config");
const log = require("./logger");

const logXP = log.create('[XP-Calculator]');

/**
 * Calcule le XP total pour un utilisateur
 * @param {string} username - Nom d'utilisateur Plex
 * @param {number} joinedAtTimestamp - Unix timestamp (secondes) depuis Plex (optionnel)
 * @param {number|null} precomputedHours - Heures déjà connues (évite l'appel HTTP lent, optionnel)
 * @param {object|null} precomputedStats - Stats déjà connues (session/movie/episode/monthly/night/morning)
 * @returns {Promise<{totalHours, totalXp, level, rank, badgeCount, progressPercent, xpNeeded}>}
 */
async function calculateUserXp(username, joinedAtTimestamp = null, precomputedHours = null, precomputedStats = null) {
  try {
    const now = Date.now();
    let statsData = precomputedStats ? { ...precomputedStats } : {};
    const tautulliUrl = getConfigValue("TAUTULLI_URL");
    const tautulliApiKey = getConfigValue("TAUTULLI_API_KEY");
    const plexUrl = getConfigValue("PLEX_URL");
    const plexToken = getConfigValue("PLEX_TOKEN");

    // 1️⃣ Récupérer les heures Tautulli
    let totalHours = 0;
    if (precomputedHours !== null && precomputedHours !== undefined) {
      // Utiliser la valeur pré-calculée (depuis DB directe) — rapide, pas d'appel HTTP
      totalHours = precomputedHours;
      if (statsData.totalHours === undefined) statsData.totalHours = precomputedHours;
      logXP.debug(`  ⚡ ${username} heures pré-calculées: ${totalHours}h`);
    } else {
      try {
        const stats = await Promise.race([
          getTautulliStats(
            username,
            tautulliUrl,
            tautulliApiKey,
            null,
            plexUrl,
            plexToken,
            joinedAtTimestamp
          ),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 5000))
        ]);
        totalHours = stats?.watchStats?.totalHours || 0;
        statsData = {
          ...statsData,
          totalHours,
          sessionCount: stats?.sessionCount || 0,
          movieCount: stats?.watchStats?.movieCount || 0,
          episodeCount: stats?.watchStats?.episodeCount || 0,
          monthlyHours: stats?.monthlyHours || 0,
          nightCount: stats?.nightCount || 0,
          morningCount: stats?.morningCount || 0
        };
      } catch (err) {
        logXP.debug(`⚠️  Heures pour ${username}: ${err.message}`);
      }
    }

    // 3️⃣ Calculer daysJoined avec stratégie multi-sources
    let daysJoined = 0;

    // Stratégie 1: joinedAtTimestamp passé en paramètre (depuis Plex - le plus fiable)
    if (joinedAtTimestamp) {
      const ms = joinedAtTimestamp < 1e13 ? joinedAtTimestamp * 1000 : joinedAtTimestamp;
      daysJoined = Math.max(0, Math.floor((now - ms) / 86400000));
      logXP.debug(`  ✅ ${username} daysJoined=${daysJoined} (depuis Plex timestamp)`);
    } else {
      // Stratégie 2: joinedAt depuis la DB
      const dbUser = UserQueries.getByUsername(username);
      if (dbUser && dbUser.joinedAt) {
        try {
          const ts = Number(dbUser.joinedAt);
          const ms = !isNaN(ts) && ts > 1e8 ? (ts < 1e13 ? ts * 1000 : ts) : new Date(dbUser.joinedAt).getTime();
          if (!isNaN(ms)) {
            daysJoined = Math.max(0, Math.floor((now - ms) / 86400000));
            logXP.debug(`  ✅ ${username} daysJoined=${daysJoined} (depuis DB)`);
          }
        } catch (_) {}
      }

      // Stratégie 3: Si toujours 0, utiliser Tautulli stats qui contient joinedAt
      if (daysJoined === 0) {
        try {
          // getTautulliStats retourne joinedAt si disponible
          const stats = await Promise.race([
            getTautulliStats(
              username,
              tautulliUrl,
              tautulliApiKey,
              null,
              plexUrl,
              plexToken,
              null  // Pas de joinedAtTimestamp au départ
            ),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 3000))
          ]);

          // Si getTautulliStats retourne joinedAt, l'utiliser
          if (stats?.joinedAt) {
            try {
              const joinedDate = new Date(stats.joinedAt).getTime();
              if (!isNaN(joinedDate)) {
                daysJoined = Math.max(0, Math.floor((now - joinedDate) / 86400000));
                logXP.debug(`  ✅ ${username} daysJoined=${daysJoined} (depuis Tautulli stats.joinedAt)`);
              }
            } catch (_) {}
          }
        } catch (_) {
          logXP.debug(`  ⚠️  ${username} Tautulli joinedAt unavailable`);
        }
      }
    }

    // Fallback intelligent si toujours 0
    if (daysJoined === 0) {
      daysJoined = 30;  // minimum conservatif
      if (totalHours > 100) daysJoined = 60;
      if (totalHours > 500) daysJoined = 120;
      logXP.debug(`  ℹ️  ${username} daysJoined=${daysJoined} (fallback basé sur heures)`);
    }

    // 4️⃣ Calculer les achievements XP (auto + manuels DB), comme le profil
    let achievementsXp = 0;
    let badgeCount = 0;
    try {
      const dbUser = UserQueries.getByUsername(username);
      const userUnlockedMap = dbUser ? UserAchievementQueries.getForUser(dbUser.id) : {};
      const progressMap = dbUser ? AchievementProgressQueries.getForUser(dbUser.id) : {};
      const data = {
        totalHours: Number(totalHours || statsData.totalHours || 0),
        movieCount: Number(statsData.movieCount || 0),
        episodeCount: Number(statsData.episodeCount || 0),
        sessionCount: Number(statsData.sessionCount || 0),
        monthlyHours: Number(statsData.monthlyHours || 0),
        nightCount: Number(statsData.nightCount || 0),
        morningCount: Number(statsData.morningCount || 0),
        daysSince: daysJoined
      };
      const unlockedAchievements = ACHIEVEMENTS.getUnlocked(data, userUnlockedMap);
      badgeCount = unlockedAchievements.length;
      achievementsXp = unlockedAchievements.reduce((sum, ach) => sum + getAchievementXp(ach, progressMap[ach.id]), 0);
    } catch (err) {
      logXP.debug(`⚠️  Achievements pour ${username}: ${err.message}`);
    }

    // 4️⃣ Calculer le XP total
    const XP_MULTIPLIERS = { HOURS: 10, ANCIENNETE: 1.5 };
    const totalXp = Math.round(totalHours * XP_MULTIPLIERS.HOURS)
                  + achievementsXp
                  + Math.round(daysJoined * XP_MULTIPLIERS.ANCIENNETE);

    // 5️⃣ Convertir en niveau et rang
    const level = XP_SYSTEM.getLevel(totalXp);
    const rank = XP_SYSTEM.getRankByLevel(level);
    const progress = XP_SYSTEM.getProgressToNextLevel(totalXp);

    return {
      totalHours,
      totalXp,
      level,
      rank: { name: rank.name, icon: rank.icon, color: rank.color, bgColor: rank.bgColor, borderColor: rank.borderColor },
      badgeCount,
      progressPercent: progress.progressPercent,
      xpNeeded: progress.xpNeeded,
      daysJoined  // debug info
    };
  } catch (err) {
    logXP.error(`Erreur calcul XP pour ${username}: ${err.message}`);
    return {
      totalHours: 0,
      totalXp: 0,
      level: 1,
      rank: XP_SYSTEM.getRankByLevel(1),
      badgeCount: 0,
      progressPercent: 0,
      xpNeeded: 1000,
      error: err.message
    };
  }
}

module.exports = { calculateUserXp };
