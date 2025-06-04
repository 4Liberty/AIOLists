// src/routes/api.js
const path = require('path');
const { defaultConfig } = require('../config');
const { compressConfig, decompressConfig, compressShareableConfig, createShareableConfig } = require('../utils/urlConfig');
const { createAddon, fetchListContent } = require('../addon/addonBuilder');
const { convertToStremioFormat } = require('../addon/converters');
const { setCacheHeaders, isWatchlist: commonIsWatchlist } = require('../utils/common');
const Cache = require('../utils/cache');
const { validateRPDBKey } = require('../utils/posters');
const { authenticateTrakt, getTraktAuthUrl, fetchTraktLists: fetchTraktUserLists, fetchPublicTraktListDetails } = require('../integrations/trakt');
const { fetchAllLists: fetchAllMDBLists, fetchListItems: fetchMDBListItemsDirect, validateMDBListKey, extractListFromUrl: extractMDBListFromUrl } = require('../integrations/mdblist');
const { importExternalAddon: importExtAddon } = require('../integrations/externalAddons');

const manifestCache = new Cache({ defaultTTL: 1 * 60 * 1000 });

function purgeListConfigs(userConfig, listIdPrefixOrExactId, isExactId = false) {
  const idsToRemove = new Set();

  if (isExactId) {
      idsToRemove.add(String(listIdPrefixOrExactId));
  }

  if (userConfig.customListNames) {
      for (const key in userConfig.customListNames) {
          if ((isExactId && key === listIdPrefixOrExactId) || (!isExactId && key.startsWith(listIdPrefixOrExactId) && !key.startsWith('traktpublic_') )) {
              idsToRemove.add(key);
              delete userConfig.customListNames[key];
          }
      }
  }
  // Also purge customMediaTypeNames
  if (userConfig.customMediaTypeNames) {
    for (const key in userConfig.customMediaTypeNames) {
        if ((isExactId && key === listIdPrefixOrExactId) || (!isExactId && key.startsWith(listIdPrefixOrExactId) && !key.startsWith('traktpublic_'))) {
            idsToRemove.add(key);
            delete userConfig.customMediaTypeNames[key];
        }
    }
  }


  if (userConfig.sortPreferences) {
      for (const key in userConfig.sortPreferences) {
          if ((isExactId && key === listIdPrefixOrExactId) || (!isExactId && key.startsWith(listIdPrefixOrExactId) && !key.startsWith('traktpublic_'))) {
              idsToRemove.add(key);
              delete userConfig.sortPreferences[key];
          }
      }
  }
  if (userConfig.mergedLists) {
      for (const key in userConfig.mergedLists) {
          if ((isExactId && key === listIdPrefixOrExactId) || (!isExactId && key.startsWith(listIdPrefixOrExactId) && !key.startsWith('traktpublic_'))) {
              idsToRemove.add(key);
              delete userConfig.mergedLists[key];
          }
      }
  }

  const filterCondition = (id) => {
      const idStr = String(id);
      if (isExactId) return idStr === listIdPrefixOrExactId;
      if (listIdPrefixOrExactId === 'trakt_') return idStr.startsWith('trakt_') && !idStr.startsWith('traktpublic_');
      if (listIdPrefixOrExactId === 'random_mdblist_catalog' && idStr === 'random_mdblist_catalog') return true;
      return idStr.startsWith(listIdPrefixOrExactId);
  };

  if (userConfig.listOrder) {
      userConfig.listOrder = userConfig.listOrder.filter(id => {
          if (filterCondition(id)) { idsToRemove.add(String(id)); return false; }
          return true;
      });
  }
  if (userConfig.hiddenLists) {
      userConfig.hiddenLists = userConfig.hiddenLists.filter(id => {
          if (filterCondition(id)) { idsToRemove.add(String(id)); return false; }
          return true;
      });
  }
  if (userConfig.removedLists) {
      userConfig.removedLists = userConfig.removedLists.filter(id => {
          if (filterCondition(id)) { idsToRemove.add(String(id)); return false; }
          return true;
      });
  }
  return idsToRemove;
}


