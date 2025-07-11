// src/integrations/tmdb.js
// ... (The file content is the same as the previous version, but I'll include it fully for you)
const axios = require('axios');
const Cache = require('../utils/cache');
const { ITEMS_PER_PAGE, TMDB_REDIRECT_URI, TMDB_BEARER_TOKEN, TMDB_CONCURRENT_REQUESTS } = require('../config');
const { getLogo, getTvLogo } = require('../utils/getFanartImages'); // Corrected import

const tmdbCache = new Cache({ defaultTTL: 24 * 3600 * 1000 });
const imdbToTmdbCache = new Cache({ defaultTTL: 7 * 24 * 3600 * 1000 });
const TMDB_BASE_URL_V3 = 'https://api.themoviedb.org/3';
const TMDB_REQUEST_TIMEOUT = 15000;
const DEFAULT_TMDB_BEARER_TOKEN = TMDB_BEARER_TOKEN;

async function batchConvertImdbToTmdbIds(imdbIds, userBearerToken = DEFAULT_TMDB_BEARER_TOKEN) {
  if (!imdbIds?.length) return {};
  const results = {};
  const uncachedIds = [];
  for (const imdbId of imdbIds) {
    const cacheKey = `imdb_to_tmdb_${imdbId}`;
    const cachedResult = imdbToTmdbCache.get(cacheKey);
    if (cachedResult) {
      results[imdbId] = cachedResult === 'null' ? null : cachedResult;
    } else {
      uncachedIds.push(imdbId);
    }
  }
  if (uncachedIds.length === 0) return results;
  const CONCURRENCY_LIMIT = TMDB_CONCURRENT_REQUESTS || 15;
  const chunks = [];
  for (let i = 0; i < uncachedIds.length; i += CONCURRENCY_LIMIT) {
    chunks.push(uncachedIds.slice(i, i + CONCURRENCY_LIMIT));
  }
  for (const chunk of chunks) {
    const chunkPromises = chunk.map(async (imdbId) => {
      try {
        const result = await convertImdbToTmdbId(imdbId, userBearerToken);
        return { imdbId, result };
      } catch (error) {
        console.error(`Error converting IMDB ID ${imdbId}:`, error.message);
        return { imdbId, result: null };
      }
    });
    const chunkResults = await Promise.all(chunkPromises);
    chunkResults.forEach(({ imdbId, result }) => {
      results[imdbId] = result;
    });
    // REMOVED DELAY
  }
  return results;
}

// ... (The rest of the functions in this file remain the same as the version you received)
async function createTmdbRequestToken(userBearerToken) {
  if (!userBearerToken) throw new Error('TMDB Bearer Token is required');
  try {
    const response = await axios.get(`${TMDB_BASE_URL_V3}/authentication/token/new`, { headers: { 'accept': 'application/json', 'Authorization': `Bearer ${userBearerToken}` }, timeout: TMDB_REQUEST_TIMEOUT });
    if (response.data && response.data.success) {
      const baseAuthUrl = `https://www.themoviedb.org/authenticate/${response.data.request_token}`;
      const authUrl = TMDB_REDIRECT_URI ? `${baseAuthUrl}?redirect_to=${encodeURIComponent(TMDB_REDIRECT_URI)}` : baseAuthUrl;
      return { success: true, requestToken: response.data.request_token, expiresAt: response.data.expires_at, authUrl: authUrl };
    }
    throw new Error('Failed to create TMDB request token');
  } catch (error) {
    console.error('Error creating TMDB request token:', error.message);
    throw new Error(`Failed to create TMDB request token: ${error.message}`);
  }
}

async function createTmdbSession(requestToken, userBearerToken) {
  if (!userBearerToken) throw new Error('TMDB Bearer Token is required');
  try {
    const response = await axios.post(`${TMDB_BASE_URL_V3}/authentication/session/new`, { request_token: requestToken }, { headers: { 'accept': 'application/json', 'content-type': 'application/json', 'Authorization': `Bearer ${userBearerToken}` }, timeout: TMDB_REQUEST_TIMEOUT });
    if (response.data && response.data.success) return { success: true, sessionId: response.data.session_id };
    throw new Error('Failed to create TMDB session');
  } catch (error) {
    console.error('Error creating TMDB session:', error.message);
    throw new Error(`Failed to create TMDB session: ${error.message}`);
  }
}

