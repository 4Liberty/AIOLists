// Test file to verify our fixes
const { fetchTraktListItems } = require('./src/integrations/trakt');
const { TMDB_BEARER_TOKEN } = require('./src/config');

async function testFixes() {
  console.log('=== Testing Trakt Integration Fixes ===');
  
  // Test 1: Configuration validation
  console.log('\n1. Testing configuration validation...');
  const result1 = await fetchTraktListItems(null, null);
  console.log('Result for null params:', result1);
  
  // Test 2: TMDB Bearer Token availability
  console.log('\n2. Testing TMDB Bearer Token...');
  console.log('TMDB_BEARER_TOKEN from config:', TMDB_BEARER_TOKEN ? 'Available' : 'Missing');
  console.log('TMDB_BEARER_TOKEN from env:', process.env.TMDB_BEARER_TOKEN ? 'Available' : 'Missing');
  
  // Test 3: Fanart API Key
  console.log('\n3. Testing Fanart API Key...');
  console.log('FANART_API_KEY from env:', process.env.FANART_API_KEY ? 'Available' : 'Missing');
  
  // Test 4: Test with basic userConfig
  console.log('\n4. Testing with basic userConfig...');
  const testConfig = {
    traktAccessToken: null,
    tmdbBearerToken: process.env.TMDB_BEARER_TOKEN || TMDB_BEARER_TOKEN || '',
    metadataSource: 'tmdb',
    tmdbLanguage: 'tr'
  };
  
  const result2 = await fetchTraktListItems('trakt_trending_movies', testConfig, 0, 'rank', 'asc', false, null, 'movie', null, false);
  console.log('Result for trending movies:', result2);
  
  console.log('\n=== Test Complete ===');
}

// Run the test
testFixes().catch(console.error);
