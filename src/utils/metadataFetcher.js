// src/utils/metadataFetcher.js
const axios = require('axios');
const { batchFetchPosters } = require('./posters');
const { METADATA_BATCH_SIZE } = require('../config');
const { getMovieFanart, getSeriesFanart } = require('./getFanartImages');
const { batchConvertImdbToTmdbIds, batchFetchTmdbMetadata } = require('../integrations/tmdb');

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const BATCH_SIZE = METADATA_BATCH_SIZE || 50;

function normalizeImdbId(id) {
  if (!id) return null;
  if (/^tt\d{7,9}$/.test(id)) return id;
  if (/^\d{7,9}$/.test(id)) return `tt${id}`;
  return null;
}

async function fetchCinemetaChunk(imdbIdChunk, type) {
  const CINEMETA_TIMEOUT = 10000;
  try {
    const promises = imdbIdChunk.map(async (imdbId) => {
      try {
        const response = await axios.get(`${CINEMETA_BASE}/meta/${type}/${imdbId}.json`, { timeout: CINEMETA_TIMEOUT });
        return { imdbId, data: response.data?.meta };
      } catch (error) {
        return { imdbId, data: null };
      }
    });
    const results = await Promise.all(promises);
    const metadataMap = {};
    results.forEach(({ imdbId, data }) => {
      if (data) metadataMap[imdbId] = data;
    });
    return metadataMap;
  } catch (error) {
    console.error('Error fetching Cinemeta chunk:', error.message);
    return {};
  }
}

async function enrichItemsWithMetadata(items, userConfig) {
  const { metadataSource, tmdbSessionId, tmdbAccountId, tmdbLanguage, tmdbBearerToken, rpdbApiKey } = userConfig;
  
  if (!items || items.length === 0 || metadataSource === 'none') {
    return items;
  }

  let baseEnrichedItems;
  const hasTmdbAccess = (tmdbSessionId && tmdbAccountId) || tmdbBearerToken;

  // Step 1: Get base metadata from the primary source.
  if (metadataSource === 'tmdb' && hasTmdbAccess) {
    // If the source is TMDB, we ONLY use TMDB. No fallback to Cinemeta.
    baseEnrichedItems = await enrichItemsWithTMDB(items, tmdbLanguage, tmdbBearerToken, userConfig);
  } else {
    // If the source is Cinemeta, we use Cinemeta.
    baseEnrichedItems = await enrichItemsWithCinemeta(items);
  }

  // Step 2: Apply the sophisticated image fallback logic
  const finalEnrichedItems = await Promise.all(
    baseEnrichedItems.map(async (item) => {
      if (!item.imdb_id && !item.tmdbId) return item;

      let fanartImages = {};
      if (item.type === 'movie') {
        fanartImages = await getMovieFanart(item.tmdbId, tmdbLanguage, item.original_language);
      } else if (item.type === 'series') {
        fanartImages = await getSeriesFanart(item.tvdb_id, item.tmdbId, tmdbLanguage, item.original_language);
      }

      // --- Image Fallback Logic ---
      item.logo = fanartImages.logo || item.tmdb_logo || item.logo;
      item.background = item.background || fanartImages.background;
      item.poster = fanartImages.poster || item.poster;

      return item;
    })
  );

  // Step 3: Apply RPDB posters (highest priority if key exists)
  if (rpdbApiKey) {
    const imdbIds = finalEnrichedItems.map(item => item.imdb_id).filter(Boolean);
    if (imdbIds.length > 0) {
      const posterMap = await batchFetchPosters(imdbIds, rpdbApiKey, tmdbLanguage);
      finalEnrichedItems.forEach(item => {
        if (item.imdb_id && posterMap[item.imdb_id]) {
          item.poster = posterMap[item.imdb_id]; // Overwrite with RPDB poster
        }
      });
    }
  }

  return finalEnrichedItems;
}

// This function now exclusively fetches from TMDB and does not fall back.
async function enrichItemsWithTMDB(items, language, userBearerToken, userConfig) {
    if (!items || items.length === 0) return items;

    // This helper function will now correctly fetch and merge the data.
    const enrichedItems = await fetchAndEnrichFromTmdb(items, language, userBearerToken, userConfig);

    // There is no fallback. We return whatever TMDB gave us.
    // If an item failed, it will just have its original, limited data.
    return enrichedItems;
}

