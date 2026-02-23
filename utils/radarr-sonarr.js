const fetch = require('node-fetch');

/**
 * Récupère les films de Radarr pour une plage de dates.
 * @param {string} radarrUrl  - URL Radarr (ex: http://radarr:7878)
 * @param {string} apiKey     - Clé API Radarr
 * @param {string} start      - Date de début ISO (YYYY-MM-DD)
 * @param {string} end        - Date de fin ISO (YYYY-MM-DD)
 * @returns {Promise<Array>}  - Liste d'events normalisés
 */
async function getRadarrCalendar(radarrUrl, apiKey, start, end) {
  if (!radarrUrl || !apiKey) return [];

  try {
    const url = `${radarrUrl.replace(/\/$/, '')}/api/v3/calendar?start=${start}&end=${end}&unmonitored=false`;
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
        thumb: m.images?.find(img => img.coverType === 'poster')?.url || null,
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
 * @param {string} sonarrUrl  - URL Sonarr (ex: http://sonarr:8989)
 * @param {string} apiKey     - Clé API Sonarr
 * @param {string} start      - Date de début ISO (YYYY-MM-DD)
 * @param {string} end        - Date de fin ISO (YYYY-MM-DD)
 * @returns {Promise<Array>}  - Liste d'events normalisés
 */
async function getSonarrCalendar(sonarrUrl, apiKey, start, end) {
  if (!sonarrUrl || !apiKey) return [];

  try {
    const url = `${sonarrUrl.replace(/\/$/, '')}/api/v3/calendar?start=${start}&end=${end}&unmonitored=false`;
    const resp = await fetch(url, {
      headers: {
        'X-Api-Key': apiKey,
        'Accept': 'application/json'
      }
    });

    if (!resp.ok) throw new Error(`Sonarr calendar HTTP ${resp.status}`);

    const episodes = await resp.json();
    return episodes
      .map(ep => ({
        id: `sonarr-${ep.id}`,
        type: 'episode',
        title: ep.series?.title || 'Série inconnue',
        subtitle: `S${String(ep.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')} - ${ep.title || 'TBA'}`,
        date: (ep.airDate || '').slice(0, 10),
        runtime: ep.series?.runtime || 0,
        available: !!ep.hasFile,
        thumb: ep.series?.images?.find(img => img.coverType === 'poster')?.url || null,
        source: 'sonarr'
      }))
      .filter(e => e.date);  // Filtrer les events sans date
  } catch (err) {
    throw new Error(`getSonarrCalendar: ${err.message}`);
  }
}

module.exports = { getRadarrCalendar, getSonarrCalendar };
