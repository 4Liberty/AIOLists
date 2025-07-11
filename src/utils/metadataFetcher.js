// src/utils/metadataFetcher.js
const { batchFetchPosters } = require('./posters');
const { getMovieFanart, getSeriesFanart } = require('./getFanartImages');
const { batchConvertImdbToTmdbIds, batchFetchTmdbMetadata } = require('../integrations/tmdb');

function normalizeImdbId(id) {
  if (!id) return null;
  if (/^tt\d{7,9}$/.test(id)) return id;
  if (/^\d{7,9}$/.test(id)) return `tt${id}`;
  return null;
}

// This is the primary function for enriching items with metadata.
async function enrichItemsWithMetadata(items, userConfig) {
  const { metadataSource, tmdbSessionId, tmdbAccountId, tmdbLanguage, tmdbBearerToken, rpdbApiKey } = userConfig;
  
  if (!items || items.length === 0 || metadataSource === 'none') {
    return items;
  }

  let baseEnrichedItems;
  const hasTmdbAccess = (tmdbSessionId && tmdbAccountId) || tmdbBearerToken;

  // Step 1: Get base metadata ONLY from TMDB. Cinemeta is no longer an option.
  if (metadataSource === 'tmdb' && hasTmdbAccess) {
    baseEnrichedItems = await enrichItemsWithTMDB(items, tmdbLanguage, tmdbBearerToken, userConfig);
  } else {
    // If TMDB is not the source or not configured, return the items with no enrichment.
    console.warn('TMDB not configured as metadata source. Skipping enrichment.');
    return items;
  }

  // Step 2: Apply image fallbacks (Logos, Wallpapers).
  const itemsWithImages = await Promise.all(
    baseEnrichedItems.map(async (item) => {
      if (!item.tmdbId) return item; // Cannot fetch fanart without TMDB ID

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

  // Step 3: Apply RPDB posters (highest priority).
  if (rpdbApiKey) {
    const imdbIds = itemsWithImages.map(item => item.imdb_id).filter(Boolean);
    if (imdbIds.length > 0) {
      const posterMap = await batchFetchPosters(imdbIds, rpdbApiKey, tmdbLanguage);
      itemsWithImages.forEach(item => {
        if (item.imdb_id && posterMap[item.imdb_id]) {
          item.poster = posterMap[item.imdb_id];
        }
      });
    }
  }

  return itemsWithImages;
}

// This function now exclusively fetches from TMDB.
async function enrichItemsWithTMDB(items, language, userBearerToken, userConfig) {
    if (!items || items.length === 0) return items;

    // Prepare items for fetching by resolving their TMDB IDs.
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
    let readyForFetch = itemsToProcess.filter(item => item.tmdbId);

    // Convert any items that only have an IMDb ID.
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

    if (readyForFetch.length === 0) {
        return items;
    }

    // Fetch full metadata from TMDB for all resolvable items.
    const uniqueItemsToFetch = Array.from(new Map(readyForFetch.map(item => [item.tmdbId, item])).values());
    const tmdbMetadataMap = await batchFetchTmdbMetadata(uniqueItemsToFetch, language, userBearerToken);

    // Merge the results. If an item failed to fetch, the original item data is preserved.
    return items.map(originalItem => {
        const processedItem = readyForFetch.find(p => p.originalItem === originalItem);
        const fetchedMeta = processedItem ? tmdbMetadataMap[processedItem.tmdbId] : null;

        if (fetchedMeta) {
            fetchedMeta.id = `tmdb:${fetchedMeta.tmdbId}`;
            return { ...originalItem, ...fetchedMeta };
        }
        
        // If TMDB fetch failed, return the original item. NO FALLBACK.
        return originalItem;
    });
}

module.exports = { enrichItemsWithMetadata };

