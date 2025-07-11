// src/utils/getFanartImages.js
const FanartTvApi = require("fanart.tv-api");
const axios = require("axios");
const { TMDB_BEARER_TOKEN } = require("../config");

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
  console.warn("WARNING: FANART_API_KEY is not set. Fanart.tv images will be unavailable.");
}

// Helper to pick the best image based on language
function pickBestImage(images, language, originalLanguage) {
  if (!images || images.length === 0) return null;
  const lang = language.split("-")[0];
  return (
    images.find(i => i.lang === lang) ||
    images.find(i => i.lang === originalLanguage) ||
    images.find(i => i.lang === "en") ||
    images[0]
  );
}

// Fetches all relevant images for a movie from Fanart.tv
async function getMovieFanart(tmdbId, language, originalLanguage) {
  if (!fanart || !tmdbId) return {};

  try {
    const res = await fanart.getMovieImages(tmdbId);
    const logo = pickBestImage(res.hdmovielogo, language, originalLanguage)?.url;
    const background = pickBestImage(res.moviebackground, language, originalLanguage)?.url;
    const poster = pickBestImage(res.movieposter, language, originalLanguage)?.url;
    return { logo, background, poster };
  } catch (error) {
    if (error.message.includes('404')) {
        // This is a normal occurrence for items not found on Fanart.tv
    } else {
        console.error(`Error fetching movie fanart for tmdbId: ${tmdbId}:`, error.message);
    }
    return {};
  }
}

// Fetches all relevant images for a series from Fanart.tv
async function getSeriesFanart(tvdbId, tmdbId, language, originalLanguage) {
  let finalTvdbId = tvdbId;

  // Fallback to fetch tvdb_id from TMDB if it's missing
  if (!finalTvdbId && tmdbId && (process.env.TMDB_BEARER_TOKEN || TMDB_BEARER_TOKEN)) {
    try {
      const token = process.env.TMDB_BEARER_TOKEN || TMDB_BEARER_TOKEN;
      const response = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`, {
        headers: { 'accept': 'application/json', 'Authorization': `Bearer ${token}` },
        timeout: 3000
      });
      if (response.data?.tvdb_id) {
        finalTvdbId = response.data.tvdb_id;
      }
    } catch (error) {
      console.warn(`[Fanart] Could not fetch tvdb_id for tmdbId: ${tmdbId}.`, error.message);
    }
  }

  if (!fanart || !finalTvdbId) return {};

  try {
    const res = await fanart.getShowImages(finalTvdbId);
    const logo = pickBestImage(res.hdtvlogo, language, originalLanguage)?.url;
    const background = pickBestImage(res.showbackground, language, originalLanguage)?.url;
    const poster = pickBestImage(res.tvposter, language, originalLanguage)?.url;
    return { logo, background, poster };
  } catch (error) {
     if (error.message.includes('404')) {
        // This is a normal occurrence for items not found on Fanart.tv
    } else {
        console.error(`Error fetching series fanart for tvdb_id: ${finalTvdbId}:`, error.message);
    }
    return {};
  }
}

module.exports = { getMovieFanart, getSeriesFanart };
