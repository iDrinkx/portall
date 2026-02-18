const fetch = require("node-fetch");

/**
 * Récupère la liste des utilisateurs autorisés du serveur Plex
 * @param {string} PLEX_URL - URL du serveur Plex
 * @param {string} PLEX_TOKEN - Token d'authentification Plex
 * @returns {Promise<Array>} Liste des utilisateurs avec leurs infos
 */
async function getPlexUsers(PLEX_URL, PLEX_TOKEN) {
  try {
    if (!PLEX_URL || !PLEX_TOKEN) {
      console.warn("[Plex] Config missing for user list");
      return [];
    }

    const url = `${PLEX_URL}/api/v2/accounts`;
    
    const res = await fetch(url, {
      headers: {
        "X-Plex-Token": PLEX_TOKEN,
        "Accept": "application/json"
      }
    });

    if (!res.ok) {
      console.error(`[Plex] Failed to get users: ${res.status}`);
      return [];
    }

    const json = await res.json();
    
    if (!Array.isArray(json?.data)) {
      console.warn("[Plex] Unexpected response format for users");
      return [];
    }

    console.debug(`[Plex] Found ${json.data.length} users on server`);
    return json.data;

  } catch (err) {
    console.error("[Plex] Error fetching users:", err.message);
    return [];
  }
}

/**
 * Récupère les infos détaillées d'un utilisateur Plex
 * @param {string|number} plexUserId - ID de l'utilisateur Plex
 * @param {string} PLEX_URL - URL du serveur Plex
 * @param {string} PLEX_TOKEN - Token d'authentification Plex
 * @returns {Promise<Object|null>} Infos utilisateur (ID, email, joinedAt, etc)
 */
async function getPlexUserInfo(plexUserId, PLEX_URL, PLEX_TOKEN) {
  try {
    if (!PLEX_URL || !PLEX_TOKEN || !plexUserId) {
      return null;
    }

    // Récupérer tous les users et chercher celui-ci
    const users = await getPlexUsers(PLEX_URL, PLEX_TOKEN);
    
    const userIdNum = parseInt(plexUserId);
    const user = users.find(u => u.id === userIdNum);

    if (user) {
      console.debug(`[Plex] Found user info for ID ${plexUserId}:`, {
        id: user.id,
        email: user.email,
        username: user.username
      });
    }

    return user || null;

  } catch (err) {
    console.error("[Plex] Error fetching user info:", err.message);
    return null;
  }
}

/**
 * Vérifie si un utilisateur Plex est autorisé (dans la whitelist du serveur)
 * @param {string|number} plexUserId - ID de l'utilisateur Plex
 * @param {string} PLEX_URL - URL du serveur Plex
 * @param {string} PLEX_TOKEN - Token d'authentification Plex
 * @returns {Promise<boolean>} True si l'utilisateur est autorisé
 */
async function isUserAuthorized(plexUserId, PLEX_URL, PLEX_TOKEN) {
  try {
    const user = await getPlexUserInfo(plexUserId, PLEX_URL, PLEX_TOKEN);
    
    if (!user) {
      console.warn(`[Plex] User ${plexUserId} not found on server - UNAUTHORIZED`);
      return false;
    }

    console.debug(`[Plex] User ${plexUserId} is authorized`);
    return true;

  } catch (err) {
    console.error("[Plex] Error checking authorization:", err.message);
    return false;
  }
}

/**
 * Récupère la date d'adhésion d'un utilisateur depuis le serveur Plex
 * Récupère les infos au format XML depuis la bibliothèque de l'utilisateur
 * @param {string|number} plexUserId - ID de l'utilisateur Plex
 * @param {string} PLEX_URL - URL du serveur Plex
 * @param {string} PLEX_TOKEN - Token d'authentification Plex
 * @returns {Promise<Date|null>} Date d'adhésion ou null
 */
async function getPlexJoinDate(plexUserId, PLEX_URL, PLEX_TOKEN) {
  try {
    if (!PLEX_URL || !PLEX_TOKEN || !plexUserId) {
      return null;
    }

    // Essayer de récupérer depuis les données de la bibliothèque
    // La seule façon fiable est via l'API /accounts
    const users = await getPlexUsers(PLEX_URL, PLEX_TOKEN);
    const user = users.find(u => u.id === parseInt(plexUserId));

    if (user?.createdAt) {
      const joinDate = new Date(user.createdAt * 1000);
      console.debug(`[Plex] User ${plexUserId} joined on ${joinDate.toISOString()}`);
      return joinDate;
    }

    return null;

  } catch (err) {
    console.error("[Plex] Error fetching join date:", err.message);
    return null;
  }
}

module.exports = {
  getPlexUsers,
  getPlexUserInfo,
  isUserAuthorized,
  getPlexJoinDate
};
