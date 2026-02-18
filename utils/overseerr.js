const fetch = require("node-fetch");

/**
 * Cherche un utilisateur Overseerr par email
 * @param {string} email - Email à chercher
 * @param {string} OVERSEERR_URL - URL de base d'Overseerr
 * @param {string} OVERSEERR_API_KEY - Clé API Overseerr
 * @returns {Promise<Object|null>} Utilisateur trouvé ou null
 */
async function findOverseerrUserByEmail(email, OVERSEERR_URL, OVERSEERR_API_KEY) {
  try {
    if (!email || !OVERSEERR_URL || !OVERSEERR_API_KEY) {
      return null;
    }

    console.debug(`[Overseerr] Searching for user with email: ${email}`);

    // Essayer sans pagination en premier lieu
    const url = `${OVERSEERR_URL}/api/v1/user`;

    const res = await fetch(url, {
      headers: {
        "X-API-Key": OVERSEERR_API_KEY,
        "Accept": "application/json"
      }
    });

    if (!res.ok) {
      console.warn(`[Overseerr] Could not fetch users list: ${res.status} ${res.statusText}`);
      return null;
    }

    const json = await res.json();
    console.debug(`[Overseerr] API response keys:`, Object.keys(json));

    // Essayer différents formats de réponse possibles
    let users = [];
    if (Array.isArray(json)) {
      users = json;
    } else if (Array.isArray(json.results)) {
      users = json.results;
    } else if (Array.isArray(json.data)) {
      users = json.data;
    } else if (Array.isArray(json.users)) {
      users = json.users;
    } else {
      console.warn(`[Overseerr] Unexpected response format. Raw data:`, JSON.stringify(json).substring(0, 500));
      return null;
    }

    console.debug(`[Overseerr] Found ${users.length} users in response`);

    // Chercher l'utilisateur avec cet email
    const found = users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());

    if (found) {
      console.info(`[Overseerr] ✓ Found user ID ${found.id} with email ${email}`);
      return found;
    }

    // Debug: afficher les emails disponibles
    const availableEmails = users
      .filter(u => u.email)
      .map(u => `${u.email} (ID: ${u.id})`)
      .slice(0, 10);
    console.warn(`[Overseerr] User not found. Available emails in system:`, availableEmails);

    return null;

  } catch (err) {
    console.error("[Overseerr] Error searching for user by email:", err.message, err.stack);
    return null;
  }
}

/**
 * Récupère l'utilisateur courant Overseerr via la clé API
 * @param {string} OVERSEERR_URL - URL de base d'Overseerr
 * @param {string} OVERSEERR_API_KEY - Clé API Overseerr
 * @returns {Promise<Object|null>} Utilisateur courant avec son ID
 */
async function getCurrentOverseerrUser(OVERSEERR_URL, OVERSEERR_API_KEY) {
  try {
    if (!OVERSEERR_URL || !OVERSEERR_API_KEY) {
      return null;
    }

    const url = `${OVERSEERR_URL}/api/v1/auth/me`;

    const res = await fetch(url, {
      headers: {
        "X-API-Key": OVERSEERR_API_KEY,
        "Accept": "application/json"
      }
    });

    if (!res.ok) {
      console.warn(`[Overseerr] Could not get current user: ${res.status}`);
      return null;
    }

    const user = await res.json();
    console.debug(`[Overseerr] Current user ID: ${user.id}`);
    return user;

  } catch (err) {
    console.error("[Overseerr] Error getting current user:", err.message);
    return null;
  }
}

/**
 * Récupère les statistiques Overseerr pour un utilisateur spécifique
 * @param {string} userEmail - Email de l'utilisateur Plex (utilisé pour trouver l'utilisateur Overseerr)
 * @param {string} OVERSEERR_URL - URL de base d'Overseerr
 * @param {string} OVERSEERR_API_KEY - Clé API Overseerr
 * @returns {Promise<Object|null>} Stats avec pending, approved, available, unavailable
 */
