const fetch = require("node-fetch");
const { getPlexJoinDate } = require("./plex");

async function getTracearrStats(username, TRACEARR_URL, TRACEARR_API_KEY, plexUserId, PLEX_URL, PLEX_TOKEN, joinedAtTimestamp = null) {
  try {
    if (!TRACEARR_URL || !TRACEARR_API_KEY) {
      console.log("[TRACEARR] Config manquante");
      return null;
    }

    console.log("[TRACEARR] Recherche utilisateur:", username);

    let page = 1;
    let totalPages = 1;
    let foundUser = null;

    while (page <= totalPages) {
      console.log("[TRACEARR] Fetch page", page, "/", totalPages);
      const res = await fetch(
        `${TRACEARR_URL}/api/v1/public/users?page=${page}&pageSize=50`,
        {
          headers: {
            Authorization: `Bearer ${TRACEARR_API_KEY}`,
            Accept: "application/json"
          }
        }
      );

      if (!res.ok) {
        console.log("[TRACEARR] API error status:", res.status);
        return null;
      }

      const json = await res.json();
      if (!json?.data) {
        console.log("[TRACEARR] Pas de data dans réponse");
        return null;
      }

      totalPages = Math.ceil(json.meta.total / json.meta.pageSize);
      console.log("[TRACEARR] Meta - total:", json.meta.total, "pageSize:", json.meta.pageSize, "totalPages:", totalPages);

      foundUser = json.data.find(
        u => u.username?.toLowerCase() === username.toLowerCase()
      );

      if (foundUser) {
        console.log("[TRACEARR] Utilisateur trouvé:", foundUser.username);
        console.log("[TRACEARR] Donnees completes:", JSON.stringify(foundUser, null, 2));
        console.log("[TRACEARR] sessionCount field:", foundUser.sessionCount);
        break;
      }

      page++;
    }

    if (!foundUser) {
      console.log("[TRACEARR] Utilisateur non trouvé apres", page - 1, "pages");
      return null;
    }

    // Prioriser Plex pour une date plus fiable
    let joinedAt = null;
    
    if (plexUserId && PLEX_URL && PLEX_TOKEN) {
      const plexJoinDate = await getPlexJoinDate(plexUserId, PLEX_URL, PLEX_TOKEN, joinedAtTimestamp);
      joinedAt = plexJoinDate ? plexJoinDate.toISOString() : null;
    }
    
    // Fallback sur Tracearr si Plex ne fourni pas de date
    if (!joinedAt) {
      joinedAt = foundUser.createdAt || null;
    }

    const result = {
      joinedAt,
      lastActivity: foundUser.lastActivityAt || null,
      sessionCount: foundUser.sessionCount || 0
    };
    console.log("[TRACEARR] Resultat final:", result);
    return result;

  } catch (err) {
    console.error("[TRACEARR] Erreur:", err.message);
    return null;
  }
}

module.exports = { getTracearrStats };
