// src/integrations/mdblist.js
const axios = require('axios');
const { ITEMS_PER_PAGE, MDB_LIST_CONCURRENT_REQUESTS } = require('../config');
const { enrichItemsWithMetadata } = require('../utils/metadataFetcher');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_RETRIES = 4;
const INITIAL_RETRY_DELAY_MS = 2000; // Reduced from 5000

// ... (The rest of the file is the same as the last version you received, but with delays removed) ...
async function validateMDBListKey(apiKey) {
  if (!apiKey) return null;
  try {
    const response = await axios.get(`https://api.mdblist.com/user?apikey=${apiKey}`, { timeout: 5000 });
    return (response.status === 200 && response.data) ? response.data : null;
  } catch (error) {
    console.error('Error validating MDBList Key:', error.message);
    return null;
  }
}

async function convertPublicListsToPremium(userConfig, apiKey) {
  if (!apiKey || !userConfig.importedAddons) {
    return { success: true, conversions: 0, errors: [] };
  }
  let conversions = 0;
  const errors = [];
  const publicListAddons = Object.entries(userConfig.importedAddons).filter(([id, addon]) => {
    if (!addon.isMDBListUrlImport || !addon.mdblistUsername || !addon.mdblistSlug) return false;
    if (addon.isPublicAccess === true) return true;
    if (addon.isPublicAccess === undefined && addon.mdblistId) {
      if (addon.mdblistId === addon.mdblistSlug) return true;
      if (isNaN(parseInt(addon.mdblistId)) || addon.mdblistId.includes('-')) return true;
    }
    return false;
  });
  if (publicListAddons.length === 0) return { success: true, conversions: 0, errors: [] };
  const convertedLists = [];
  for (const [addonId, addon] of publicListAddons) {
    try {
      const listUrl = `https://mdblist.com/lists/${addon.mdblistUsername}/${addon.mdblistSlug}`;
      const apiListData = await extractListFromUrl(listUrl, apiKey);
      if (apiListData && !apiListData.isPublicAccess) {
        userConfig.importedAddons[addonId] = { ...addon, mdblistId: apiListData.listId, isPublicAccess: false, hasMovies: apiListData.hasMovies, hasShows: apiListData.hasShows };
        conversions++;
        convertedLists.push({ id: addonId, name: addon.name, username: addon.mdblistUsername, slug: addon.mdblistSlug, newApiId: apiListData.listId });
      } else {
        errors.push(`Failed to convert "${addon.name}" to API access`);
      }
    } catch (error) {
      errors.push(`Error converting "${addon.name}": ${error.message}`);
    }
    // REMOVED DELAY
  }
  const result = { success: true, conversions, errors, message: conversions > 0 ? `Successfully converted ${conversions} public lists to premium API access` : 'No lists were converted', convertedLists: convertedLists };
  return result;
}

async function fetchAllLists(apiKey) {
  if (!apiKey) return [];
  let allLists = [];
  const listEndpoints = [
    { url: `https://api.mdblist.com/lists/user?apikey=${apiKey}`, type: 'L' },
    { url: `https://api.mdblist.com/external/lists/user?apikey=${apiKey}`, type: 'E' }
  ];
  for (const endpoint of listEndpoints) {
    let currentRetries = 0;
    let success = false;
    while (currentRetries < MAX_RETRIES && !success) {
      try {
        const response = await axios.get(endpoint.url, { timeout: 15000 });
        if (response.data && Array.isArray(response.data)) {
          allLists.push(...response.data.map(list => ({ ...list, listType: endpoint.type, name: list.name })));
        }
        success = true;
      } catch (err) {
        currentRetries++;
        if (err.response && (err.response.status === 503 || err.response.status === 429) && currentRetries < MAX_RETRIES) {
          const retryDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, currentRetries - 1);
          await delay(retryDelay);
        } else {
          break;
        }
      }
    }
    // REMOVED DELAY
  }
  allLists.push({ id: 'watchlist', name: 'My Watchlist', listType: 'W', isWatchlist: true });
  return allLists;
}