async function getTmdbAccountDetails(sessionId, userBearerToken) {
  if (!userBearerToken) throw new Error('TMDB Bearer Token is required');
  try {
    const response = await axios.get(`${TMDB_BASE_URL_V3}/account`, { params: { session_id: sessionId }, headers: { 'accept': 'application/json', 'Authorization': `Bearer ${userBearerToken}` }, timeout: TMDB_REQUEST_TIMEOUT });
    return response.data;
  } catch (error) {
    console.error('Error getting TMDB account details:', error.message);
    throw new Error(`Failed to get TMDB account details: ${error.message}`);
  }
}

async function getTmdbAuthUrl(userBearerToken) {
  return await createTmdbRequestToken(userBearerToken);
}

async function authenticateTmdb(requestToken, userBearerToken) {
  const sessionData = await createTmdbSession(requestToken, userBearerToken);
  const accountData = await getTmdbAccountDetails(sessionData.sessionId, userBearerToken);
  return { sessionId: sessionData.sessionId, accountId: accountData.id, username: accountData.username, name: accountData.name };
}

async function fetchTmdbLists(userConfig) {
  if (!userConfig.tmdbSessionId || !userConfig.tmdbAccountId) return { isConnected: false, lists: [], addons: [], message: 'TMDB not connected.' };
  try {
    const listsResponse = await axios.get(`${TMDB_BASE_URL_V3}/account/${userConfig.tmdbAccountId}/lists`, { params: { session_id: userConfig.tmdbSessionId, page: 1 }, headers: { 'accept': 'application/json', 'Authorization': `Bearer ${userConfig.tmdbBearerToken || DEFAULT_TMDB_BEARER_TOKEN}` }, timeout: TMDB_REQUEST_TIMEOUT });
    const userLists = listsResponse.data?.results || [];
    const specialLists = [{ id: 'tmdb_watchlist', name: 'TMDB Watchlist', isTmdbWatchlist: true, description: 'Your TMDB watchlist' }, { id: 'tmdb_favorites', name: 'TMDB Favorites', isTmdbFavorites: true, description: 'Your TMDB favorites' }];
    const allLists = [...specialLists, ...userLists.map(list => ({ id: `tmdb_list_${list.id}`, name: list.name, description: list.description, tmdbListId: list.id, isTmdbList: true, itemCount: list.item_count }))];
    return { isConnected: true, lists: allLists, addons: [], message: `TMDB connected. Found ${allLists.length} lists.` };
  } catch (error) {
    console.error('Error fetching TMDB lists:', error.message);
    return { isConnected: true, lists: [], addons: [], message: 'TMDB connected but failed to fetch lists.' };
  }
}

async function fetchTmdbListItems(listId, userConfig, skip = 0, sortBy = 'created_at', sortOrder = 'desc', genre = null) {
  if (!userConfig.tmdbSessionId || !userConfig.tmdbAccountId) return null;
  const limit = ITEMS_PER_PAGE;
  const page = Math.floor(skip / limit) + 1;
  try {
    let apiUrl;
    let params = { session_id: userConfig.tmdbSessionId, page: page, language: userConfig.tmdbLanguage || 'en-US' };
    const headers = { 'accept': 'application/json', 'Authorization': `Bearer ${userConfig.tmdbBearerToken || DEFAULT_TMDB_BEARER_TOKEN}` };
    if (listId === 'tmdb_watchlist') {
      const [moviesResponse, tvResponse] = await Promise.all([
        axios.get(`${TMDB_BASE_URL_V3}/account/${userConfig.tmdbAccountId}/watchlist/movies`, { headers, params, timeout: TMDB_REQUEST_TIMEOUT }),
        axios.get(`${TMDB_BASE_URL_V3}/account/${userConfig.tmdbAccountId}/watchlist/tv`, { headers, params, timeout: TMDB_REQUEST_TIMEOUT })
      ]);
      const allItems = [...(moviesResponse.data?.results || []).map(item => ({ ...item, media_type: 'movie' })), ...(tvResponse.data?.results || []).map(item => ({ ...item, media_type: 'tv' }))];
      return processListItems(allItems, userConfig, genre);
    } else if (listId === 'tmdb_favorites') {
      const [moviesResponse, tvResponse] = await Promise.all([
        axios.get(`${TMDB_BASE_URL_V3}/account/${userConfig.tmdbAccountId}/favorite/movies`, { headers, params, timeout: TMDB_REQUEST_TIMEOUT }),
        axios.get(`${TMDB_BASE_URL_V3}/account/${userConfig.tmdbAccountId}/favorite/tv`, { headers, params, timeout: TMDB_REQUEST_TIMEOUT })
      ]);
      const allItems = [...(moviesResponse.data?.results || []).map(item => ({ ...item, media_type: 'movie' })), ...(tvResponse.data?.results || []).map(item => ({ ...item, media_type: 'tv' }))];
      return processListItems(allItems, userConfig, genre);
    } else if (listId.startsWith('tmdb_list_')) {
      const tmdbListId = listId.replace('tmdb_list_', '');
      apiUrl = `${TMDB_BASE_URL_V3}/list/${tmdbListId}`;
      const response = await axios.get(apiUrl, { headers, params, timeout: TMDB_REQUEST_TIMEOUT });
      return processListItems(response.data?.items || [], userConfig, genre);
    } else {
      return null;
    }
  } catch (error) {
    console.error(`Error fetching TMDB list ${listId}:`, error.message);
    return null;
  }
}

