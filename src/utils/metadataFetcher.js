// src/utils/metadataFetcher.js
const axios = require('axios');
const { batchFetchPosters } = require('./posters');
const { METADATA_BATCH_SIZE } = require('../config');
const { getMovieFanart, getSeriesFanart } = require('./getFanartImages');
const { batchConvertImdbToTmdbIds, batchFetchTmdbMetadata } = require('../integrations/tmdb');

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const BATCH_SIZE = METADATA_BATCH_SIZE || 50; // Use the aggressive batch size from config

// ... (The rest of the file is the same as the last version you received, but with delays removed) ...
function normalizeImdbId(id) {
  if (!id) return null;
  if (/^tt\d{7,9}$/.test(id)) return id;
  if (/^\d{7,9}$/.test(id)) return `tt${id}`;
  return null;
}

async function fetchCinemetaChunk(imdbIdChunk, type) {
  const CINEMETA_TIMEOUT = 10000; // Increased timeout slightly
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

async function fetchCinemetaBatched(imdbIds, type) {
  if (!imdbIds || imdbIds.length === 0) return {};
  const allMetadata = {};
  const CINEMETA_BATCH_SIZE = BATCH_SIZE; // Use the aggressive batch size
  
  for (let i = 0; i < imdbIds.length; i += CINEMETA_BATCH_SIZE) {
    const batch = imdbIds.slice(i, i + CINEMETA_BATCH_SIZE);
    try {
      const batchMetadata = await fetchCinemetaChunk(batch, type);
      Object.assign(allMetadata, batchMetadata);
      // REMOVED DELAY
    } catch (error) {
      console.error(`[METADATA PERF] Cinemeta batch failed:`, error.message);
    }
  }
  return allMetadata;
}

async function enrichItemsWithMetadata(items, metadataSource = 'cinemeta', hasTmdbOAuth = false, tmdbLanguage = 'en-US', tmdbBearerToken = null, rpdbApiKey = null) {
  if (!items || items.length === 0) return [];
  if (metadataSource === 'none') return items;
  let baseEnrichedItems;
  if (metadataSource === 'tmdb' && (hasTmdbOAuth || tmdbBearerToken)) {
    baseEnrichedItems = await enrichItemsWithTMDB(items, tmdbLanguage, tmdbBearerToken);
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
      item.background = item.background || fanartImages.background;
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

async function enrichItemsWithTMDB(items, language, userBearerToken) {
    if (!items || items.length === 0) return items;
    const tmdbEnrichedItems = await fetchAndEnrichFromTmdb(items, language, userBearerToken);
    const successfulItems = new Map();
    const failedItems = [];
    tmdbEnrichedItems.forEach(item => {
        const imdbId = normalizeImdbId(item.id || item.imdb_id);
        if (imdbId && (item.name || item.title) && item.tmdbId) {
            successfulItems.set(imdbId, item);
        } else if (imdbId) {
            const originalItem = items.find(orig => normalizeImdbId(orig.id || orig.imdb_id) === imdbId);
            failedItems.push(originalItem || item);
        }
    });
    let cinemetaFallbacks = [];
    if (failedItems.length > 0) {
        cinemetaFallbacks = await enrichItemsWithCinemeta(failedItems);
    }
    const finalResults = items.map(originalItem => {
        const imdbId = normalizeImdbId(originalItem.id || originalItem.imdb_id);
        if (successfulItems.has(imdbId)) return successfulItems.get(imdbId);
        const fallback = cinemetaFallbacks.find(fb => normalizeImdbId(fb.id || fb.imdb_id) === imdbId);
        return fallback || originalItem;
    });
    return finalResults;
}

async function fetchAndEnrichFromTmdb(items, language, userBearerToken) {
    const itemsWithIds = items.map(item => ({ imdbId: normalizeImdbId(item.imdb_id || item.id), originalItem: item })).filter(item => item.imdbId);
    if (itemsWithIds.length === 0) return items;
    const imdbToTmdbMap = await batchConvertImdbToTmdbIds(itemsWithIds.map(i => i.imdbId), userBearerToken);
    const itemsForTmdbFetch = itemsWithIds.map(item => {
        const conversion = imdbToTmdbMap[item.imdbId];
        if (conversion) return { ...item, tmdbId: conversion.tmdbId, type: conversion.type };
        return null;
    }).filter(Boolean);
    if (itemsForTmdbFetch.length === 0) return items;
    const tmdbMetadataMap = await batchFetchTmdbMetadata(itemsForTmdbFetch, language, userBearerToken);
    return items.map(originalItem => {
        const imdbId = normalizeImdbId(originalItem.id || originalItem.imdb_id);
        const fetchedMeta = tmdbMetadataMap[imdbId];
        if (fetchedMeta) return { ...originalItem, ...fetchedMeta, id: imdbId, imdb_id: imdbId };
        return originalItem;
    });
}

async function enrichItemsWithCinemeta(items) {
  if (!items || items.length === 0) return [];
  const processedItems = items.map((item, index) => ({ originalIndex: index, imdbId: normalizeImdbId(item.imdb_id || item.id), originalItem: item }));
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

module.exports = { enrichItemsWithMetadata };
