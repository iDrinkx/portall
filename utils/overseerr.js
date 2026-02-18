const fetch = require("node-fetch");

/**
 * Récupère les statistiques Overseerr pour un utilisateur donné
 * @param {string|number} userId - ID utilisateur Plex
 * @param {string} OVERSEERR_URL - URL de base d'Overseerr
 * @param {string} OVERSEERR_API_KEY - Clé API Overseerr
 * @returns {Promise<Object|null>} Stats avec pending, approved, available, unavailable
 */
async function getOverseerrStats(userId, OVERSEERR_URL, OVERSEERR_API_KEY) {
  try {
    if (!OVERSEERR_URL || !OVERSEERR_API_KEY) return null;

    // ID utilisateur doit être un nombre
    const userIdNum = parseInt(userId);
    if (isNaN(userIdNum)) {
      console.warn("Invalid userId for Overseerr:", userId);
      return null;
    }

    // Récupérer les demandes filtrées par utilisateur
    // L'API d'Overseerr permet de filtrer par requestedBy (user ID)
    const url = new URL(`${OVERSEERR_URL}/api/v1/request`);
    url.searchParams.set("filter", "all");
    url.searchParams.set("sort", "updated");
    url.searchParams.set("page", "1");
    url.searchParams.set("perPage", "50");

    const res = await fetch(url.toString(), {
      headers: {
        "X-API-Key": OVERSEERR_API_KEY,
        "Accept": "application/json"
      }
    });

    if (!res.ok) {
      console.error(`Overseerr API error: ${res.status}`);
      return null;
    }

    const json = await res.json();

    if (!json?.results || !Array.isArray(json.results)) {
      return {
        pending: 0,
        approved: 0,
        available: 0,
        unavailable: 0,
        total: 0
      };
    }

    // Compter les demandes par statut pour cet utilisateur
    let pending = 0;
    let approved = 0;
    let available = 0;
    let unavailable = 0;

    json.results.forEach(req => {
      // Vérifier si la demande appartient à cet utilisateur
      if (req.requestedBy?.id !== userIdNum) {
        return;
      }

      // Statut possibles dans Overseerr:
      // 1 = PENDING
      // 2 = APPROVED
      // 3 = DECLINED
      if (req.status === 1) {
        pending++;
      } else if (req.status === 2) {
        approved++;
      } else if (req.status === 3) {
        unavailable++;
      }

      // Vérifier si le contenu est disponible
      // media.status: 5 = AVAILABLE
      if (req.media?.status === 5) {
        available++;
      }
    });

    return {
      pending,
      approved: approved > available ? approved - available : 0,
      available,
      unavailable,
      total: pending + approved + unavailable
    };

  } catch (err) {
    console.error("Overseerr error:", err.message);
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
