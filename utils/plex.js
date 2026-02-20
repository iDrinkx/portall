const fetch = require("node-fetch");

/**
 * Récupère l'ID Plex du propriétaire du serveur (le compte lié au PLEX_TOKEN admin).
 * Utilise l'API cloud plex.tv — fiable même si le serveur local est en redémarrage.
 */
async function getServerOwnerId(PLEX_TOKEN) {
  const res = await fetch("https://plex.tv/api/v2/user", {
    headers: {
      "X-Plex-Token": PLEX_TOKEN,
      "X-Plex-Client-Identifier": "plex-portal-app",
      "Accept": "application/json"
    }
  });
  if (!res.ok) throw new Error(`plex.tv/api/v2/user → HTTP ${res.status}`);
  const data = await res.json();
  return data.id ? parseInt(data.id) : null;
}

/**
 * Récupère la liste complète des amis/partagés du compte admin via l'API cloud plex.tv.
 * Gère la pagination : boucle jusqu'à ce que toutes les pages soient récupérées.
 */
async function getPlexFriends(PLEX_TOKEN) {
  const PAGE_SIZE = 100;
  let offset = 0;
  let allFriends = [];

  while (true) {
    const url = `https://plex.tv/api/v2/friends?includeSharedServers=1&count=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url, {
      headers: {
        "X-Plex-Token": PLEX_TOKEN,
        "X-Plex-Client-Identifier": "plex-portal-app",
        "Accept": "application/json"
      }
    });
    if (!res.ok) throw new Error(`plex.tv/api/v2/friends → HTTP ${res.status}`);
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;

    allFriends = allFriends.concat(page);
    console.debug(`[Plex] Friends page offset=${offset}: ${page.length} reçus, total=${allFriends.length}`);

    // Si la page est moins remplie que PAGE_SIZE, c'est la dernière
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  console.info(`[Plex] ✅ Total amis récupérés: ${allFriends.length}`);
  return allFriends;
}

/**
 * Vérifie si un utilisateur Plex a accès au serveur.
 * - Autorisé s'il est le propriétaire du token admin (l'admin lui-même)
 * - Autorisé s'il figure dans la liste des amis partagés
 * - Propagate les erreurs réseau → l'appelant décide du fail-open
 */
async function isUserAuthorized(plexUserId, _PLEX_URL, PLEX_TOKEN) {
  const userId = parseInt(plexUserId);
  console.info(`\n[Plex Auth] Vérification accès pour user ID: ${userId}`);

  // 1. L'utilisateur est-il le propriétaire du serveur (admin) ?
  const ownerId = await getServerOwnerId(PLEX_TOKEN);
  if (ownerId && ownerId === userId) {
    console.info(`✅ [Plex Auth] User ${userId} est le propriétaire du serveur`);
    return true;
  }

  // 2. L'utilisateur est-il dans la liste des amis partagés ?
  const friends = await getPlexFriends(PLEX_TOKEN);
  console.info(`[Plex Auth] ${friends.length} amis trouvés — recherche de l'ID ${userId}…`);

  const found = friends.find(f => parseInt(f.id) === userId);
  if (found) {
    console.info(`✅ [Plex Auth] User ${userId} (${found.email || found.username}) est un ami partagé`);
    return true;
  }

  console.warn(`❌ [Plex Auth] User ${userId} absent du serveur (owner=${ownerId}, friends=[${friends.map(f => f.id).join(',')}])`);
  return false;
}

/**
 * Récupère les infos d'un utilisateur Plex (pour compatibilité avec le reste du code).
 * Cherche parmi l'owner + les amis.
 */
async function getPlexUserInfo(plexUserId, _PLEX_URL, PLEX_TOKEN) {
  try {
    const userId = parseInt(plexUserId);

    // Vérifier si c'est l'owner
    const ownerRes = await fetch("https://plex.tv/api/v2/user", {
      headers: {
        "X-Plex-Token": PLEX_TOKEN,
        "X-Plex-Client-Identifier": "plex-portal-app",
        "Accept": "application/json"
      }
    });
    if (ownerRes.ok) {
      const owner = await ownerRes.json();
      if (parseInt(owner.id) === userId) return owner;
    }

    // Sinon chercher dans les amis
    const friends = await getPlexFriends(PLEX_TOKEN);
    return friends.find(f => parseInt(f.id) === userId) || null;

  } catch (err) {
    console.error("[Plex] Erreur getPlexUserInfo:", err.message);
    return null;
  }
}

/**
 * Compatibilité — conservé pour getPlexJoinDate.
 * @deprecated Utiliser getPlexFriends() directement.
 */
async function getPlexUsers(_PLEX_URL, PLEX_TOKEN) {
  return getPlexFriends(PLEX_TOKEN);
}

/**
 * Récupère la date d'adhésion d'un utilisateur.
 * Utilise en priorité le timestamp Plex OAuth (le plus fiable).
 */
async function getPlexJoinDate(plexUserId, PLEX_URL, PLEX_TOKEN, joinedAtTimestamp = null) {
  try {
    if (joinedAtTimestamp) {
      const joinDate = new Date(joinedAtTimestamp * 1000);
      console.info(`[Plex JoinDate] ✅ User ${plexUserId} joined ${joinDate.toISOString()} (depuis OAuth)`);
      return joinDate;
    }

    const user = await getPlexUserInfo(plexUserId, PLEX_URL, PLEX_TOKEN);
    if (user?.createdAt) {
      return new Date(user.createdAt * 1000);
    }
    return null;
  } catch (err) {
    console.error("[Plex JoinDate] Erreur:", err.message);
    return null;
  }
}

module.exports = {
  getPlexUsers,
  getPlexUserInfo,
  isUserAuthorized,
  getPlexJoinDate
};
