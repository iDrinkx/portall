const fs = require('fs');
const path = require('path');
const log = require('./logger').create('[Cache]');

const CACHE_FILE = path.join(__dirname, '../data/session-stats-cache.json');

// Créer le répertoire data s'il n'existe pas
const dataDir = path.dirname(CACHE_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

class SessionStatsCache {
  /**
   * Charger le cache depuis le fichier
   */
  static load() {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const data = fs.readFileSync(CACHE_FILE, 'utf-8');
        let cache = JSON.parse(data);
        
        // 🚨 Nettoyer les données aberrantes à la lecture
        cache = this._sanitizeCache(cache);
        
        return cache;
      }
    } catch (err) {
      log.error('lecture cache:', err.message);
    }
    return {};
  }

  /**
   * Nettoyer les données aberrantes du cache (heures impossibles)
   */
  static _sanitizeCache(cache) {
    const cleaned = {};
    const MAX_REASONABLE_HOURS = 1000;  // Max ~42 ans de visionnage continu
    
    for (const [username, stats] of Object.entries(cache)) {
      if (!stats || !stats.watchStats) {
        cleaned[username] = stats;
        continue;
      }
      
      const watchStats = stats.watchStats;
      let needsClean = false;
      
      // Vérifier si les heures sont aberrantes
      if (!isFinite(watchStats.totalHours) || watchStats.totalHours > MAX_REASONABLE_HOURS) {
        log.warn(`Valeur aberrante totalHours (${watchStats.totalHours}) pour ${username}`);
        needsClean = true;
      }
      if (!isFinite(watchStats.movieHours) || watchStats.movieHours > MAX_REASONABLE_HOURS) {
        log.warn(`Valeur aberrante movieHours (${watchStats.movieHours}) pour ${username}`);
        needsClean = true;
      }
      if (!isFinite(watchStats.episodeHours) || watchStats.episodeHours > MAX_REASONABLE_HOURS) {
        log.warn(`Valeur aberrante episodeHours (${watchStats.episodeHours}) pour ${username}`);
        needsClean = true;
      }
      
      if (needsClean) {
        // Nettoyer les stats aberrantes MAIS garder lastSessionTimestamp pour le delta
        cleaned[username] = {
          ...stats,
          watchStats: {
            totalHours: 0,
            movieHours: 0,
            movieCount: 0,
            episodeHours: 0,
            episodeCount: 0
          }
          // ✅ GARDER lastSessionTimestamp pour que les prochains scans utilisant le delta
        };
        log.debug(`Cache nettoyé pour ${username} (stats réinitialisées)`);
      } else {
        cleaned[username] = stats;
      }
    }
    
    return cleaned;
  }

  /**
   * Sauvegarder le cache dans le fichier
   */
  static save(cache) {
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch (err) {
      log.error('écriture cache:', err.message);
    }
  }

  /**
   * Obtenir les stats en cache pour un utilisateur
   */
  static get(username) {
    const cache = this.load();
    return cache[username] || null;
  }

  /**
   * Mettre à jour les stats pour un utilisateur
   */
  static set(username, stats) {
    const cache = this.load();
    cache[username] = {
      ...stats,
      lastUpdated: new Date().toISOString()
    };
    this.save(cache);
  }

  /**
   * Supprimer les stats en cache
   */
  static delete(username) {
    const cache = this.load();
    delete cache[username];
    this.save(cache);
  }

  /**
   * Vérifier si le cache est expiré (> X heures)
   */
  static isExpired(username, hours = 24) {
    const cached = this.get(username);
    if (!cached || !cached.lastUpdated) return true;

    const lastUpdate = new Date(cached.lastUpdated);
    const now = new Date();
    const diffHours = (now - lastUpdate) / (1000 * 60 * 60);

    return diffHours > hours;
  }

  /**
   * Obtenir toutes les entrées du cache
   */
  static getAll() {
    return this.load();
  }

  /**
   * Obtenir les noms d'utilisateurs en cache
   */
  static getKeys() {
    return Object.keys(this.load());
  }

  /**
   * Obtenir les stats avec temps depuis dernière mise à jour
   */
  static getWithTimestamp(username) {
    const cached = this.get(username);
    if (!cached) return null;

    const lastUpdate = new Date(cached.lastUpdated);
    const now = new Date();
    const diffMs = now - lastUpdate;
    const diffMin = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHours / 24);

    let timeSince = '';
    if (diffDays > 0) {
      timeSince = `il y a ${diffDays} jour${diffDays > 1 ? 's' : ''}`;
    } else if (diffHours > 0) {
      timeSince = `il y a ${diffHours}h`;
    } else if (diffMin > 0) {
      timeSince = `il y a ${diffMin}min`;
    } else {
      timeSince = 'a l\'instant';
    }

    return {
      ...cached,
      timeSince
    };
  }

  /**
   * Effacer tout le cache
   */
  static clear() {
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify({}));
    } catch (err) {
      log.error('effacement cache:', err.message);
    }
  }
}

module.exports = SessionStatsCache;
