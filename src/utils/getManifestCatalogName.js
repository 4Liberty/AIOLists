// src/utils/getManifestCatalogName.js
/**
 * Returns the display name for a catalog in the manifest, using custom names if available.
 * @param {string} catalogId - The catalog/list ID
 * @param {string} fallbackName - The default/fallback name
 * @param {object} customListNames - User's custom list names mapping
 * @returns {string} Display name for the catalog
 */
function getManifestCatalogName(catalogId, fallbackName, customListNames = {}) {
  if (customListNames && typeof customListNames === 'object' && customListNames[catalogId]) {
    return customListNames[catalogId];
  }
  return fallbackName || catalogId;
}

module.exports = getManifestCatalogName;