async function processListItems(items, userConfig, genre) {
  if (!items || items.length === 0) return { allItems: [], hasMovies: false, hasShows: false };
  let hasMovies = false, hasShows = false;
  const processedItems = items.map(item => {
    const isMovie = item.media_type === 'movie' || (item.title && !item.name) || (item.release_date && !item.first_air_date);
    const type = isMovie ? 'movie' : 'series';
    if (type === 'movie') hasMovies = true;
    if (type === 'series') hasShows = true;
    return { tmdb_id: item.id, type, title: isMovie ? item.title : item.name, name: isMovie ? item.title : item.name, overview: item.overview, description: item.overview, year: isMovie ? (item.release_date?.split('-')[0]) : (item.first_air_date?.split('-')[0]), release_date: item.release_date, first_air_date: item.first_air_date, poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : undefined, background: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : undefined, poster_path: item.poster_path, backdrop_path: item.backdrop_path, vote_average: item.vote_average, vote_count: item.vote_count, popularity: item.popularity, genre_ids: item.genre_ids, genres: [], imdbRating: item.vote_average?.toFixed(1) };
  });
  const itemsWithTmdbIds = processedItems.filter(item => item.tmdb_id);
  if (itemsWithTmdbIds.length > 0) {
    const CONCURRENCY_LIMIT = TMDB_CONCURRENT_REQUESTS || 5;
    const chunks = [];
    for (let i = 0; i < itemsWithTmdbIds.length; i += CONCURRENCY_LIMIT) chunks.push(itemsWithTmdbIds.slice(i, i + CONCURRENCY_LIMIT));
    const externalIdsResults = [];
    for (const chunk of chunks) {
      const chunkPromises = chunk.map(async (item) => {
        try {
          const endpoint = item.type === 'movie' ? 'movie' : 'tv';
          const response = await axios.get(`${TMDB_BASE_URL_V3}/${endpoint}/${item.tmdb_id}/external_ids`, { headers: { 'accept': 'application/json', 'Authorization': `Bearer ${userConfig.tmdbBearerToken || DEFAULT_TMDB_BEARER_TOKEN}` }, timeout: TMDB_REQUEST_TIMEOUT });
          return { tmdb_id: item.tmdb_id, imdb_id: response.data?.imdb_id };
        } catch (error) {
          return { tmdb_id: item.tmdb_id, imdb_id: null };
        }
      });
      externalIdsResults.push(...await Promise.all(chunkPromises));
      // REMOVED DELAY
    }
    const externalIdsMap = new Map(externalIdsResults.map(r => [r.tmdb_id, r.imdb_id]));
    processedItems.forEach(item => {
      const imdbId = externalIdsMap.get(item.tmdb_id);
      if (imdbId) { item.imdb_id = imdbId; item.id = imdbId; } else { item.id = `tmdb:${item.tmdb_id}`; }
    });
  }
  const validItems = processedItems.filter(item => item.imdb_id || item.tmdb_id);
  return { allItems: validItems, hasMovies, hasShows };
}

