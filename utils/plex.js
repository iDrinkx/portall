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
 * Récupère le machineIdentifier du serveur Plex local.
 * Utilisé pour filtrer précisément les accès à CE serveur dans le XML plex.tv.
 */
async function getServerMachineId(PLEX_URL, PLEX_TOKEN) {
  try {
    const res = await fetch(`${PLEX_URL}/identity`, {
      headers: {
        "X-Plex-Token": PLEX_TOKEN,
        "Accept": "application/json"
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.MediaContainer?.machineIdentifier || null;
  } catch (e) {
    console.warn("[Plex] Impossible de récupérer machineIdentifier:", e.message);
    return null;
  }
}

/**
 * Récupère la liste des utilisateurs ayant RÉELLEMENT accès au serveur.
 * Utilise l'API XML plex.tv/api/users et filtre par les entrées <Server> dans chaque <User>.
 * Un utilisateur supprimé n'aura plus de <Server> dans son entrée XML — contrairement à
 * /api/v2/friends qui peut avoir du cache, ou /api/users sans filtre qui inclut d'anciennes relations.
 *
 * @param {string} PLEX_TOKEN  Token admin
 * @param {string|null} machineId  machineIdentifier du PMS (optionnel, pour filter précis)
 */
async function getAuthorizedServerUsers(PLEX_TOKEN, machineId) {
  const res = await fetch("https://plex.tv/api/users", {
    headers: {
      "X-Plex-Token": PLEX_TOKEN,
      "X-Plex-Client-Identifier": "plex-portal-app",
      "Accept": "application/xml"
    }
  });
  if (!res.ok) throw new Error(`plex.tv/api/users → HTTP ${res.status}`);

  const xml = await res.text();
  const authorizedUsers = [];

  // Découper le XML en blocs <User>...</User>
  const userBlockRegex = /<User\s[\s\S]*?<\/User>/g;
  const attrRegex = /(\w+)="([^"]*)"/g;

  let block;
  while ((block = userBlockRegex.exec(xml)) !== null) {
    const openTagMatch = block[0].match(/<User\s([^>]+)>/);
    if (!openTagMatch) continue;

    const attrs = {};
    let m;
    while ((m = attrRegex.exec(openTagMatch[1])) !== null) {
      attrs[m[1]] = m[2];
    }
    if (!attrs.id) continue;

    // Un utilisateur a accès si son bloc contient un élément <Server> correspondant à notre serveur.
    // Si machineId est connu → filtre exact. Sinon → n'importe quel <Server> = accès à un serveur partagé.
    const hasAccess = machineId
      ? block[0].includes(`machineIdentifier="${machineId}"`)
      : /<Server[\s>]/.test(block[0]);

    if (hasAccess) {
      authorizedUsers.push({
        id: parseInt(attrs.id),
        username: attrs.title || attrs.username || "",
        email: attrs.email || ""
      });
    }
  }

  console.info(`[Plex] ✅ Utilisateurs avec accès serveur${machineId ? ` (machine: ${machineId})` : ""}: ${authorizedUsers.length}`);
  return authorizedUsers;
}

/**
 * @deprecated Alias pour compatibilité avec getPlexUsers / getPlexUserInfo.
 * Retourne tous les utilisateurs de plex.tv/api/users sans filtrage server.
 */
async function getPlexFriends(PLEX_TOKEN) {
  const res = await fetch("https://plex.tv/api/users", {
    headers: {
      "X-Plex-Token": PLEX_TOKEN,
      "X-Plex-Client-Identifier": "plex-portal-app",
      "Accept": "application/xml"
    }
  });
  if (!res.ok) throw new Error(`plex.tv/api/users → HTTP ${res.status}`);

  const xml = await res.text();
  const users = [];
  const userRegex = /<User\s([^>]+)>/g;
  const attrRegex = /(\w+)="([^"]*)"/g;
  let userMatch;

  while ((userMatch = userRegex.exec(xml)) !== null) {
    const attrs = {};
    let attrMatch;
    const attrStr = userMatch[1];
    while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }
    if (attrs.id) {
      users.push({ id: parseInt(attrs.id), username: attrs.title || "", email: attrs.email || "" });
    }
  }
  return users;
}

/**
 * Vérifie si un utilisateur Plex a accès au serveur.
 * - Autorisé s'il est le propriétaire du token admin (l'admin lui-même)
 * - Autorisé s'il a un <Server machineIdentifier="..."> dans plex.tv/api/users
 *   → seuls les utilisateurs avec accès actif au serveur ont cette entrée
 * - Propagate les erreurs réseau → l'appelant décide du fail-open
 */
async function isUserAuthorized(plexUserId, PLEX_URL, PLEX_TOKEN) {
  const userId = parseInt(plexUserId);
  console.info(`\n[Plex Auth] Vérification accès pour user ID: ${userId}`);

  // 1. L'utilisateur est-il le propriétaire du serveur (admin) ?
  const ownerId = await getServerOwnerId(PLEX_TOKEN);
  if (ownerId && ownerId === userId) {
    console.info(`✅ [Plex Auth] User ${userId} est le propriétaire du serveur`);
    return true;
  }

  // 2. Récupérer le machineIdentifier du PMS pour un filtrage précis
  const machineId = PLEX_URL ? await getServerMachineId(PLEX_URL, PLEX_TOKEN) : null;
  if (machineId) {
    console.info(`[Plex Auth] MachineIdentifier serveur: ${machineId}`);
  } else {
    console.warn(`[Plex Auth] ⚠️ MachineIdentifier non disponible — filtrage sur tout <Server> partagé`);
  }

  // 3. Vérifier si l'utilisateur a un accès serveur actif dans plex.tv/api/users
  const authorizedUsers = await getAuthorizedServerUsers(PLEX_TOKEN, machineId);
  console.info(`[Plex Auth] ${authorizedUsers.length} utilisateurs avec accès serveur — recherche de l'ID ${userId}…`);

  const found = authorizedUsers.find(u => u.id === userId);
  if (found) {
    console.info(`✅ [Plex Auth] User ${userId} (${found.email || found.username}) a accès au serveur`);
    return true;
  }

  console.warn(`❌ [Plex Auth] User ${userId} absent du serveur (owner=${ownerId}, authorized=[${authorizedUsers.map(u => u.id).join(',')}])`);
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
