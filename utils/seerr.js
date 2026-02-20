const fetch = require("node-fetch");

/**
 * Cherche un utilisateur Seerr par email OU username Plex
 * @param {string} email - Email à chercher
 * @param {string} SEERR_URL - URL de base d'Seerr
 * @param {string} SEERR_API_KEY - Clé API Seerr
 * @param {string} username - Username Plex à chercher aussi en fallback
 * @returns {Promise<Object|null>} Utilisateur trouvé ou null
 */
async function findSeerrUserByEmail(email, SEERR_URL, SEERR_API_KEY, username = null) {
  try {
    if (!email || !SEERR_URL || !SEERR_API_KEY) {
      return null;
    }

    // Récupérer TOUS les utilisateurs Seerr avec pagination
    let allUsers = [];
    let page = 0;  // Seerr commence à 0
    let hasMore = true;
    let pageInfo = null;

    while (hasMore) {
      // Essayer différents formats de paramètres de pagination
      const url = new URL(`${SEERR_URL}/api/v1/user`);
      url.searchParams.set('skip', page * 50);
      url.searchParams.set('take', 50);



      const res = await fetch(url.toString(), {
        headers: {
          "X-API-Key": SEERR_API_KEY,
          "Accept": "application/json"
        }
      });

      if (!res.ok) { break; }

      const json = await res.json();
      pageInfo = json.pageInfo;

      // Extraire les utilisateurs selon le format de réponse
      let users = [];
      if (Array.isArray(json)) {
        users = json;
      } else if (Array.isArray(json.results)) {
        users = json.results;
      } else if (Array.isArray(json.data)) {
        users = json.data;
      } else if (Array.isArray(json.users)) {
        users = json.users;
      }

      if (users.length === 0) { break; }

      allUsers = allUsers.concat(users);

      // Vérifier s'il y a d'autres pages
      if (pageInfo) {
        if (pageInfo.pages && page + 1 >= pageInfo.pages) {
          hasMore = false;
        }
      }

      page++;
    }

    // Chercher l'utilisateur avec cet email
    let found = allUsers.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
    if (found) return found;

    // Si pas trouvé par email, essayer par username Plex
    if (username) {
      found = allUsers.find(u => {
        const displayName = (u.displayName || "").toLowerCase();
        const usernameField = (u.username || "").toLowerCase();
        const plexUsername = (u.plexUsername || "").toLowerCase();
        const target = username.toLowerCase();
        return displayName === target || usernameField === target || plexUsername === target ||
               displayName.includes(target) || usernameField.includes(target);
      });
      if (found) return found;
    }

    return null;

  } catch (err) {
    require('./logger').create('[Seerr]').error('findSeerrUserByEmail:', err.message);
    return null;
  }
}

/**
 * Récupère l'utilisateur courant Seerr via la clé API
 * @param {string} SEERR_URL - URL de base d'Seerr
 * @param {string} SEERR_API_KEY - Clé API Seerr
 * @returns {Promise<Object|null>} Utilisateur courant avec son ID
 */
async function getCurrentSeerrUser(SEERR_URL, SEERR_API_KEY) {
  try {
    if (!SEERR_URL || !SEERR_API_KEY) {
      return null;
    }

    const url = `${SEERR_URL}/api/v1/auth/me`;

    const res = await fetch(url, {
      headers: {
        "X-API-Key": SEERR_API_KEY,
        "Accept": "application/json"
      }
    });

    if (!res.ok) { return null; }

    const user = await res.json();
    return user;

  } catch (err) {
    return null;
  }
}

/**
 * Récupère les statistiques Seerr pour un utilisateur spécifique
 * @param {string} userEmail - Email de l'utilisateur Plex (utilisé pour trouver l'utilisateur Seerr)
 * @param {string} username - Username Plex (fallback si l'email ne match pas)
 * @param {string} SEERR_URL - URL de base d'Seerr
 * @param {string} SEERR_API_KEY - Clé API Seerr
 * @returns {Promise<Object|null>} Stats avec pending, approved, available, unavailable
 */
async function getSeerrStats(userEmail, username, SEERR_URL, SEERR_API_KEY) {
  try {
    if (!SEERR_URL || !SEERR_API_KEY) { return null; }

    if (!userEmail) { return null; }

    // Chercher l'utilisateur Seerr par son email OU username Plex
    const seerrUser = await findSeerrUserByEmail(userEmail, SEERR_URL, SEERR_API_KEY, username);
    
    if (!seerrUser || !seerrUser.id) { return null; }

    const userIdNum = seerrUser.id;

    // Récupérer TOUTES les demandes en paginant avec skip/take
    let allRequests = [];
    let skip = 0;
    const take = 50;
    let hasMore = true;

    while (hasMore) {
      const url = new URL(`${SEERR_URL}/api/v1/user/${userIdNum}/requests`);
      url.searchParams.set('skip', skip);
      url.searchParams.set('take', take);

const res = await fetch(url.toString(), {
        headers: {
          "X-API-Key": SEERR_API_KEY,
          "Accept": "application/json"
        }
      });

      if (!res.ok) { break; }

      const json = await res.json();

      // Essayer différents formats de réponse
      let requests = [];
      if (Array.isArray(json)) {
        requests = json;
      } else if (Array.isArray(json.results)) {
        requests = json.results;
      } else if (Array.isArray(json.data)) {
        requests = json.data;
      }

      if (requests.length === 0) { break; }

      allRequests = allRequests.concat(requests);

      // Vérifier s'il y a d'autres résultats
      if (requests.length < take) {
        hasMore = false;
      } else {
        skip += take;
      }
    }

    // Compter par statut
    let pending = 0;
    let approved = 0;
    let approvedAvailable = 0;
    let available = 0;
    let unavailable = 0;

    allRequests.forEach(req => {
      if (req.status === 1) {
        pending++;
      } else if (req.status === 2) {
        approved++;
        if (req.media?.status === 5) approvedAvailable++;
      } else if (req.status === 3) {
        unavailable++;
      }
      if (req.media?.status === 5) available++;
    });

    const result = {
      pending,
      approved: approved - approvedAvailable,
      available: approvedAvailable,
      unavailable,
      total: allRequests.length
    };

    return result;

  } catch (err) {
    require('./logger').create('[Seerr]').error('getSeerrStats:', err.message);
    return null;
  }
}

/**
 * Récupère les statistiques globales d'Seerr
 * @param {string} SEERR_URL - URL de base d'Seerr
 * @param {string} SEERR_API_KEY - Clé API Seerr
 * @returns {Promise<Object|null>} Stats globales
 */
async function getSeerrGlobalStats(SEERR_URL, SEERR_API_KEY) {
  try {
    if (!SEERR_URL || !SEERR_API_KEY) return null;

    const url = new URL(`${SEERR_URL}/api/v1/request`);
    url.searchParams.set("sort", "updated");
    url.searchParams.set("page", "1");
    url.searchParams.set("perPage", "1");

    const res = await fetch(url.toString(), {
      headers: {
        "X-API-Key": SEERR_API_KEY,
        "Accept": "application/json"
      }
    });

    if (!res.ok) return null;

    const json = await res.json();
    const totalRequests = json.pageInfo?.totalResults || 0;

    return {
      totalRequests,
      pending: 0,
      approved: 0,
      available: 0
    };

  } catch (err) {
    require('./logger').create('[Seerr]').error('getSeerrGlobalStats:', err.message);
    return null;
  }
}

module.exports = { getSeerrStats, getSeerrGlobalStats, getCurrentSeerrUser, findSeerrUserByEmail };
