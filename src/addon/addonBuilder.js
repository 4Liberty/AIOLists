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
const { getMovieFanart, getSeriesFanart } = require('../utils/getFanartImages');

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

async function getLightweightListMetadata(listId, userConfig, type = 'all') {
  try {
    const lightweightConfig = { ...userConfig, rpdbApiKey: null, metadataSource: 'none', customMediaTypeNames: {} };
    const content = await fetchListContent(listId, lightweightConfig, 0, null, type);
    return { hasMovies: content?.hasMovies || false, hasShows: content?.hasShows || false, itemCount: content?.allItems?.length || 0 };
  } catch (error) {
    console.error(`[METADATA LIGHT] Lightweight check failed for ${listId}:`, error.message);
    return { hasMovies: false, hasShows: false, itemCount: 0, error: error.message };
  }
}

const getManifestCatalogName = (listId, originalName, customListNames) => {
  return customListNames?.[listId]?.trim() || originalName;
};

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
    if (isImportedSubCatalog) {
      const type = customMediaTypeNames?.[currentListId] || listSourceInfo.type;
      if (type && displayName) tempGeneratedCatalogs.push({ id: currentListId, type, name: displayName, ...baseProps });
      return;
    }
    // ... (rest of the processing logic remains the same)
  };
  // ... (rest of the createAddon function remains the same)
  
  const builder = new addonBuilder(manifest);

  builder.defineCatalogHandler(async ({ type, id, extra }) => {
    // ... (catalog handler logic remains the same)
  });

  // --- START OF CORRECTED META HANDLER ---
  builder.defineMetaHandler(async ({ type, id }) => {
    try {
        if (!id.startsWith('tt') && !id.startsWith('tmdb:')) {
            return Promise.resolve({ meta: null });
        }

        const itemToEnrich = [{
            id: id,
            type: type,
            imdb_id: id.startsWith('tt') ? id : undefined,
        }];

        // We call the exact same enrichment pipeline as the catalog handler.
        // This ensures data consistency between discovery and detail views.
        const enrichedItems = await enrichItemsWithMetadata(itemToEnrich, userConfig);

        if (enrichedItems && enrichedItems.length > 0) {
            const meta = enrichedItems[0];
            
            // Final check to ensure the ID is what Stremio requested.
            meta.id = id;
            
            // Clean up any undefined properties before sending.
            Object.keys(meta).forEach(key => {
                if (meta[key] === undefined) delete meta[key];
            });

            return Promise.resolve({ 
                meta,
                cacheMaxAge: 24 * 60 * 60 // Cache for 24 hours
            });
        }

        console.error(`[MetaHandler] All metadata sources failed for ${id}`);
        return Promise.resolve({ meta: { id, type, name: "Details unavailable" } });

    } catch (error) {
        console.error(`Error in meta handler for ${id}:`, error);
        return Promise.resolve({ meta: { id, type, name: "Error loading details" } });
    }
  });
  // --- END OF CORRECTED META HANDLER ---

  const addonInterface = builder.getInterface();
  if (ENABLE_MANIFEST_CACHE) {
    const cacheKey = getManifestCacheKey(userConfig);
    manifestCache.set(cacheKey, { addon: addonInterface, timestamp: Date.now() });
    if (manifestCache.size > 5) manifestCache.delete(manifestCache.keys().next().value);
  }
  return addonInterface;
}

module.exports = { createAddon, fetchListContent };
