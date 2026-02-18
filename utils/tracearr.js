const fetch = require("node-fetch");
const { getPlexJoinDate } = require("./plex");

async function getTracearrStats(username, TRACEARR_URL, TRACEARR_API_KEY, plexUserId, PLEX_URL, PLEX_TOKEN, joinedAtTimestamp = null) {
  try {
    if (!TRACEARR_URL || !TRACEARR_API_KEY) {
      console.log("[TRACEARR] Config manquante");
      return null;
    }

    console.log("[TRACEARR] Recherche utilisateur:", username);

    // D'abord, récupérer l'utilisateur pour ses infos de base (joinedAt, lastActivityAt)
    let page = 1;
    let totalPages = 1;
    let userInfo = null;

    while (page <= totalPages && !userInfo) {
      const res = await fetch(
        `${TRACEARR_URL}/api/v1/public/users?page=${page}&pageSize=50`,
        {
          headers: {
            Authorization: `Bearer ${TRACEARR_API_KEY}`,
            Accept: "application/json"
          }
        }
      );

      if (!res.ok) return null;

      const json = await res.json();
      if (!json?.data) return null;

      totalPages = Math.ceil(json.meta.total / json.meta.pageSize);
      userInfo = json.data.find(u => u.username?.toLowerCase() === username.toLowerCase());
      page++;
    }

    if (!userInfo) {
      console.log("[TRACEARR] Utilisateur non trouve");
      return null;
    }

    console.log("[TRACEARR] Utilisateur trouve:", userInfo.username);

    // Maintenant, récupérer l'historique complet pour compter les sessions
    console.log("[TRACEARR] Recuperation de l'historique pour compter les sessions...");
    
    let historyPage = 1;
    let historyTotalPages = 1;
    let sessionCount = 0;
    let latestActivity = userInfo.lastActivityAt;

    while (historyPage <= historyTotalPages) {
      const histRes = await fetch(
        `${TRACEARR_URL}/api/v1/public/history?page=${historyPage}&pageSize=100`,
        {
          headers: {
            Authorization: `Bearer ${TRACEARR_API_KEY}`,
            Accept: "application/json"
          }
        }
      );

      if (!histRes.ok) {
        console.log("[TRACEARR] Erreur historique - status:", histRes.status);
        break;
      }

      const histJson = await histRes.json();
      if (!histJson?.data) break;

      historyTotalPages = Math.ceil((histJson.meta?.total || 0) / (histJson.meta?.pageSize || 100));
      
      // Compter les sessions de cet utilisateur
      const userSessions = histJson.data.filter(session => 
        session.user?.username?.toLowerCase() === username.toLowerCase()
      );
      
      sessionCount += userSessions.length;
      console.log("[TRACEARR] Page", historyPage, "- Sessions trouvees pour", username, ":", userSessions.length);

      historyPage++;
    }

    console.log("[TRACEARR] Total sessions pour", username, ":", sessionCount);

    // Prioriser Plex pour une date plus fiable
    let joinedAt = null;
    
    if (plexUserId && PLEX_URL && PLEX_TOKEN) {
      const plexJoinDate = await getPlexJoinDate(plexUserId, PLEX_URL, PLEX_TOKEN, joinedAtTimestamp);
      joinedAt = plexJoinDate ? plexJoinDate.toISOString() : null;
    }
    
    // Fallback sur Tracearr si Plex ne fourni pas de date
    if (!joinedAt) {
      joinedAt = userInfo.createdAt || null;
    }

    const result = {
      joinedAt,
      lastActivity: latestActivity || null,
      sessionCount: sessionCount
    };
    console.log("[TRACEARR] Resultat final:", result);
    return result;

  } catch (err) {
    console.error("[TRACEARR] Erreur:", err.message);
    return null;
  }
}

module.exports = { getTracearrStats };