async function validateTMDBKey(userBearerToken) {
  if (!userBearerToken) return false;
  try {
    const response = await axios.get(`${TMDB_BASE_URL_V3}/configuration`, { headers: { 'accept': 'application/json', 'Authorization': `Bearer ${userBearerToken}` }, timeout: 10000 });
    return response.status === 200 && response.data;
  } catch (error) {
    return false;
  }
}

async function convertImdbToTmdbId(imdbId, userBearerToken = DEFAULT_TMDB_BEARER_TOKEN) {
  if (!imdbId || !imdbId.match(/^tt\d+$/)) return null;
  const cacheKey = `imdb_to_tmdb_${imdbId}`;
  const cachedResult = imdbToTmdbCache.get(cacheKey);
  if (cachedResult) return cachedResult === 'null' ? null : cachedResult;
  try {
    const response = await axios.get(`${TMDB_BASE_URL_V3}/find/${imdbId}`, { params: { external_source: 'imdb_id' }, headers: { 'accept': 'application/json', 'Authorization': `Bearer ${userBearerToken}` }, timeout: TMDB_REQUEST_TIMEOUT });
    const data = response.data;
    let result = null;
    if (data.movie_results?.length > 0) result = { tmdbId: data.movie_results[0].id, type: 'movie' };
    else if (data.tv_results?.length > 0) result = { tmdbId: data.tv_results[0].id, type: 'series' };
    imdbToTmdbCache.set(cacheKey, result || 'null');
    return result;
  } catch (error) {
    imdbToTmdbCache.set(cacheKey, 'null', 3600 * 1000);
    return null;
  }
}

async function fetchTmdbMetadata(tmdbId, type, language = 'en-US', userBearerToken = DEFAULT_TMDB_BEARER_TOKEN) {
  if (!tmdbId) return null;
  const EPISODE_NUMBERING_VERSION = 'v2'; 
  const cacheKey = `tmdb_${type}_${tmdbId}_${language}_${EPISODE_NUMBERING_VERSION}`;
  const cachedResult = tmdbCache.get(cacheKey);
  if (cachedResult) return cachedResult === 'null' ? null : cachedResult;
  try {
    const endpoint = type === 'movie' ? 'movie' : 'tv';
    const response = await axios.get(`${TMDB_BASE_URL_V3}/${endpoint}/${tmdbId}`, { params: { language, append_to_response: 'credits,videos,external_ids,images' }, headers: { 'accept': 'application/json', 'Authorization': `Bearer ${userBearerToken || DEFAULT_TMDB_BEARER_TOKEN}` }, timeout: TMDB_REQUEST_TIMEOUT });
    const data = response.data;
    if (type === 'series' && data.number_of_seasons) {
      try {
        const seasonPromises = [];
        for (let seasonNum = 0; seasonNum <= data.number_of_seasons; seasonNum++) {
          if (seasonNum === 0 && data.number_of_seasons > 5) continue;
          seasonPromises.push(axios.get(`${TMDB_BASE_URL_V3}/tv/${tmdbId}/season/${seasonNum}`, { params: { language }, headers: { 'accept': 'application/json', 'Authorization': `Bearer ${userBearerToken || DEFAULT_TMDB_BEARER_TOKEN}` }, timeout: TMDB_REQUEST_TIMEOUT }).catch(e => null));
        }
        data.seasons_with_episodes = (await Promise.all(seasonPromises)).filter(Boolean).map(r => r.data);
      } catch (error) {
        console.warn(`[TMDB] Failed to fetch episode data for series ${tmdbId}:`, error.message);
      }
    }
    const stremioMeta = convertTmdbToStremioFormat(data, type);
    tmdbCache.set(cacheKey, stremioMeta);
    return stremioMeta;
  } catch (error) {
    console.error(`Error fetching TMDB metadata for ${type} ${tmdbId}:`, error.message);
    tmdbCache.set(cacheKey, 'null', 3600 * 1000);
    return null;
  }
}

