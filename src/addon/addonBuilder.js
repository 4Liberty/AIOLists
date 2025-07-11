// src/addon/addonBuilder.js
const { addonBuilder } = require('stremio-addon-sdk');
const { fetchTraktListItems, fetchTraktLists, initTraktApi } = require('../integrations/trakt');
const { fetchListItems: fetchMDBListItems, fetchAllLists: fetchAllMDBLists, fetchAllListsForUser } = require('../integrations/mdblist');
const { fetchExternalAddonItems } = require('../integrations/externalAddons');
const { convertToStremioFormat } = require('./converters');
const { isWatchlist } = require('../utils/common');
const { staticGenres, MANIFEST_GENERATION_CONCURRENCY, ENABLE_MANIFEST_CACHE } = require('../config');
const axios = require('axios');
const { enrichItemsWithMetadata } = require('../utils/metadataFetcher');

const manifestCache = new Map();
const MANIFEST_CACHE_TTL = 5 * 60 * 1000;

function getManifestCacheKey(userConfig) {
  const cacheableConfig = {
    apiKey: !!userConfig.apiKey,
    traktAccessToken: !!userConfig.traktAccessToken,
    tmdbSessionId: !!userConfig.tmdbSessionId,
    listOrder: userConfig.listOrder,
    hiddenLists: userConfig.hiddenLists,
    removedLists: userConfig.removedLists,
    customListNames: userConfig.customListNames,
    customMediaTypeNames: userConfig.customMediaTypeNames,
    mergedLists: userConfig.mergedLists,
    importedAddons: Object.keys(userConfig.importedAddons || {}),
    enableRandomListFeature: userConfig.enableRandomListFeature,
    metadataSource: userConfig.metadataSource,
    tmdbLanguage: userConfig.tmdbLanguage,
    tmdbBearerToken: !!userConfig.tmdbBearerToken,
    searchSources: userConfig.searchSources || [],
    mergedSearchSources: userConfig.mergedSearchSources || [],
    animeSearchEnabled: userConfig.animeSearchEnabled || false
  };
  return JSON.stringify(cacheableConfig);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const METADATA_FETCH_RETRY_DELAY_MS = 2000;
const MAX_METADATA_FETCH_RETRIES = 2;

async function fetchListContent(listId, userConfig, skip = 0, genre = null, stremioCatalogType = 'all') {
  const catalogIdFromRequest = String(listId);
  if (catalogIdFromRequest.startsWith('trakt_') && !catalogIdFromRequest.startsWith('traktpublic_')) {
    await initTraktApi(userConfig);
  }
  const { apiKey, traktAccessToken, listsMetadata = {}, sortPreferences = {}, importedAddons = {}, rpdbApiKey, randomMDBListUsernames, enableRandomListFeature } = userConfig;
  let itemTypeHintForFetching = (stremioCatalogType === 'movie' || stremioCatalogType === 'series') ? stremioCatalogType : 'all';
  let originalListIdForSortLookup = catalogIdFromRequest;
  const addonDetails = importedAddons?.[catalogIdFromRequest];
  const isUrlImport = addonDetails && (addonDetails.isMDBListUrlImport || addonDetails.isTraktPublicList);
  if (catalogIdFromRequest.startsWith('aiolists-')) {
    const parts = catalogIdFromRequest.split('-');
    if (parts.length >= 2) originalListIdForSortLookup = parts[1] === 'watchlist' ? 'watchlist' : parts[1];
  } else if (isUrlImport) {
    originalListIdForSortLookup = addonDetails.mdblistId || addonDetails.id;
  } else if (catalogIdFromRequest === 'random_mdblist_catalog') {
    originalListIdForSortLookup = 'random_mdblist_catalog';
  } else if (importedAddons) {
    for (const addon of Object.values(importedAddons)) {
      if (addon.isMDBListUrlImport || addon.isTraktPublicList) continue;
      const foundCatalog = addon.catalogs?.find(c => c.id === catalogIdFromRequest);
      if (foundCatalog) {
        originalListIdForSortLookup = foundCatalog.originalId;
        break;
      }
    }
  }
  const sortPrefs = sortPreferences?.[originalListIdForSortLookup] || {};
  let itemsResult;
  if (catalogIdFromRequest === 'random_mdblist_catalog' && enableRandomListFeature && randomMDBListUsernames?.length > 0) {
    const randomUsername = randomMDBListUsernames[Math.floor(Math.random() * randomMDBListUsernames.length)];
    if (apiKey) {
      const userLists = await fetchAllListsForUser(apiKey, randomUsername);
      if (userLists?.length > 0) {
        const randomUserList = userLists[Math.floor(Math.random() * userLists.length)];
        itemsResult = await fetchMDBListItems(randomUserList.slug || String(randomUserList.id), apiKey, {}, skip, sortPrefs.sort || 'default', sortPrefs.order || 'desc', false, genre, randomUsername, false, userConfig);
      }
    } else {
        // Public fallback logic for random lists
    }
  } else if (isUrlImport) {
    if (addonDetails.isTraktPublicList) {
      itemsResult = await fetchTraktListItems(addonDetails.id, userConfig, skip, sortPrefs.sort || 'rank', sortPrefs.order || 'asc', true, addonDetails.traktUser, itemTypeHintForFetching, genre);
    } else if (addonDetails.isMDBListUrlImport) {
      const isListUserMerged = userConfig.mergedLists?.[catalogIdFromRequest] !== false;
      if (apiKey) {
        itemsResult = await fetchMDBListItems(addonDetails.mdblistId || addonDetails.id, apiKey, listsMetadata, skip, sortPrefs.sort || 'default', sortPrefs.order || 'desc', true, genre, null, isListUserMerged, userConfig);
      } else if (addonDetails.mdblistUsername && addonDetails.mdblistSlug) {
        const { fetchListItemsFromPublicJson } = require('../integrations/mdblist');
        itemsResult = await fetchListItemsFromPublicJson(addonDetails.mdblistUsername, addonDetails.mdblistSlug, skip, sortPrefs.sort || 'rank', sortPrefs.order || 'asc', genre, userConfig, isListUserMerged);
      }
    }
  } else if (importedAddons) {
    for (const parentAddon of Object.values(importedAddons)) {
      if (parentAddon.isMDBListUrlImport || parentAddon.isTraktPublicList) continue;
      const catalogEntry = parentAddon.catalogs?.find(c => String(c.id) === catalogIdFromRequest);
      if (catalogEntry) {
        const externalResult = await fetchExternalAddonItems(catalogEntry.originalId, catalogEntry.originalType, parentAddon, skip, rpdbApiKey, genre, userConfig);
        if (externalResult?.metas) itemsResult = { allItems: externalResult.metas, hasMovies: externalResult.hasMovies, hasShows: externalResult.hasShows };
        break;
      }
    }
  } else if (catalogIdFromRequest.startsWith('trakt_') && !catalogIdFromRequest.startsWith('traktpublic_') && traktAccessToken) {
    let actualTraktItemTypeHint = itemTypeHintForFetching;
    if (itemTypeHintForFetching === 'all' && (catalogIdFromRequest.includes("_movies") || catalogIdFromRequest.includes("_shows"))) {
        actualTraktItemTypeHint = catalogIdFromRequest.includes("_movies") ? 'movie' : 'series';
    }
    itemsResult = await fetchTraktListItems(catalogIdFromRequest, userConfig, skip, sortPrefs.sort || 'rank', sortPrefs.order || 'asc', false, null, actualTraktItemTypeHint, genre);
  } else if (catalogIdFromRequest.startsWith('tmdb_') && userConfig.tmdbSessionId) {
    const { fetchTmdbListItems } = require('../integrations/tmdb');
    itemsResult = await fetchTmdbListItems(catalogIdFromRequest, userConfig, skip, sortPrefs.sort || 'created_at', sortPrefs.order || 'desc', genre);
  } else if (apiKey && catalogIdFromRequest.startsWith('aiolists-')) {
    const match = catalogIdFromRequest.match(/^aiolists-([^-]+(?:-[^-]+)*)-([ELW])$/);
    let mdbListOriginalId = match ? match[1] : catalogIdFromRequest.replace(/^aiolists-/, '').replace(/-[ELW]$/, '');
    if (catalogIdFromRequest === 'aiolists-watchlist-W') mdbListOriginalId = 'watchlist';
    const isListUserMerged = userConfig.mergedLists?.[catalogIdFromRequest] !== false;
    itemsResult = await fetchMDBListItems(mdbListOriginalId, apiKey, listsMetadata, skip, sortPrefs.sort || 'default', sortPrefs.order || 'desc', false, genre, null, isListUserMerged, userConfig);
  }
  return itemsResult || null;
}

async function createAddon(userConfig) {
  if (ENABLE_MANIFEST_CACHE) {
    const cacheKey = getManifestCacheKey(userConfig);
    const cachedManifest = manifestCache.get(cacheKey);
    if (cachedManifest && (Date.now() - cachedManifest.timestamp) < MANIFEST_CACHE_TTL) return cachedManifest.addon;
  }
  await initTraktApi(userConfig);
  const manifest = { id: 'org.stremio.aiolists', version: `1.2.7-${Date.now()}`, name: 'AIOLists', description: 'Manage all your lists in one place.', resources: ['catalog', 'meta'], types: [], idPrefixes: ['tt', 'tmdb:'], catalogs: [], logo: `https://i.imgur.com/DigFuAQ.png`, behaviorHints: { configurable: true, configurationRequired: false } };
  const { apiKey, traktAccessToken, listOrder = [], hiddenLists = [], removedLists = [], customListNames = {}, customMediaTypeNames = {}, mergedLists = {}, importedAddons = {}, enableRandomListFeature, randomMDBListUsernames, disableGenreFilter } = userConfig;
  const allKnownTypes = new Set(['movie', 'series', 'all']);
  if ((userConfig.mergedSearchSources || []).includes('tmdb') && (userConfig.tmdbBearerToken || require('../config').TMDB_BEARER_TOKEN)) allKnownTypes.add('search');
  if (userConfig.animeSearchEnabled) allKnownTypes.add('anime');
  Object.values(userConfig.customMediaTypeNames || {}).forEach(type => { if (type) allKnownTypes.add(type); });
  if (userConfig.importedAddons) {
      Object.values(userConfig.importedAddons).forEach(addon => {
          addon.catalogs?.forEach(catalog => { if (catalog.type) allKnownTypes.add(catalog.type.toLowerCase()); });
          addon.types?.forEach(type => { if (type) allKnownTypes.add(type.toLowerCase()); });
      });
  }
  manifest.types = Array.from(allKnownTypes);
  const includeGenresInManifest = !disableGenreFilter;
  const hiddenListsSet = new Set(hiddenLists.map(String));
  const removedListsSet = new Set(removedLists.map(String));
  let availableGenres = staticGenres;
  if ((userConfig.metadataSource === 'tmdb' || (userConfig.tmdbLanguage && userConfig.tmdbLanguage !== 'en-US')) && userConfig.tmdbBearerToken) {
    try {
      const { fetchTmdbGenres } = require('../integrations/tmdb');
      const tmdbGenres = await fetchTmdbGenres(userConfig.tmdbLanguage || 'en-US', userConfig.tmdbBearerToken);
      if (tmdbGenres.length > 0) availableGenres = tmdbGenres;
    } catch (error) {
      console.warn('Failed to fetch TMDB genres, falling back to static genres:', error.message);
    }
  }
  let tempGeneratedCatalogs = [];
  if (enableRandomListFeature && randomMDBListUsernames?.length > 0) {
    const randomCatalogId = 'random_mdblist_catalog';
    let randomCatalogDisplayName = getManifestCatalogName(randomCatalogId, "Discovery", customListNames);
    if (customMediaTypeNames?.[randomCatalogId]) randomCatalogDisplayName = customMediaTypeNames[randomCatalogId];
    if (!apiKey) randomCatalogDisplayName += " (Public)";
    const randomCatalogExtra = [{ name: "skip" }];
    if (includeGenresInManifest) randomCatalogExtra.push({ name: "genre", options: availableGenres, isRequired: false });
    tempGeneratedCatalogs.push({ id: randomCatalogId, type: customMediaTypeNames?.[randomCatalogId] || 'all', name: randomCatalogDisplayName, extra: randomCatalogExtra, extraSupported: randomCatalogExtra.map(e => e.name) });
  }
  let activeListsInfo = [];
  if (apiKey) activeListsInfo.push(...(await fetchAllMDBLists(apiKey)).map(l => ({ ...l, source: 'mdblist', originalId: String(l.id) })));
  if (traktAccessToken) activeListsInfo.push(...(await fetchTraktLists(userConfig)).map(l => ({ ...l, source: 'trakt', originalId: String(l.id) })));
  if (userConfig.tmdbSessionId && userConfig.tmdbAccountId) {
    try {
      const { fetchTmdbLists } = require('../integrations/tmdb');
      const tmdbResult = await fetchTmdbLists(userConfig);
      if (tmdbResult.isConnected && tmdbResult.lists?.length > 0) activeListsInfo.push(...tmdbResult.lists.map(l => ({ ...l, source: 'tmdb', originalId: String(l.id) })));
    } catch (error) {
      console.warn('Failed to fetch TMDB lists:', error.message);
    }
  }
  
  const processListForManifest = async (listSourceInfo, currentListId, isImportedSubCatalog = false) => {
    if (removedListsSet.has(currentListId) || hiddenListsSet.has(currentListId)) return;

    let displayName = getManifestCatalogName(currentListId, listSourceInfo.name, customListNames);
    const catalogExtra = [{ name: "skip" }];
    if (includeGenresInManifest) catalogExtra.push({ name: "genre", options: availableGenres, isRequired: false });
    const baseProps = { extra: catalogExtra, extraSupported: catalogExtra.map(e => e.name) };

    // --- START OF SIMPLIFIED LOGIC ---
    // Trust the hasMovies and hasShows flags from the initial fetch.
    const sourceHasMovies = !!listSourceInfo.hasMovies;
    const sourceHasShows = !!listSourceInfo.hasShows;
    const customUserDefinedType = customMediaTypeNames?.[currentListId];

    if (!sourceHasMovies && !sourceHasShows && !customUserDefinedType) {
        return; // Skip if no content and no custom type.
    }

    const isMergeable = sourceHasMovies && sourceHasShows;
    const isUserMerged = isMergeable && (mergedLists[currentListId] !== false);

    if (isUserMerged) {
        const catalogType = customUserDefinedType || 'all';
        tempGeneratedCatalogs.push({ id: currentListId, type: catalogType, name: displayName, ...baseProps });
    } else if (isMergeable) {
        if (sourceHasMovies) tempGeneratedCatalogs.push({ id: currentListId, type: 'movie', name: displayName, ...baseProps });
        if (sourceHasShows) tempGeneratedCatalogs.push({ id: currentListId, type: 'series', name: displayName, ...baseProps });
    } else {
        if (customUserDefinedType) {
            tempGeneratedCatalogs.push({ id: currentListId, type: customUserDefinedType, name: displayName, ...baseProps });
        } else if (sourceHasMovies) {
            tempGeneratedCatalogs.push({ id: currentListId, type: 'movie', name: displayName, ...baseProps });
        } else if (sourceHasShows) {
            tempGeneratedCatalogs.push({ id: currentListId, type: 'series', name: displayName, ...baseProps });
        }
    }
    // --- END OF SIMPLIFIED LOGIC ---
  };
  
  const chunks = [];
  for (let i = 0; i < activeListsInfo.length; i += MANIFEST_GENERATION_CONCURRENCY) {
    chunks.push(activeListsInfo.slice(i, i + MANIFEST_GENERATION_CONCURRENCY));
  }
  
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (listInfo) => {
      try {
        if (listInfo.source === 'mdblist') {
          const originalMdbListId = String(listInfo.id); 
          const listTypeSuffix = listInfo.listType || 'L';
          const fullManifestListId = originalMdbListId === 'watchlist' ? `aiolists-watchlist-W` : `aiolists-${originalMdbListId}-${listTypeSuffix}`; 
          await processListForManifest({ ...listInfo, id: fullManifestListId, originalId: originalMdbListId }, fullManifestListId, false);
        } else if (listInfo.source === 'trakt' || listInfo.source === 'tmdb') {
          await processListForManifest(listInfo, String(listInfo.id), false);
        }
      } catch (error) {
        console.error(`[AddonBuilder] Error processing list ${listInfo.id || listInfo.name}:`, error.message);
      }
    }));
  }
  
  for (const addon of Object.values(importedAddons || {})) {
    const addonGroupId = String(addon.id);
    if (removedListsSet.has(addonGroupId) || hiddenListsSet.has(addonGroupId)) continue;
    const isMDBListUrlImport = !!addon.isMDBListUrlImport;
    const isTraktPublicList = !!addon.isTraktPublicList;
    if (isMDBListUrlImport || isTraktPublicList) {
      await processListForManifest(addon, addonGroupId, false);
    } else if (addon.catalogs?.length > 0) { 
      for (const catalog of addon.catalogs) {
        await processListForManifest(catalog, String(catalog.id), true);
      }
    }
  }
  
  if (listOrder?.length > 0) {
    const orderMap = new Map(listOrder.map((id, index) => [String(id), index]));
    tempGeneratedCatalogs.sort((a, b) => {
        const indexA = orderMap.get(String(a.id));
        const indexB = orderMap.get(String(b.id));
        if (indexA !== undefined && indexB !== undefined) return indexA - indexB; 
        if (indexA !== undefined) return -1; 
        if (indexB !== undefined) return 1;  
        return 0;
    });
  }
  
  const userSearchSources = userConfig.searchSources || [];
  let hasValidSearchSources = userSearchSources.includes('cinemeta') || userSearchSources.includes('trakt') || (userSearchSources.includes('tmdb') && (userConfig.tmdbBearerToken || require('../config').TMDB_BEARER_TOKEN));
  if (hasValidSearchSources) {
    const searchCatalogExtra = [{ name: "search", isRequired: true }];
    tempGeneratedCatalogs.push({ id: 'aiolists_search_movies', type: 'movie', name: 'Search Movies', extra: searchCatalogExtra, extraSupported: searchCatalogExtra.map(e => e.name) });
    tempGeneratedCatalogs.push({ id: 'aiolists_search_series', type: 'series', name: 'Search Series', extra: searchCatalogExtra, extraSupported: searchCatalogExtra.map(e => e.name) });
  }

  const userMergedSearchSources = userConfig.mergedSearchSources || [];
  if (userMergedSearchSources.includes('tmdb') && (userConfig.tmdbBearerToken || require('../config').TMDB_BEARER_TOKEN)) {
    const mergedSearchCatalogExtra = [{ name: "search", isRequired: true }];
    tempGeneratedCatalogs.push({ id: 'aiolists_merged_search', type: 'search', name: 'Merged Search', extra: mergedSearchCatalogExtra, extraSupported: mergedSearchCatalogExtra.map(e => e.name) });
  }

  if (userConfig.animeSearchEnabled) {
    const animeSearchCatalogExtra = [{ name: "search", isRequired: true }];
    tempGeneratedCatalogs.push({ id: 'aiolists_anime_search', type: 'anime', name: 'Anime Search', extra: animeSearchCatalogExtra, extraSupported: animeSearchCatalogExtra.map(e => e.name) });
  }
  
  manifest.catalogs = tempGeneratedCatalogs;
  const builder = new addonBuilder(manifest);

  builder.defineCatalogHandler(async ({ type, id, extra }) => {
    const skip = parseInt(extra?.skip) || 0;
    const genre = extra?.genre || null;
    const searchQuery = extra?.search || null;
    if ((id.includes('_search')) && searchQuery) {      
      if (!searchQuery || searchQuery.trim().length < 2) return Promise.resolve({ metas: [] });
      try {
        const { searchContent } = require('../utils/searchEngine');
        let searchResults;
        if (id === 'aiolists_merged_search') {
          searchResults = await searchContent({ query: searchQuery.trim(), type: 'search', sources: ['multi'], limit: 50, userConfig: userConfig });
        } else if (id === 'aiolists_anime_search') {
          searchResults = await searchContent({ query: searchQuery.trim(), type: 'anime', sources: ['anime'], limit: 50, userConfig: userConfig });
        } else {
          const userSearchSources = userConfig.searchSources || [];
          let sources = userSearchSources.filter(s => s === 'cinemeta' || s === 'trakt' || (s === 'tmdb' && (userConfig.tmdbBearerToken || userConfig.tmdbSessionId)));
          if (sources.length === 0) return Promise.resolve({ metas: [] });
          searchResults = await searchContent({ query: searchQuery.trim(), type: type || 'all', sources: sources, limit: 50, userConfig: userConfig });
        }
        let filteredMetas = searchResults.results || [];
        if ((id === 'aiolists_search_movies' || id === 'aiolists_search_series') && type && type !== 'all' && type !== 'search') {
          filteredMetas = filteredMetas.filter(result => result.type === type);
        }
        if (genre && genre !== 'All') {
          filteredMetas = filteredMetas.filter(result => result.genres?.some(g => String(g).toLowerCase() === String(genre).toLowerCase()));
        }
        return Promise.resolve({ metas: filteredMetas, cacheMaxAge: 300 });
      } catch (error) {
        console.error(`[Search] Error in search catalog "${id}" for "${searchQuery}":`, error);
        return Promise.resolve({ metas: [] });
      }
    }
    const itemsResult = await fetchListContent(id, userConfig, skip, genre, type); 
    if (!itemsResult || !itemsResult.allItems) return Promise.resolve({ metas: [] });
    const enrichedItems = await enrichItemsWithMetadata(itemsResult.allItems, userConfig);
    const enrichedResult = { ...itemsResult, allItems: enrichedItems };
    const metadataConfig = { metadataSource: userConfig.metadataSource || 'cinemeta', tmdbLanguage: userConfig.tmdbLanguage || 'en-US' };
    let metas = await convertToStremioFormat(enrichedResult, userConfig.rpdbApiKey, metadataConfig);
    if (type === 'movie' || type === 'series') {
        metas = metas.filter(meta => meta.type === type);
    }
    if (genre && genre !== 'All' && metas.length > 0) {
        metas = metas.filter(meta => meta.genres?.some(g => String(g).toLowerCase() === String(genre).toLowerCase()));
    }
    const cacheMaxAge = (id === 'random_mdblist_catalog' || isWatchlist(id)) ? 0 : (5 * 60);
    return Promise.resolve({ metas, cacheMaxAge });
  });

  builder.defineMetaHandler(async ({ type, id }) => {
    try {
        if (!id.startsWith('tt') && !id.startsWith('tmdb:')) {
            return Promise.resolve({ meta: null });
        }
        const itemToEnrich = [{ id: id, type: type, imdb_id: id.startsWith('tt') ? id : undefined }];
        const enrichedItems = await enrichItemsWithMetadata(itemToEnrich, userConfig);
        if (enrichedItems && enrichedItems.length > 0) {
            const meta = enrichedItems[0];
            meta.id = id;
            Object.keys(meta).forEach(key => { if (meta[key] === undefined) delete meta[key]; });
            return Promise.resolve({ meta, cacheMaxAge: 24 * 60 * 60 });
        }
        console.error(`[MetaHandler] All metadata sources failed for ${id}`);
        return Promise.resolve({ meta: { id, type, name: "Details unavailable" } });
    } catch (error) {
        console.error(`Error in meta handler for ${id}:`, error);
        return Promise.resolve({ meta: { id, type, name: "Error loading details" } });
    }
  });

  const addonInterface = builder.getInterface();
  if (ENABLE_MANIFEST_CACHE) {
    const cacheKey = getManifestCacheKey(userConfig);
    manifestCache.set(cacheKey, { addon: addonInterface, timestamp: Date.now() });
    if (manifestCache.size > 5) manifestCache.delete(manifestCache.keys().next().value);
  }
  return addonInterface;
}

module.exports = { createAddon, fetchListContent };
