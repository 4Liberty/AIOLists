// src/utils/getLogo.js
const FanartTvApi = require("fanart.tv-api");
const { MovieDb } = require("moviedb-promise");

const FANART_API_KEY = process.env.FANART_API_KEY ? process.env.FANART_API_KEY.trim() : null;
const TMDB_API_KEY = process.env.TMDB_API_KEY ? process.env.TMDB_API_KEY.trim() : null;

console.log(`[DEBUG] Read FANART_API_KEY: ${FANART_API_KEY ? 'found a key' : 'not found'}`);
console.log(`[DEBUG] Read TMDB_API_KEY: ${TMDB_API_KEY ? 'found a key' : 'not found'}`);

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

let moviedb = null;
if (TMDB_API_KEY) {
    try {
        moviedb = new MovieDb(TMDB_API_KEY);
        console.log("TMDB client (moviedb-promise) initialized successfully.");
    } catch (e) {
        console.error("ERROR: Failed to initialize moviedb-promise with TMDB_API_KEY:", e.message);
    }
} else {
    console.warn("WARNING: TMDB_API_KEY is not set for moviedb-promise. TMDB logo fallback may be limited.");
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
  if (!fanart || !tvdb_id) {
    return '';
  }

  try {
    const fanartRes = await fanart.getShowImages(tvdb_id).then(res => res.hdtvlogo || []).catch(() => []);
    const fanartLogos = fanartRes.map(l => ({ url: l.url, lang: l.lang || 'en' }));

    if (fanartLogos.length === 0) return '';
    const picked = pickLogo(fanartLogos, language, originalLanguage);
    return picked?.url || '';
  } catch (error) {
    console.error("Error fetching TV show logo from Fanart.tv:", error.message);
    return '';
  }
}

module.exports = { getLogo, getTvLogo };
