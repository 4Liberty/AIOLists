// src/addon/addonBuilder.js
const { addonBuilder } = require('stremio-addon-sdk');
const { fetchTraktListItems, fetchTraktLists, initTraktApi } = require('../integrations/trakt');
const { fetchListItems: fetchMDBListItems, fetchAllLists: fetchAllMDBLists, fetchAllListsForUser } = require('../integrations/mdblist');
const { fetchExternalAddonItems } = require('../integrations/externalAddons');
const { convertToStremioFormat } = require('./converters');
const { isWatchlist } = require('../utils/common');
const { staticGenres, MANIFEST_GENERATION_CONCURRENCY, ENABLE_MANIFEST_CACHE } = require('../config');
const axios = require('axios');
const { enrichItemsWithMetadata } = require('../utils/metadataFetcher'); // Import the main enrichment function

// Cache for manifest generation to avoid re-processing unchanged lists
const manifestCache = new Map();
const MANIFEST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getManifestCacheKey(userConfig) {
  // Create a hash-like key from user configuration that affects manifest generation
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
    tmdbLanguage: userConfig.tmdbLanguage, // Include language in cache key
    tmdbBearerToken: !!userConfig.tmdbBearerToken, // Include token presence in cache key
    // Include search settings in cache key - CRITICAL for search catalog generation
    searchSources: userConfig.searchSources || [],
    mergedSearchSources: userConfig.mergedSearchSources || [],
    animeSearchEnabled: userConfig.animeSearchEnabled || false
  };
  return JSON.stringify(cacheableConfig);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const METADATA_FETCH_RETRY_DELAY_MS = 2000; // Reduced from 5000
const MAX_METADATA_FETCH_RETRIES = 2;
// Removed DELAY_BETWEEN_DIFFERENT_TRAKT_LISTS_MS as we are removing artificial delays

// ... (The rest of the file is the same as the last version you received, I'll include the full code for completeness)
async function getLightweightListMetadata(listId, userConfig, type = 'all') {
  const startTime = Date.now();
  
  try {
    const lightweightConfig = {
      ...userConfig,
      rpdbApiKey: null,
      metadataSource: 'none',
      customMediaTypeNames: {}
    };
    
    const content = await fetchListContent(listId, lightweightConfig, 0, null, type);
    
      const endTime = Date.now();
  
  return {
      hasMovies: content?.hasMovies || false,
      hasShows: content?.hasShows || false,
      itemCount: content?.allItems?.length || 0
    };
  } catch (error) {
    const endTime = Date.now();
    console.error(`[METADATA LIGHT] Lightweight check failed in ${endTime - startTime}ms for ${listId}:`, error.message);
    return {
      hasMovies: false,
      hasShows: false,
      itemCount: 0,
      error: error.message
    };
  }
}

const getManifestCatalogName = (listId, originalName, customListNames) => {
  const customPencilName = customListNames?.[listId]?.trim();
  if (customPencilName) {
    return customPencilName;
  }
  return originalName;
};

