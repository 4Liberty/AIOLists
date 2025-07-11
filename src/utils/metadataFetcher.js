// src/utils/metadataFetcher.js
const axios = require('axios');
const { batchFetchPosters } = require('./posters');
const { METADATA_BATCH_SIZE } = require('../config');
const { getMovieFanart, getSeriesFanart } = require('./getFanartImages');
const { batchConvertImdbToTmdbIds, batchFetchTmdbMetadata } = require('../integrations/tmdb');

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const BATCH_SIZE = METADATA_BATCH_SIZE || 20;

function normalizeImdbId(id) {
  if (!id) return null;
  if (/^tt\d{7,9}$/.test(id)) return id;
  if (/^\d{7,9}$/.test(id)) return `tt${id}`;
  return null;
}

async function fetchCinemetaChunk(imdbIdChunk, type) {
  const CINEMETA_TIMEOUT = 5000;
  try {
    const promises = imdbIdChunk.map(async (imdbId) => {
      try {
        const response = await Promise.race([
          axios.get(`${CINEMETA_BASE}/meta/${type}/${imdbId}.json`, { timeout: CINEMETA_TIMEOUT }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Circuit breaker timeout')), CINEMETA_TIMEOUT + 1000))
        ]);
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
      
      // LOGO: Fanart.tv -> TMDB -> Cinemeta (implicit from base fetch)
      item.logo = fanartImages.logo || item.tmdb_logo || item.logo;

      // WALLPAPER: TMDB (original) -> Fanart.tv -> Cinemeta (implicit from base fetch)
      item.background = item.background || fanartImages.background;

      // POSTER: (RPDB handled later) -> Fanart.tv -> TMDB -> Cinemeta (implicit from base fetch)
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

async function enrichItemsWithTMDB(items, language, userBearerToken) {
    const itemsWithIds = items.map(item => ({
        imdbId: normalizeImdbId(item.imdb_id || item.id),
        originalItem: item
    })).filter(item => item.imdbId);

    if (itemsWithIds.length === 0) return items;

    const imdbToTmdbMap = await batchConvertImdbToTmdbIds(itemsWithIds.map(i => i.imdbId), userBearerToken);
    
    const itemsForTmdbFetch = itemsWithIds.map(item => {
        const conversion = imdbToTmdbMap[item.imdbId];
        if (conversion) {
            return { ...item, tmdbId: conversion.tmdbId, type: conversion.type };
        }
        return null;
    }).filter(Boolean);

    if (itemsForTmdbFetch.length === 0) return items;

    const tmdbMetadataMap = await batchFetchTmdbMetadata(itemsForTmdbFetch, language, userBearerToken);

    return items.map(originalItem => {
        const imdbId = normalizeImdbId(originalItem.id || originalItem.imdb_id);
        const fetchedMeta = tmdbMetadataMap[imdbId];
        if (fetchedMeta) {
            return { ...originalItem, ...fetchedMeta, id: imdbId, imdb_id: imdbId };
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
  const CINEMETA_BATCH_SIZE = Math.min(BATCH_SIZE, 10);
  const CINEMETA_DELAY = 150;
  for (let i = 0; i < imdbIds.length; i += CINEMETA_BATCH_SIZE) {
    const batch = imdbIds.slice(i, i + CINEMETA_BATCH_SIZE);
    try {
      const batchMetadata = await fetchCinemetaChunk(batch, type);
      Object.assign(allMetadata, batchMetadata);
      if (i + CINEMETA_BATCH_SIZE < imdbIds.length) {
        await new Promise(resolve => setTimeout(resolve, CINEMETA_DELAY));
      }
    } catch (error) {
      console.error(`[METADATA PERF] Cinemeta batch failed:`, error.message);
    }
  }
  return allMetadata;
}

module.exports = { enrichItemsWithMetadata };
