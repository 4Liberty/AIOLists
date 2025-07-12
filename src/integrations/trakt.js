// src/integrations/trakt.js
const axios = require('axios');
const { ITEMS_PER_PAGE, TRAKT_CLIENT_ID, TRAKT_REDIRECT_URI, TRAKT_CONCURRENT_REQUESTS } = require('../config');
const { getTraktTokens, saveTraktTokens } = require('../utils/remoteStorage');

const TRAKT_API_URL = 'https://api.trakt.tv';

// ... (The rest of the file is the same as the last version you received, but with batch sizes increased and delays removed) ...

async function batchFetchTraktMetadata(items) {
  if (!items || items.length === 0) return [];

  // AGGRESSIVE SETTINGS FOR SINGLE USER
  const BATCH_SIZE = 20; // Increased from 5
  const DELAY_BETWEEN_BATCHES = 100; // Reduced from 2500
  const DELAY_BETWEEN_REQUESTS = 0; // Reduced from 500

  const results = [];
  
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    
    const batchPromises = batch.map(async (item) => {
      if (!item.imdb_id || !item.type) {
        return item;
      }
      
      try {
        const traktMetadata = await fetchTraktMetadata(item.imdb_id, item.type);
        if (traktMetadata) {
          return { ...item, ...traktMetadata };
        }
        return item;
      } catch (error) {
        if (error.response && error.response.status === 429) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait on rate limit
          try {
            const traktMetadata = await fetchTraktMetadata(item.imdb_id, item.type);
            if (traktMetadata) return { ...item, ...traktMetadata };
          } catch (retryError) {
            // fail silently on retry
          }
        }
        return item;
      }
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    if (i + BATCH_SIZE < items.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
    }
  }

  return results;
}