async function fetchListContent(listId, userConfig, skip = 0, genre = null, stremioCatalogType = 'all') {
  const fetchContentStartTime = Date.now();
  
  const catalogIdFromRequest = String(listId);

  if (catalogIdFromRequest.startsWith('trakt_') && !catalogIdFromRequest.startsWith('traktpublic_')) {
    await initTraktApi(userConfig);
  }

  const { apiKey, traktAccessToken, listsMetadata = {}, sortPreferences = {}, importedAddons = {}, rpdbApiKey, randomMDBListUsernames, enableRandomListFeature, customMediaTypeNames = {} } = userConfig;
  
  let itemTypeHintForFetching = (stremioCatalogType === 'movie' || stremioCatalogType === 'series') ? stremioCatalogType : 'all';

  let originalListIdForSortLookup = catalogIdFromRequest;
  const addonDetails = importedAddons?.[catalogIdFromRequest];
  const isUrlImport = addonDetails && (addonDetails.isMDBListUrlImport || addonDetails.isTraktPublicList);

  if (catalogIdFromRequest.startsWith('aiolists-') && (catalogIdFromRequest.includes('-L') || catalogIdFromRequest.includes('-E') || catalogIdFromRequest.includes('-W'))) {
    const parts = catalogIdFromRequest.split('-');
    if (parts.length >= 2) originalListIdForSortLookup = parts[1] === 'watchlist' ? 'watchlist' : parts[1];
  } else if (isUrlImport) {
    if (addonDetails.isMDBListUrlImport) originalListIdForSortLookup = addonDetails.mdblistId;
    else if (addonDetails.isTraktPublicList) originalListIdForSortLookup = addonDetails.id; 
    else originalListIdForSortLookup = addonDetails.id;
  } else if (catalogIdFromRequest === 'random_mdblist_catalog') {
    originalListIdForSortLookup = 'random_mdblist_catalog';
  } else if (importedAddons) {
      let found = false;
      for (const addon of Object.values(importedAddons)) {
          if (addon.isMDBListUrlImport || addon.isTraktPublicList) continue;
          const foundCatalog = addon.catalogs?.find(c => c.id === catalogIdFromRequest);
          if (foundCatalog) {
              originalListIdForSortLookup = foundCatalog.originalId;
              found = true;
              break;
          }
      }
      if (!found && !originalListIdForSortLookup.startsWith('trakt_') && originalListIdForSortLookup !== 'random_mdblist_catalog') {
        originalListIdForSortLookup = catalogIdFromRequest;
      }
  }

  const sortPrefsForImportedOrRandom = userConfig.sortPreferences?.[originalListIdForSortLookup] ||
                               ( (catalogIdFromRequest.startsWith('traktpublic_') || (addonDetails?.isTraktPublicList && originalListIdForSortLookup?.startsWith('traktpublic_'))) ?
                                 { sort: 'rank', order: 'asc' } : { sort: 'default', order: 'desc' } );

  let itemsResult;

  if (catalogIdFromRequest === 'random_mdblist_catalog' && enableRandomListFeature && randomMDBListUsernames && randomMDBListUsernames.length > 0) {
    const randomUsername = randomMDBListUsernames[Math.floor(Math.random() * randomMDBListUsernames.length)];
    
    if (apiKey) {
      const userLists = await fetchAllListsForUser(apiKey, randomUsername);
      if (userLists && userLists.length > 0) {
        const randomUserList = userLists[Math.floor(Math.random() * userLists.length)];
        const listIdentifierToFetch = randomUserList.slug || String(randomUserList.id);
        const randomCatalogSortPrefs = sortPreferences?.['random_mdblist_catalog'] || { sort: 'default', order: 'desc' };
        itemsResult = await fetchMDBListItems( listIdentifierToFetch, apiKey, {}, skip, randomCatalogSortPrefs.sort, randomCatalogSortPrefs.order, false, genre, randomUsername, false, userConfig );
      } else {
        itemsResult = { allItems: [], hasMovies: false, hasShows: false };
      }
    } else {
      const popularListSlugs = [
        'latest-tv-shows', 'top-rated-movies-2024', 'latest-movies', 'popular-series', 
        'trending-movies', 'best-sci-fi-movies', 'top-horror-movies', 'classic-movies',
        'marvel-movies', 'disney-movies', 'netflix-series', 'hbo-series'
      ];
      
      const randomListSlug = popularListSlugs[Math.floor(Math.random() * popularListSlugs.length)];
      const randomCatalogSortPrefs = sortPreferences?.['random_mdblist_catalog'] || { sort: 'rank', order: 'asc' };
      
      const { fetchListItemsFromPublicJson } = require('../integrations/mdblist');
      itemsResult = await fetchListItemsFromPublicJson(randomUsername, randomListSlug, skip, randomCatalogSortPrefs.sort, randomCatalogSortPrefs.order, genre, userConfig, false);
      
      if (!itemsResult) {
        const altUsername = randomMDBListUsernames[Math.floor(Math.random() * randomMDBListUsernames.length)];
        const altListSlug = popularListSlugs[Math.floor(Math.random() * popularListSlugs.length)];
        itemsResult = await fetchListItemsFromPublicJson(altUsername, altListSlug, skip, randomCatalogSortPrefs.sort, randomCatalogSortPrefs.order, genre, userConfig, false);
      }
      
      if (!itemsResult) {
        itemsResult = { allItems: [], hasMovies: false, hasShows: false };
      }
    }
  }

  if (!itemsResult && isUrlImport) {
    const addonConfig = importedAddons[catalogIdFromRequest];
    if (addonConfig.isTraktPublicList) {
      itemsResult = await fetchTraktListItems( addonConfig.id, userConfig, skip, sortPrefsForImportedOrRandom.sort, sortPrefsForImportedOrRandom.order, true, addonConfig.traktUser, itemTypeHintForFetching, genre );
    } else if (addonConfig.isMDBListUrlImport) {
      if (apiKey && addonConfig.mdblistId) {
        const isListUserMerged = userConfig.mergedLists?.[catalogIdFromRequest] !== false;
        itemsResult = await fetchMDBListItems( addonConfig.mdblistId, apiKey, listsMetadata, skip, sortPrefsForImportedOrRandom.sort, sortPrefsForImportedOrRandom.order, true, genre, null, isListUserMerged, userConfig );
      } else if (apiKey) {
        const listIdForApi = addonConfig.mdblistId || addonConfig.listId;
        const isListUserMerged = userConfig.mergedLists?.[catalogIdFromRequest] !== false;
        itemsResult = await fetchMDBListItems( listIdForApi, apiKey, listsMetadata, skip, sortPrefsForImportedOrRandom.sort, sortPrefsForImportedOrRandom.order, true, genre, null, isListUserMerged, userConfig );
      } else if (addonConfig.mdblistUsername && addonConfig.mdblistSlug) {
        const { fetchListItemsFromPublicJson } = require('../integrations/mdblist');
        const isListUserMerged = userConfig.mergedLists?.[catalogIdFromRequest] !== false;
        itemsResult = await fetchListItemsFromPublicJson(
          addonConfig.mdblistUsername, 
          addonConfig.mdblistSlug, 
          skip, 
          sortPrefsForImportedOrRandom.sort, 
          sortPrefsForImportedOrRandom.order, 
          genre, 
          userConfig,
          isListUserMerged
        );
      }
    }
  }

  if (!itemsResult && importedAddons) {
    for (const parentAddon of Object.values(importedAddons)) {
      if (parentAddon.isMDBListUrlImport || parentAddon.isTraktPublicList) continue;
      const catalogEntry = parentAddon.catalogs?.find(c => String(c.id) === String(catalogIdFromRequest));
      if (catalogEntry) {
        const externalResult = await fetchExternalAddonItems( catalogEntry.originalId, catalogEntry.originalType, parentAddon, skip, rpdbApiKey, genre, userConfig );
        if (externalResult && externalResult.metas) {
          itemsResult = {
            allItems: externalResult.metas,
            hasMovies: externalResult.hasMovies,
            hasShows: externalResult.hasShows
          };
        }
        break;
      }
    }
  }

  if (!itemsResult && catalogIdFromRequest.startsWith('trakt_') && !catalogIdFromRequest.startsWith('traktpublic_') && traktAccessToken) {
    let sortPrefs = sortPreferences?.[originalListIdForSortLookup] || (catalogIdFromRequest.startsWith('trakt_watchlist') ? { sort: 'added', order: 'desc'} : { sort: 'rank', order: 'asc' });
    if (catalogIdFromRequest === 'trakt_watchlist' && itemTypeHintForFetching === 'all') { sortPrefs.sort = 'added'; } 
    
    let actualTraktItemTypeHint = itemTypeHintForFetching;
    if (itemTypeHintForFetching === 'all') {
        if (catalogIdFromRequest.includes("_movies")) actualTraktItemTypeHint = 'movie';
        else if (catalogIdFromRequest.includes("_shows")) actualTraktItemTypeHint = 'series';
    }
    itemsResult = await fetchTraktListItems( catalogIdFromRequest, userConfig, skip, sortPrefs.sort, sortPrefs.order, false, null, actualTraktItemTypeHint, genre );
  }

  if (!itemsResult && catalogIdFromRequest.startsWith('tmdb_') && userConfig.tmdbSessionId) {
    const { fetchTmdbListItems } = require('../integrations/tmdb');
    let sortPrefs = sortPreferences?.[originalListIdForSortLookup] || { sort: 'created_at', order: 'desc' };
    itemsResult = await fetchTmdbListItems(catalogIdFromRequest, userConfig, skip, sortPrefs.sort, sortPrefs.order, genre);
  }

  if (!itemsResult && apiKey && catalogIdFromRequest.startsWith('aiolists-')) {
    const match = catalogIdFromRequest.match(/^aiolists-([^-]+(?:-[^-]+)*)-([ELW])$/);
    let mdbListOriginalIdFromCatalog = match ? match[1] : catalogIdFromRequest.replace(/^aiolists-/, '').replace(/-[ELW]$/, '');
    if (catalogIdFromRequest === 'aiolists-watchlist-W') { mdbListOriginalIdFromCatalog = 'watchlist'; }
    const mdbListSortPrefs = sortPreferences?.[mdbListOriginalIdFromCatalog] || { sort: 'default', order: 'desc' };
    let sortForMdbList = mdbListSortPrefs.sort;
    if (mdbListOriginalIdFromCatalog === 'watchlist' && itemTypeHintForFetching === 'all') { sortForMdbList = 'added'; }
    const isListUserMerged = userConfig.mergedLists?.[catalogIdFromRequest] !== false;
    itemsResult = await fetchMDBListItems( mdbListOriginalIdFromCatalog, apiKey, listsMetadata, skip, sortForMdbList, mdbListSortPrefs.order, false, genre, null, isListUserMerged, userConfig );
  }
  const finalResult = itemsResult || null;
  return finalResult;
}

