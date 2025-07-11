// src/utils/getLogo.js
const FanartTvApi = require("fanart.tv-api");
const axios = require("axios");
const { TMDB_BEARER_TOKEN } = require("../config");

// Directly access and clean the environment variables
const FANART_API_KEY = process.env.FANART_API_KEY ? process.env.FANART_API_KEY.trim() : null;

let fanart = null;
if (FANART_API_KEY) {
  try {
    fanart = new FanartTvApi({ apiKey: FANART_API_KEY });
    console.log("Fanart.tv API client initialized successfully.");
  } catch (e) {
    console.error("ERROR: Failed to initialize Fanart.tv API client:", e.message);
  }
} else {
  console.warn("WARNING: FANART_API_KEY is not set. Fanart.tv logos will be unavailable.");
}

function pickLogo(logos, language, originalLanguage) {
  const lang = language.split("-")[0];
  return (
    logos.find(l => l.lang === lang) ||
    logos.find(l => l.lang === originalLanguage) ||
    logos.find(l => l.lang === "en") ||
    logos[0]
  );
}

async function getLogo(tmdbId, language, originalLanguage) {
  if (!fanart || !tmdbId) {
    return '';
  }

  try {
    const fanartRes = await fanart.getMovieImages(tmdbId).then(res => res.hdmovielogo || []).catch(() => []);
    const fanartLogos = fanartRes.map(l => ({ url: l.url, lang: l.lang || 'en' }));

    if (fanartLogos.length === 0) return '';
    const picked = pickLogo(fanartLogos, language, originalLanguage);
    return picked?.url || '';
  } catch (error) {
    console.error("Error fetching movie logo from Fanart.tv:", error.message);
    return '';
  }
}

async function getTvLogo(tvdb_id, tmdbId, language, originalLanguage) {
  let finalTvdbId = tvdb_id;

  // If tvdb_id is missing but tmdbId is available, try to fetch it from TMDB as a fallback.
  // This makes the function more robust.
  if (!finalTvdbId && tmdbId && (process.env.TMDB_BEARER_TOKEN || TMDB_BEARER_TOKEN)) {
    try {
      const token = process.env.TMDB_BEARER_TOKEN || TMDB_BEARER_TOKEN;
      console.log(`[getTvLogo] Missing tvdb_id for tmdbId: ${tmdbId}. Fetching from TMDB.`);
      const response = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`, {
        headers: {
          'accept': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        timeout: 3000 // Use a short timeout
      });
      if (response.data?.tvdb_id) {
        finalTvdbId = response.data.tvdb_id;
        console.log(`[getTvLogo] Found tvdb_id: ${finalTvdbId} for tmdbId: ${tmdbId}.`);
      }
    } catch (error) {
      // It's okay if this fails, we just won't have a logo.
      console.warn(`[getTvLogo] Could not fetch external_ids for tmdbId: ${tmdbId}.`, error.message);
    }
  }

  if (!fanart || !finalTvdbId) {
    return '';
  }

  try {
    const fanartRes = await fanart.getShowImages(finalTvdbId).then(res => res.hdtvlogo || []).catch(() => []);
    const fanartLogos = fanartRes.map(l => ({ url: l.url, lang: l.lang || 'en' }));

    if (fanartLogos.length === 0) return '';
    const picked = pickLogo(fanartLogos, language, originalLanguage);
    return picked?.url || '';
  } catch (error) {
    console.error(`Error fetching TV show logo from Fanart.tv for tvdb_id: ${finalTvdbId}:`, error.message);
    return '';
  }
}

module.exports = { getLogo, getTvLogo };