// This helper function now only returns successful fetches.
async function fetchAndEnrichFromTmdb(items, language, userBearerToken, userConfig) {
    // 1. Prepare items for processing, identifying both IMDb and TMDB IDs.
    const itemsToProcess = items.map(item => {
        const imdbId = normalizeImdbId(item.imdb_id || item.id);
        const tmdbIdFromId = item.id?.startsWith('tmdb:') ? item.id.replace('tmdb:', '') : null;
        return {
            imdbId: imdbId,
            tmdbId: item.tmdbId || tmdbIdFromId,
            type: item.type,
            originalItem: item
        };
    });

    // 2. Find items that need their TMDB ID looked up via their IMDb ID.
    const needsConversion = itemsToProcess.filter(item => item.imdbId && !item.tmdbId);
    const readyForFetch = itemsToProcess.filter(item => item.tmdbId);

    if (needsConversion.length > 0) {
        const imdbIdsToConvert = needsConversion.map(item => item.imdbId);
        const conversionMap = await batchConvertImdbToTmdbIds(imdbIdsToConvert, userBearerToken);
        
        needsConversion.forEach(item => {
            const conversionResult = conversionMap[item.imdbId];
            if (conversionResult) {
                // Add the successfully converted item to the list of items ready to be fetched.
                readyForFetch.push({
                    ...item,
                    tmdbId: conversionResult.tmdbId,
                    type: conversionResult.type, 
                });
            }
        });
    }

    if (readyForFetch.length === 0) {
        // If no items could be resolved to a TMDB ID, return the original items.
        return items;
    }

    // 3. Fetch full metadata from TMDB for all items that now have a TMDB ID.
    const uniqueItemsToFetch = Array.from(new Map(readyForFetch.map(item => [item.tmdbId, item])).values());
    const tmdbMetadataMap = await batchFetchTmdbMetadata(uniqueItemsToFetch, language, userBearerToken);

    // 4. Merge the fetched metadata back into the original items list, maintaining order.
    return items.map(originalItem => {
        // Find the corresponding processed item to get the resolved IDs.
        const processedItem = readyForFetch.find(p => p.originalItem === originalItem);
        const fetchedMeta = processedItem ? tmdbMetadataMap[processedItem.imdbId] || tmdbMetadataMap[`tmdb:${processedItem.tmdbId}`] : null;

        if (fetchedMeta) {
            // If we have new metadata, merge it with the original item.
            // Ensure the final 'id' matches the one Stremio will use to call the meta handler.
            const finalId = originalItem.id;
            return { ...originalItem, ...fetchedMeta, id: finalId };
        }
        
        // If no metadata was fetched for this item, return it as-is. NO CINEMETA FALLBACK.
        return originalItem;
    });
}


// This function is now only called if the user explicitly selects "Cinemeta" as the source.
async function enrichItemsWithCinemeta(items) {
  if (!items || items.length === 0) return [];
  
  const processedItems = items.map((item, index) => ({
    originalIndex: index,
    imdbId: normalizeImdbId(item.imdb_id || item.id),
    originalItem: item
  }));

  const movieItems = processedItems.filter(item => item.originalItem.type === 'movie' && item.imdbId);
  const seriesItems = processedItems.filter(item => item.originalItem.type === 'series' && item.imdbId);
  
  const [movieMetadata, seriesMetadata] = await Promise.all([
    fetchCinemetaBatched(movieItems.map(item => item.imdbId), 'movie'),
    fetchCinemetaBatched(seriesItems.map(item => item.imdbId), 'series')
  ]);

  const allMetadata = { ...movieMetadata, ...seriesMetadata };

  return items.map((originalItem, index) => {
    const processedItem = processedItems[index];
    if (processedItem.imdbId && allMetadata[processedItem.imdbId]) {
      const metadata = allMetadata[processedItem.imdbId];
      return { ...originalItem, ...metadata, id: processedItem.imdbId, imdb_id: processedItem.imdbId, type: originalItem.type };
    }
    return originalItem;
  });
}

async function fetchCinemetaBatched(imdbIds, type) {
  if (!imdbIds || imdbIds.length === 0) return {};
  const allMetadata = {};
  const CINEMETA_BATCH_SIZE = BATCH_SIZE;
  
  for (let i = 0; i < imdbIds.length; i += CINEMETA_BATCH_SIZE) {
    const batch = imdbIds.slice(i, i + CINEMETA_BATCH_SIZE);
    try {
      const batchMetadata = await fetchCinemetaChunk(batch, type);
      Object.assign(allMetadata, batchMetadata);
    } catch (error) {
      console.error(`[METADATA PERF] Cinemeta batch failed:`, error.message);
    }
  }
  return allMetadata;
}

module.exports = { enrichItemsWithMetadata };
