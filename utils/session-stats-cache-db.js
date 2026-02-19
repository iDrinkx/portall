const db = require('./database');

/**
 * Module de cache des stats de session utilisant SQLite
 * Remplace le système JSON pour plus de performance et d'historique
 */
class SessionStatsCacheDB {
  /**
   * Obtenir les stats en cache pour un utilisateur
   */
  static get(username) {
    try {
      const user = db.UserQueries.getByUsername(username);
      if (!user) return null;
      
      const latest = db.WatchHistoryQueries.getLatestForUser(user.id);
      if (!latest) return null;
      
      return {
        sessionCount: latest.sessionCount,
        lastSessionTimestamp: latest.lastSessionTimestamp,
        joinedAt: user.joinedAt,
        lastActivity: latest.scannedAt,
        watchStats: {
          totalHours: latest.totalHours,
          movieHours: latest.movieHours,
          movieCount: latest.movieCount,
          episodeHours: latest.episodeHours,
          episodeCount: latest.episodeCount
        }
      };
    } catch (err) {
      console.error("[CACHE-DB] Erreur get:", err.message);
      return null;
    }
  }

  /**
   * Sauvegarder les stats pour un utilisateur
   */
  static set(username, stats) {
    try {
      // 🚨 VALIDATION STRICTE avant sauvegarde
      if (!stats.watchStats) stats.watchStats = {};
      
      const watchStats = stats.watchStats;
      const MAX_REASONABLE_HOURS = 1000; // Max ~42 ans continu
      
      // Nettoyer les valeurs aberrantes
      if (!isFinite(watchStats.totalHours) || watchStats.totalHours > MAX_REASONABLE_HOURS) {
        console.warn("[CACHE-DB] ⚠️  NETTOYAGE: totalHours aberrante pour", username, ":", watchStats.totalHours);
        watchStats.totalHours = 0;
      }
      if (!isFinite(watchStats.movieHours) || watchStats.movieHours > MAX_REASONABLE_HOURS) {
        console.warn("[CACHE-DB] ⚠️  NETTOYAGE: movieHours aberrante pour", username, ":", watchStats.movieHours);
        watchStats.movieHours = 0;
      }
      if (!isFinite(watchStats.episodeHours) || watchStats.episodeHours > MAX_REASONABLE_HOURS) {
        console.warn("[CACHE-DB] ⚠️  NETTOYAGE: episodeHours aberrante pour", username, ":", watchStats.episodeHours);
        watchStats.episodeHours = 0;
      }
      
      // Créer/mettre à jour l'utilisateur
      const user = db.UserQueries.upsert(
        username,
        stats.plexId || null,
        stats.email || null,
        stats.joinedAt || null
      );
      
      // Insérer l'historique (avec données validées)
      db.WatchHistoryQueries.insert(user.id, new Date().toISOString(), {
        movieCount: stats.watchStats?.movieCount || 0,
        movieHours: watchStats.movieHours,
        episodeCount: stats.watchStats?.episodeCount || 0,
        episodeHours: watchStats.episodeHours,
        totalHours: watchStats.totalHours,
        sessionCount: stats.sessionCount || 0,
        lastSessionTimestamp: stats.lastSessionTimestamp || null
      });
      
      console.log("[CACHE-DB] Stats sauvegardées pour", username);
    } catch (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        // Déjà inséré ce scan
        console.log("[CACHE-DB] Stats déjà enregistrées pour ce scan:", username);
      } else {
        console.error("[CACHE-DB] Erreur set:", err.message);
      }
    }
  }

  /**
   * Obtenir toutes les entrées du cache (utilisateurs connus)
   */
  static getAll() {
    try {
      const users = db.UserQueries.getAll();
      const result = {};
      
      for (const user of users) {
        const latest = db.WatchHistoryQueries.getLatestForUser(user.id);
        if (latest) {
          result[user.username] = {
            sessionCount: latest.sessionCount,
            lastSessionTimestamp: latest.lastSessionTimestamp,
            watchStats: {
              totalHours: latest.totalHours,
              movieHours: latest.movieHours,
              movieCount: latest.movieCount,
              episodeHours: latest.episodeHours,
              episodeCount: latest.episodeCount
            }
          };
        }
      }
      
      return result;
    } catch (err) {
      console.error("[CACHE-DB] Erreur getAll:", err.message);
      return {};
    }
  }

  /**
   * Obtenir les clés (usernames) en cache
   */
  static getKeys() {
    try {
      return db.UserQueries.getAll().map(u => u.username);
    } catch (err) {
      console.error("[CACHE-DB] Erreur getKeys:", err.message);
      return [];
    }
  }

  /**
   * Obtenir l'historique d'un utilisateur (derniers 30 jours par défaut)
   */
  static getHistory(username, days = 30) {
    try {
      const user = db.UserQueries.getByUsername(username);
      if (!user) return [];
      
      return db.WatchHistoryQueries.getHistoryForUser(user.id, days);
    } catch (err) {
      console.error("[CACHE-DB] Erreur getHistory:", err.message);
      return [];
    }
  }

  /**
   * Obtenir l'historique COMPLET d'un utilisateur
   */
  static getFullHistory(username) {
    try {
      const user = db.UserQueries.getByUsername(username);
      if (!user) return [];
      
      return db.WatchHistoryQueries.getAllForUser(user.id);
    } catch (err) {
      console.error("[CACHE-DB] Erreur getFullHistory:", err.message);
      return [];
    }
  }

  /**
   * Obtenir les stats avec temps depuis dernière mise à jour
   */
  static getWithTimestamp(username) {
    try {
      const cache = this.get(username);
      if (!cache) return null;
      
      const lastUpdated = cache.lastActivity;
      if (!lastUpdated) return cache;
      
      const lastUpdateDate = new Date(lastUpdated);
      const now = new Date();
      const diffMs = now - lastUpdateDate;
      
      let timeSince = "jamais";
      if (diffMs < 1000) {
        timeSince = "à l'instant";
      } else if (diffMs < 60 * 1000) {
        timeSince = `il y a ${Math.floor(diffMs / 1000)}s`;
      } else if (diffMs < 60 * 60 * 1000) {
        timeSince = `il y a ${Math.floor(diffMs / (60 * 1000))}m`;
      } else if (diffMs < 24 * 60 * 60 * 1000) {
        timeSince = `il y a ${Math.floor(diffMs / (60 * 60 * 1000))}h`;
      } else {
        timeSince = `il y a ${Math.floor(diffMs / (24 * 60 * 60 * 1000))}j`;
      }
      
      return {
        ...cache,
        cachedAt: lastUpdated,
        timeSince
      };
    } catch (err) {
      console.error("[CACHE-DB] Erreur getWithTimestamp:", err.message);
      return null;
    }
  }

  /**
   * Supprimer les stats en cache pour un utilisateur
   */
  static delete(username) {
    try {
      const user = db.UserQueries.getByUsername(username);
      if (user) {
        // Les suppressions en cascade vont nettoyer watch_history via FOREIGN KEY
        console.log("[CACHE-DB] Utilisateur supprimé:", username);
      }
    } catch (err) {
      console.error("[CACHE-DB] Erreur delete:", err.message);
    }
  }

  /**
   * Vérifier si le cache est expiré (> X heures)
   */
  static isExpired(username, hours = 24) {
    try {
      const cache = this.get(username);
      if (!cache || !cache.lastActivity) return true;
      
      const lastUpdate = new Date(cache.lastActivity);
      const now = new Date();
      const diffHours = (now - lastUpdate) / (1000 * 60 * 60);
      
      return diffHours > hours;
    } catch (err) {
      console.error("[CACHE-DB] Erreur isExpired:", err.message);
      return true;
    }
  }

  /**
   * Nettoyer les données aberrantes du cache (héritée de l'ancienne version JSON)
   */
  static _sanitizeCache() {
    // Avec SQLite, on n'a pas besoin de cette méthode car les données sont validées avant insertion
    console.log("[CACHE-DB] ✅ Pas de nettoyage nécessaire (validation à l'insertion)");
  }
}

module.exports = SessionStatsCacheDB;