// ... (The rest of the functions in this file remain the same, just with delays removed where they existed)
async function fetchAllListsForUser(apiKey, username) {
  if (!apiKey || !username) return [];
  let userLists = [];
  try {
    const response = await axios.get(`https://api.mdblist.com/lists/user/${username}?apikey=${apiKey}`, { timeout: 10000 });
    if (response.data && Array.isArray(response.data)) {
      userLists.push(...response.data.map(list => ({ ...list, listType: 'L', fetchedForUser: username })));
    }
  } catch (error) {
    console.error(`Error fetching lists for MDBList user ${username}:`, error.message);
  }
  // REMOVED DELAY
  try {
    const extResponse = await axios.get(`https://api.mdblist.com/external/lists/user/${username}?apikey=${apiKey}`, { timeout: 10000 });
    if (extResponse.data && Array.isArray(extResponse.data)) {
      userLists.push(...extResponse.data.map(list => ({ ...list, listType: 'E', fetchedForUser: username })));
    }
  } catch (error) {
    console.error(`Error fetching external lists for MDBList user ${username}:`, error.message);
  }
  return userLists.filter(list => (list.private === false || list.public === true) && list.items > 0);
}

function processMDBListApiResponse(data, isWatchlistUnified = false) {
    if (!data || data.error) {
      return { items: [], hasMovies: false, hasShows: false };
    }
    let rawItems = [];
    let hasMovies = false;
    let hasShows = false;
    if (isWatchlistUnified && Array.isArray(data)) {
      rawItems = data.map(item => {
        const type = (item.type === 'show' || item.mediatype === 'show' || item.media_type === 'show') ? 'series' : 'movie';
        if (type === 'movie') hasMovies = true;
        if (type === 'series') hasShows = true;
        return { ...item, type, imdb_id: item.imdb_id || item.imdbid, id: item.imdb_id || item.imdbid };
      });
    } else {
      if (Array.isArray(data.movies) && data.movies.length > 0) {
        rawItems.push(...data.movies.map(m => ({ ...m, type: 'movie' })));
        hasMovies = true;
      }
      if (Array.isArray(data.shows) && data.shows.length > 0) {
        rawItems.push(...data.shows.map(s => ({ ...s, type: 'series' })));
        hasShows = true;
      }
      if (rawItems.length === 0) {
        let itemsInput = [];
        if (Array.isArray(data)) itemsInput = data;
        else if (Array.isArray(data.items)) itemsInput = data.items;
        else if (Array.isArray(data.results)) itemsInput = data.results;
        rawItems = itemsInput.map(item => {
          const type = (item.type === 'show' || item.mediatype === 'show' || item.media_type === 'show') ? 'series' : 'movie';
          if (type === 'movie') hasMovies = true;
          if (type === 'series') hasShows = true;
          return { ...item, type };
        });
      }
    }
    const finalItems = rawItems.map(item => ({ ...item, imdb_id: item.imdb_id || item.imdbid, id: item.imdb_id || item.imdbid })).filter(item => item.imdb_id);
    return { items: finalItems, hasMovies, hasShows };
}

