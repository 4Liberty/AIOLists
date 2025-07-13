// Comprehensive diagnostic script
require('dotenv').config();

console.log('=== AIOLists Diagnostic Report ===\n');

// 1. Environment Variables Check
console.log('1. Environment Variables:');
console.log('   NODE_ENV:', process.env.NODE_ENV || 'not set');
console.log('   PORT:', process.env.PORT || 'not set (default: 7000)');
console.log('   TMDB_BEARER_TOKEN:', process.env.TMDB_BEARER_TOKEN ? 'SET' : 'NOT SET');
console.log('   FANART_API_KEY:', process.env.FANART_API_KEY ? 'SET' : 'NOT SET');
console.log('   TRAKT_CLIENT_ID:', process.env.TRAKT_CLIENT_ID ? 'SET' : 'NOT SET (using default)');
console.log('   MDB_LIST_API_KEY:', process.env.MDB_LIST_API_KEY ? 'SET' : 'NOT SET');
console.log('   RPDB_API_KEY:', process.env.RPDB_API_KEY ? 'SET' : 'NOT SET');

// 2. Configuration Check
console.log('\n2. Configuration:');
try {
  const config = require('./src/config');
  console.log('   TMDB_BEARER_TOKEN from config:', config.TMDB_BEARER_TOKEN ? 'SET' : 'NOT SET');
  console.log('   TRAKT_CLIENT_ID from config:', config.TRAKT_CLIENT_ID ? 'SET' : 'NOT SET');
  console.log('   ITEMS_PER_PAGE:', config.ITEMS_PER_PAGE);
  console.log('   Default metadata source:', config.defaultConfig.metadataSource);
} catch (error) {
  console.log('   ERROR loading config:', error.message);
}

// 3. Fanart.tv API Check
console.log('\n3. Fanart.tv API:');
try {
  const { getMovieFanart } = require('./src/utils/getFanartImages');
  console.log('   Fanart module loaded successfully');
  
  // Test with a known movie (The Matrix - TMDB ID: 603)
  getMovieFanart('603', 'tr', 'en').then(result => {
    console.log('   Test fanart fetch result:', result);
  }).catch(error => {
    console.log('   Test fanart fetch error:', error.message);
  });
} catch (error) {
  console.log('   ERROR loading fanart module:', error.message);
}

// 4. Trakt API Check
console.log('\n4. Trakt API:');
try {
  const { validateTraktApi } = require('./src/integrations/trakt');
  
  validateTraktApi().then(isValid => {
    console.log('   Trakt API validation:', isValid ? 'VALID' : 'INVALID');
  }).catch(error => {
    console.log('   Trakt API validation error:', error.message);
  });
} catch (error) {
  console.log('   ERROR loading trakt module:', error.message);
}

// 5. Critical Dependencies Check
console.log('\n5. Dependencies:');
const criticalDeps = ['axios', 'express', 'cors', 'fanart.tv-api', 'stremio-addon-sdk'];
criticalDeps.forEach(dep => {
  try {
    require(dep);
    console.log(`   ${dep}: OK`);
  } catch (error) {
    console.log(`   ${dep}: ERROR - ${error.message}`);
  }
});

// 6. Summary and Recommendations
console.log('\n=== SUMMARY ===');
console.log('');
console.log('REQUIRED FOR BASIC FUNCTIONALITY:');
console.log('- TMDB_BEARER_TOKEN: ' + (process.env.TMDB_BEARER_TOKEN ? '✓ SET' : '✗ MISSING'));
console.log('- FANART_API_KEY: ' + (process.env.FANART_API_KEY ? '✓ SET' : '✗ MISSING'));
console.log('');
console.log('OPTIONAL BUT RECOMMENDED:');
console.log('- MDB_LIST_API_KEY: ' + (process.env.MDB_LIST_API_KEY ? '✓ SET' : '○ NOT SET'));
console.log('- RPDB_API_KEY: ' + (process.env.RPDB_API_KEY ? '✓ SET' : '○ NOT SET'));
console.log('');

if (!process.env.TMDB_BEARER_TOKEN) {
  console.log('⚠️  CRITICAL: TMDB_BEARER_TOKEN is required for metadata fetching!');
  console.log('   Get it from: https://www.themoviedb.org/settings/api');
}

if (!process.env.FANART_API_KEY) {
  console.log('⚠️  CRITICAL: FANART_API_KEY is required for logo fetching!');
  console.log('   Get it from: https://fanart.tv/get-an-api-key/');
}

console.log('\nDone. Check the logs above for any errors.');
