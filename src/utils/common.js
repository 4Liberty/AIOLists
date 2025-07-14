// src/utils/common.js

/**
 * Checks if a list ID represents a watchlist.
 * @param {string} listId - List ID to check.
 * @returns {boolean}
 */
function isWatchlist(listId) {
    if (!listId) return false;
    return listId.endsWith('watchlist') || 
           listId.endsWith('watchlist-W') ||
           listId.includes('trakt_watchlist'); // Covers both trakt_watchlist and aiolists-trakt_watchlist-T etc.
  }
  
  /**
   * Sets appropriate cache headers.
   * Watchlists get no cache. Other lists get a short cache time
   * to let Stremio handle the main caching.
   * @param {Object} res - Express response object.
   * @param {string} listId - List ID.
   */
  function setCacheHeaders(res, listId) {
    if (isWatchlist(listId)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      // Short cache time (e.g. 5 minutes) to rely on Stremio
      res.setHeader('Cache-Control', `public, max-age=${5 * 60}`); 
    }
  }
  
  module.exports = {
    isWatchlist,
    setCacheHeaders
  };