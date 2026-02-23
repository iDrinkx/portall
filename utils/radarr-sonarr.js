const fetch = require('node-fetch');

/**
 * Convertit une URL relative en URL absolue en utilisant le baseUrl public ou serveur
 * @param {string|null} url - URL relative ou absolue
 * @param {string} baseUrl - URL de base interne (ex: http://sonarr:8989)
 * @param {string|null} publicUrl - URL publique accessible au client (ex: https://sonarr.example.com)
 * @returns {string|null} - URL absolue ou null
 */
function makeAbsoluteUrl(url, baseUrl, publicUrl) {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  // Utiliser l'URL publique si disponible, sinon l'URL du serveur
  const targetUrl = publicUrl || baseUrl;
  return `${targetUrl}${url}`;
}

/**
 * Récupère les films de Radarr pour une plage de dates.
 * @param {string} radarrUrl  - URL Radarr interne (ex: http://radarr:7878)
 * @param {string} apiKey     - Clé API Radarr
 * @param {string} start      - Date de début ISO (YYYY-MM-DD)
 * @param {string} end        - Date de fin ISO (YYYY-MM-DD)
 * @param {string} publicUrl  - URL publique Radarr accessible au client (optionnel)
 * @returns {Promise<Array>}  - Liste d'events normalisés
 */
async function getRadarrCalendar(radarrUrl, apiKey, start, end, publicUrl) {
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
        thumb: makeAbsoluteUrl(m.images?.find(img => img.coverType === 'poster')?.url, baseUrl, publicUrl),
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
 * @param {string} publicUrl  - URL publique Sonarr accessible au client (optionnel)
 * @returns {Promise<Array>}  - Liste d'events normalisés
 */
async function getSonarrCalendar(sonarrUrl, apiKey, start, end, publicUrl) {
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
        thumb: makeAbsoluteUrl(s.images?.find(img => img.coverType === 'poster')?.url, baseUrl, publicUrl)
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
