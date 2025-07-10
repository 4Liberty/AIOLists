// src/utils/getLogo.js
// Do not use dotenv here; Heroku provides environment variables directly.
const FanartTvApi = require("fanart.tv-api");
const { MovieDb } = require("moviedb-promise");

// --- START OF FIX ---
// Directly access and clean the environment variables
const FANART_API_KEY = process.env.FANART_API_KEY ? process.env.FANART_API_KEY.trim() : null;
const TMDB_API_KEY = process.env.TMDB_API_KEY ? process.env.TMDB_API_KEY.trim() : null;

// Add extra logging to see what the application is reading
console.log(`[DEBUG] Read FANART_API_KEY: ${FANART_API_KEY ? 'found a key' : 'not found'}`);
console.log(`[DEBUG] Read TMDB_API_KEY: ${TMDB_API_KEY ? 'found a key' : 'not found'}`);

let fanart = null;
if (FANART_API_KEY) {
  try {
    fanart = new FanartTvApi({ api_key: FANART_API_KEY });
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
// --- END OF FIX ---

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
  const promises = [];

  if (fanart && tmdbId) {
    promises.push(
      fanart.getMovieImages(tmdbId).then(res => res.hdmovielogo || []).catch(() => [])
    );
  } else {
    promises.push(Promise.resolve([]));
  }

  if (moviedb && tmdbId) {
    promises.push(
      moviedb.movieImages({ id: tmdbId }).then(res => res.logos || []).catch(() => [])
    );
  } else {
    promises.push(Promise.resolve([]));
  }

  const [fanartRes, tmdbRes] = await Promise.all(promises);
  const fanartLogos = fanartRes.map(l => ({ url: l.url, lang: l.lang || 'en', source: 'fanart' }));
  const tmdbLogos = tmdbRes.map(l => ({ url: `https://image.tmdb.org/t/p/original${l.file_path}`, lang: l.iso_639_1 || 'en', source: 'tmdb' }));
  const combined = [...fanartLogos, ...tmdbLogos];

  if (combined.length === 0) return '';
  const picked = pickLogo(combined, language, originalLanguage);
  return picked?.url || '';
}

async function getTvLogo(tvdb_id, tmdbId, language, originalLanguage) {
  const promises = [];

  if (fanart && tvdb_id) {
    promises.push(
      fanart.getShowImages(tvdb_id).then(res => res.hdtvlogo || []).catch(() => [])
    );
  } else {
    promises.push(Promise.resolve([]));
  }

  if (moviedb && tmdbId) {
    promises.push(
      moviedb.tvImages({ id: tmdbId }).then(res => res.logos || []).catch(() => [])
    );
  } else {
    promises.push(Promise.resolve([]));
  }

  const [fanartRes, tmdbRes] = await Promise.all(promises);
  const fanartLogos = fanartRes.map(l => ({ url: l.url, lang: l.lang || 'en', source: 'fanart' }));
  const tmdbLogos = tmdbRes.map(l => ({ url: `https://image.tmdb.org/t/p/original${l.file_path}`, lang: l.iso_639_1 || 'en', source: 'tmdb' }));
  const combined = [...fanartLogos, ...tmdbLogos];

  if (combined.length === 0) return '';
  const picked = pickLogo(combined, language, originalLanguage);
  return picked?.url || '';
}

module.exports = { getLogo, getTvLogo };
