const fetch = require("node-fetch");

/**
 * Récupère les statistiques Overseerr pour un utilisateur donné
 * @param {string|number} userId - ID utilisateur Overseerr (pas Plex!)
 * @param {string} OVERSEERR_URL - URL de base d'Overseerr
 * @param {string} OVERSEERR_API_KEY - Clé API Overseerr
 * @returns {Promise<Object|null>} Stats avec pending, approved, available, unavailable
 */
async function getOverseerrStats(userId, OVERSEERR_URL, OVERSEERR_API_KEY) {
  try {
    if (!OVERSEERR_URL || !OVERSEERR_API_KEY) {
      console.warn("Overseerr config missing:", { hasUrl: !!OVERSEERR_URL, hasKey: !!OVERSEERR_API_KEY });
      return null;
    }

    // ID utilisateur doit être un nombre
    const userIdNum = parseInt(userId);
    if (isNaN(userIdNum)) {
      console.warn("Invalid userId for Overseerr:", userId);
      return null;
    }

    console.debug(`[Overseerr] Fetching requests for userId: ${userIdNum}`);

    // Récupérer les demandes de l'utilisateur via l'endpoint dédié
    // GET /user/{userId}/requests selon la documentation API
    const url = `${OVERSEERR_URL}/api/v1/user/${userIdNum}/requests`;

    const res = await fetch(url, {
      headers: {
        "X-API-Key": OVERSEERR_API_KEY,
        "Accept": "application/json"
      }
    });

    if (!res.ok) {
      console.error(`[Overseerr] API error: ${res.status} for userId ${userIdNum}`);
      return null;
    }

    const json = await res.json();

    if (!json?.results || !Array.isArray(json.results)) {
      console.warn(`[Overseerr] No results or invalid format for userId ${userIdNum}`, json);
      return {
        pending: 0,
        approved: 0,
        available: 0,
        unavailable: 0,
        total: 0
      };
    }

    console.debug(`[Overseerr] Found ${json.results.length} requests for userId ${userIdNum}`);

    // Compter par statut
    let pending = 0;
    let approved = 0;
    let available = 0;
    let unavailable = 0;

    json.results.forEach(req => {
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
      total: json.results.length
    };

    console.debug(`[Overseerr] Stats for userId ${userIdNum}:`, result);

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

module.exports = { getOverseerrStats, getOverseerrGlobalStats };
