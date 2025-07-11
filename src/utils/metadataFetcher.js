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

async function enrichItemsWithMetadata(items, userConfig) {
  const { metadataSource, tmdbSessionId, tmdbAccountId, tmdbLanguage, tmdbBearerToken, rpdbApiKey } = userConfig;
  
  if (!items || items.length === 0 || metadataSource === 'none') {
    return items;
  }

  let baseEnrichedItems;
  const hasTmdbAccess = (tmdbSessionId && tmdbAccountId) || tmdbBearerToken;

  if (metadataSource === 'tmdb' && hasTmdbAccess) {
    baseEnrichedItems = await enrichItemsWithTMDB(items, tmdbLanguage, tmdbBearerToken, userConfig);
  } else {
    baseEnrichedItems = await enrichItemsWithCinemeta(items);
  }

  const finalEnrichedItems = await Promise.all(
    baseEnrichedItems.map(async (item) => {
      if (!item.imdb_id && !item.tmdbId) return item;

      let fanartImages = {};
      if (item.type === 'movie') {
        fanartImages = await getMovieFanart(item.tmdbId, tmdbLanguage, item.original_language);
      } else if (item.type === 'series') {
        fanartImages = await getSeriesFanart(item.tvdb_id, item.tmdbId, tmdbLanguage, item.original_language);
      }

      item.logo = fanartImages.logo || item.tmdb_logo || item.logo;
      item.background = fanartImages.background || item.background;
      item.poster = fanartImages.poster || item.poster;

      return item;
    })
  );

  if (rpdbApiKey) {
    const imdbIds = finalEnrichedItems.map(item => item.imdb_id).filter(Boolean);
    if (imdbIds.length > 0) {
      const posterMap = await batchFetchPosters(imdbIds, rpdbApiKey, tmdbLanguage);
      finalEnrichedItems.forEach(item => {
        if (item.imdb_id && posterMap[item.imdb_id]) {
          item.poster = posterMap[item.imdb_id];
        }
      });
    }
  }

  return finalEnrichedItems;
}

async function enrichItemsWithTMDB(items, language, userBearerToken, userConfig) {
  if (!items || items.length === 0) return items;

  const enrichedItems = await fetchAndEnrichFromTmdb(items, language, userBearerToken, userConfig);
  
  return enrichedItems;
}

async function fetchAndEnrichFromTmdb(items, language, userBearerToken, userConfig) {
    const itemsToProcess = items.map(item => ({
        imdbId: normalizeImdbId(item.imdb_id || item.id),
        tmdbId: item.id?.startsWith('tmdb:') ? item.id.replace('tmdb:', '') : item.tmdbId,
        type: item.type,
        originalItem: item
    }));

    const needsConversion = itemsToProcess.filter(item => item.imdbId && !item.tmdbId);
    let readyForFetch = itemsToProcess.filter(item => item.tmdbId);

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

    if (readyForFetch.length === 0) return items;

    const uniqueItemsToFetch = Array.from(new Map(readyForFetch.map(item => [item.tmdbId, item])).values());
    const tmdbMetadataMap = await batchFetchTmdbMetadata(uniqueItemsToFetch, language, userBearerToken);

    return items.map(originalItem => {
        const processedItem = readyForFetch.find(p => p.originalItem === originalItem);
        const fetchedMeta = processedItem ? tmdbMetadataMap[processedItem.tmdbId] : null;

        if (fetchedMeta) {
            // CRITICAL FIX: Ensure the final ID is the TMDB ID for routing.
            // The imdb_id is preserved for other uses (like RPDB).
            fetchedMeta.id = `tmdb:${fetchedMeta.tmdbId}`;
            return { ...originalItem, ...fetchedMeta };
        }
        
        return originalItem;
    });
}


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