async function createAddon(userConfig) {
  const startTime = Date.now();
  
  if (ENABLE_MANIFEST_CACHE) {
    const cacheKey = getManifestCacheKey(userConfig);
    const cachedManifest = manifestCache.get(cacheKey);
    
    if (cachedManifest && (Date.now() - cachedManifest.timestamp) < MANIFEST_CACHE_TTL) {
      return cachedManifest.addon;
    }
  }
  
  await initTraktApi(userConfig);
  const manifest = {
    id: 'org.stremio.aiolists',
    version: `1.2.7-${Date.now()}`,
    name: 'AIOLists',
    description: 'Manage all your lists in one place.',
    resources: ['catalog', 'meta'],
    types: [],
    idPrefixes: ['tt', 'tmdb:'],
    catalogs: [],
    logo: `https://i.imgur.com/DigFuAQ.png`,
    behaviorHints: { configurable: true, configurationRequired: false }
  };

  const {
    apiKey, traktAccessToken, listOrder = [], hiddenLists = [], removedLists = [],
    customListNames = {}, customMediaTypeNames = {}, mergedLists = {}, importedAddons = {}, listsMetadata = {},
    disableGenreFilter, enableRandomListFeature, randomMDBListUsernames
  } = userConfig;

  const allKnownTypes = new Set(['movie', 'series', 'all']);

  const searchSources = userConfig.searchSources || [];
  const mergedSearchSources = userConfig.mergedSearchSources || [];
  
  if (mergedSearchSources.includes('tmdb') && (userConfig.tmdbBearerToken || require('../config').TMDB_BEARER_TOKEN)) {
    allKnownTypes.add('search');
  }
  
  if (userConfig.animeSearchEnabled === true) {
    allKnownTypes.add('anime');
  }

  Object.values(userConfig.customMediaTypeNames || {}).forEach(type => {
      if (type && typeof type === 'string') {
          allKnownTypes.add(type);
      }
  });

  if (userConfig.importedAddons) {
      Object.values(userConfig.importedAddons).forEach(addon => {
          if (addon.catalogs && Array.isArray(addon.catalogs)) {
              addon.catalogs.forEach(catalog => {
                  if (catalog.type && typeof catalog.type === 'string') {
                      allKnownTypes.add(catalog.type.toLowerCase());
                  }
              });
          }
          if (addon.types && Array.isArray(addon.types)) {
              addon.types.forEach(type => {
                   if (type && typeof type === 'string') {
                      allKnownTypes.add(type.toLowerCase());
                  }
              });
          }
      });
  }
  manifest.types = Array.from(allKnownTypes);

  const includeGenresInManifest = !disableGenreFilter;
  const hiddenListsSet = new Set(hiddenLists.map(String));
  const removedListsSet = new Set(removedLists.map(String));
  
  const shouldUseTmdbGenres = userConfig.metadataSource === 'tmdb' && userConfig.tmdbLanguage && userConfig.tmdbBearerToken;
  const shouldUseTmdbLanguageGenres = userConfig.tmdbLanguage && userConfig.tmdbLanguage !== 'en-US' && userConfig.tmdbBearerToken;
  let availableGenres = staticGenres;
  
  if (shouldUseTmdbGenres || shouldUseTmdbLanguageGenres) {
    try {
      const { fetchTmdbGenres } = require('../integrations/tmdb');
      const genreLanguage = userConfig.tmdbLanguage || 'en-US';
      
      const tmdbGenres = await Promise.race([
        fetchTmdbGenres(genreLanguage, userConfig.tmdbBearerToken),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TMDB genres timeout')), 5000))
      ]);
      if (tmdbGenres.length > 0) {
        availableGenres = tmdbGenres;
      }
    } catch (error) {
      console.warn('Failed to fetch TMDB genres, falling back to static genres:', error.message);
    }
  }
  
  let tempGeneratedCatalogs = [];

  if (enableRandomListFeature && randomMDBListUsernames && randomMDBListUsernames.length > 0) {
    const randomCatalogId = 'random_mdblist_catalog';
    let randomCatalogDisplayName = getManifestCatalogName(randomCatalogId, "Discovery", customListNames);
     if (customMediaTypeNames?.[randomCatalogId]){
        randomCatalogDisplayName = customMediaTypeNames[randomCatalogId];
     }
    
    if (!apiKey) {
      randomCatalogDisplayName += " (Public)";
    }
    
    const randomCatalogExtra = [{ name: "skip" }];
    if (includeGenresInManifest) {
        randomCatalogExtra.push({ name: "genre", options: availableGenres, isRequired: false });
    }
    tempGeneratedCatalogs.push({
        id: randomCatalogId,
        type: customMediaTypeNames?.[randomCatalogId] || 'all',
        name: randomCatalogDisplayName,
        extra: randomCatalogExtra,
        extraSupported: randomCatalogExtra.map(e => e.name)
    });
  }

  let activeListsInfo = [];
  if (apiKey) {
    const mdbLists = await fetchAllMDBLists(apiKey);
    activeListsInfo.push(...mdbLists.map(l => ({ ...l, source: 'mdblist', originalId: String(l.id) })));
  }
  if (traktAccessToken) {
    const traktFetchedLists = await fetchTraktLists(userConfig);
    activeListsInfo.push(...traktFetchedLists.map(l => ({ ...l, source: 'trakt', originalId: String(l.id) })));
  }
  
  if (userConfig.tmdbSessionId && userConfig.tmdbAccountId) {
    try {
      const { fetchTmdbLists } = require('../integrations/tmdb');
      const tmdbResult = await Promise.race([
        fetchTmdbLists(userConfig),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TMDB lists timeout')), 5000))
      ]);
      if (tmdbResult.isConnected && tmdbResult.lists && tmdbResult.lists.length > 0) {
        activeListsInfo.push(...tmdbResult.lists.map(l => ({ ...l, source: 'tmdb', originalId: String(l.id) })));
      }
    } catch (error) {
      console.warn('Failed to fetch TMDB lists:', error.message);
    }
  }
  
  const processListForManifest = async (listSourceInfo, currentListId, isImportedSubCatalog = false, parentAddon = null) => {
    if (removedListsSet.has(currentListId) || hiddenListsSet.has(currentListId)) {
        return;
    }

    let originalName = listSourceInfo.name;
    let displayName = getManifestCatalogName(currentListId, originalName, customListNames);

    const catalogExtraForThisList = [{ name: "skip" }];
    if (includeGenresInManifest) {
        let genreOpts = availableGenres;
        if (isImportedSubCatalog && listSourceInfo.extraSupported && Array.isArray(listSourceInfo.extraSupported)) {
            const genreExtraDef = listSourceInfo.extraSupported.find(e => typeof e === 'object' && e.name === 'genre');
            if (genreExtraDef && Array.isArray(genreExtraDef.options) && genreExtraDef.options.length > 0) {
                genreOpts = genreExtraDef.options;
            }
        }
        catalogExtraForThisList.push({ name: "genre", options: genreOpts, isRequired: false });
    }

    const baseCatalogProps = {
        extra: catalogExtraForThisList,
        extraSupported: catalogExtraForThisList.map(e => e.name),
    };

    if (isImportedSubCatalog) {
        const manifestCatalogType = customMediaTypeNames?.[currentListId] || listSourceInfo.type;
        if (!manifestCatalogType || !displayName) return;
        tempGeneratedCatalogs.push({ id: currentListId, type: manifestCatalogType, name: displayName, ...baseCatalogProps });
        return; 
    }

    let sourceHasMovies, sourceHasShows;
    if (listSourceInfo.source === 'mdblist' || listSourceInfo.source === 'mdblist_url') {
      let metadata = userConfig.listsMetadata[currentListId] || userConfig.listsMetadata[listSourceInfo.originalId] || {};
      sourceHasMovies = listSourceInfo.hasMovies || metadata.hasMovies === true;
      sourceHasShows = listSourceInfo.hasShows || metadata.hasShows === true;
  } else if (listSourceInfo.source === 'trakt_public') {
      sourceHasMovies = listSourceInfo.hasMovies;
      sourceHasShows = listSourceInfo.hasShows;
  } else if (listSourceInfo.source === 'trakt') {
      let metadata = userConfig.listsMetadata[currentListId] || userConfig.listsMetadata[listSourceInfo.originalId] || {};
      sourceHasMovies = metadata.hasMovies === true;
      sourceHasShows = metadata.hasShows === true;
      if (listSourceInfo.source === 'trakt' && (typeof metadata.hasMovies !== 'boolean' || typeof metadata.hasShows !== 'boolean' || metadata.errorFetching) && traktAccessToken) {
            let success = false; let fetchRetries = 0; if(metadata.errorFetching) delete metadata.errorFetching;
            while (!success && fetchRetries < MAX_METADATA_FETCH_RETRIES) {
                try {
                    const tempUserConfigForMetadata = { ...userConfig, listsMetadata: {}, rpdbApiKey: null, customMediaTypeNames: {} };
                    let typeForMetaCheck = 'all';
                     if (currentListId.startsWith('trakt_recommendations_') || currentListId.startsWith('trakt_trending_') || currentListId.startsWith('trakt_popular_')) {
                        if (currentListId.includes("_shows")) typeForMetaCheck = 'series'; else if (currentListId.includes("_movies")) typeForMetaCheck = 'movie';
                    }
                    if (currentListId === 'trakt_watchlist') typeForMetaCheck = 'all';
                    const content = await fetchListContent(currentListId, tempUserConfigForMetadata, 0, null, typeForMetaCheck);
                    sourceHasMovies = content?.hasMovies || false;
                    sourceHasShows = content?.hasShows || false;
                    userConfig.listsMetadata[currentListId] = { ...(userConfig.listsMetadata[currentListId] || {}), hasMovies: sourceHasMovies, hasShows: sourceHasShows, lastChecked: new Date().toISOString() };
                    delete userConfig.listsMetadata[currentListId].errorFetching;
                    success = true;
                } catch (error) {
                    fetchRetries++;
                    if (fetchRetries >= MAX_METADATA_FETCH_RETRIES) {
                        const fallbackMeta = userConfig.listsMetadata[currentListId] || {};
                        sourceHasMovies = fallbackMeta.hasMovies || false;
                        sourceHasShows = fallbackMeta.hasShows || false;
                        userConfig.listsMetadata[currentListId] = { ...fallbackMeta, errorFetching: true, lastChecked: new Date().toISOString() };
                    } else { 
                        await delay(METADATA_FETCH_RETRY_DELAY_MS * Math.pow(2, fetchRetries - 1)); 
                    }
                }
            }
        }
    } else if (listSourceInfo.source === 'tmdb') {
      sourceHasMovies = listSourceInfo.hasMovies || false;
      sourceHasShows = listSourceInfo.hasShows || false;
    } else {
        sourceHasMovies = listSourceInfo.hasMovies || false;
        sourceHasShows = listSourceInfo.hasShows || false;
    }

    const sourceIsStructurallyMergeable = sourceHasMovies && sourceHasShows;
    const customUserDefinedType = customMediaTypeNames?.[currentListId];
    
    if (!sourceHasMovies && !sourceHasShows && !customUserDefinedType) {
        if (listSourceInfo.type !== 'all' || (listSourceInfo.type === 'all' && (listSourceInfo.hasMovies === false && listSourceInfo.hasShows === false))) {
             return;
        }
    }
    
    const isUserMerged = sourceIsStructurallyMergeable ? (mergedLists[currentListId] !== false) : false;

    if (isUserMerged && sourceIsStructurallyMergeable) {
        const catalogType = customUserDefinedType || 'all';
        tempGeneratedCatalogs.push({ id: currentListId, type: catalogType, name: displayName, ...baseCatalogProps });
    } else if (!isUserMerged && sourceIsStructurallyMergeable) {
        if (sourceHasMovies) tempGeneratedCatalogs.push({ id: currentListId, type: 'movie', name: displayName, ...baseCatalogProps });
        if (sourceHasShows) tempGeneratedCatalogs.push({ id: currentListId, type: 'series', name: displayName, ...baseCatalogProps });
    } else {
        if (customUserDefinedType) {
             tempGeneratedCatalogs.push({ id: currentListId, type: customUserDefinedType, name: displayName, ...baseCatalogProps });
        } else {
            if (sourceHasMovies) tempGeneratedCatalogs.push({ id: currentListId, type: 'movie', name: displayName, ...baseCatalogProps });
            else if (sourceHasShows) tempGeneratedCatalogs.push({ id: currentListId, type: 'series', name: displayName, ...baseCatalogProps });
            else if (listSourceInfo.type === 'all' && !customUserDefinedType) tempGeneratedCatalogs.push({ id: currentListId, type: 'all', name: displayName, ...baseCatalogProps });
        }
    }
  };
  
  const chunks = [];
  for (let i = 0; i < activeListsInfo.length; i += MANIFEST_GENERATION_CONCURRENCY) {
    chunks.push(activeListsInfo.slice(i, i + MANIFEST_GENERATION_CONCURRENCY));
  }
  
  for (const chunk of chunks) {
    const chunkPromises = chunk.map(async (listInfo) => {
      try {
        if (listInfo.source === 'mdblist') {
            const originalMdbListId = String(listInfo.id); 
            const listTypeSuffix = listInfo.listType || 'L';
            const fullManifestListId = originalMdbListId === 'watchlist' ? `aiolists-watchlist-W` : `aiolists-${originalMdbListId}-${listTypeSuffix}`; 
            let listDataForProcessing = { ...listInfo, id: fullManifestListId, originalId: originalMdbListId };
            let determinedHasMovies, determinedHasShows;
            if (originalMdbListId === 'watchlist') {
                determinedHasMovies = true;
                determinedHasShows = true;
            } else {
                const existingMetadata = userConfig.listsMetadata[fullManifestListId];
                if (existingMetadata && typeof existingMetadata.hasMovies === 'boolean' && typeof existingMetadata.hasShows === 'boolean') {
                    determinedHasMovies = existingMetadata.hasMovies;
                    determinedHasShows = existingMetadata.hasShows;
                } else {
                    const moviesCount = parseInt(listInfo.movies) || 0;
                    const showsCount = parseInt(listInfo.shows) || 0;
                    determinedHasMovies = moviesCount > 0;
                    determinedHasShows = showsCount > 0;
                    if (moviesCount === 0 && showsCount === 0) {
                        const mediatype = listInfo.mediatype;
                        if (mediatype === 'movie') determinedHasMovies = true;
                        else if (mediatype === 'show' || mediatype === 'series') determinedHasShows = true;
                    }
                }
            }
            listDataForProcessing.hasMovies = determinedHasMovies;
            listDataForProcessing.hasShows = determinedHasShows;
            if (!userConfig.listsMetadata) userConfig.listsMetadata = {};
            userConfig.listsMetadata[fullManifestListId] = { ...(userConfig.listsMetadata[fullManifestListId] || {}), hasMovies: determinedHasMovies, hasShows: determinedHasShows, lastChecked: new Date().toISOString() };
            await processListForManifest(listDataForProcessing, fullManifestListId, false, null);
        } else if (listInfo.source === 'trakt') {
            const currentListId = String(listInfo.id);
            let listDataForProcessing = { ...listInfo, originalId: currentListId, source: 'trakt' }; 
            await processListForManifest(listDataForProcessing, currentListId, false, null);
        } else if (listInfo.source === 'tmdb') {
            const currentListId = String(listInfo.id);
            let metadata = userConfig.listsMetadata[currentListId] || {};
            let determinedHasMovies = metadata.hasMovies;
            let determinedHasShows = metadata.hasShows;
            if (typeof determinedHasMovies !== 'boolean' || typeof determinedHasShows !== 'boolean') {
                if (currentListId === 'tmdb_watchlist' || currentListId === 'tmdb_favorites') {
                    determinedHasMovies = true;
                    determinedHasShows = true;
                } else if (currentListId.startsWith('tmdb_list_')) {
                    determinedHasMovies = true;
                    determinedHasShows = true;
                } else {
                    determinedHasMovies = true;
                    determinedHasShows = true;
                }
                if (!userConfig.listsMetadata) userConfig.listsMetadata = {};
                userConfig.listsMetadata[currentListId] = { ...(userConfig.listsMetadata[currentListId] || {}), hasMovies: determinedHasMovies, hasShows: determinedHasShows, lastChecked: new Date().toISOString() };
            }
            let listDataForProcessing = { ...listInfo, originalId: currentListId, source: 'tmdb', hasMovies: determinedHasMovies, hasShows: determinedHasShows };
            await processListForManifest(listDataForProcessing, currentListId, false, null);
        }
      } catch (error) {
        console.error(`[AddonBuilder] Error processing list ${listInfo.id || listInfo.name}:`, error.message);
      }
    });
    await Promise.all(chunkPromises);
    // REMOVED DELAY
  }
  
  for (const addon of Object.values(importedAddons || {})) {
    const addonGroupId = String(addon.id);
    if (removedListsSet.has(addonGroupId) || hiddenListsSet.has(addonGroupId)) continue;
    const isMDBListUrlImport = !!addon.isMDBListUrlImport;
    const isTraktPublicList = !!addon.isTraktPublicList;
    if (isMDBListUrlImport || isTraktPublicList) {
      let listDataForUrlImport = { id: addonGroupId, name: addon.name, hasMovies: addon.hasMovies, hasShows: addon.hasShows, source: isMDBListUrlImport ? 'mdblist_url' : 'trakt_public' };
      await processListForManifest(listDataForUrlImport, addonGroupId, false, null);
    } else if (addon.catalogs && addon.catalogs.length > 0) { 
      for (const catalog_from_imported_addon of addon.catalogs) {
        const catalogIdForManifest = String(catalog_from_imported_addon.id); 
        if (removedListsSet.has(catalogIdForManifest) || hiddenListsSet.has(catalogIdForManifest)) continue;
        let subCatalogData = { name: catalog_from_imported_addon.name, type: catalog_from_imported_addon.type, extraSupported: catalog_from_imported_addon.extraSupported, extraRequired: catalog_from_imported_addon.extraRequired };
        await processListForManifest(subCatalogData, catalogIdForManifest, true, addon);
      }
    }
  }
  
  const hasCustomOrder = userConfig.listOrder && Array.isArray(userConfig.listOrder) && userConfig.listOrder.length > 0;
  if (hasCustomOrder) {
    const orderMap = new Map(userConfig.listOrder.map((id, index) => [String(id), index]));
    const catalogsWithIndex = tempGeneratedCatalogs.map((catalog, index) => ({ catalog, originalIndex: index }));
    catalogsWithIndex.sort((a, b) => {
        const idA_base = String(a.catalog.id); 
        const idB_base = String(b.catalog.id);
        const indexA = orderMap.get(idA_base);
        const indexB = orderMap.get(idB_base);
        if (indexA !== undefined && indexB !== undefined) {
            if (indexA === indexB) { 
                const typeOrder = { 'movie': 1, 'series': 2 };
                let priorityA = typeOrder[a.catalog.type];
                let priorityB = typeOrder[b.catalog.type];
                if (customMediaTypeNames?.[idA_base] === a.catalog.type || a.catalog.type === 'all' || !priorityA ) priorityA = 0;
                if (customMediaTypeNames?.[idB_base] === b.catalog.type || b.catalog.type === 'all' || !priorityB ) priorityB = 0;
                if (priorityA !== priorityB) return priorityA - priorityB;
                return a.originalIndex - b.originalIndex;
            }
            return indexA - indexB; 
        }
        if (indexA !== undefined) return -1; 
        if (indexB !== undefined) return 1;  
        return a.originalIndex - b.originalIndex;
    });
    tempGeneratedCatalogs = catalogsWithIndex.map(item => item.catalog);
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
    
    const metadataSource = userConfig.metadataSource || 'cinemeta';
    const hasTmdbOAuth = !!(userConfig.tmdbSessionId && userConfig.tmdbAccountId);
    const tmdbLanguage = userConfig.tmdbLanguage || 'en-US';
    const tmdbBearerToken = userConfig.tmdbBearerToken || require('../config').TMDB_BEARER_TOKEN;
    
    const enrichedItems = await enrichItemsWithMetadata(itemsResult.allItems, metadataSource, hasTmdbOAuth, tmdbLanguage, tmdbBearerToken, userConfig.rpdbApiKey);
    
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
      const metadataSource = userConfig.metadataSource || 'cinemeta';
      const hasTmdbOAuth = !!(userConfig.tmdbSessionId && userConfig.tmdbAccountId);
      const tmdbLanguage = userConfig.tmdbLanguage || 'en-US';
      const tmdbBearerToken = userConfig.tmdbBearerToken || require('../config').TMDB_BEARER_TOKEN;
      const itemToEnrich = [{ id: id, type: type, imdb_id: id.startsWith('tt') ? id : undefined }];
      const enrichedItems = await enrichItemsWithMetadata(itemToEnrich, metadataSource, hasTmdbOAuth, tmdbLanguage, tmdbBearerToken, userConfig.rpdbApiKey);
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
    if (manifestCache.size > 5) {
      const oldestKey = manifestCache.keys().next().value;
      manifestCache.delete(oldestKey);
    }
  }
  
  return addonInterface;
}

module.exports = { createAddon, fetchListContent };
