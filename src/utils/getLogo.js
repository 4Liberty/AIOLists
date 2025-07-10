// src/utils/getLogo.js
const FanartTvApi = require("fanart.tv-api");
const { MovieDb } = require("moviedb-promise");

// Directly access environment variables
const FANART_API_KEY = process.env.FANART_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY; // This is the v3 key for moviedb-promise

let fanart;
if (FANART_API_KEY) {
  try {
    fanart = new FanartTvApi(FANART_API_KEY);
    console.log("Fanart.tv API client initialized.");
  } catch (e) {
    console.error("Failed to initialize Fanart.tv API client:", e.message);
    fanart = null; // Ensure fanart is null if initialization fails
  }
} else {
  console.warn("FANART_API_KEY is not set. Fanart.tv logos will be unavailable.");
}

let moviedb;
if (TMDB_API_KEY) {
  try {
    moviedb = new MovieDb(TMDB_API_KEY);
    console.log("TMDB client (moviedb-promise) initialized for logo fetching.");
  } catch (e) {
    console.error("Failed to initialize moviedb-promise with TMDB_API_KEY:", e.message);
    moviedb = null; // Ensure moviedb is null if initialization fails
  }
} else {
  console.warn("TMDB_API_KEY is not set for moviedb-promise. TMDB logo fallback may be limited.");
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