function convertTmdbToStremioFormat(tmdbData, type) {
  const isMovie = type === 'movie';
  const tmdbId = `tmdb:${tmdbData.id}`;
  const imdbId = tmdbData.external_ids?.imdb_id || tmdbData.imdb_id;
  const tvdbId = tmdbData.external_ids?.tvdb_id;
  const cast = tmdbData.credits?.cast?.slice(0, 10).map(p => p.name) || [];
  const crew = tmdbData.credits?.crew || [];
  const directors = crew.filter(p => p.job === 'Director').map(p => p.name);
  const writers = crew.filter(p => ['Writer', 'Screenplay', 'Story'].includes(p.job)).map(p => p.name);
  const trailerVideos = tmdbData.videos?.results?.filter(v => v.type === 'Trailer' && v.site === 'YouTube') || [];
  const releaseDate = isMovie ? tmdbData.release_date : tmdbData.first_air_date;
  const releaseYear = releaseDate?.split('-')[0];
  let formattedYear = releaseYear;
  if (!isMovie && releaseYear) {
    const lastAirDate = tmdbData.last_air_date;
    const status = tmdbData.status;
    if (status === 'Returning Series' || status === 'In Production' || !lastAirDate) formattedYear = `${releaseYear}-`;
    else if (lastAirDate && lastAirDate !== releaseDate) {
      const endYear = lastAirDate.split('-')[0];
      if (endYear !== releaseYear) formattedYear = `${releaseYear}-${endYear}`;
    }
  }
  let tmdbLogo = null;
  if (tmdbData.images?.logos?.length > 0) {
    const englishLogo = tmdbData.images.logos.find(img => img.iso_639_1 === 'en') || tmdbData.images.logos[0];
    tmdbLogo = `https://image.tmdb.org/t/p/original${englishLogo.file_path}`;
  }
  let videos = [];
  if (!isMovie && tmdbData.seasons_with_episodes) {
    let isAnimeWithAbsoluteNumbering = false;
    let totalEpisodesProcessed = 0;
    for (const season of tmdbData.seasons_with_episodes) {
        if (season.episodes?.length > 0) {
            const firstEpisodeNum = season.episodes[0].episode_number;
            if (firstEpisodeNum > season.episodes.length * 2 || (season.season_number <= 5 && firstEpisodeNum >= 100) || (totalEpisodesProcessed > 0 && firstEpisodeNum > totalEpisodesProcessed)) {
                isAnimeWithAbsoluteNumbering = true;
                break;
            }
            totalEpisodesProcessed += season.episodes.length;
        }
    }
    tmdbData.seasons_with_episodes.forEach(season => {
      season.episodes?.forEach((episode, episodeIndex) => {
        let seasonEpisodeNumber = isAnimeWithAbsoluteNumbering ? episodeIndex + 1 : episode.episode_number;
        const episodeId = imdbId ? `${imdbId}:${season.season_number}:${seasonEpisodeNumber}` : `${tmdbId}:${season.season_number}:${seasonEpisodeNumber}`;
        videos.push({ id: episodeId, name: episode.name || `Episode ${seasonEpisodeNumber}`, season: season.season_number, number: seasonEpisodeNumber, episode: seasonEpisodeNumber, thumbnail: episode.still_path ? `https://image.tmdb.org/t/p/w500${episode.still_path}` : undefined, overview: episode.overview || "", description: episode.overview || "", rating: episode.vote_average?.toFixed(1) || "0", released: episode.air_date ? `${episode.air_date}T00:00:00.001Z` : null, absoluteNumber: isAnimeWithAbsoluteNumbering ? episode.episode_number : undefined });
      });
    });
    videos.sort((a, b) => a.season !== b.season ? a.season - b.season : a.episode - b.episode);
  }
  const metadata = {
    id: tmdbId, imdb_id: imdbId, tvdb_id: tvdbId, type: type, name: isMovie ? tmdbData.title : tmdbData.name, description: tmdbData.overview || "", poster: tmdbData.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : undefined, background: tmdbData.backdrop_path ? `https://image.tmdb.org/t/p/original${tmdbData.backdrop_path}` : undefined, releaseInfo: formattedYear, year: formattedYear, released: releaseDate ? `${releaseDate}T00:00:00.000Z` : undefined, runtime: isMovie ? (tmdbData.runtime ? `${tmdbData.runtime} min` : undefined) : (tmdbData.episode_run_time?.[0] ? `${tmdbData.episode_run_time[0]} min` : undefined), genres: tmdbData.genres?.map(g => g.name) || [], cast: cast.length > 0 ? cast : undefined, director: directors.length > 0 ? directors : undefined, writer: writers.length > 0 ? writers : undefined, imdbRating: tmdbData.vote_average?.toFixed(1), country: isMovie ? (tmdbData.production_countries?.[0]?.name) : (tmdbData.origin_country?.[0]), trailerStreams: trailerVideos.length > 0 ? trailerVideos.map(v => ({ title: tmdbData.title || tmdbData.name, ytId: v.key })) : undefined, videos: videos, status: !isMovie ? tmdbData.status : undefined, tmdbId: tmdbData.id, tmdb_logo: tmdbLogo, behaviorHints: { hasScheduledVideos: !isMovie }
  };
  return metadata;
}

