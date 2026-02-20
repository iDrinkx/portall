document.addEventListener("DOMContentLoaded", async () => {

  const basePath = window.APP_BASE_PATH || "";
  const SUBSCRIPTION_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  const STATS_CACHE_DURATION = 30000; // 30 secondes

  // Récupérer l'ID utilisateur depuis le attribut data du body (à ajouter dans le template si absent)
  const userId = document.body.getAttribute("data-user-id") || "guest";

  /* ===============================
     🎮 XP SYSTEM DEFINITION
  =============================== */

  const XP_SYSTEM = {
    badges: [
      { level: 1, name: "Bronze",  icon: "🥉", minXp: 0,     maxXp: 500,   color: "#CD7F32", bgColor: "rgba(205, 127, 50, 0.2)",   borderColor: "#CD7F32" },
      { level: 2, name: "Argent",  icon: "🥈", minXp: 500,   maxXp: 1500,  color: "#C0C0C0", bgColor: "rgba(192, 192, 192, 0.2)",  borderColor: "#C0C0C0" },
      { level: 3, name: "Or",      icon: "🥇", minXp: 1500,  maxXp: 3500,  color: "#E5A00D", bgColor: "rgba(229, 160, 13, 0.2)",   borderColor: "#E5A00D" },
      { level: 4, name: "Platine", icon: "💠", minXp: 3500,  maxXp: 7000,  color: "#00D9FF", bgColor: "rgba(0, 217, 255, 0.2)",    borderColor: "#00D9FF" },
      { level: 5, name: "Diamant", icon: "💎", minXp: 7000,  maxXp: 10000, color: "#FF1493", bgColor: "rgba(255, 20, 147, 0.2)",   borderColor: "#FF1493" },
      { level: 6, name: "Légende", icon: "👑", minXp: 10000, maxXp: 100000,color: "#7C3AED", bgColor: "rgba(124, 58, 237, 0.2)",   borderColor: "#7C3AED" }
    ]
  };

  XP_SYSTEM.getBadgeByXp = function(totalXp) {
    return this.badges.find(b => totalXp >= b.minXp && totalXp < b.maxXp) || this.badges[this.badges.length - 1];
  };

  /* ===============================
     💾 CACHE UTILITIES
  =============================== */

  const cacheManager = {
    get(key, duration = STATS_CACHE_DURATION) {
      const cacheKey = `${key}:${userId}`;
      const cached = sessionStorage.getItem(cacheKey);
      const time = sessionStorage.getItem(`${cacheKey}:time`);
      const now = Date.now();

      if (cached && time && now - parseInt(time) < duration) {
        return JSON.parse(cached);
      }
      
      sessionStorage.removeItem(cacheKey);
      sessionStorage.removeItem(`${cacheKey}:time`);
      return null;
    },

    set(key, data) {
      const cacheKey = `${key}:${userId}`;
      sessionStorage.setItem(cacheKey, JSON.stringify(data));
      sessionStorage.setItem(`${cacheKey}:time`, Date.now());
    },

    invalidate(key) {
      const cacheKey = `${key}:${userId}`;
      sessionStorage.removeItem(cacheKey);
      sessionStorage.removeItem(`${cacheKey}:time`);
    }
  };

  /* ===============================
     🎮 UPDATE AVATAR XP COLOR
  =============================== */

  async function updateAvatarXpColor() {
    try {
      const avatarEl = document.querySelector(".user-avatar");
      if (!avatarEl) return;

      // Charger stats et overseerr
      let tautulliData = cacheManager.get("statsCache", STATS_CACHE_DURATION);
      if (!tautulliData) {
        const res = await fetch(basePath + "/api/stats", {
          headers: { "Accept": "application/json" }
        });
        if (!res.ok) return;
        tautulliData = await res.json();
        cacheManager.set("statsCache", tautulliData);
      }

      let seerrData = cacheManager.get("seerrCache", STATS_CACHE_DURATION);
      if (!seerrData) {
        const res = await fetch(basePath + "/api/seerr", {
          headers: { "Accept": "application/json" }
        });
        if (!res.ok) return;
        seerrData = await res.json();
        cacheManager.set("seerrCache", seerrData);
      }

      // Calculer l'XP
      const sessionCount = tautulliData?.sessionCount || 0;
      const totalXp = sessionCount * 2; // Seerr ne procure plus d'XP

      // Obtenir le badge couleur
      const badge = XP_SYSTEM.getBadgeByXp(totalXp);

      // Mettre à jour la couleur du avatar
      avatarEl.style.borderColor = badge.borderColor;
    } catch (err) {
      console.debug("Avatar XP color update skipped:", err.message);
    }
  }

  /* ===============================
     🚀 LOAD ALL DATA
  =============================== */

  await updateAvatarXpColor();

});