module.exports = function(router) {
  router.param('configHash', async (req, res, next, configHash) => {
    try {
      req.userConfig = await decompressConfig(configHash);
      req.configHash = configHash;
      req.isPotentiallySharedConfig = (!req.userConfig.apiKey && Object.values(req.userConfig.importedAddons || {}).some(addon => addon.isMDBListUrlImport)) ||
                                     (!req.userConfig.traktAccessToken && Object.values(req.userConfig.importedAddons || {}).some(addon => addon.isTraktPublicList)) ||
                                     (!req.userConfig.traktAccessToken && (req.userConfig.listOrder || []).some(id => id.startsWith('trakt_') && !id.startsWith('traktpublic_')));
      next();
    } catch (error) {
      console.error('Error decompressing configHash:', configHash, error);
      if (!res.headersSent) { return res.redirect('/configure'); }
      next(error);
    }
  });

  router.get('/:configHash/shareable-hash', async (req, res) => {
    try {
        const shareableHash = await compressShareableConfig(req.userConfig);
        res.json({ success: true, shareableHash: shareableHash });
    } catch (error) {
        console.error('Error creating shareable config hash:', error);
        res.status(500).json({ success: false, error: 'Failed to create shareable configuration hash' });
    }
  });

  router.post('/:configHash/config/genre-filter', async (req, res) => {
    try {
      const { disableGenreFilter } = req.body;
      if (typeof disableGenreFilter !== 'boolean') {
        return res.status(400).json({ success: false, error: 'Invalid value for disableGenreFilter. Must be boolean.' });
      }

      req.userConfig.disableGenreFilter = disableGenreFilter;
      req.userConfig.lastUpdated = new Date().toISOString();

      const newConfigHash = await compressConfig(req.userConfig);
      manifestCache.clear();
      res.json({ success: true, configHash: newConfigHash });
    } catch (error) {
      console.error('Error updating genre filter setting:', error);
      res.status(500).json({ success: false, error: 'Failed to update genre filter setting' });
    }
  });

  router.post('/:configHash/config/random-list-feature', async (req, res) => {
    try {
      const { enable, randomMDBListUsernames } = req.body; // Added randomMDBListUsernames
      if (typeof enable !== 'boolean') {
        return res.status(400).json({ success: false, error: 'Invalid value for enable. Must be boolean.' });
      }
      if (enable && !req.userConfig.apiKey) {
        return res.status(400).json({ success: false, error: 'MDBList API Key is required to enable this feature.' });
      }

      req.userConfig.enableRandomListFeature = enable;

      // Update randomMDBListUsernames if provided and valid
      if (randomMDBListUsernames !== undefined) {
        if (Array.isArray(randomMDBListUsernames) && randomMDBListUsernames.every(u => typeof u === 'string')) {
            req.userConfig.randomMDBListUsernames = randomMDBListUsernames.map(u => u.trim()).filter(u => u.length > 0);
            if (req.userConfig.randomMDBListUsernames.length === 0 && defaultConfig.randomMDBListUsernames.length > 0) {
                // If user clears all, revert to default non-empty list to prevent issues
                req.userConfig.randomMDBListUsernames = [...defaultConfig.randomMDBListUsernames];
                 console.warn("Random MDBList usernames cleared by user, reverting to internal default to ensure functionality.");
            }
        } else {
            return res.status(400).json({ success: false, error: 'Invalid format for randomMDBListUsernames. Must be an array of strings.' });
        }
      }

      req.userConfig.lastUpdated = new Date().toISOString();

      if (!enable) {
        if (req.userConfig.listOrder) {
            req.userConfig.listOrder = req.userConfig.listOrder.filter(id => id !== 'random_mdblist_catalog');
        }
        if (req.userConfig.hiddenLists) {
            req.userConfig.hiddenLists = req.userConfig.hiddenLists.filter(id => id !== 'random_mdblist_catalog');
        }
      }

      const newConfigHash = await compressConfig(req.userConfig);
      manifestCache.clear();
      // Send back the potentially updated list of usernames
      res.json({ success: true, configHash: newConfigHash, randomMDBListUsernames: req.userConfig.randomMDBListUsernames });
    } catch (error)
    {
      console.error('Error updating random list feature setting:', error);
      res.status(500).json({ success: false, error: 'Failed to update random list feature setting' });
    }
  });

  router.get('/:configHash/configure', (req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html'));
  });

  router.get('/:configHash/manifest.json', async (req, res) => {
    try {
      const cacheKey = `manifest_${req.configHash}`;
      let addonInterface = manifestCache.get(cacheKey);
      if (!addonInterface) {
        addonInterface = await createAddon(req.userConfig);
        manifestCache.set(cacheKey, addonInterface);
      }
      setCacheHeaders(res, null);
      res.json(addonInterface.manifest);
    } catch (error) {
      console.error('Error serving manifest:', error);
      res.status(500).json({ error: 'Failed to serve manifest' });
    }
  });

  router.get('/:configHash/catalog/:type/:id/:extra?.json', async (req, res) => {
    try {
      const { type: catalogType, id: catalogId } = req.params;
      const extraParamsString = req.params.extra;
      let skip = parseInt(req.query.skip);
      let genre = req.query.genre;

      if (isNaN(skip) && extraParamsString) {
        const skipMatch = extraParamsString.match(/skip=(\d+)/);
        if (skipMatch) skip = parseInt(skipMatch[1]);
      }
      if (!genre && extraParamsString) {
        const genreMatch = extraParamsString.match(/genre=([^&]+)/);
        if (genreMatch) genre = decodeURIComponent(genreMatch[1]);
      }

      skip = isNaN(skip) ? 0 : skip;
      genre = genre || null;

      const listSource = catalogId === 'random_mdblist_catalog' ? 'random_mdblist' :
                         catalogId.startsWith('aiolists-') ? 'mdblist_native' :
                         catalogId.startsWith('trakt_') && !catalogId.startsWith('traktpublic_') ? 'trakt_native' :
                         catalogId.startsWith('mdblisturl_') ? 'mdblist_url' :
                         catalogId.startsWith('traktpublic_') ? 'trakt_public_url' :
                         'external_addon';

      if ((listSource === 'mdblist_native' || listSource === 'mdblist_url' || listSource === 'random_mdblist') && !req.userConfig.apiKey) {
          console.log(`[Shared Config] MDBList API key missing for ${catalogId}. Returning empty.`);
          return res.json({ metas: [] });
      }
      if (listSource === 'trakt_native' && !req.userConfig.traktAccessToken) {
          console.log(`[Shared Config] Trakt Access Token missing for ${catalogId}. Returning empty.`);
          return res.json({ metas: [] });
      }

      if (catalogId === 'random_mdblist_catalog' || commonIsWatchlist(catalogId)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      } else {
        setCacheHeaders(res, catalogId);
      }

      const itemsResult = await fetchListContent(catalogId, req.userConfig, skip, genre, catalogType);

      if (!itemsResult) {
        return res.json({ metas: [] });
      }

      let metas = await convertToStremioFormat(itemsResult, req.userConfig.rpdbApiKey);
      
      // If a custom media type is set, the manifest type is 'all'.
      // The catalogType in the request might still be 'movie' or 'series' if the user clicks on a specific type from Stremio's UI.
      // We should honor Stremio's request type if a custom media type implies 'all'.
      const customMediaType = req.userConfig.customMediaTypeNames?.[catalogId];
      if (!customMediaType) { // Only filter by Stremio's requested catalogType if NO custom media type is set
        if (catalogType !== 'all' && (catalogType === 'movie' || catalogType === 'series')) {
            metas = metas.filter(meta => meta.type === catalogType);
        } else if (catalogType !== 'all') {
            const addonInfo = req.userConfig.importedAddons && req.userConfig.importedAddons[catalogId.split('_')[0]];
            if (!(addonInfo && addonInfo.types && addonInfo.types.includes(catalogType))) {
            }
            metas = metas.filter(meta => meta.type === catalogType);
        }
      }


      if (genre && metas.length > 0) {
        const needsFiltering = metas.some(meta => !(meta.genres && meta.genres.map(g => String(g).toLowerCase()).includes(String(genre).toLowerCase())));
        if (needsFiltering) {
            metas = metas.filter(meta => meta.genres && meta.genres.map(g => String(g).toLowerCase()).includes(String(genre).toLowerCase()));
        }
      }
      res.json({ metas });
    } catch (error) {
      console.error(`Error in catalog endpoint (/catalog/${req.params.type}/${req.params.id}):`, error);
      res.status(500).json({ error: 'Internal server error in catalog handler' });
    }
  });

  router.get('/:configHash/config', (req, res) => {
    const configToSend = JSON.parse(JSON.stringify(req.userConfig));
    delete configToSend.availableSortOptions;
    delete configToSend.traktSortOptions;
    configToSend.hiddenLists = Array.from(new Set(configToSend.hiddenLists || []));
    configToSend.removedLists = Array.from(new Set(configToSend.removedLists || []));
    // Ensure customMediaTypeNames is an object
    configToSend.customMediaTypeNames = configToSend.customMediaTypeNames || {};
    res.json({ success: true, config: configToSend, isPotentiallySharedConfig: req.isPotentiallySharedConfig });
  });

  router.post('/:configHash/apikey', async (req, res) => {
    try {
      const { apiKey, rpdbApiKey } = req.body;
      let configChanged = false;

      const newApiKey = apiKey || '';
      const newRpdbApiKey = rpdbApiKey || '';

      if (req.userConfig.rpdbApiKey !== newRpdbApiKey) {
        req.userConfig.rpdbApiKey = newRpdbApiKey;
        configChanged = true;
      }

      if (req.userConfig.apiKey !== newApiKey) {
        configChanged = true;
        if (newApiKey === '') {
            console.log('MDBList API key cleared. Purging aiolists- and mdblisturl_ entries. Disabling random list feature.');
            req.userConfig.apiKey = '';
            if (req.userConfig.mdblistUsername) delete req.userConfig.mdblistUsername;
            req.userConfig.enableRandomListFeature = false;
            purgeListConfigs(req.userConfig, 'aiolists-');
            purgeListConfigs(req.userConfig, 'random_mdblist_catalog', true);
            if (req.userConfig.importedAddons) {
                for (const addonKey in req.userConfig.importedAddons) {
                    if (req.userConfig.importedAddons[addonKey]?.isMDBListUrlImport) {
                        purgeListConfigs(req.userConfig, addonKey, true);
                        delete req.userConfig.importedAddons[addonKey];
                    }
                }
            }
        } else {
            req.userConfig.apiKey = newApiKey;
        }
      }

      if (configChanged) {
        req.userConfig.lastUpdated = new Date().toISOString();
        const newConfigHash = await compressConfig(req.userConfig);
        manifestCache.clear();
        return res.json({ success: true, configHash: newConfigHash });
      }
      return res.json({ success: true, configHash: req.configHash, message: "API keys processed" });
    } catch (error) {
      console.error('Error in /apikey:', error);
      res.status(500).json({ error: 'Internal server error in /apikey' });
    }
  });

  router.post('/:configHash/trakt/auth', async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'Authorization code required' });

        const traktTokens = await authenticateTrakt(code);
        req.userConfig.traktAccessToken = traktTokens.accessToken;
        req.userConfig.traktRefreshToken = traktTokens.refreshToken;
        req.userConfig.traktExpiresAt = traktTokens.expiresAt;
        req.userConfig.lastUpdated = new Date().toISOString();

        const newConfigHash = await compressConfig(req.userConfig);
        manifestCache.clear();
        res.json({
            success: true,
            configHash: newConfigHash,
            accessToken: traktTokens.accessToken,
            refreshToken: traktTokens.refreshToken,
            expiresAt: traktTokens.expiresAt,
            message: 'Authenticated with Trakt'
        });
    } catch (error) {
        console.error('Error in /trakt/auth:', error);
        res.status(500).json({ error: 'Failed to authenticate with Trakt', details: error.message });
    }
  });

  router.post('/:configHash/trakt/disconnect', async (req, res) => {
    try {
        console.log('Trakt disconnect requested. Purging native trakt_ entries (excluding traktpublic_).');
        req.userConfig.traktAccessToken = null;
        req.userConfig.traktRefreshToken = null;
        req.userConfig.traktExpiresAt = null;

        purgeListConfigs(req.userConfig, 'trakt_');

        req.userConfig.lastUpdated = new Date().toISOString();
        const newConfigHash = await compressConfig(req.userConfig);
        manifestCache.clear();
        res.json({ success: true, configHash: newConfigHash, message: 'Disconnected from Trakt. Native Trakt data purged; Trakt Public URL imports retained.' });
    } catch (error) {
        console.error('Error in /trakt/disconnect:', error);
        res.status(500).json({ error: 'Failed to disconnect from Trakt', details: error.message });
    }
  });

  router.post('/:configHash/import-list-url', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'List URL required' });

        let importedListDetails;
        let addonId;
        let sourceSystem;
        let listNameForDisplay;
        let addonToStore = {};

        if (url.includes('mdblist.com/lists/')) {
            importedListDetails = await extractMDBListFromUrl(url, req.userConfig.apiKey);
            addonId = `mdblisturl_${importedListDetails.listId}`;
            listNameForDisplay = importedListDetails.listName;
            sourceSystem = "MDBList";
            addonToStore = {
                id: addonId,
                name: `${listNameForDisplay}`,
                hasMovies: importedListDetails.hasMovies,
                hasShows: importedListDetails.hasShows,
                isMDBListUrlImport: true,
                mdblistId: importedListDetails.listId,
                dynamic: importedListDetails.dynamic,
                mediatype: importedListDetails.mediatype,
                types: [
                    ...(importedListDetails.hasMovies ? ['movie'] : []),
                    ...(importedListDetails.hasShows ? ['series'] : [])
                ],
            };
        } else if (url.includes('trakt.tv/users/') && url.includes('/lists/')) {
            importedListDetails = await fetchPublicTraktListDetails(url);
            addonId = importedListDetails.listId;
            listNameForDisplay = importedListDetails.listName;
            sourceSystem = "Trakt Public";
            addonToStore = {
                id: addonId,
                name: `${listNameForDisplay}`,
                hasMovies: importedListDetails.hasMovies,
                hasShows: importedListDetails.hasShows,
                isTraktPublicList: true,
                traktUser: importedListDetails.traktUser,
                traktListSlug: importedListDetails.originalTraktSlug,
                types: [
                    ...(importedListDetails.hasMovies ? ['movie'] : []),
                    ...(importedListDetails.hasShows ? ['series'] : [])
                ],
            };
        } else {
            return res.status(400).json({ error: 'Invalid or unsupported URL.' });
        }

        if (!req.userConfig.importedAddons) req.userConfig.importedAddons = {};
        if (req.userConfig.importedAddons[addonId]) {
             return res.status(400).json({ error: `List "${listNameForDisplay}" from ${sourceSystem} is already imported.` });
        }
        if (!addonToStore.hasMovies && !addonToStore.hasShows) {
            return res.status(400).json({ error: `List "${listNameForDisplay}" from ${sourceSystem} contains no movie or show content.` });
        }
        req.userConfig.importedAddons[addonId] = addonToStore;
        req.userConfig.lastUpdated = new Date().toISOString();
        const newConfigHash = await compressConfig(req.userConfig);
        manifestCache.clear();
        res.json({ success: true, configHash: newConfigHash, addon: req.userConfig.importedAddons[addonId], message: `Imported ${listNameForDisplay} from ${sourceSystem}` });
    } catch (error) {
        console.error('Error in /import-list-url:', error);
        res.status(500).json({ error: error.message || `Failed to import URL` });
    }
  });

  router.post('/:configHash/import-addon', async (req, res) => {
    try {
        const { manifestUrl } = req.body;
        if (!manifestUrl) return res.status(400).json({ error: 'Manifest URL required' });

        const addonInfo = await importExtAddon(manifestUrl, req.userConfig);

        if (!req.userConfig.importedAddons) {
            req.userConfig.importedAddons = {};
        }

        if (req.userConfig.importedAddons[addonInfo.id]) {
            console.warn(`Re-importing addon with manifest ID: ${addonInfo.id}. Overwriting with new import.`);
            req.userConfig.importedAddons[addonInfo.id] = addonInfo;
        } else {
            req.userConfig.importedAddons[addonInfo.id] = addonInfo;
        }

        const finalAddonEntry = req.userConfig.importedAddons[addonInfo.id];
        if (finalAddonEntry && finalAddonEntry.catalogs) {
            finalAddonEntry.hasMovies = finalAddonEntry.catalogs.some(c => {
                const typeFromCatalog = c.type;
                const sourceManifestTypes = addonInfo.types || [];
                return typeFromCatalog === 'movie' || (typeFromCatalog === 'all' && sourceManifestTypes.includes('movie'));
            });
            finalAddonEntry.hasShows = finalAddonEntry.catalogs.some(c => {
                const typeFromCatalog = c.type;
                const sourceManifestTypes = addonInfo.types || [];
                return typeFromCatalog === 'series' || typeFromCatalog === 'tv' || (typeFromCatalog === 'all' && (sourceManifestTypes.includes('series') || sourceManifestTypes.includes('tv')));
            });
        }

        req.userConfig.lastUpdated = new Date().toISOString();
        const newConfigHash = await compressConfig(req.userConfig);
        manifestCache.clear();
        res.json({ success: true, configHash: newConfigHash, addon: req.userConfig.importedAddons[addonInfo.id], message: `Imported ${addonInfo.name}` });
    } catch (error) {
        console.error('Error in /import-addon:', error);
        res.status(500).json({ error: 'Failed to import addon by manifest', details: error.message });
    }
  });

  router.post('/:configHash/remove-addon', async (req, res) => {
    try {
        const { addonId } = req.body;
        if (!addonId || !req.userConfig.importedAddons || !req.userConfig.importedAddons[addonId]) {
            return res.status(400).json({ error: 'Invalid addon ID or addon not found in imports.' });
        }

        const addonToRemove = req.userConfig.importedAddons[addonId];
        delete req.userConfig.importedAddons[addonId];

        purgeListConfigs(req.userConfig, addonId, true);

        if (addonToRemove && addonToRemove.catalogs && Array.isArray(addonToRemove.catalogs)) {
            for (const subCatalog of addonToRemove.catalogs) {
                const subCatalogIdStr = String(subCatalog.id);
                purgeListConfigs(req.userConfig, subCatalogIdStr, true);
                const subCatalogOriginalId = String(subCatalog.originalId);
                if (subCatalogOriginalId && subCatalogOriginalId !== subCatalogIdStr && req.userConfig.sortPreferences?.[subCatalogOriginalId]) {
                     delete req.userConfig.sortPreferences[subCatalogOriginalId];
                }
            }
        }

        req.userConfig.lastUpdated = new Date().toISOString();
        const newConfigHash = await compressConfig(req.userConfig);
        manifestCache.clear();
        res.json({ success: true, configHash: newConfigHash, message: 'Addon group and its configurations removed.' });
    } catch (error) {
        console.error('Error in /remove-addon:', error);
        res.status(500).json({ error: 'Failed to remove addon group', details: error.message });
    }
  });

  router.post('/:configHash/lists/order', async (req, res) => {
    try {
        const { order } = req.body;
        if (!Array.isArray(order)) return res.status(400).json({ error: 'Order must be an array of strings.' });
        req.userConfig.listOrder = order.map(String);
        req.userConfig.lastUpdated = new Date().toISOString();
        const newConfigHash = await compressConfig(req.userConfig);
        manifestCache.clear();
        res.json({ success: true, configHash: newConfigHash, message: 'List order updated' });
    } catch (error) {
        console.error('Failed to update list order:', error);
        res.status(500).json({ error: 'Failed to update list order' });
    }
  });

  router.post('/:configHash/lists/names', async (req, res) => {
    try {
      const { listId, customName } = req.body;
      if (!listId) return res.status(400).json({ error: 'List ID required' });
      if (!req.userConfig.customListNames) req.userConfig.customListNames = {};
      if (customName && customName.trim()) {
        req.userConfig.customListNames[String(listId)] = customName.trim();
      } else {
        delete req.userConfig.customListNames[String(listId)];
      }
      req.userConfig.lastUpdated = new Date().toISOString();
      const newConfigHash = await compressConfig(req.userConfig);
      manifestCache.clear();
      res.json({ success: true, configHash: newConfigHash, message: 'List name updated' });
    } catch (error) {
        console.error('Failed to update list name:', error);
        res.status(500).json({ error: 'Failed to update list name' });
    }
  });

  // New endpoint to save custom media type names
  router.post('/:configHash/lists/mediatype', async (req, res) => {
    try {
      const { listId, customMediaType } = req.body;
      if (!listId) return res.status(400).json({ error: 'List ID required for custom media type.' });

      if (!req.userConfig.customMediaTypeNames) {
        req.userConfig.customMediaTypeNames = {};
      }

      if (customMediaType && customMediaType.trim()) {
        req.userConfig.customMediaTypeNames[String(listId)] = customMediaType.trim();
      } else {
        // If customMediaType is empty or null, remove the custom setting
        delete req.userConfig.customMediaTypeNames[String(listId)];
      }

      req.userConfig.lastUpdated = new Date().toISOString();
      const newConfigHash = await compressConfig(req.userConfig);
      manifestCache.clear();
      res.json({ success: true, configHash: newConfigHash, message: 'Custom media type display name updated' });
    } catch (error) {
      console.error('Failed to update custom media type name:', error);
      res.status(500).json({ error: 'Failed to update custom media type name' });
    }
  });

  router.post('/:configHash/lists/visibility', async (req, res) => {
    try {
      const { hiddenLists } = req.body;
      if (!Array.isArray(hiddenLists)) return res.status(400).json({ error: 'Hidden lists must be an array of strings.' });
      req.userConfig.hiddenLists = hiddenLists.map(String);
      req.userConfig.lastUpdated = new Date().toISOString();
      const newConfigHash = await compressConfig(req.userConfig);
      manifestCache.clear();
      res.json({ success: true, configHash: newConfigHash, message: 'List visibility updated' });
    } catch (error) {
        console.error('Failed to update list visibility:', error);
        res.status(500).json({ error: 'Failed to update list visibility' });
    }
  });

  router.post('/:configHash/lists/remove', async (req, res) => {
    try {
      const { listIds } = req.body;
      if (!Array.isArray(listIds)) return res.status(400).json({ error: 'List IDs must be an array of strings.' });

      const currentRemoved = new Set(req.userConfig.removedLists || []);

      for (const listIdToRemove of listIds) {
        const idStr = String(listIdToRemove);

        const addonDetails = req.userConfig.importedAddons?.[idStr];
        const isUrlImport = addonDetails && (addonDetails.isMDBListUrlImport || addonDetails.isTraktPublicList);

        const isNativeMDBList = idStr.startsWith('aiolists-');
        const isNativeTrakt = idStr.startsWith('trakt_') && !idStr.startsWith('traktpublic_');
        const isRandomCatalog = idStr === 'random_mdblist_catalog';

        let isSubCatalog = false;
        let parentAddonIdForSubCatalog = null;
        let subCatalogOriginalId = null;

        if (!isNativeMDBList && !isNativeTrakt && !isUrlImport && !isRandomCatalog) {
            for (const importedAddonId in req.userConfig.importedAddons) {
                const parentAddon = req.userConfig.importedAddons[importedAddonId];
                if (parentAddon && !(parentAddon.isMDBListUrlImport || parentAddon.isTraktPublicList) && parentAddon.catalogs) {
                    const foundCatalog = parentAddon.catalogs.find(cat => String(cat.id) === idStr);
                    if (foundCatalog) {
                        isSubCatalog = true;
                        parentAddonIdForSubCatalog = importedAddonId;
                        subCatalogOriginalId = String(foundCatalog.originalId);
                        break;
                    }
                }
            }
        }

        if (isRandomCatalog) {
            console.log(`Disabling Random MDBList Catalog feature due to removal from UI.`);
            req.userConfig.enableRandomListFeature = false;
        } else if (isUrlImport) {
          console.log(`Purging URL import: ${idStr}`);
          if (req.userConfig.importedAddons) delete req.userConfig.importedAddons[idStr];
          purgeListConfigs(req.userConfig, idStr, true);
        } else if (isSubCatalog && parentAddonIdForSubCatalog) {
          console.log(`Purging sub-catalog: ${idStr} from parent ${parentAddonIdForSubCatalog}`);
          purgeListConfigs(req.userConfig, idStr, true);
          if (subCatalogOriginalId && subCatalogOriginalId !== idStr && req.userConfig.sortPreferences?.[subCatalogOriginalId]) {
            delete req.userConfig.sortPreferences[subCatalogOriginalId];
          }
          if (req.userConfig.importedAddons[parentAddonIdForSubCatalog]?.catalogs) {
            req.userConfig.importedAddons[parentAddonIdForSubCatalog].catalogs =
              req.userConfig.importedAddons[parentAddonIdForSubCatalog].catalogs.filter(cat => String(cat.id) !== idStr);
          }
        } else if (isNativeMDBList || isNativeTrakt) {
          console.log(`Soft deleting native list: ${idStr}`);
          currentRemoved.add(idStr);
          if (req.userConfig.hiddenLists) {
            req.userConfig.hiddenLists = req.userConfig.hiddenLists.filter(id => String(id) !== idStr);
          }
        } else {
          console.warn(`Removing unclassified list ID: ${idStr}. Assuming it's a top-level manifest import being removed.`);
          if (req.userConfig.importedAddons && req.userConfig.importedAddons[idStr]) {
             delete req.userConfig.importedAddons[idStr];
          }
          purgeListConfigs(req.userConfig, idStr, true);
        }
      }

      req.userConfig.removedLists = Array.from(currentRemoved);

      req.userConfig.lastUpdated = new Date().toISOString();
      const newConfigHash = await compressConfig(req.userConfig);
      manifestCache.clear();
      res.json({ success: true, configHash: newConfigHash, message: 'Lists processed for removal' });
    } catch (error) {
        console.error('Failed to remove lists:', error);
        res.status(500).json({ error: 'Failed to remove lists', details: error.message });
    }
  });

  router.post('/:configHash/lists/sort', async (req, res) => {
    try {
      const { listId, sort, order } = req.body;
      if (!listId || !sort) return res.status(400).json({ error: 'List ID (originalId) and sort field required' });
      if (!req.userConfig.sortPreferences) req.userConfig.sortPreferences = {};
      req.userConfig.sortPreferences[String(listId)] = { sort, order: order || 'desc' };
      req.userConfig.lastUpdated = new Date().toISOString();
      const newConfigHash = await compressConfig(req.userConfig);
      manifestCache.clear();
      res.json({ success: true, configHash: newConfigHash, message: 'Sort preferences updated' });
    } catch (error) {
        console.error('Failed to update sort preferences:', error);
        res.status(500).json({ error: 'Failed to update sort preferences' });
    }
  });

  router.post('/:configHash/lists/merge', async (req, res) => {
    try {
        const { listId, merged } = req.body;
        if (!listId || typeof merged !== 'boolean') {
            return res.status(400).json({ error: 'List ID (manifestId) and merge preference (boolean) required' });
        }

        let canBeMerged = false;
        const listInfoFromMetadata = req.userConfig.listsMetadata?.[listId];
        const listInfoFromImported = req.userConfig.importedAddons?.[listId];
        
        if (listInfoFromMetadata) {
            if (listInfoFromMetadata.hasMovies && listInfoFromMetadata.hasShows) {
                canBeMerged = true;
            }
        } else if (listInfoFromImported) {
            if (listInfoFromImported.hasMovies && listInfoFromImported.hasShows) {
                canBeMerged = true;
            }
        }
        
        if (!canBeMerged && merged === true) { // If trying to set to merged, but source doesn't have both
          return res.status(400).json({ error: 'This list does not contain both movies and series, so it cannot be merged into a single "All" type view.' });
        }
        
        if (!req.userConfig.mergedLists) req.userConfig.mergedLists = {};
        req.userConfig.mergedLists[String(listId)] = merged;
        req.userConfig.lastUpdated = new Date().toISOString();
        const newConfigHash = await compressConfig(req.userConfig);
        manifestCache.clear();
        res.json({ success: true, configHash: newConfigHash, message: `List ${merged ? 'merged' : 'split'}` });
    } catch (error) {
        console.error('Failed to update list merge preference:', error);
        res.status(500).json({ error: 'Failed to update list merge preference' });
    }
  });

  router.post('/config/create', async (req, res) => {
    try {
      let newConfig = { ...defaultConfig, listOrder: [], hiddenLists: [], removedLists: [], customListNames: {}, customMediaTypeNames: {}, mergedLists: {}, sortPreferences: {}, importedAddons: {}, listsMetadata: {}, enableRandomListFeature: false, lastUpdated: new Date().toISOString() };

      if (req.body.sharedConfig) {
        const sharedSettings = await decompressConfig(req.body.sharedConfig);
        const shareablePart = createShareableConfig(sharedSettings);
        newConfig = { ...newConfig, ...shareablePart };
      }

      const { sharedConfig, ...otherBodyParams } = req.body;
      newConfig = { ...newConfig, ...otherBodyParams };

      const configHash = await compressConfig(newConfig);
      res.json({ success: true, configHash });
    } catch (error) { console.error('Error in /config/create:', error); res.status(500).json({ error: 'Failed to create configuration' }); }
  });

  router.post('/validate-keys', async (req, res) => {
    try {
      const { apiKey, rpdbApiKey } = req.body;
      const results = { mdblist: null, rpdb: null };

      if (apiKey) {
        const mdblistResult = await validateMDBListKey(apiKey);
        results.mdblist = (mdblistResult && mdblistResult.username) ? { valid: true, username: mdblistResult.username } : { valid: false };
      }
      if (rpdbApiKey) {
        results.rpdb = { valid: await validateRPDBKey(rpdbApiKey) };
      }
      res.json(results);
    } catch (error) {
        console.error('Error in /validate-keys:', error);
        res.status(500).json({ error: 'Failed to validate keys' });
    }
  });

  router.get('/trakt/login', (req, res) => {
    try { res.redirect(getTraktAuthUrl()); }
    catch (error) {
        console.error('Error in /trakt/login redirect:', error);
        res.status(500).json({ error: 'Internal server error for Trakt login' });
    }
  });

  router.get('/:configHash/lists', async (req, res) => {
    try {
      let allUserLists = [];
      if (req.userConfig.apiKey) {
          const mdbLists = await fetchAllMDBLists(req.userConfig.apiKey);
          allUserLists.push(...mdbLists.map(l => ({...l, source: 'mdblist'})));
      }
      if (req.userConfig.traktAccessToken) {
          const traktLists = await fetchTraktUserLists(req.userConfig);
          allUserLists.push(...traktLists.map(l => ({...l, source: 'trakt'})));
      }

      const removedListsSet = new Set(req.userConfig.removedLists || []);
      let configChangedDueToMetadataFetch = false;
      if (!req.userConfig.listsMetadata) req.userConfig.listsMetadata = {};
      if (!req.userConfig.customMediaTypeNames) req.userConfig.customMediaTypeNames = {};


      let processedLists = [];

      if (req.userConfig.enableRandomListFeature && req.userConfig.apiKey) {
        const manifestListId = 'random_mdblist_catalog';
        const customTypeName = req.userConfig.customMediaTypeNames?.[manifestListId];
        let effectiveMediaTypeDisplay = customTypeName || 'All';


        const randomCatalogUIEntry = {
            id: manifestListId,
            originalId: manifestListId,
            name: 'Random MDBList Catalog',
            customName: req.userConfig.customListNames?.[manifestListId] || null,
            effectiveMediaTypeDisplay: effectiveMediaTypeDisplay,
            isHidden: (req.userConfig.hiddenLists || []).includes(manifestListId),
            hasMovies: true, hasShows: true, canBeMerged: false,
            isRandomCatalog: true, tag: '🎲', tagImage: null,
            sortPreferences: req.userConfig.sortPreferences?.[manifestListId] || { sort: 'default', order: 'desc' },
            isMerged: false, source: 'random_mdblist'
        };
        if (randomCatalogUIEntry.customName) randomCatalogUIEntry.name = randomCatalogUIEntry.customName;
        processedLists.push(randomCatalogUIEntry);
      }

      const activeListsProcessingPromises = allUserLists
        .map(async list => {
            const originalListIdStr = String(list.id);
            let manifestListId = originalListIdStr;
            let tagType = 'L';
            let hasMovies, hasShows, canBeMergedFromSource;

            if (list.source === 'mdblist') {
                const listTypeSuffix = list.listType || 'L';
                manifestListId = list.id === 'watchlist' ? `aiolists-watchlist-W` : `aiolists-${list.id}-${listTypeSuffix}`;
                tagType = listTypeSuffix;

                const mediatype = list.mediatype;
                const dynamic = list.dynamic;
                hasMovies = (mediatype === 'movie' || !mediatype || mediatype === '');
                hasShows = (mediatype === 'show' || mediatype === 'series' || !mediatype || mediatype === '');
                canBeMergedFromSource = (dynamic === false || !mediatype || mediatype === '');

                req.userConfig.listsMetadata[manifestListId] = {
                    ...(req.userConfig.listsMetadata[manifestListId] || {}),
                    hasMovies, hasShows, canBeMerged: canBeMergedFromSource,
                    lastChecked: new Date().toISOString()
                };
            } else if (list.source === 'trakt'){
                manifestListId = list.id;
                tagType = 'T';
                let metadata = req.userConfig.listsMetadata[manifestListId] || req.userConfig.listsMetadata[originalListIdStr] || {};
                hasMovies = metadata.hasMovies === true;
                hasShows = metadata.hasShows === true;
                canBeMergedFromSource = true;

                if (typeof metadata.hasMovies !== 'boolean' || typeof metadata.hasShows !== 'boolean') {
                    if (req.userConfig.traktAccessToken) {
                        const tempContent = await fetchListContent(manifestListId, { ...req.userConfig, rpdbApiKey: null }, 0, null, 'all');
                        hasMovies = tempContent?.hasMovies || false;
                        hasShows = tempContent?.hasShows || false;
                        req.userConfig.listsMetadata[manifestListId] = { ...metadata, hasMovies, hasShows, canBeMerged: true, lastChecked: new Date().toISOString() };
                        configChangedDueToMetadataFetch = true;
                    } else {
                        hasMovies = metadata.hasMovies || false;
                        hasShows = metadata.hasShows || false;
                        req.userConfig.listsMetadata[manifestListId] = { ...metadata, hasMovies, hasShows, canBeMerged: true, lastChecked: new Date().toISOString() };
                    }
                }
            } else {
                hasMovies = false; hasShows = false; canBeMergedFromSource = false;
            }

            if (list.isWatchlist) tagType = 'W';
            if (removedListsSet.has(manifestListId)) return null;

            const actualCanBeMerged = canBeMergedFromSource && hasMovies && hasShows;
            const isUserMerged = actualCanBeMerged ? (req.userConfig.mergedLists?.[manifestListId] !== false) : false;

            let defaultSort = { sort: (list.source === 'trakt') ? 'rank' : 'default', order: (list.source === 'trakt') ? 'asc' : 'desc' };
            if (list.source === 'trakt' && list.isTraktWatchlist) {
                defaultSort = { sort: 'added', order: 'desc' };
            }

            const customTypeName = req.userConfig.customMediaTypeNames?.[manifestListId];
            let effectiveMediaTypeDisplay;
            if (customTypeName) {
                effectiveMediaTypeDisplay = customTypeName;
            } else {
                if (hasMovies && hasShows) effectiveMediaTypeDisplay = 'All';
                else if (hasMovies) effectiveMediaTypeDisplay = 'Movie';
                else if (hasShows) effectiveMediaTypeDisplay = 'Series';
                else effectiveMediaTypeDisplay = 'N/A';
            }


            return {
                id: manifestListId,
                originalId: originalListIdStr,
                name: list.name,
                customName: req.userConfig.customListNames?.[manifestListId] || null,
                effectiveMediaTypeDisplay: effectiveMediaTypeDisplay,
                isHidden: (req.userConfig.hiddenLists || []).includes(manifestListId),
                hasMovies: hasMovies,
                hasShows: hasShows,
                canBeMerged: actualCanBeMerged,
                isMerged: isUserMerged,
                isTraktList: list.source === 'trakt' && list.isTraktList,
                isTraktWatchlist: list.source === 'trakt' && list.isTraktWatchlist,
                isTraktRecommendations: list.isTraktRecommendations,
                isTraktTrending: list.isTraktTrending,
                isTraktPopular: list.isTraktPopular,
                isWatchlist: !!list.isWatchlist,
                tag: tagType,
                listType: list.listType,
                tagImage: list.source === 'trakt' ? 'https://walter.trakt.tv/hotlink-ok/public/favicon.ico' : null,
                sortPreferences: req.userConfig.sortPreferences?.[originalListIdStr] || defaultSort,
                source: list.source,
                dynamic: list.dynamic,
                mediatype: list.mediatype
            };
        });

        const activeListsResults = (await Promise.all(activeListsProcessingPromises)).filter(p => p !== null);
        processedLists.push(...activeListsResults);

        if (req.userConfig.importedAddons) {
          for (const addonKey in req.userConfig.importedAddons) {
              const addon = req.userConfig.importedAddons[addonKey];
              const addonGroupId = String(addon.id);

              if (removedListsSet.has(addonGroupId) || (req.userConfig.hiddenLists || []).includes(addonGroupId)) continue;

              const isMDBListUrlImport = !!addon.isMDBListUrlImport;
              const isTraktPublicList = !!addon.isTraktPublicList;

              if (isMDBListUrlImport || isTraktPublicList) {
                   let urlImportHasMovies = addon.hasMovies;
                   let urlImportHasShows = addon.hasShows;
                   let urlImportCanBeMerged = true;
                    if (isMDBListUrlImport && typeof addon.dynamic === 'boolean' && typeof addon.mediatype !== 'undefined') {
                        urlImportCanBeMerged = (addon.dynamic === false || !addon.mediatype || addon.mediatype === '');
                    }

                  if ((urlImportHasMovies || urlImportHasShows)) {
                      let tagType = 'A';
                      let tagImage = addon.logo;
                      if(isMDBListUrlImport) { tagType = 'L'; tagImage = null; }
                      else if (isTraktPublicList) { tagType = 'T'; tagImage = 'https://walter.trakt.tv/hotlink-ok/public/favicon.ico'; }

                      let sortOriginalId = addon.mdblistId || (isTraktPublicList ? `traktpublic_${addon.traktUser}_${addon.traktListSlug}` : addonGroupId);
                      const actualCanBeMergedForUrl = urlImportCanBeMerged && urlImportHasMovies && urlImportHasShows;
                      const isUserMergedForUrl = actualCanBeMergedForUrl ? (req.userConfig.mergedLists?.[addonGroupId] !== false) : false;

                      const customTypeName = req.userConfig.customMediaTypeNames?.[addonGroupId];
                      let effectiveMediaTypeDisplay;
                      if (customTypeName) {
                          effectiveMediaTypeDisplay = customTypeName;
                      } else {
                          if (urlImportHasMovies && urlImportHasShows) effectiveMediaTypeDisplay = 'All';
                          else if (urlImportHasMovies) effectiveMediaTypeDisplay = 'Movie';
                          else if (urlImportHasShows) effectiveMediaTypeDisplay = 'Series';
                          else effectiveMediaTypeDisplay = 'N/A';
                      }

                      processedLists.push({
                          id: addonGroupId,
                          originalId: sortOriginalId,
                          name: addon.name,
                          customName: req.userConfig.customListNames?.[addonGroupId] || null,
                          effectiveMediaTypeDisplay: effectiveMediaTypeDisplay,
                          isHidden: (req.userConfig.hiddenLists || []).includes(addonGroupId),
                          hasMovies: urlImportHasMovies,
                          hasShows: urlImportHasShows,
                          canBeMerged: actualCanBeMergedForUrl,
                          isMerged: isUserMergedForUrl,
                          addonId: addonGroupId,
                          addonName: addon.name,
                          tag: tagType,
                          tagImage: tagImage,
                          sortPreferences: req.userConfig.sortPreferences?.[sortOriginalId] ||
                                           { sort: (isTraktPublicList ? 'rank' : 'default'),
                                             order: (isTraktPublicList ? 'asc' : 'desc') },
                          source: isMDBListUrlImport ? 'mdblist_url' : (isTraktPublicList ? 'trakt_public' : 'addon_url_import'),
                          isUrlImportedType: true,
                          isMDBListUrlImport: isMDBListUrlImport,
                          isTraktPublicList: isTraktPublicList,
                          traktUser: addon.traktUser,
                          traktListSlug: addon.traktListSlug,
                          requiresApiKey: isMDBListUrlImport ? 'mdblist' : (isTraktPublicList ? null : null),
                          dynamic: isMDBListUrlImport ? addon.dynamic : undefined,
                          mediatype: isMDBListUrlImport ? addon.mediatype : undefined
                      });
                  }
              }
              else if (addon.catalogs && addon.catalogs.length > 0) {
                   (addon.catalogs || []).forEach(catalog => {
                      const catalogIdStr = String(catalog.id);
                      if (removedListsSet.has(catalogIdStr) || (req.userConfig.hiddenLists || []).includes(catalogIdStr)) return;
                      let catalogHasMovies = catalog.type === 'movie';
                      let catalogHasShows = catalog.type === 'series' || catalog.type === 'tv';
                      if (catalog.type === 'all') {
                          catalogHasMovies = addon.types?.includes('movie');
                          catalogHasShows = addon.types?.includes('series') || addon.types?.includes('tv');
                      }
                      const subCatalogCanBeMerged = catalogHasMovies && catalogHasShows;
                      const subCatalogIsUserMerged = subCatalogCanBeMerged ? (req.userConfig.mergedLists?.[catalogIdStr] !== false) : false;

                      const customTypeName = req.userConfig.customMediaTypeNames?.[catalogIdStr];
                      let effectiveMediaTypeDisplay;
                      if (customTypeName) {
                          effectiveMediaTypeDisplay = customTypeName;
                      } else {
                          if (catalogHasMovies && catalogHasShows) effectiveMediaTypeDisplay = 'All';
                          else if (catalogHasMovies) effectiveMediaTypeDisplay = 'Movie';
                          else if (catalogHasShows) effectiveMediaTypeDisplay = 'Series';
                          else effectiveMediaTypeDisplay = 'N/A'; // Or based on catalog.type
                      }

                      processedLists.push({
                          id: catalogIdStr,
                          originalId: catalog.originalId || catalogIdStr,
                          name: catalog.name,
                          customName: req.userConfig.customListNames?.[catalogIdStr] || null,
                          effectiveMediaTypeDisplay: effectiveMediaTypeDisplay,
                          isHidden: (req.userConfig.hiddenLists || []).includes(catalogIdStr),
                          hasMovies: catalogHasMovies,
                          hasShows: catalogHasShows,
                          canBeMerged: subCatalogCanBeMerged,
                          isMerged: subCatalogIsUserMerged,
                          addonId: addon.id,
                          addonName: addon.name,
                          tag: 'A',
                          tagImage: addon.logo,
                          sortPreferences: req.userConfig.sortPreferences?.[catalog.originalId || catalogIdStr] || { sort: 'default', order: 'desc' },
                          source: 'addon_manifest',
                          isUrlImportedType: false,
                      });
                  });
              }
          }
      }

     if (req.userConfig.listOrder && req.userConfig.listOrder.length > 0) {
        const orderMap = new Map(req.userConfig.listOrder.map((id, index) => [String(id), index]));
        processedLists.sort((a, b) => {
            const indexA = orderMap.get(String(a.id));
            const indexB = orderMap.get(String(b.id));
            if (indexA !== undefined && indexB !== undefined) return indexA - indexB;
            if (indexA !== undefined) return -1;
            if (indexB !== undefined) return 1;
            return 0;
        });
    } else {
        processedLists.sort((a, b) => {
            if (a.id === 'random_mdblist_catalog' && b.id !== 'random_mdblist_catalog') return -1;
            if (b.id === 'random_mdblist_catalog' && a.id !== 'random_mdblist_catalog') return 1;
            return (a.name || '').localeCompare(b.name || '');
        });
    }

    let responsePayload = {
      success: true,
      lists: processedLists,
      importedAddons: req.userConfig.importedAddons || {},
      listsMetadata: req.userConfig.listsMetadata,
      isPotentiallySharedConfig: req.isPotentiallySharedConfig,
      randomMDBListUsernames: req.userConfig.randomMDBListUsernames // Send current usernames
    };

    if (configChangedDueToMetadataFetch) {
        req.userConfig.lastUpdated = new Date().toISOString();
        const newConfigHash = await compressConfig(req.userConfig);
        responsePayload.newConfigHash = newConfigHash;
        manifestCache.clear();
    }
    res.json(responsePayload);
  } catch (error) {
      console.error('Error fetching /lists:', error);
      res.status(500).json({ error: 'Failed to fetch lists', details: error.message });
  }
});

};