async function getOverseerrStats(userEmail, OVERSEERR_URL, OVERSEERR_API_KEY) {
  try {
    if (!OVERSEERR_URL || !OVERSEERR_API_KEY) {
      console.warn("Overseerr config missing:", { hasUrl: !!OVERSEERR_URL, hasKey: !!OVERSEERR_API_KEY });
      return null;
    }

    if (!userEmail) {
      console.warn("[Overseerr] No user email provided");
      return null;
    }

    // Chercher l'utilisateur Overseerr par son email Plex
    const overseerrUser = await findOverseerrUserByEmail(userEmail, OVERSEERR_URL, OVERSEERR_API_KEY);
    
    if (!overseerrUser || !overseerrUser.id) {
      console.warn(`[Overseerr] Could not find Overseerr user for email: ${userEmail}`);
      return null;
    }

    const userIdNum = overseerrUser.id;
    console.debug(`[Overseerr] Fetching requests for Overseerr user ID: ${userIdNum}`);

    // Récupérer TOUTES les demandes en paginant
    let allRequests = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const url = `${OVERSEERR_URL}/api/v1/user/${userIdNum}/requests?page=${page}&perPage=50`;

      const res = await fetch(url, {
        headers: {
          "X-API-Key": OVERSEERR_API_KEY,
          "Accept": "application/json"
        }
      });

      if (!res.ok) {
        console.error(`[Overseerr] API error: ${res.status} for user ID ${userIdNum}`);
        break;
      }

      const json = await res.json();

      if (!json?.results || !Array.isArray(json.results)) {
        console.warn(`[Overseerr] No results on page ${page}`);
        break;
      }

      allRequests = allRequests.concat(json.results);
      console.debug(`[Overseerr] Page ${page}: ${json.results.length} results (total so far: ${allRequests.length})`);

      // Vérifier s'il y a d'autres pages
      if (!json.pageInfo || page >= json.pageInfo.pages) {
        hasMore = false;
      } else {
        page++;
      }
    }

    console.debug(`[Overseerr] Retrieved ${allRequests.length} total requests for user ID ${userIdNum}`);

    // Compter par statut
    let pending = 0;
    let approved = 0;
    let available = 0;
    let unavailable = 0;

    allRequests.forEach(req => {
      // Status: 1=PENDING, 2=APPROVED, 3=DECLINED
      // mediaStatus: 1=UNKNOWN, 2=PENDING, 3=PROCESSING, 4=PARTIALLY_AVAILABLE, 5=AVAILABLE
      if (req.status === 1) {
        pending++;
      } else if (req.status === 2) {
        approved++;
      } else if (req.status === 3) {
        unavailable++;
      }

      // Vérifier si le contenu est disponible
      if (req.media?.status === 5) {
        available++;
      }
    });

    const result = {
      pending,
      approved: approved - available,
      available,
      unavailable,
      total: allRequests.length
    };

    console.debug(`[Overseerr] Stats for user ID ${userIdNum}:`, result);

    return result;

  } catch (err) {
    console.error("[Overseerr] Error:", err.message);
    return null;
  }
}

/**
 * Récupère les statistiques globales d'Overseerr
 * @param {string} OVERSEERR_URL - URL de base d'Overseerr
 * @param {string} OVERSEERR_API_KEY - Clé API Overseerr
 * @returns {Promise<Object|null>} Stats globales
 */
async function getOverseerrGlobalStats(OVERSEERR_URL, OVERSEERR_API_KEY) {
  try {
    if (!OVERSEERR_URL || !OVERSEERR_API_KEY) return null;

    const url = new URL(`${OVERSEERR_URL}/api/v1/request`);
    url.searchParams.set("sort", "updated");
    url.searchParams.set("page", "1");
    url.searchParams.set("perPage", "1");

    const res = await fetch(url.toString(), {
      headers: {
        "X-API-Key": OVERSEERR_API_KEY,
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
    console.error("Overseerr global stats error:", err.message);
    return null;
  }
}

module.exports = { getOverseerrStats, getOverseerrGlobalStats, getCurrentOverseerrUser, findOverseerrUserByEmail };
