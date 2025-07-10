// src/utils/getLogo.js
require('dotenv').config();
const FanartTvApi = require("fanart.tv-api");
const { MovieDb } = require("moviedb-promise");

// Get API keys from environment variables
const FANART_API_KEY = process.env.FANART_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY; // Use TMDB_API_KEY

// Initialize APIs only if the keys are provided
let fanart;
if (FANART_API_KEY) {
  fanart = new FanartTvApi(FANART_API_KEY);
  console.log("Fanart.tv API client initialized.");
} else {
  console.warn("Fanart.tv API key is not defined. Logo fetching from Fanart.tv will be disabled.");
}

let moviedb;
if (TMDB_API_KEY) {
  moviedb = new MovieDb(TMDB_API_KEY);
  console.log("TMDB client (moviedb-promise) initialized for logo fetching.");
} else {
  console.warn("TMDB_API_KEY is not defined. TMDB logo fallback may be limited.");
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
  // Return early if the Fanart API key is missing or no tmdbId is provided
  if (!fanart || !tmdbId) {
    return '';
  }

  const fanartPromise = fanart
    .getMovieImages(tmdbId)
    .then(res => res.hdmovielogo || [])
    .catch(() => []);

  const tmdbPromise = moviedb ? moviedb
    .movieImages({ id: tmdbId })
    .then(res => res.logos || [])
    .catch(() => []) : Promise.resolve([]);

  const [fanartRes, tmdbRes] = await Promise.all([fanartPromise, tmdbPromise]);

  const fanartLogos = fanartRes.map(l => ({
    url: l.url,
    lang: l.lang || 'en',
    source: 'fanart'
  }));

  const tmdbLogos = tmdbRes.map(l => ({
    url: `https://image.tmdb.org/t/p/original${l.file_path}`,
    lang: l.iso_639_1 || 'en',
    source: 'tmdb'
  }));

  const combined = [...fanartLogos, ...tmdbLogos];

  if (combined.length === 0) return '';

  const picked = pickLogo(combined, language, originalLanguage);
  return picked?.url || '';
}

async function getTvLogo(tvdb_id, tmdbId, language, originalLanguage) {
  // Return early if Fanart API is not initialized or no IDs are provided
  if (!fanart || (!tvdb_id && !tmdbId)) {
    return '';
  }

  const fanartPromise = tvdb_id
    ? fanart
        .getShowImages(tvdb_id)
        .then(res => res.hdtvlogo || [])
        .catch(() => [])
    : Promise.resolve([]);

  const tmdbPromise = (moviedb && tmdbId)
    ? moviedb
        .tvImages({ id: tmdbId })
        .then(res => res.logos || [])
        .catch(() => [])
    : Promise.resolve([]);

  const [fanartRes, tmdbRes] = await Promise.all([fanartPromise, tmdbPromise]);

  const fanartLogos = fanartRes.map(l => ({
    url: l.url,
    lang: l.lang || 'en',
    source: 'fanart'
  }));

  const tmdbLogos = tmdbRes.map(l => ({
    url: `https://image.tmdb.org/t/p/original${l.file_path}`,
    lang: l.iso_639_1 || 'en',
    source: 'tmdb'
  }));

  const combined = [...fanartLogos, ...tmdbLogos];

  if (combined.length === 0) return '';

  const picked = pickLogo(combined, language, originalLanguage);
  return picked?.url || '';
}

module.exports = { getLogo, getTvLogo };