// ... (The rest of the functions in this file remain the same)
async function getTraktUserUuid(accessToken) {
  const response = await axios.get(`${TRAKT_API_URL}/users/settings`, { headers: { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': TRAKT_CLIENT_ID, 'Authorization': `Bearer ${accessToken}` } });
  return response.data.user.ids.uuid;
}
async function getTraktUserSettings(accessToken) {
  const response = await axios.get(`${TRAKT_API_URL}/users/settings`, { headers: { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': TRAKT_CLIENT_ID, 'Authorization': `Bearer ${accessToken}` } });
  return { uuid: response.data.user.ids.uuid, username: response.data.user.username };
}
async function refreshTraktToken(userConfig) {
  const refreshToken = userConfig.traktRefreshToken;
  if (!refreshToken) return false;
  try {
    const response = await axios.post(`${TRAKT_API_URL}/oauth/token`, { refresh_token: refreshToken, client_id: TRAKT_CLIENT_ID, redirect_uri: TRAKT_REDIRECT_URI, grant_type: 'refresh_token' });
    if (response.status === 200 && response.data) {
      const newTokens = { accessToken: response.data.access_token, refreshToken: response.data.refresh_token, expiresAt: Date.now() + (response.data.expires_in * 1000) };
      userConfig.traktAccessToken = newTokens.accessToken;
      userConfig.traktRefreshToken = newTokens.refreshToken;
      userConfig.traktExpiresAt = newTokens.expiresAt;
      if (userConfig.upstashUrl && userConfig.traktUuid) await saveTraktTokens(userConfig, newTokens);
      return true;
    }
    return false;
  } catch (error) {
    if (error.response?.status === 401) {
      userConfig.traktAccessToken = null;
      userConfig.traktRefreshToken = null;
      userConfig.traktExpiresAt = null;
      if (userConfig.upstashUrl && userConfig.traktUuid) await saveTraktTokens(userConfig, { accessToken: null, refreshToken: null, expiresAt: null });
    }
    return false;
  }
}
async function initTraktApi(userConfig) {
  if (userConfig.upstashUrl && userConfig.upstashToken && userConfig.traktUuid) {
    const tokens = await getTraktTokens(userConfig);
    if (tokens) {
      userConfig.traktAccessToken = tokens.accessToken;
      userConfig.traktRefreshToken = tokens.refreshToken;
      userConfig.traktExpiresAt = tokens.expiresAt;
      if (Date.now() >= new Date(userConfig.traktExpiresAt).getTime()) return await refreshTraktToken(userConfig);
      return true;
    }
  }
  if (userConfig.traktAccessToken && userConfig.traktExpiresAt) {
    if (Date.now() >= new Date(userConfig.traktExpiresAt).getTime()) return await refreshTraktToken(userConfig);
    return true;
  }
  return false;
}
function getTraktAuthUrl(state = null) {
  let url = `${TRAKT_API_URL}/oauth/authorize?response_type=code&client_id=${TRAKT_CLIENT_ID}&redirect_uri=${encodeURIComponent(TRAKT_REDIRECT_URI)}`;
  if (state) url += `&state=${encodeURIComponent(state)}`;
  return url;
}
async function authenticateTrakt(code, userConfig) {
  const response = await axios.post(`${TRAKT_API_URL}/oauth/token`, { code, client_id: TRAKT_CLIENT_ID, grant_type: 'authorization_code', redirect_uri: TRAKT_REDIRECT_URI });
  if (response.status === 200 && response.data) {
    const tokens = { accessToken: response.data.access_token, refreshToken: response.data.refresh_token, expiresAt: Date.now() + (response.data.expires_in * 1000) };
    const userSettings = await getTraktUserSettings(tokens.accessToken);
    return { uuid: userSettings.uuid, username: userSettings.username, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt };
  }
  throw new Error('Failed to authenticate with Trakt');
}
async function fetchTraktLists(userConfig) {
    if (!await initTraktApi(userConfig)) return [];
    try {
      const response = await axios.get(`${TRAKT_API_URL}/users/me/lists`, { headers: { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': TRAKT_CLIENT_ID, 'Authorization': `Bearer ${userConfig.traktAccessToken}` } });
      const lists = response.data.map(list => ({ id: `trakt_${list.ids.slug}`, name: list.name, updated: list.updated_at, listType: 'T', isTraktList: true, hasMovies: true, hasShows: true }));
      const specialLists = [
        { id: 'trakt_watchlist', name: 'Trakt Watchlist', isTraktWatchlist: true, listType: 'T', hasMovies: true, hasShows: true },
        { id: 'trakt_recommendations_movies', name: 'Recommended Movies', isTraktRecommendations: true, listType: 'T', hasMovies: true, hasShows: false },
        { id: 'trakt_recommendations_shows', name: 'Recommended Shows', isTraktRecommendations: true, listType: 'T', hasMovies: false, hasShows: true },
        { id: 'trakt_trending_movies', name: 'Trending Movies', isTraktTrending: true, listType: 'T', hasMovies: true, hasShows: false },
        { id: 'trakt_trending_shows', name: 'Trending Shows', isTraktTrending: true, listType: 'T', hasMovies: false, hasShows: true },
        { id: 'trakt_popular_movies', name: 'Popular Movies', isTraktPopular: true, listType: 'T', hasMovies: true, hasShows: false },
        { id: 'trakt_popular_shows', name: 'Popular Shows', isTraktPopular: true, listType: 'T', hasMovies: false, hasShows: true }
      ];
      return [...lists, ...specialLists.map(sl => ({ ...sl, updated: new Date().toISOString() }))];
    } catch (error) {
      console.error("[TraktIntegration] Exception fetching Trakt lists:", error.message);
      return [];
    }
}
async function fetchPublicTraktListDetails(traktListUrl) {
    try {
      const cleanedUrl = traktListUrl.split('?')[0];
      const urlMatch = cleanedUrl.match(/^https?:\/\/trakt\.tv\/users\/([\w-]+)\/lists\/([\w-]+)\/?$/);
      if (!urlMatch) throw new Error('Invalid Trakt list URL format.');
      const [, username, listSlugOrId] = urlMatch;
      const headers = { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': TRAKT_CLIENT_ID };
      const listDetailsResponse = await axios.get(`${TRAKT_API_URL}/users/${username}/lists/${listSlugOrId}`, { headers });
      if (!listDetailsResponse.data) throw new Error('Could not fetch Trakt list details.');
      const listData = listDetailsResponse.data;
      let hasMovies = false, hasShows = false;
      if (listData.item_count > 0) {
        const sampleLimit = Math.min(listData.item_count, 10);
        const itemsResp = await axios.get(`${TRAKT_API_URL}/users/${username}/lists/${listData.ids.slug}/items?limit=${sampleLimit}&extended=full`, { headers });
        if (itemsResp.data && Array.isArray(itemsResp.data)) {
          for (const item of itemsResp.data) {
            if (item.type === 'movie' && item.movie) hasMovies = true;
            if (item.type === 'show' && item.show) hasShows = true;
            if (hasMovies && hasShows) break;
          }
        }
      }
      return { listId: `traktpublic_${username}_${listData.ids.slug}`, originalTraktId: String(listData.ids.trakt), originalTraktSlug: listData.ids.slug, traktUser: username, listName: listData.name, isTraktPublicList: true, hasMovies: hasMovies, hasShows: hasShows, itemCount: listData.item_count };
    } catch (error) {
      console.error("[TraktIntegration] Exception fetching public Trakt list details:", error.response?.data || error.message);
      throw new Error(`Failed to fetch Trakt list: ${error.response?.data?.error_description || error.message}`);
    }
}
async function fetchTraktListItems(listId, userConfig, skip = 0, sortBy = 'rank', sortOrder = 'asc', isPublicImport = false, publicUsername = null, itemTypeHint = null, genre = null, isMetadataCheck = false) {
  if (!listId) return null;
  console.log(`[Trakt] fetchTraktListItems called: listId=${listId}, skip=${skip}, sortBy=${sortBy}, sortOrder=${sortOrder}, isPublicImport=${isPublicImport}, publicUsername=${publicUsername}, itemTypeHint=${itemTypeHint}, genre=${genre}, isMetadataCheck=${isMetadataCheck}`);
  const limit = isMetadataCheck ? 1 : ITEMS_PER_PAGE;
  const page = isMetadataCheck ? 1 : Math.floor(skip / limit) + 1;
  const headers = { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': TRAKT_CLIENT_ID };
  if (!isPublicImport) {
    if (!await initTraktApi(userConfig)) return null;
    headers['Authorization'] = `Bearer ${userConfig.traktAccessToken}`;
  }
  let requestUrl, params = { limit, page, extended: 'full' }, rawTraktEntries = [], effectiveItemTypeForEndpoint = itemTypeHint;
  try {
    if (isPublicImport && publicUsername) {
      console.log(`[Trakt] Fetching public Trakt list: user=${publicUsername}, listId=${listId}, itemTypeHint=${itemTypeHint}`);
        const actualSlug = listId.replace(/^traktpublic_[^_]+_/, '');
        let basePath = `${TRAKT_API_URL}/users/${publicUsername}/lists/${actualSlug}/items`;
        if (itemTypeHint === 'movie') requestUrl = `${basePath}/movies`;
        else if (itemTypeHint === 'series') requestUrl = `${basePath}/shows`;
        else requestUrl = basePath; 
        effectiveItemTypeForEndpoint = itemTypeHint;
        if (['rank', 'added', 'title', 'released', 'runtime', 'popularity', 'votes', 'random'].includes(sortBy) && !isMetadataCheck) {
            params.sort_by = sortBy; if (sortOrder) params.sort_how = sortOrder;
        }
    } else if (listId === 'trakt_watchlist') {
      console.log(`[Trakt] Fetching Trakt watchlist: itemTypeHint=${itemTypeHint}`);
        let typeForEndpoint = itemTypeHint || 'all'; 
        if (itemTypeHint === 'series') typeForEndpoint = 'shows';
        if (itemTypeHint === 'movie') typeForEndpoint = 'movies';
        let sortForEndpoint = sortBy;
        requestUrl = `${TRAKT_API_URL}/sync/watchlist/${typeForEndpoint}/${sortForEndpoint}/${sortOrder}`;
        params = { limit, page, extended: 'full' };
        effectiveItemTypeForEndpoint = null; 
    } else if (listId.startsWith('trakt_recommendations_')) {
      console.log(`[Trakt] Fetching Trakt recommendations: listId=${listId}, itemTypeHint=${itemTypeHint}`);
        effectiveItemTypeForEndpoint = listId.endsWith('_movies') ? 'movie' : (listId.endsWith('_shows') ? 'series' : null);
        if (!effectiveItemTypeForEndpoint) return null; 
        requestUrl = `${TRAKT_API_URL}/recommendations/${effectiveItemTypeForEndpoint === 'series' ? 'shows' : 'movies'}`;
        if (genre && !isMetadataCheck) params.genres = genre.toLowerCase().replace(/\s+/g, '-');
    } else if (listId.startsWith('trakt_trending_') || listId.startsWith('trakt_popular_')) {
      console.log(`[Trakt] Fetching Trakt trending/popular: listId=${listId}, itemTypeHint=${itemTypeHint}`);
        effectiveItemTypeForEndpoint = listId.includes('_movies') ? 'movie' : (listId.includes('_shows') ? 'series' : null);
        if (!effectiveItemTypeForEndpoint) return null; 
        const endpointType = listId.startsWith('trakt_trending_') ? 'trending' : 'popular';
        if (headers.Authorization) delete headers.Authorization;
        requestUrl = `${TRAKT_API_URL}/${effectiveItemTypeForEndpoint === 'series' ? 'shows' : 'movies'}/${endpointType}`;
        if (genre && !isMetadataCheck) params.genres = genre.toLowerCase().replace(/\s+/g, '-');
    } else if (listId.startsWith('trakt_')) { 
      console.log(`[Trakt] Fetching Trakt user list: listId=${listId}, itemTypeHint=${itemTypeHint}`);
        const listSlug = listId.replace('trakt_', '');
        let basePath = `${TRAKT_API_URL}/users/me/lists/${listSlug}/items`;
        if (itemTypeHint === 'movie') { requestUrl = `${basePath}/movies`; effectiveItemTypeForEndpoint = 'movie'; }
        else if (itemTypeHint === 'series') { requestUrl = `${basePath}/shows`; effectiveItemTypeForEndpoint = 'series'; }
        else { requestUrl = basePath; effectiveItemTypeForEndpoint = null; } 
        if (sortBy && !isMetadataCheck) params.sort_by = sortBy; 
        if (sortOrder && !isMetadataCheck) params.sort_how = sortOrder;
    } else {
      return null;
    }
    if (requestUrl) { 
        console.log(`[Trakt] Requesting URL: ${requestUrl} with params:`, params);
        const response = await axios.get(requestUrl, { headers, params });
        if (Array.isArray(response.data)) rawTraktEntries = response.data;
        console.log(`[Trakt] Raw entries received:`, rawTraktEntries.length);
    }
      // Helper to fetch IMDb ID from TMDB if missing
      const axios = require('axios');
      async function getImdbIdFromTmdb(tmdbId, type, tmdbBearerToken) {
        if (!tmdbId) return null;
        try {
          const tmdbType = type === 'series' ? 'tv' : 'movie';
          const url = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}`;
          const headers = { 'Authorization': `Bearer ${tmdbBearerToken || ''}` };
          const response = await axios.get(url, { headers });
          return response.data && response.data.imdb_id ? response.data.imdb_id : null;
        } catch (e) { return null; }
      }

      // Map entries, fetch missing IMDb IDs if needed
      const tmdbBearerToken = userConfig.tmdbBearerToken;
      const initialItems = await Promise.all(rawTraktEntries.map(async entry => {
      // Log each entry for debugging
      // console.log(`[Trakt] Raw entry:`, entry);
        let itemDataForDetails, resolvedStremioType, listedAt = entry.listed_at;
        const itemTypeFromEntry = entry.type;
        if (itemTypeFromEntry === 'movie' && entry.movie) { resolvedStremioType = 'movie'; itemDataForDetails = entry.movie; }
        else if (itemTypeFromEntry === 'show' && entry.show) { resolvedStremioType = 'series'; itemDataForDetails = entry.show; }
        else if (itemTypeFromEntry === 'episode' && entry.episode && entry.show) { resolvedStremioType = 'series'; itemDataForDetails = entry.show; }
        else if (itemTypeFromEntry === 'season' && entry.season && entry.show) { resolvedStremioType = 'series'; itemDataForDetails = entry.show; }
        else {
           if (listId.startsWith('trakt_trending_')) {
              if (effectiveItemTypeForEndpoint === 'movie' && entry.movie && entry.movie.ids && entry.movie.title && typeof entry.movie.year === 'number') { resolvedStremioType = 'movie'; itemDataForDetails = entry.movie; }
              else if (effectiveItemTypeForEndpoint === 'series' && entry.show && entry.show.ids && entry.show.title && typeof entry.show.year === 'number') { resolvedStremioType = 'series'; itemDataForDetails = entry.show; }
              else return null;
           } else if (listId.startsWith('trakt_recommendations_') || listId.startsWith('trakt_popular_')) {
              if (effectiveItemTypeForEndpoint === 'movie' && entry.ids && entry.title && typeof entry.year === 'number') { resolvedStremioType = 'movie'; itemDataForDetails = entry; }
              else if (effectiveItemTypeForEndpoint === 'series' && entry.ids && entry.title && typeof entry.year === 'number') { resolvedStremioType = 'series'; itemDataForDetails = entry; }
              else return null;
           } else return null;
        }
        if (!itemDataForDetails) return null;
        if (itemTypeHint && itemTypeHint !== 'all' && resolvedStremioType !== itemTypeHint) return null;
        let imdbId = itemDataForDetails.ids?.imdb;
        const tmdbId = itemDataForDetails.ids?.tmdb;
        // Fallback: fetch IMDb ID from TMDB if missing
        if (!imdbId && tmdbId) {
          imdbId = await getImdbIdFromTmdb(tmdbId, resolvedStremioType, tmdbBearerToken);
        }
        if (!imdbId && !tmdbId) return null;
        return {
          imdb_id: imdbId,
          tmdb_id: tmdbId,
          title: itemDataForDetails.title,
          year: itemDataForDetails.year,
          overview: itemDataForDetails.overview,
          genres: itemDataForDetails.genres,
          runtime: itemDataForDetails.runtime,
          type: resolvedStremioType,
          listed_at: listedAt
        };
      }));
      const filteredItems = initialItems.filter(item => item !== null);
      console.log(`[Trakt] Items after mapping/filtering:`, filteredItems.length);
      if (listId === 'trakt_watchlist' && sortBy === 'added' && initialItems.length > 0) {
          initialItems.sort((a, b) => { const dateA = a.listed_at ? new Date(a.listed_at) : 0; const dateB = b.listed_at ? new Date(b.listed_at) : 0; return (sortOrder === 'asc' ? dateA - dateB : dateB - dateA); });
      }
      const finalResult = { allItems: initialItems, hasMovies: false, hasShows: false };
      initialItems.forEach(item => { if (item.type === 'movie') finalResult.hasMovies = true; else if (item.type === 'series') finalResult.hasShows = true; });
      return finalResult;
      // Log final result for debugging
      console.log(`[Trakt] Final result:`, finalResult);
    } catch (error) {
      console.error(`[TraktIntegration] Critical exception in fetchTraktListItems for list ${listId}: ${error.message}`, error.stack); 
      if (error.response) console.error(`[TraktIntegration] Trakt API Error Response: Status ${error.response.status}`, JSON.stringify(error.response.data, null, 2)); 
      return null;
    }
}
async function fetchTraktMetadata(imdbId, type) {
  try {
    const cleanImdbId = imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`;
    const traktType = type === 'series' ? 'shows' : 'movies';
    const headers = { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': TRAKT_CLIENT_ID };
    const response = await axios.get(`${TRAKT_API_URL}/${traktType}/${cleanImdbId}?extended=full`, { headers, timeout: 10000 });
    if (response.data) return convertTraktToStremioFormat(response.data, type);
    return null;
  } catch (error) {
    console.warn(`Failed to fetch Trakt metadata for ${imdbId}:`, error.message);
    return null;
  }
}
function convertTraktToStremioFormat(traktData, type) {
  const baseData = { id: traktData.ids?.imdb || null, type: type, name: traktData.title || 'Unknown Title', description: traktData.overview || undefined, year: traktData.year || undefined, released: traktData.released || undefined, genres: traktData.genres || undefined, runtime: traktData.runtime ? `${traktData.runtime} min` : undefined, country: traktData.country || undefined, language: traktData.language || undefined, certification: traktData.certification || undefined, rating: traktData.rating || undefined, votes: traktData.votes || undefined, comment_count: traktData.comment_count || undefined, popularity: traktData.popularity || undefined, updated_at: traktData.updated_at || undefined, available_translations: traktData.available_translations || undefined };
  if (type === 'series') { baseData.status = traktData.status; baseData.first_aired = traktData.first_aired; baseData.airs = traktData.airs; baseData.network = traktData.network; baseData.aired_episodes = traktData.aired_episodes; }
  else if (type === 'movie') { baseData.tagline = traktData.tagline; baseData.homepage = traktData.homepage; }
  Object.keys(baseData).forEach(key => baseData[key] === undefined && delete baseData[key]);
  return baseData;
}
async function fetchTraktGenres() {
  try {
    const headers = { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': TRAKT_CLIENT_ID };
    const [movieGenresResponse, showGenresResponse] = await Promise.all([
      axios.get(`${TRAKT_API_URL}/genres/movies`, { headers, timeout: 10000 }),
      axios.get(`${TRAKT_API_URL}/genres/shows`, { headers, timeout: 10000 })
    ]);
    const movieGenres = movieGenresResponse.data?.map(g => g.name) || [];
    const showGenres = showGenresResponse.data?.map(g => g.name) || [];
    const allGenres = [...new Set([...movieGenres, ...showGenres])];
    allGenres.sort();
    return ['All', ...allGenres];
  } catch (error) {
    console.error('Failed to fetch Trakt genres:', error.message);
    return [ 'All', 'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance', 'Science Fiction', 'Thriller', 'War', 'Western' ];
  }
}
async function validateTraktApi() {
  try {
    const response = await axios.get(`${TRAKT_API_URL}/stats`, { headers: { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': TRAKT_CLIENT_ID }, timeout: 5000 });
    return response.status === 200;
  } catch (error) {
    console.error('Failed to validate Trakt API access:', error.message);
    return false;
  }
}
module.exports = { initTraktApi, getTraktAuthUrl, getTraktUserSettings, authenticateTrakt, fetchTraktLists, fetchTraktListItems, fetchPublicTraktListDetails, fetchTraktMetadata, batchFetchTraktMetadata, fetchTraktGenres, validateTraktApi };