async function fetchListItemsFromPublicJson(username, listSlug, skip = 0, sort = 'rank', order = 'asc', genre = null, userConfig = null, isMergedByUser = false) {
  try {
    const params = new URLSearchParams({ limit: ITEMS_PER_PAGE.toString() });
    if (skip > 0) params.append('offset', skip.toString());
    if (sort && sort !== 'default') params.append('sort', sort);
    if (order === 'desc' || order === 'asc') params.append('order', order);
    if (isMergedByUser) params.append('unified', 'true');
    params.append('append_to_response', 'ratings');
    const publicJsonUrl = `https://mdblist.com/lists/${username}/${listSlug}/json/?${params.toString()}`;
    const response = await axios.get(publicJsonUrl, { timeout: 15000, headers: { 'User-Agent': 'AIOLists-Stremio-Addon/1.0' } });
    if (!response.data || !Array.isArray(response.data)) return null;
    let hasMovies = false, hasShows = false;
    const processedItems = response.data.map(item => {
      const type = (item.mediatype === 'show' || item.mediatype === 'series') ? 'series' : 'movie';
      if (type === 'movie') hasMovies = true;
      if (type === 'series') hasShows = true;
      return { id: item.imdb_id, imdb_id: item.imdb_id, type: type, title: item.title, name: item.title, year: item.release_year, release_year: item.release_year, rank: item.rank, tvdb_id: item.tvdbid, adult: item.adult };
    }).filter(item => item.imdb_id);
    return { allItems: processedItems, hasMovies, hasShows };
  } catch (error) {
    console.error(`[MDBList Public] Error fetching from public JSON endpoint:`, error.message);
    return null;
  }
}

