/* ================================================
   OVERSEERR INTEGRATION - CLIENT JS
   ================================================ */

(function () {
  "use strict";

  /* ===============================
     CONFIG
  =============================== */
  const BASE = window.APP_BASE_PATH || "";
  const API  = BASE + "/api/overseerr/proxy";
  const IMG  = BASE + "/api/overseerr/image?url=";
  const TMDB_IMG = "https://image.tmdb.org/t/p/";

  /* ===============================
     STATE
  =============================== */
  const state = {
    currentView: "discover",
    currentFilter: "all",
    currentModal: null,
    selectedSeasons: new Set(),
    searchTimeout: null,
    user: null,
    quota: null
  };

  /* ===============================
     DOM HELPERS
  =============================== */
  const $ = id => document.getElementById(id);
  const $$ = sel => document.querySelectorAll(sel);

  function tmdbImg(path, size = "w342") {
    if (!path) return null;
    return IMG + encodeURIComponent(TMDB_IMG + size + path);
  }

  function formatStatus(status) {
    const map = {
      1: { label: "Non demandé",    cls: "unavailable", icon: "○" },
      2: { label: "En attente",     cls: "pending",     icon: "◐" },
      3: { label: "En traitement",  cls: "processing",  icon: "◑" },
      4: { label: "Partiel",        cls: "processing",  icon: "◑" },
      5: { label: "Disponible",     cls: "available",   icon: "●" },
      6: { label: "Non disponible", cls: "unavailable", icon: "○" }
    };
    return map[status] || { label: "Inconnu", cls: "unknown", icon: "?" };
  }

  function formatRequestStatus(status) {
    const map = {
      1: { label: "En attente",    cls: "pending" },
      2: { label: "Approuvé",      cls: "processing" },
      3: { label: "Refusé",        cls: "declined" },
      4: { label: "Disponible",    cls: "available" },
      5: { label: "Partiellement disponible", cls: "processing" }
    };
    return map[status] || { label: "Inconnu", cls: "unknown" };
  }

  function yearFromDate(date) {
    if (!date) return "";
    return new Date(date).getFullYear();
  }

  function timeAgo(dateStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60)    return "à l'instant";
    if (diff < 3600)  return `il y a ${Math.floor(diff/60)} min`;
    if (diff < 86400) return `il y a ${Math.floor(diff/3600)} h`;
    return `il y a ${Math.floor(diff/86400)} j`;
  }

  /* ===============================
     API CALLS
  =============================== */
  async function apiGet(path, params = {}) {
    const url = new URL(API + path, window.location.origin);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }

  async function apiPost(path, body = {}) {
    const res = await fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `API ${res.status}`);
    }
    return res.json();
  }

  async function apiDelete(path) {
    const res = await fetch(API + path, { method: "DELETE" });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json().catch(() => ({}));
  }

  /* ===============================
     TOAST
  =============================== */
  function toast(msg, type = "info") {
    const container = $("seerrToasts");
    if (!container) return;
    const el = document.createElement("div");
    el.className = `seerr-toast ${type}`;
    el.innerHTML = `<span>${type === "success" ? "✓" : type === "error" ? "✕" : "ℹ"}</span><span>${msg}</span>`;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  /* ===============================
     LOADING STATES
  =============================== */
  function loadingHTML() {
    return `<div class="seerr-loading"><div class="seerr-spinner"></div> Chargement...</div>`;
  }

  function emptyHTML(text = "Aucun résultat", sub = "") {
    return `<div class="seerr-empty">
      <div class="seerr-empty-icon">🎬</div>
      <div class="seerr-empty-text">${text}</div>
      ${sub ? `<div class="seerr-empty-sub">${sub}</div>` : ""}
    </div>`;
  }

  /* ===============================
     MEDIA CARD
  =============================== */
  function buildCard(item) {
    const isTV    = item.mediaType === "tv";
    const poster  = tmdbImg(item.posterPath, "w342");
    const status  = item.mediaInfo?.status || 1;
    const st      = formatStatus(status);
    const year    = yearFromDate(isTV ? item.firstAirDate : item.releaseDate);

    const card = document.createElement("div");
    card.className = "seerr-card";
    card.dataset.id   = item.id;
    card.dataset.type = item.mediaType;

    card.innerHTML = `
      <span class="seerr-card-overlay ${isTV ? "tv" : "movie"}">${isTV ? "SÉRIE" : "FILM"}</span>
      ${status !== 1 ? `<span class="seerr-card-status-overlay ${st.cls}" title="${st.label}">${st.icon}</span>` : ""}
      ${poster
        ? `<img class="seerr-card-poster" src="${poster}" alt="" loading="lazy" onerror="this.parentNode.querySelector('.seerr-card-poster-placeholder').style.display='flex';this.style.display='none'">`
        : ""}
      <div class="seerr-card-poster-placeholder" style="display:${poster ? "none" : "flex"}">🎬</div>
      <div class="seerr-card-body">
        <div class="seerr-card-title">${item.title || item.name || "Sans titre"}</div>
        <div class="seerr-card-meta">
          <span class="seerr-badge seerr-badge-${isTV ? "tv" : "movie"}">${year}</span>
        </div>
      </div>`;

    card.addEventListener("click", () => openModal(item.id, item.mediaType));
    return card;
  }

  function buildCardRow(items, container) {
    container.innerHTML = "";
    if (!items || items.length === 0) {
      container.innerHTML = emptyHTML("Aucun contenu", "");
      return;
    }
    items.forEach(item => container.appendChild(buildCard(item)));
  }

  /* ===============================
     QUOTA
     Utilise les vrais endpoints API Seerr :
     - GET /auth/me        → infos utilisateur
     - GET /user/{id}/quota → quotas film/TV précis
     - GET /request/count  → compteur de demandes en attente
  =============================== */
  async function loadUserQuota() {
    try {
      // 1. Infos utilisateur
      const me = await apiGet("/auth/me");
      state.user = me;

      const nameEl = $("seerrUserName");
      if (nameEl) nameEl.textContent = me.displayName || me.plexUsername || me.email || "Utilisateur";

      const roleEl = $("seerrUserRole");
      if (roleEl) {
        // permissions: 0=user, 2=manage-requests, 4=admin (bitmask)
        const isAdmin = (me.permissions & 4) !== 0 || me.permissions === 2;
        roleEl.textContent = isAdmin ? "Administrateur" : "Membre";
      }

      // 2. Quota précis via l'endpoint dédié GET /user/{id}/quota
      try {
        const quota = await apiGet(`/user/${me.id}/quota`);
        // quota.movie : { days, limit, used, remaining, restricted }
        // quota.tv    : { days, limit, used, remaining, restricted }
        const mq = quota.movie || {};
        const tq = quota.tv    || {};
        updateQuota("movieQuota", mq.limit || 0, mq.days  || 0, mq.used  || 0, mq.remaining);
        updateQuota("tvQuota",    tq.limit || 0, tq.days  || 0, tq.used  || 0, tq.remaining);
      } catch (_) {
        // Fallback : pas de quota configuré → cacher les barres
        const mw = $("movieQuota"); if (mw) mw.style.display = "none";
        const tw = $("tvQuota");    if (tw) tw.style.display = "none";
      }

      // 3. Badge "demandes en attente" via GET /request/count
      try {
        const counts = await apiGet("/request/count");
        // counts : { total, movie, tv, pending, approved, declined, processing, available }
        const pendingBadge = $("pendingRequestsBadge");
        if (pendingBadge) {
          const n = counts.pending || 0;
          pendingBadge.textContent = n;
          pendingBadge.style.display = n > 0 ? "" : "none";
        }
        // Mettre à jour les compteurs dans la vue Demandes
        updateRequestCountBadges(counts);
      } catch (_) { /* silencieux */ }

      state.quota = me;
    } catch (e) {
      console.warn("[Overseerr] Could not load user quota:", e.message);
    }
  }

  function updateRequestCountBadges(counts) {
    // Injecter le nombre dans chaque bouton de filtre
    const map = {
      all:       counts.total     || 0,
      pending:   counts.pending   || 0,
      approved:  counts.approved  || 0,
      available: counts.available || 0,
      declined:  counts.declined  || 0
    };
    $$(".seerr-filter-btn").forEach(btn => {
      const f = btn.dataset.filter;
      if (f in map && map[f] > 0) {
        btn.textContent = `${btn.textContent.replace(/ \(\d+\)$/, "")} (${map[f]})`;
      }
    });
  }

  function updateQuota(id, limit, days, used, remaining) {
    const wrap = $(id);
    if (!wrap) return;

    // Cacher si pas de quota configuré (limit 0 = illimité)
    if (!limit) {
      wrap.style.display = "none";
      return;
    }

    wrap.style.display = "";
    const pct = Math.min((used / limit) * 100, 100);
    const fillEl   = wrap.querySelector(".seerr-quota-fill");
    const labelEl  = wrap.querySelector(".seerr-quota-used");
    const daysEl   = wrap.querySelector(".seerr-quota-days");

    if (fillEl) {
      fillEl.style.width = pct + "%";
      fillEl.className = "seerr-quota-fill" + (pct >= 100 ? " danger" : pct >= 75 ? " warning" : "");
    }
    if (labelEl) labelEl.textContent = `${used}/${limit}`;
    if (daysEl && days) daysEl.textContent = `(${days}j)`;
  }

  /* ===============================
     DISCOVER VIEW
     Charge en parallèle :
     - /discover/movies          → films populaires
     - /discover/tv              → séries populaires
     - /discover/trending        → tendances
     - /discover/movies/upcoming → films à venir
     - /discover/tv/upcoming     → séries à venir
     - /discover/watchlist       → watchlist Plex
  =============================== */
  async function loadDiscover() {
    showView("discover");
    setActiveNav("nav-discover");

    const rows = ["rowMovies","rowTV","rowTrending","rowUpcomingMovies","rowUpcomingTV","rowWatchlist"];
    rows.forEach(id => { if ($(id)) $(id).innerHTML = loadingHTML(); });

    const [movies, tv, trending, upMovies, upTV, watchlist] = await Promise.allSettled([
      apiGet("/discover/movies",          { page: 1 }),
      apiGet("/discover/tv",              { page: 1 }),
      apiGet("/discover/trending",        { page: 1 }),
      apiGet("/discover/movies/upcoming", { page: 1 }),
      apiGet("/discover/tv/upcoming",     { page: 1 }),
      apiGet("/discover/watchlist",       { page: 1 })
    ]);

    if (movies.status   === "fulfilled" && $("rowMovies"))         buildCardRow(movies.value.results   || [], $("rowMovies"));
    if (tv.status       === "fulfilled" && $("rowTV"))             buildCardRow(tv.value.results       || [], $("rowTV"));
    if (trending.status === "fulfilled" && $("rowTrending"))       buildCardRow(trending.value.results || [], $("rowTrending"));

    // À venir — films
    if (upMovies.status === "fulfilled" && $("rowUpcomingMovies")) {
      buildCardRow(upMovies.value.results || [], $("rowUpcomingMovies"));
      showSection("sectionUpcomingMovies", upMovies.value.results?.length > 0);
    }

    // À venir — séries
    if (upTV.status === "fulfilled" && $("rowUpcomingTV")) {
      buildCardRow(upTV.value.results || [], $("rowUpcomingTV"));
      showSection("sectionUpcomingTV", upTV.value.results?.length > 0);
    }

    // Watchlist Plex
    if (watchlist.status === "fulfilled" && $("rowWatchlist")) {
      const items = watchlist.value.results || [];
      buildCardRow(items, $("rowWatchlist"));
      showSection("sectionWatchlist", items.length > 0);
    }
  }

  function showSection(id, visible) {
    const el = $(id);
    if (el) el.style.display = visible ? "" : "none";
  }

  /* ===============================
     MOVIES VIEW
  =============================== */
  async function loadMovies() {
    showView("movies");
    setActiveNav("nav-movies");
    const grid = $("gridMovies");
    if (!grid) return;
    grid.innerHTML = loadingHTML();
    try {
      const data = await apiGet("/discover/movies", { page: 1 });
      grid.className = "seerr-media-grid";
      buildCardRow(data.results || [], grid);
    } catch (e) {
      if (grid) grid.innerHTML = emptyHTML("Erreur", e.message);
    }
  }

  /* ===============================
     TV VIEW
  =============================== */
  async function loadTV() {
    showView("tv");
    setActiveNav("nav-tv");
    const grid = $("gridTV");
    if (!grid) return;
    grid.innerHTML = loadingHTML();
    try {
      const data = await apiGet("/discover/tv", { page: 1 });
      grid.className = "seerr-media-grid";
      buildCardRow(data.results || [], grid);
    } catch (e) {
      if (grid) grid.innerHTML = emptyHTML("Erreur", e.message);
    }
  }

  /* ===============================
     REQUESTS VIEW
  =============================== */
  async function loadRequests(filter = "all") {
    showView("requests");
    setActiveNav("nav-requests");
    state.currentFilter = filter;

    // Mettre à jour les boutons de filtre
    $$(".seerr-filter-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.filter === filter);
    });

    const container = $("requestsContainer");
    if (!container) return;
    container.innerHTML = loadingHTML();

    try {
      const data = await apiGet("/request", { filter, sort: "added", skip: 0, take: 40 });
      const requests = data.results || [];

      if (requests.length === 0) {
        container.innerHTML = emptyHTML("Aucune demande", "Vous n'avez pas encore fait de demande");
        return;
      }

      container.innerHTML = "";
      container.className = "seerr-request-row";

      for (const req of requests) {
        const card = buildRequestCard(req);
        container.appendChild(card);
      }
    } catch (e) {
      container.innerHTML = emptyHTML("Erreur", e.message);
    }
  }

  function buildRequestCard(req) {
    const media  = req.media || {};
    const isTV   = media.mediaType === "tv";
    const poster = tmdbImg(media.posterPath, "w154");
    const st     = formatRequestStatus(req.status);
    const year   = yearFromDate(isTV ? media.firstAirDate : media.releaseDate);
    const name   = media.title || media.name || "Sans titre";
    const by     = req.requestedBy;

    const card = document.createElement("div");
    card.className = "seerr-request-card";

    card.innerHTML = `
      ${poster
        ? `<img class="seerr-request-poster" src="${poster}" alt="" loading="lazy">`
        : `<div class="seerr-request-poster-placeholder">🎬</div>`}
      <div class="seerr-request-info">
        <span class="seerr-request-year">${year}${isTV && req.seasons?.length ? ` · Saison${req.seasons.length > 1 ? "s" : ""} ${req.seasons.map(s => s.seasonNumber).join(", ")}` : ""}</span>
        <div class="seerr-request-title">${name}</div>
        <div class="seerr-request-by">
          ${by?.avatar ? `<img class="seerr-request-avatar-mini" src="${by.avatar}" alt="">` : ""}
          <span>${by?.displayName || by?.plexUsername || "Inconnu"}</span>
          <span style="margin-left:auto;font-size:11px">${timeAgo(req.createdAt)}</span>
        </div>
        <span class="seerr-status-pill ${st.cls}">${st.label}</span>
      </div>`;

    card.addEventListener("click", () => {
      if (media.tmdbId) openModal(media.tmdbId, media.mediaType);
    });

    return card;
  }

  /* ===============================
     SEARCH
  =============================== */
  function setupSearch() {
    const input = $("seerrSearchInput");
    if (!input) return;

    input.addEventListener("input", () => {
      clearTimeout(state.searchTimeout);
      const q = input.value.trim();

      if (q.length < 2) {
        // Retour à la vue précédente si on efface la recherche
        if (state.currentView === "search") {
          loadDiscover();
        }
        return;
      }

      state.searchTimeout = setTimeout(() => doSearch(q), 400);
    });

    input.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        input.value = "";
        if (state.currentView === "search") loadDiscover();
      }
    });
  }

  async function doSearch(query) {
    showView("search");
    setActiveNav(null);
    const grid = $("searchGrid");
    const titleEl = $("searchTitle");
    if (titleEl) titleEl.textContent = `Résultats pour "${query}"`;
    if (grid) grid.innerHTML = loadingHTML();

    try {
      const data = await apiGet("/search", { query, page: 1 });
      const results = (data.results || []).filter(r => r.mediaType === "movie" || r.mediaType === "tv");

      if (grid) {
        grid.className = "seerr-media-grid";
        buildCardRow(results, grid);
        if (results.length === 0) {
          grid.innerHTML = emptyHTML(`Aucun résultat pour "${query}"`, "Essayez avec d'autres mots");
        }
      }
    } catch (e) {
      if (grid) grid.innerHTML = emptyHTML("Erreur de recherche", e.message);
    }
  }

  /* ===============================
     MODAL - MEDIA DETAIL
  =============================== */
  async function openModal(tmdbId, mediaType) {
    const overlay = $("seerrModal");
    const body    = $("seerrModalBody");
    if (!overlay || !body) return;

    state.currentModal = { tmdbId, mediaType };
    state.selectedSeasons.clear();

    body.innerHTML = loadingHTML();
    overlay.classList.add("open");
    document.body.style.overflow = "hidden";

    try {
      const endpoint = mediaType === "movie" ? `/movie/${tmdbId}` : `/tv/${tmdbId}`;
      const data = await apiGet(endpoint);
      renderModal(data, mediaType);
    } catch (e) {
      body.innerHTML = emptyHTML("Erreur", e.message);
    }
  }

  function renderModal(data, mediaType) {
    const body = $("seerrModalBody");
    if (!body) return;

    const isTV    = mediaType === "tv";
    const title   = data.title || data.name || "Sans titre";
    const year    = yearFromDate(isTV ? data.firstAirDate : data.releaseDate);
    const runtime = data.runtime ? `${data.runtime} min` : (data.episodeRunTime?.[0] ? `~${data.episodeRunTime[0]} min/ép.` : "");
    const genres  = (data.genres || []).map(g => g.name).join(", ");
    const status  = data.mediaInfo?.status || 1;
    const st      = formatStatus(status);

    const posterUrl = tmdbImg(data.posterPath, "w342");
    const backdropUrl = tmdbImg(data.backdropPath, "w1280");

    // Seasons avec statut par saison
    const seasons = isTV ? (data.seasons || []).filter(s => s.seasonNumber > 0) : [];

    body.innerHTML = `
      <div class="seerr-modal-hero">
        ${backdropUrl
          ? `<img class="seerr-modal-backdrop" src="${backdropUrl}" alt="">`
          : `<div style="height:100%;background:var(--seerr-surface-2)"></div>`}
        <div class="seerr-modal-hero-overlay"></div>
        <div class="seerr-modal-hero-content">
          ${posterUrl ? `<img class="seerr-modal-poster" src="${posterUrl}" alt="">` : ""}
          <div class="seerr-modal-title-wrap">
            <div class="seerr-modal-type">${isTV ? "SÉRIE TÉLÉVISÉE" : "FILM"}</div>
            <h2 class="seerr-modal-title">${title}</h2>
            <div class="seerr-modal-meta">
              ${year ? `<span>${year}</span>` : ""}
              ${year && runtime ? `<span class="seerr-modal-meta-sep">·</span>` : ""}
              ${runtime ? `<span>${runtime}</span>` : ""}
              ${data.voteAverage ? `<span class="seerr-modal-meta-sep">·</span><span>⭐ ${data.voteAverage.toFixed(1)}</span>` : ""}
              ${genres ? `<span class="seerr-modal-meta-sep">·</span><span>${genres}</span>` : ""}
            </div>
          </div>
        </div>
      </div>

      <div style="padding:20px 24px">
        <div class="seerr-modal-status">
          <div class="seerr-modal-status-dot ${st.cls}"></div>
          <span><strong>Statut :</strong> ${st.label}</span>
        </div>

        ${data.overview
          ? `<p class="seerr-modal-overview">${data.overview}</p>`
          : ""}

        ${isTV && seasons.length > 0 ? buildSeasonsUI(seasons, data) : ""}

        <div class="seerr-modal-actions" id="modalActions">
          ${buildModalActions(data, isTV, status)}
        </div>

        <!-- Recommandations chargées en async après affichage du modal -->
        <div id="modalRecommendations" style="margin-top:24px"></div>
      </div>`;

    // Charger les recommandations en arrière-plan sans bloquer l'affichage
    loadModalRecommendations(data.id, mediaType);

    // Attacher les events seasons
    if (isTV) {
      $$(".seerr-season-btn").forEach(btn => {
        if (btn.dataset.available === "true") return; // déjà dispo
        btn.addEventListener("click", () => {
          const n = parseInt(btn.dataset.season);
          if (state.selectedSeasons.has(n)) {
            state.selectedSeasons.delete(n);
            btn.classList.remove("selected");
          } else {
            state.selectedSeasons.add(n);
            btn.classList.add("selected");
          }
          // Mettre à jour le bouton de demande
          updateRequestButton(data, isTV, status);
        });
      });
    }

    // Attacher les events du bouton de demande
    attachModalActions(data, isTV, status);
  }

  /* ===============================
     RECOMMANDATIONS DANS LE MODAL
     GET /movie/{id}/recommendations ou /tv/{id}/recommendations
  =============================== */
  async function loadModalRecommendations(tmdbId, mediaType) {
    const container = $("modalRecommendations");
    if (!container) return;

    try {
      const endpoint = mediaType === "movie"
        ? `/movie/${tmdbId}/recommendations`
        : `/tv/${tmdbId}/recommendations`;

      const data = await apiGet(endpoint, { page: 1 });
      const results = (data.results || []).slice(0, 12);

      if (results.length === 0) return; // Rien à afficher

      container.innerHTML = `
        <div style="margin-bottom:12px;font-size:14px;font-weight:700;color:var(--seerr-text)">
          Recommandations similaires
        </div>
        <div class="seerr-media-row" id="recoRow"></div>`;

      const row = $("recoRow");
      if (row) results.forEach(item => row.appendChild(buildCard(item)));
    } catch (_) {
      // Silencieux — les recommandations sont optionnelles
    }
  }

  function buildSeasonsUI(seasons, tvData) {
    const mediaInfo = tvData.mediaInfo || {};
    const requests  = mediaInfo.requests || [];

    const seasonStatuses = {};
    for (const r of requests) {
      (r.seasons || []).forEach(s => {
        if (!seasonStatuses[s.seasonNumber] || s.status > seasonStatuses[s.seasonNumber]) {
          seasonStatuses[s.seasonNumber] = s.status;
        }
      });
    }

    const html = seasons.map(s => {
      const sn    = s.seasonNumber;
      const avail = seasonStatuses[sn] === 5;
      const req   = seasonStatuses[sn] && seasonStatuses[sn] < 5;

      return `<button class="seerr-season-btn ${avail ? "available" : req ? "requested" : ""}"
        data-season="${sn}" data-available="${avail}">
        ${avail ? "✓ " : req ? "◐ " : ""}Saison ${sn}
      </button>`;
    }).join("");

    return `<div class="seerr-seasons">
      <div class="seerr-seasons-title">Saisons (cliquer pour sélectionner)</div>
      <div class="seerr-seasons-grid" id="seasonsGrid">${html}</div>
    </div>`;
  }

  function buildModalActions(data, isTV, status) {
    const isAvailable = status === 5;
    const isPending   = status === 2 || status === 3 || status === 4;

    if (isAvailable) {
      return `<button class="seerr-btn seerr-btn-secondary" disabled>
        ✓ Déjà disponible
      </button>`;
    }

    const btnLabel = isTV ? "Demander les saisons sélectionnées" : "Demander ce film";
    const disabled = isTV && state.selectedSeasons.size === 0 ? "disabled" : "";

    return `<button class="seerr-btn seerr-btn-primary" id="btnRequest" ${disabled}>
      🎬 ${btnLabel}
    </button>
    ${data.mediaInfo?.id ? `<button class="seerr-btn seerr-btn-secondary" id="btnMoreInfo">Voir plus d'infos</button>` : ""}`;
  }

  function updateRequestButton(data, isTV, status) {
    const actions = $("modalActions");
    if (!actions) return;
    actions.innerHTML = buildModalActions(data, isTV, status);
    attachModalActions(data, isTV, status);
  }

  function attachModalActions(data, isTV, status) {
    const btnReq = $("btnRequest");
    if (btnReq) {
      btnReq.addEventListener("click", () => submitRequest(data, isTV));
    }
  }

  async function submitRequest(data, isTV) {
    const btnReq = $("btnRequest");
    if (btnReq) {
      btnReq.disabled = true;
      btnReq.textContent = "Envoi en cours...";
    }

    try {
      const body = {
        mediaType: isTV ? "tv" : "movie",
        mediaId: data.id
      };

      if (isTV) {
        if (state.selectedSeasons.size === 0) {
          toast("Veuillez sélectionner au moins une saison", "error");
          if (btnReq) { btnReq.disabled = false; btnReq.textContent = "Demander les saisons sélectionnées"; }
          return;
        }
        body.seasons = Array.from(state.selectedSeasons);
      }

      await apiPost("/request", body);
      toast(`Demande envoyée pour "${data.title || data.name}"`, "success");
      closeModal();

      // Rafraîchir le quota
      loadUserQuota();

    } catch (e) {
      toast(`Erreur : ${e.message}`, "error");
      if (btnReq) { btnReq.disabled = false; btnReq.textContent = isTV ? "Demander les saisons sélectionnées" : "Demander ce film"; }
    }
  }

  function closeModal() {
    const overlay = $("seerrModal");
    if (overlay) overlay.classList.remove("open");
    document.body.style.overflow = "";
    state.currentModal = null;
    state.selectedSeasons.clear();
  }

  /* ===============================
     VIEW NAVIGATION
  =============================== */
  function showView(name) {
    state.currentView = name;
    $$(".seerr-view").forEach(el => el.classList.remove("active"));
    const view = $("view-" + name);
    if (view) view.classList.add("active");
  }

  function setActiveNav(id) {
    $$(".seerr-nav-item").forEach(el => el.classList.remove("active"));
    if (id) {
      const el = $(id);
      if (el) el.classList.add("active");
    }
  }

  /* ===============================
     SIDEBAR MOBILE
  =============================== */
  function setupMobileSidebar() {
    const burger  = $("seerrBurger");
    const sidebar = $("seerrSidebar");
    const overlay = $("sidebarOverlay");

    if (!burger || !sidebar || !overlay) return;

    burger.addEventListener("click", () => {
      sidebar.classList.toggle("open");
      overlay.classList.toggle("open");
    });

    overlay.addEventListener("click", () => {
      sidebar.classList.remove("open");
      overlay.classList.remove("open");
    });
  }

  /* ===============================
     NAV EVENTS
  =============================== */
  function setupNav() {
    const navMap = {
      "nav-discover":  loadDiscover,
      "nav-movies":    loadMovies,
      "nav-tv":        loadTV,
      "nav-requests":  () => loadRequests("all"),
    };

    Object.entries(navMap).forEach(([id, fn]) => {
      const el = $(id);
      if (el) el.addEventListener("click", () => {
        fn();
        // Fermer le menu mobile si ouvert
        $("seerrSidebar")?.classList.remove("open");
        $("sidebarOverlay")?.classList.remove("open");
      });
    });

    // Filtres de demandes
    $$(".seerr-filter-btn").forEach(btn => {
      btn.addEventListener("click", () => loadRequests(btn.dataset.filter));
    });
  }

  /* ===============================
     MODAL EVENTS
  =============================== */
  function setupModal() {
    const overlay = $("seerrModal");
    const closeBtn = $("seerrModalClose");

    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    if (overlay) {
      overlay.addEventListener("click", e => {
        if (e.target === overlay) closeModal();
      });
    }

    document.addEventListener("keydown", e => {
      if (e.key === "Escape") closeModal();
    });
  }

  /* ===============================
     INIT
  =============================== */
  async function init() {
    setupNav();
    setupModal();
    setupSearch();
    setupMobileSidebar();

    // Charger les données utilisateur + quota
    await loadUserQuota();

    // Charger la vue découvrir par défaut
    await loadDiscover();
  }

  // Lancer au chargement du DOM
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
