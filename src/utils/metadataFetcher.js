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

async function enrichItemsWithMetadata(items, metadataSource = 'cinemeta', hasTmdbOAuth = false, tmdbLanguage = 'en-US', tmdbBearerToken = null, rpdbApiKey = null) {
  if (!items || items.length === 0) return [];
  if (metadataSource === 'none') return items;

  let baseEnrichedItems;

  // Step 1: Get base metadata from the primary source (TMDB or Cinemeta)
  if (metadataSource === 'tmdb' && (hasTmdbOAuth || tmdbBearerToken)) {
    baseEnrichedItems = await enrichItemsWithTMDB(items, tmdbLanguage, tmdbBearerToken);
  } else {
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

      // --- Fallback Logic ---
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

// --- START OF CORRECTED LOGIC ---

// This is the main orchestrator for TMDB enrichment.
async function enrichItemsWithTMDB(items, language, userBearerToken) {
    if (!items || items.length === 0) return items;

    // fetchAndEnrichFromTmdb now returns a Map of successfully fetched items.
    const successfullyEnrichedMap = await fetchAndEnrichFromTmdb(items, language, userBearerToken);

    const failedItems = [];
    const finalResults = [];

    // Iterate through the original items to maintain order.
    for (const originalItem of items) {
        const imdbId = normalizeImdbId(originalItem.id || originalItem.imdb_id);
        const tmdbId = originalItem.id?.startsWith('tmdb:') ? originalItem.id : null;
        const primaryId = imdbId || tmdbId;

        if (primaryId && successfullyEnrichedMap.has(primaryId)) {
            // Success! Use the high-quality TMDB result.
            finalResults.push(successfullyEnrichedMap.get(primaryId));
        } else {
            // Failure, this item needs to be fetched from Cinemeta.
            failedItems.push(originalItem);
        }
    }

    // If there were any failures, fetch them from Cinemeta.
    if (failedItems.length > 0) {
        console.log(`[TMDB Fallback] ${failedItems.length} items failed TMDB enrichment. Falling back to Cinemeta for those items.`);
        const cinemetaFallbacks = await enrichItemsWithCinemeta(failedItems);
        const cinemetaMap = new Map(cinemetaFallbacks.map(item => [normalizeImdbId(item.id || item.imdb_id) || item.id, item]));

        // Re-integrate the Cinemeta fallbacks into the final results list, maintaining original order.
        let failedIndex = 0;
        for (let i = 0; i < items.length; i++) {
            const originalItem = items[i];
            const primaryId = normalizeImdbId(originalItem.id || originalItem.imdb_id) || originalItem.id;
            
            // If the item was not in the success map, it must be a failed item.
            if (!successfullyEnrichedMap.has(primaryId)) {
                const fallbackData = cinemetaMap.get(primaryId);
                // Insert the fallback data at the correct position.
                finalResults.splice(i, 0, fallbackData || originalItem);
                failedIndex++;
            }
        }
    }

    return finalResults;
}

// This helper function now only returns successful fetches.
async function fetchAndEnrichFromTmdb(items, language, userBearerToken) {
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

    const needsConversion = itemsToProcess.filter(item => item.imdbId && !item.tmdbId);
    const readyForFetch = itemsToProcess.filter(item => item.tmdbId);

    if (needsConversion.length > 0) {
        const imdbIdsToConvert = needsConversion.map(item => item.imdbId);
        const conversionMap = await batchConvertImdbToTmdbIds(imdbIdsToConvert, userBearerToken);
        
        needsConversion.forEach(item => {
            const conversionResult = conversionMap[item.imdbId];
            if (conversionResult) {
                readyForFetch.push({
                    ...item,
                    tmdbId: conversionResult.tmdbId,
                    type: conversionResult.type, 
                });
            }
        });
    }

    if (readyForFetch.length === 0) return new Map();

    const uniqueItemsToFetch = Array.from(new Map(readyForFetch.map(item => [item.tmdbId, item])).values());
    const tmdbMetadataMap = await batchFetchTmdbMetadata(uniqueItemsToFetch, language, userBearerToken);

    // Instead of returning a mixed array, return a map of successes.
    const successMap = new Map();
    items.forEach(originalItem => {
        const originalImdbId = normalizeImdbId(originalItem.id || originalItem.imdb_id);
        const originalTmdbId = originalItem.id?.startsWith('tmdb:') ? originalItem.id.replace('tmdb:', '') : originalItem.tmdbId;

        // The key in tmdbMetadataMap can be either 'tt...' or 'tmdb:...'
        const fetchedMeta = tmdbMetadataMap[originalImdbId] || tmdbMetadataMap[`tmdb:${originalTmdbId}`];
        
        if (fetchedMeta) {
            // A fetch is successful if we get a name/title.
            if (fetchedMeta.name || fetchedMeta.title) {
                const finalId = originalItem.id || fetchedMeta.id;
                const enrichedItem = { ...originalItem, ...fetchedMeta, id: finalId };
                const primaryId = normalizeImdbId(finalId) || finalId;
                successMap.set(primaryId, enrichedItem);
            }
        }
    });

    return successMap;
}

// --- END OF CORRECTED LOGIC ---

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
