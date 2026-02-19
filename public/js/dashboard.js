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
      { level: 1, name: "Bronze", icon: "🔵", minXp: 0, maxXp: 100, color: "#5B9BD5", bgColor: "rgba(91, 155, 213, 0.2)", borderColor: "#5B9BD5" },
      { level: 2, name: "Argent", icon: "⚪", minXp: 100, maxXp: 300, color: "#C0C0C0", bgColor: "rgba(192, 192, 192, 0.2)", borderColor: "#C0C0C0" },
      { level: 3, name: "Or", icon: "🟡", minXp: 300, maxXp: 700, color: "#E5A00D", bgColor: "rgba(229, 160, 13, 0.2)", borderColor: "#E5A00D" },
      { level: 4, name: "Platine", icon: "💎", minXp: 700, maxXp: 1500, color: "#00D9FF", bgColor: "rgba(0, 217, 255, 0.2)", borderColor: "#00D9FF" },
      { level: 5, name: "Diamant", icon: "💜", minXp: 1500, maxXp: Infinity, color: "#FF1493", bgColor: "rgba(255, 20, 147, 0.2)", borderColor: "#FF1493" }
    ]
  };

  XP_SYSTEM.getBadgeByXp = function(totalXp) {
    return this.badges.find(b => totalXp >= b.minXp && totalXp < b.maxXp) || this.badges[this.badges.length - 1];
  };

  /* ===============================
     🕒 DATE UTILITIES
  =============================== */

  function formatRelativeTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);
    const diffWeek = Math.floor(diffDay / 7);
    const diffMonth = Math.floor(diffDay / 30);
    const diffYear = Math.floor(diffDay / 365);

    if (diffYear > 0) return `il y a ${diffYear} an${diffYear > 1 ? 's' : ''}`;
    if (diffMonth > 0) return `il y a ${diffMonth} mois`;
    if (diffWeek > 0) return `il y a ${diffWeek} semaine${diffWeek > 1 ? 's' : ''}`;
    if (diffDay > 0) return `il y a ${diffDay} jour${diffDay > 1 ? 's' : ''}`;
    if (diffHour > 0) return `il y a ${diffHour}h`;
    if (diffMin > 0) return `il y a ${diffMin}min`;
    return 'À l\'instant';
  }

  window.formatRelativeTime = formatRelativeTime;

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
    },

    invalidateAll() {
      ["subscriptionCache", "statsCache", "overseerrCache"].forEach(key => this.invalidate(key));
    }
  };

  // Expose pour utilisation depuis le HTML si besoin
  window.cacheManager = cacheManager;

  /* ===============================
     📅 SUBSCRIPTION
  =============================== */

  async function loadSubscription() {
    const statusEl = document.getElementById("subscriptionStatus");
    const contentEl = document.getElementById("subscriptionContent");

    try {
      // Vérifier cache local (5 minutes - moins fréquent que stats)
      let sub = cacheManager.get("subscriptionCache", SUBSCRIPTION_CACHE_DURATION);

      if (!sub) {
        const res = await fetch(basePath + "/api/subscription");
        if (!res.ok) throw new Error("API error");
        sub = await res.json();
        cacheManager.set("subscriptionCache", sub);
      }

      statusEl.className = "status-mini " + sub.status;
      statusEl.textContent = sub.status || "Indispo";
      
      // Afficher "X jours restants" ou "Accès illimité"
      const displayText = sub.daysLeft ? `${sub.daysLeft} jours restants` : "Accès illimité";
      contentEl.innerHTML = `<p>${displayText}</p>`;

    } catch (err) {
      console.error("Subscription load error:", err);
      statusEl.textContent = "Erreur";
    }
  }

  /* =====================================
     📊 STATS (Tautulli + Overseerr)
  ===================================== */

  async function loadStats() {
    const statusEl = document.getElementById("statsStatus");
    const contentEl = document.getElementById("statsContent");

    try {
      // Charger Tautulli stats
      let tautulliData = cacheManager.get("statsCache", STATS_CACHE_DURATION);
      if (!tautulliData) {
        const res = await fetch(basePath + "/api/stats", {
          headers: { "Accept": "application/json" }
        });
        if (!res.ok) throw new Error("stats_api_error");
        tautulliData = await res.json();
        cacheManager.set("statsCache", tautulliData);
      }

      // Charger Overseerr stats
      let overseerrData = cacheManager.get("overseerrCache", STATS_CACHE_DURATION);
      if (!overseerrData) {
        const res = await fetch(basePath + "/api/overseerr", {
          headers: { "Accept": "application/json" }
        });
        if (!res.ok) throw new Error("overseerr_api_error");
        overseerrData = await res.json();
        cacheManager.set("overseerrCache", overseerrData);
      }

      // Vérifier si on a au moins une donnée
      const hasTautulliData = tautulliData && (tautulliData.joinedAt || tautulliData.lastActivity);
      const hasOverseerrData = overseerrData && overseerrData.total > 0;

      if (!hasTautulliData && !hasOverseerrData) {
        statusEl.className = "status-mini loading";
        statusEl.textContent = "Indispo";
        contentEl.innerHTML = `<p class="subscription-loading">Données indisponibles.</p>`;
        return;
      }

      statusEl.className = "status-mini active";
      statusEl.textContent = "OK";

      let html = "";

      // Afficher derniere activité Tautulli en format relatif
      if (hasTautulliData && tautulliData.lastActivity) {
        const last = formatRelativeTime(tautulliData.lastActivity);
        html += `<p style="font-size:14px; margin-bottom:6px;">🕒 Dernière activité : <strong>${last}</strong></p>`;
      }

      // Afficher nombre de demandes Overseerr
      if (hasOverseerrData) {
        html += `<p style="color:#bbb; font-size:13px;">🎬 Demandes : ${overseerrData.total}</p>`;
      }

      contentEl.innerHTML = html;

    } catch (err) {
      console.error("Stats load error:", err);
      statusEl.className = "status-mini expired";
      statusEl.textContent = "Erreur";
      contentEl.innerHTML = `<p class="subscription-expired">Impossible de charger</p>`;
    }
  }

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

      let overseerrData = cacheManager.get("overseerrCache", STATS_CACHE_DURATION);
      if (!overseerrData) {
        const res = await fetch(basePath + "/api/overseerr", {
          headers: { "Accept": "application/json" }
        });
        if (!res.ok) return;
        overseerrData = await res.json();
        cacheManager.set("overseerrCache", overseerrData);
      }

      // Calculer l'XP
      const sessionCount = tautulliData?.sessionCount || 0;
      const totalRequests = overseerrData?.total || 0;
      const totalXp = sessionCount * 2; // Overseerr ne procure plus d'XP

      // Obtenir le badge couleur
      const badge = XP_SYSTEM.getBadgeByXp(totalXp);

      // Mettre à jour la couleur du avatar
      avatarEl.style.borderColor = badge.borderColor;
    } catch (err) {
      console.debug("Avatar XP color update skipped:", err.message);
    }
  }

  /* ===============================
     � ANIMATION COMPTEUR STATISTIQUES
  =============================== */

  /**
   * Animer un compteur de 0 à la valeur cible
   * Utilisation: animateCounter(element, targetValue, duration)
   */
  function animateCounter(element, targetValue, duration = 1500) {
    // Parser la valeur cible
    const target = parseFloat(targetValue);
    if (isNaN(target)) return;

    let current = 0;
    const startTime = Date.now();
    const easeOutQuad = (t) => t * (2 - t); // Fonction d'ease ease-out

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOutQuad(progress);
      
      current = target * eased;
      
      // Afficher avec zéro décimal pour les entiers, 1 décimal pour les heures
      if (targetValue % 1 === 0 || targetValue < 1) {
        element.textContent = Math.round(current);
      } else {
        element.textContent = current.toFixed(1);
      }

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        element.textContent = targetValue;
      }
    };

    requestAnimationFrame(animate);
  }

  /**
   * Démarrer animations des compteurs une fois qu'ils sont visibles
   */
  function initCounterAnimations() {
    const counters = document.querySelectorAll('.stat-value.counter');
    
    if (counters.length === 0) return;

    // Utiliser IntersectionObserver pour animer seulement quand visible
    const observerOptions = {
      threshold: 0.3,
      rootMargin: '0px'
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && !entry.target.hasAttribute('data-animated')) {
          const target = parseFloat(entry.target.getAttribute('data-target')) || 0;
          animateCounter(entry.target, target, 1800);
          entry.target.setAttribute('data-animated', 'true');
          observer.unobserve(entry.target);
        }
      });
    }, observerOptions);

    counters.forEach(counter => observer.observe(counter));
  }

  /**
   * Charger et afficher les stats de visionnage (Tautulli)
   */
  async function updateWatchStats() {
    try {
      const res = await fetch(basePath + "/api/stats", {
        headers: { "Accept": "application/json" }
      });
      
      if (!res.ok) {
        console.warn("[WATCH-STATS] Erreur API stats:", res.status);
        return;
      }
      
      const stats = await res.json();
      console.log("[WATCH-STATS] Stats reçues:", stats);
      
      // Mettre à jour les compteurs si les données existent
      if (stats && stats.watchStats) {
        const { totalHours, movieCount, episodeCount } = stats.watchStats;
        const sessionCount = stats.sessionCount || 0;
        
        console.log("[WATCH-STATS] Données extraites:", { totalHours, movieCount, episodeCount, sessionCount });
        
        // Mettre à jour avec les vraies données
        const hoursEl = document.getElementById('counterHours');
        const moviesEl = document.getElementById('counterMovies');
        const episodesEl = document.getElementById('counterEpisodes');
        const sessionsEl = document.getElementById('counterSessions');
        
        console.log("[WATCH-STATS] Éléments DOM:", { hoursEl: !!hoursEl, moviesEl: !!moviesEl, episodesEl: !!episodesEl, sessionsEl: !!sessionsEl });
        
        if (hoursEl) {
          hoursEl.setAttribute('data-target', Math.round(totalHours * 10) / 10 || 0);
          hoursEl.textContent = Math.round(totalHours * 10) / 10 || 0;
          console.log("[WATCH-STATS] Heures mis à jour:", totalHours);
        }
        if (moviesEl) {
          moviesEl.setAttribute('data-target', movieCount || 0);
          moviesEl.textContent = movieCount || 0;
          console.log("[WATCH-STATS] Films mis à jour:", movieCount);
        }
        if (episodesEl) {
          episodesEl.setAttribute('data-target', episodeCount || 0);
          episodesEl.textContent = episodeCount || 0;
          console.log("[WATCH-STATS] Épisodes mis à jour:", episodeCount);
        }
        if (sessionsEl) {
          sessionsEl.setAttribute('data-target', sessionCount || 0);
          sessionsEl.textContent = sessionCount || 0;
          console.log("[WATCH-STATS] Sessions mis à jour:", sessionCount);
        }
        
        console.log("[WATCH-STATS] ✅ Tous les compteurs mis à jour");
      } else {
        console.warn("[WATCH-STATS] ⚠️  watchStats non présent dans la réponse");
      }
    } catch (err) {
      console.error("[WATCH-STATS] ❌ Erreur chargement:", err.message);
    }
  }

  /* ===============================
     🚀 LOAD ALL DATA
  =============================== */

  await Promise.all([
    loadSubscription(),
    loadStats(),
    updateWatchStats(),
    updateAvatarXpColor()
  ]);

  // Démarrer animations compteurs après chargement
  setTimeout(() => {
    initCounterAnimations();
  }, 200);