async function fetchListItems(listId, apiKey, listsMetadata, stremioSkip = 0, sort = 'default', order = 'desc', isUrlImported = false, genre = null, usernameForRandomList = null, isMergedByUser = false, userConfig = null) {
  if (!apiKey) {
    let username = usernameForRandomList;
    let listSlug = String(listId);
    if (!username && userConfig?.importedAddons) {
      for (const addon of Object.values(userConfig.importedAddons)) {
        if (addon.isMDBListUrlImport && (addon.mdblistId === listId || addon.id === listId)) {
          username = addon.mdblistUsername;
          listSlug = addon.mdblistSlug || addon.mdblistId;
          break;
        }
      }
    }
    if (username && listSlug) {
      const publicResult = await fetchListItemsFromPublicJson(username, listSlug, stremioSkip, sort, order, genre, userConfig, isMergedByUser);
      if (publicResult) return publicResult;
    }
    return null;
  }
  const MAX_ATTEMPTS_FOR_GENRE_FILTER = 1;
  const MDBLIST_PAGE_LIMIT = ITEMS_PER_PAGE;
  let effectiveMdbListId = String(listId);
  let mdbListOffset = 0;
  let attemptsForGenreCompletion = 0;
  let allEnrichedGenreItems = [];
  let morePagesFromMdbList = true;
  let allItems = [];
  let hasMovies = false;
  let hasShows = false;
  const listOwnerUsername = usernameForRandomList;
  if (genre) {
    while (allEnrichedGenreItems.length < stremioSkip + MDBLIST_PAGE_LIMIT && attemptsForGenreCompletion < MAX_ATTEMPTS_FOR_GENRE_FILTER && morePagesFromMdbList) {
      let apiUrl;
      const params = new URLSearchParams({ apikey: apiKey, sort: sort, order: order, limit: MDBLIST_PAGE_LIMIT, offset: mdbListOffset });
      if (isMergedByUser && effectiveMdbListId !== 'watchlist' && effectiveMdbListId !== 'watchlist-W' && !listOwnerUsername) params.append('unified', 'true');
      if (listOwnerUsername) apiUrl = `https://api.mdblist.com/lists/${listOwnerUsername}/${effectiveMdbListId}/items?${params.toString()}`;
      else if (effectiveMdbListId === 'watchlist' || effectiveMdbListId === 'watchlist-W') {
        params.append('unified', 'true');
        apiUrl = `https://api.mdblist.com/watchlist/items?${params.toString()}`;
      } else {
        let listPrefix = '';
        const metadata = listsMetadata && (listsMetadata[listId] || listsMetadata[`aiolists-${listId}-L`] || listsMetadata[`aiolists-${listId}-E`]);
        let effectiveListType = metadata?.listType;
        if (!isUrlImported && !effectiveListType) {
            const allUserLists = await fetchAllLists(apiKey);
            const listObj = allUserLists.find(l => String(l.id) === String(effectiveMdbListId));
            effectiveListType = listObj?.listType;
        }
        if (effectiveListType === 'E') listPrefix = 'external/';
        apiUrl = `https://api.mdblist.com/${listPrefix}lists/${effectiveMdbListId}/items?${params.toString()}`;
      }
      let response;
      let success = false;
      let currentRetries = 0;
      while(currentRetries < MAX_RETRIES && !success) {
        try {
          response = await axios.get(apiUrl, { timeout: 15000 });
          if (response.status === 429 && currentRetries < MAX_RETRIES) {
            currentRetries++;
            const retryDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, currentRetries - 1);
            await delay(retryDelay);
            continue;
          }
          success = true;
        } catch (error) {
          if (!success && error.response && (error.response.status === 401 || error.response.status === 403)) {
            let username = listOwnerUsername, listSlug = effectiveMdbListId;
            if (!username && userConfig?.importedAddons) {
              for (const addon of Object.values(userConfig.importedAddons)) {
                if (addon.isMDBListUrlImport && (addon.mdblistId === listId || addon.id === listId)) {
                  username = addon.mdblistUsername;
                  listSlug = addon.mdblistSlug || addon.mdblistId;
                  break;
                }
              }
            }
            if (username && listSlug) {
              const publicResult = await fetchListItemsFromPublicJson(username, listSlug, stremioSkip, sort, order, genre, userConfig, isMergedByUser);
              if (publicResult) return publicResult;
            }
          }
          currentRetries++;
          if (error.response && (error.response.status === 503 || error.response.status === 429) && currentRetries < MAX_RETRIES) {
              const retryDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, currentRetries - 1);
              await delay(retryDelay);
          } else if (error.response && error.response.status === 404 && listOwnerUsername) {
             return null;
          } else {
              morePagesFromMdbList = false;
              break;
          }
        }
      }
      if (!success || !morePagesFromMdbList) break;
      const mdbApiResponseData = response.data;
      const isWatchlistCall = !listOwnerUsername && (effectiveMdbListId === 'watchlist' || effectiveMdbListId === 'watchlist-W');
      const { items: initialItemsFlat, hasMovies: pageHasMovies, hasShows: pageHasShows } = processMDBListApiResponse(mdbApiResponseData, isWatchlistCall);
      if (pageHasMovies) hasMovies = true;
      if (pageHasShows) hasShows = true;
      if (!initialItemsFlat || initialItemsFlat.length === 0) { morePagesFromMdbList = false; break; }
      const genreItemsFromPage = initialItemsFlat;
      allEnrichedGenreItems.push(...genreItemsFromPage);
      mdbListOffset += MDBLIST_PAGE_LIMIT;
      attemptsForGenreCompletion++;
      // REMOVED DELAY
    }
    allItems = allEnrichedGenreItems.slice(stremioSkip, stremioSkip + ITEMS_PER_PAGE);
  } else {
    let apiUrl;
    mdbListOffset = stremioSkip;
    const params = new URLSearchParams({ apikey: apiKey, sort: sort, order: order, limit: ITEMS_PER_PAGE, offset: mdbListOffset });
    if (isMergedByUser && effectiveMdbListId !== 'watchlist' && effectiveMdbListId !== 'watchlist-W' && !listOwnerUsername) params.append('unified', 'true');
    if (listOwnerUsername) apiUrl = `https://api.mdblist.com/lists/${listOwnerUsername}/${effectiveMdbListId}/items?${params.toString()}`;
    else if (effectiveMdbListId === 'watchlist' || effectiveMdbListId === 'watchlist-W') {
        params.append('unified', 'true');
        apiUrl = `https://api.mdblist.com/watchlist/items?${params.toString()}`;
    } else {
        let listPrefix = '';
        if (!isUrlImported) {
            const metadata = listsMetadata && (listsMetadata[listId] || listsMetadata[`aiolists-${listId}-L`] || listsMetadata[`aiolists-${listId}-E`]);
            let originalListType = metadata?.listType;
             if (!originalListType) {
                const allUserLists = await fetchAllLists(apiKey);
                const listObj = allUserLists.find(l => String(l.id) === String(effectiveMdbListId));
                originalListType = listObj?.listType;
            }
            if (originalListType === 'E') listPrefix = 'external/';
        }
        apiUrl = `https://api.mdblist.com/${listPrefix}lists/${effectiveMdbListId}/items?${params.toString()}`;
    }
    let response;
    let success = false;
    let currentRetries = 0;
    while(currentRetries < MAX_RETRIES && !success) {
      try {
          response = await axios.get(apiUrl, { timeout: 15000 });
          if (response.status === 429 && currentRetries < MAX_RETRIES) {
             currentRetries++;
             const retryDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, currentRetries - 1);
             await delay(retryDelay);
             continue;
          }
          success = true;
      } catch (error) {
          if (!success && error.response && (error.response.status === 401 || error.response.status === 403)) {
            let username = listOwnerUsername, listSlug = effectiveMdbListId;
            if (!username && userConfig?.importedAddons) {
              for (const addon of Object.values(userConfig.importedAddons)) {
                if (addon.isMDBListUrlImport && (addon.mdblistId === listId || addon.id === listId)) {
                  username = addon.mdblistUsername;
                  listSlug = addon.mdblistSlug || addon.mdblistId;
                  break;
                }
              }
            }
            if (username && listSlug) {
              const publicResult = await fetchListItemsFromPublicJson(username, listSlug, stremioSkip, sort, order, genre, userConfig, isMergedByUser);
              if (publicResult) return publicResult;
            }
          }
          currentRetries++;
          if (error.response && (error.response.status === 503 || error.response.status === 429) && currentRetries < MAX_RETRIES) {
              const retryDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, currentRetries - 1);
              await delay(retryDelay);
          } else if (error.response && error.response.status === 404 && listOwnerUsername) {
             return null;
          } else {
              return null;
          }
      }
    }
    if (!success) return null;
    const mdbApiResponseData = response.data;
    const isWatchlistCall = !listOwnerUsername && (effectiveMdbListId === 'watchlist' || effectiveMdbListId === 'watchlist-W');
    const { items: initialItemsFlat, hasMovies: pageHasMovies, hasShows: pageHasShows } = processMDBListApiResponse(mdbApiResponseData, isWatchlistCall);
    if (pageHasMovies) hasMovies = true;
    if (pageHasShows) hasShows = true;
    if (!initialItemsFlat || initialItemsFlat.length === 0) return { allItems: [], hasMovies: false, hasShows: false };
    allItems = initialItemsFlat;
  }
  return { allItems: allItems, hasMovies, hasShows };
}