async function batchFetchTmdbMetadata(items, language = 'en-US', userBearerToken = DEFAULT_TMDB_BEARER_TOKEN) {
  if (!items?.length) return {};
  const CONCURRENCY_LIMIT = TMDB_CONCURRENT_REQUESTS || 12;
  const results = {};
  const chunks = [];
  for (let i = 0; i < items.length; i += CONCURRENCY_LIMIT) {
    chunks.push(items.slice(i, i + CONCURRENCY_LIMIT));
  }
  for (const chunk of chunks) {
    const chunkPromises = chunk.map(async (item) => {
      const identifier = item.imdbId || `tmdb:${item.tmdbId}`;
      try {
        const metadata = await fetchTmdbMetadata(item.tmdbId, item.type, language, userBearerToken);
        if (metadata) {
          if (item.imdbId) {
            metadata.id = item.imdbId;
            metadata.imdb_id = item.imdbId;
          }
          return { identifier, metadata };
        }
        return { identifier, metadata: null };
      } catch (error) {
        return { identifier, metadata: null };
      }
    });
    const chunkResults = await Promise.all(chunkPromises);
    chunkResults.forEach(({ identifier, metadata }) => {
      if (metadata) results[identifier] = metadata;
    });
    // REMOVED DELAY
  }
  return results;
}

async function fetchTmdbGenres(language = 'en-US', userBearerToken = DEFAULT_TMDB_BEARER_TOKEN) {
  if (!language) return [];
  const cacheKey = `tmdb_genres_${language}`;
  const cachedGenres = tmdbCache.get(cacheKey);
  if (cachedGenres) return cachedGenres === 'null' ? [] : cachedGenres;
  try {
    const [movieResponse, tvResponse] = await Promise.all([
      axios.get(`${TMDB_BASE_URL_V3}/genre/movie/list`, { params: { language }, headers: { 'accept': 'application/json', 'Authorization': `Bearer ${userBearerToken}` }, timeout: TMDB_REQUEST_TIMEOUT }),
      axios.get(`${TMDB_BASE_URL_V3}/genre/tv/list`, { params: { language }, headers: { 'accept': 'application/json', 'Authorization': `Bearer ${userBearerToken}` }, timeout: TMDB_REQUEST_TIMEOUT })
    ]);
    const genreMap = new Map();
    [...(movieResponse.data.genres || []), ...(tvResponse.data.genres || [])].forEach(genre => {
      if (!genreMap.has(genre.name.toLowerCase())) genreMap.set(genre.name.toLowerCase(), genre.name);
    });
    const translatedGenres = ['All', ...Array.from(genreMap.values()).sort()];
    tmdbCache.set(cacheKey, translatedGenres, 24 * 3600 * 1000);
    return translatedGenres;
  } catch (error) {
    console.error(`Error fetching TMDB genres for language ${language}:`, error.message);
    tmdbCache.set(cacheKey, 'null', 3600 * 1000);
    return [];
  }
}

function clearTmdbCaches() {
  tmdbCache.clear();
  imdbToTmdbCache.clear();
}

module.exports = {
  createTmdbRequestToken,
  createTmdbSession,
  getTmdbAccountDetails,
  getTmdbAuthUrl,
  authenticateTmdb,
  fetchTmdbLists,
  fetchTmdbListItems,
  validateTMDBKey,
  convertImdbToTmdbId,
  batchConvertImdbToTmdbIds,
  fetchTmdbMetadata,
  batchFetchTmdbMetadata,
  fetchTmdbGenres,
  clearTmdbCaches
};
