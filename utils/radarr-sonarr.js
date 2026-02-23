const fetch = require('node-fetch');

/**
 * Génère une URL TMDB pour un poster (films Radarr)
 * @param {string|null} posterPath - Chemin du poster depuis TMDB (ex: /abc123def.jpg ou URL TMDB complète)
 * @returns {string|null} - URL TMDB complète optimisée ou null
 */
function getTmdbPosterUrl(posterPath) {
  if (!posterPath) return null;
  // Si c'est une URL TMDB complète, la redimensionner (original → w342 pour optimiser)
  if (posterPath.includes('image.tmdb.org')) {
    return posterPath.replace('/t/p/original/', '/t/p/w342/');
  }
  // Si c'est une autre URL externe, la retourner telle quelle
  if (posterPath.startsWith('http://') || posterPath.startsWith('https://')) return posterPath;
  // Construire l'URL TMDB (largeur 342px pour mobile/desktop)
  return `https://image.tmdb.org/t/p/w342${posterPath}`;
}

/**
 * Génère une URL TVDB pour un poster (séries Sonarr)
 * @param {string|null} posterPath - Chemin du poster depuis TVDB (ex: /MediaCover/123/poster.jpg ou URL TVDB complète)
 * @returns {string|null} - URL TVDB complète ou null
 */
function getTvdbPosterUrl(posterPath) {
  if (!posterPath) return null;
  // Si c'est une URL externe, la retourner telle quelle (mais enlever les query params CORS restrictifs)
  if (posterPath.startsWith('http://') || posterPath.startsWith('https://')) {
    return posterPath.split('?')[0]; // Enlever les query params (ex: ?lastWrite=...)
  }
  // Construire l'URL TVDB (CDN artworks)
  return `https://artworks.thetvdb.com${posterPath.split('?')[0]}`; // Enlever query params si présents
}

/**
 * Récupère les films de Radarr pour une plage de dates.
 * @param {string} radarrUrl  - URL Radarr interne (ex: http://radarr:7878)
 * @param {string} apiKey     - Clé API Radarr
 * @param {string} start      - Date de début ISO (YYYY-MM-DD)
 * @param {string} end        - Date de fin ISO (YYYY-MM-DD)
 * @returns {Promise<Array>}  - Liste d'events normalisés
 */
async function getRadarrCalendar(radarrUrl, apiKey, start, end) {
  if (!radarrUrl || !apiKey) return [];

  try {
    const baseUrl = radarrUrl.replace(/\/$/, '');
    const url = `${baseUrl}/api/v3/calendar?start=${start}&end=${end}&unmonitored=false`;
    const resp = await fetch(url, {
      headers: {
        'X-Api-Key': apiKey,
        'Accept': 'application/json'
      }
    });

    if (!resp.ok) throw new Error(`Radarr calendar HTTP ${resp.status}`);

    const movies = await resp.json();
    return movies
      .map(m => ({
        id: `radarr-${m.id}`,
        type: 'movie',
        title: m.title,
        subtitle: null,
        date: (m.digitalRelease || m.physicalRelease || m.inCinemas || '').slice(0, 10),
        runtime: m.runtime || 0,
        available: !!m.hasFile,
        thumb: getTmdbPosterUrl(m.images?.find(img => img.coverType === 'poster')?.remoteUrl),
        year: m.year || null,
        source: 'radarr'
      }))
      .filter(e => e.date);  // Filtrer les events sans date
  } catch (err) {
    throw new Error(`getRadarrCalendar: ${err.message}`);
  }
}

/**
 * Récupère les épisodes de Sonarr pour une plage de dates.
 * @param {string} sonarrUrl  - URL Sonarr interne (ex: http://sonarr:8989)
 * @param {string} apiKey     - Clé API Sonarr
 * @param {string} start      - Date de début ISO (YYYY-MM-DD)
 * @param {string} end        - Date de fin ISO (YYYY-MM-DD)
 * @returns {Promise<Array>}  - Liste d'events normalisés
 */
async function getSonarrCalendar(sonarrUrl, apiKey, start, end) {
  if (!sonarrUrl || !apiKey) return [];

  try {
    const baseUrl = sonarrUrl.replace(/\/$/, '');

    // 1️⃣ Récupérer TOUTES les séries une fois pour construire un map seriesId → seriesTitle
    const seriesResp = await fetch(`${baseUrl}/api/v3/series`, {
      headers: {
        'X-Api-Key': apiKey,
        'Accept': 'application/json'
      }
    });

    if (!seriesResp.ok) throw new Error(`Sonarr series HTTP ${seriesResp.status}`);

    const allSeries = await seriesResp.json();
    const seriesMap = {};
    allSeries.forEach(s => {
      seriesMap[s.id] = {
        title: s.title,
        runtime: s.runtime || 0,
        thumb: getTvdbPosterUrl(s.images?.find(img => img.coverType === 'poster')?.remoteUrl || s.images?.find(img => img.coverType === 'poster')?.url)
      };
    });

    // 2️⃣ Récupérer le calendrier avec les dates
    const calendarResp = await fetch(`${baseUrl}/api/v3/calendar?start=${start}&end=${end}&unmonitored=false`, {
      headers: {
        'X-Api-Key': apiKey,
        'Accept': 'application/json'
      }
    });

    if (!calendarResp.ok) throw new Error(`Sonarr calendar HTTP ${calendarResp.status}`);

    const episodes = await calendarResp.json();

    // 3️⃣ Mapper les épisodes avec les infos de série
    return episodes
      .map(ep => ({
        id: `sonarr-${ep.id}`,
        type: 'episode',
        title: seriesMap[ep.seriesId]?.title || 'Série inconnue',
        subtitle: `S${String(ep.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')} - ${ep.title || 'TBA'}`,
        date: (ep.airDate || '').slice(0, 10),
        runtime: seriesMap[ep.seriesId]?.runtime || 0,
        available: !!ep.hasFile,
        thumb: seriesMap[ep.seriesId]?.thumb || null,
        source: 'sonarr'
      }))
      .filter(e => e.date);  // Filtrer les events sans date
  } catch (err) {
    throw new Error(`getSonarrCalendar: ${err.message}`);
  }
}

module.exports = { getRadarrCalendar, getSonarrCalendar };