async function extractListFromUrl(url, apiKey) {
  const urlPattern = /^https?:\/\/mdblist\.com\/lists\/([\w-]+)\/([\w-]+)\/?$/;
  const urlMatch = url.match(urlPattern);
  if (!urlMatch) throw new Error('Invalid MDBList URL format. Expected: https://mdblist.com/lists/username/list-slug');
  const [, usernameFromUrl, listSlug] = urlMatch;
  if (!apiKey) {
    try {
      const sampleUrl = `https://mdblist.com/lists/${usernameFromUrl}/${listSlug}/json/?limit=1`;
      const response = await axios.get(sampleUrl, { timeout: 10000, headers: { 'User-Agent': 'AIOLists-Stremio-Addon/1.0' } });
      if (!response.data || !Array.isArray(response.data)) throw new Error('Public JSON endpoint returned invalid format');
      const hasItems = response.data.length > 0;
      let hasMovies = false, hasShows = false;
      if (hasItems) response.data.forEach(item => { if (item.mediatype === 'movie') hasMovies = true; if (item.mediatype === 'show' || item.mediatype === 'series') hasShows = true; });
      if (!hasMovies && !hasShows) { hasMovies = true; hasShows = true; }
      const humanReadableName = listSlug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
      return { listId: listSlug, listSlug: listSlug, username: usernameFromUrl, listName: humanReadableName, isUrlImport: true, isPublicAccess: true, hasMovies: hasMovies, hasShows: hasShows, mdblistUsername: usernameFromUrl, mdblistSlug: listSlug };
    } catch (error) {
      throw new Error(`Failed to extract MDBList via public JSON: ${error.message}. An API key may be required for this list.`);
    }
  }
  let currentRetries = 0;
  while (currentRetries < MAX_RETRIES) {
    try {
      const apiResponse = await axios.get(`https://api.mdblist.com/lists/${usernameFromUrl}/${listSlug}?apikey=${apiKey}`, { timeout: 15000 });
      if (!apiResponse.data || !Array.isArray(apiResponse.data) || apiResponse.data.length === 0) throw new Error('Could not fetch list details from MDBList API or list is empty/not found. Response: ' + JSON.stringify(apiResponse.data));
      const listData = apiResponse.data[0];
      if (typeof listData.user_name === 'undefined') throw new Error(`API response did not include expected 'user_name'. Response: ${JSON.stringify(listData)}`);
      return { listId: String(listData.id), listSlug: listData.slug, username: listData.user_name, listName: listData.name, isUrlImport: true, hasMovies: listData.movies > 0, hasShows: listData.shows > 0, mdblistUsername: usernameFromUrl, mdblistSlug: listSlug };
    } catch (error) {
      currentRetries++;
      if (error.response && (error.response.status === 401 || error.response.status === 403)) {
        try {
          const sampleUrl = `https://mdblist.com/lists/${usernameFromUrl}/${listSlug}/json/?limit=1`;
          const publicResponse = await axios.get(sampleUrl, { timeout: 10000, headers: { 'User-Agent': 'AIOLists-Stremio-Addon/1.0' } });
          if (publicResponse.data && Array.isArray(publicResponse.data)) {
            const hasItems = publicResponse.data.length > 0;
            let hasMovies = false, hasShows = false;
            if (hasItems) publicResponse.data.forEach(item => { if (item.mediatype === 'movie') hasMovies = true; if (item.mediatype === 'show' || item.mediatype === 'series') hasShows = true; });
            if (!hasMovies && !hasShows) { hasMovies = true; hasShows = true; }
            const humanReadableName = listSlug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
            return { listId: listSlug, listSlug: listSlug, username: usernameFromUrl, listName: humanReadableName, isUrlImport: true, isPublicAccess: true, hasMovies: hasMovies, hasShows: hasShows, mdblistUsername: usernameFromUrl, mdblistSlug: listSlug };
          }
        } catch (publicError) {
          // Fall through to retry logic
        }
      }
      if (error.response && (error.response.status === 503 || error.response.status === 429) && currentRetries < MAX_RETRIES) {
        const retryDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, currentRetries - 1);
        await delay(retryDelay);
      } else {
        const errorMessage = error.response?.data?.error || error.message;
        const actualResponseContent = error.response?.data ? JSON.stringify(error.response.data) : (error.message.includes("Response:") ? error.message.split("Response:")[1] : "No detailed response data in error.");
        throw new Error(`Failed to extract MDBList: ${errorMessage}. Actual API response structure: ${actualResponseContent}`);
      }
    }
  }
  throw new Error('Failed to extract MDBList from URL after multiple retries.');
}

module.exports = {
  fetchAllLists,
  fetchAllListsForUser,
  fetchListItems,
  fetchListItemsFromPublicJson,
  validateMDBListKey,
  extractListFromUrl,
  convertPublicListsToPremium
};
