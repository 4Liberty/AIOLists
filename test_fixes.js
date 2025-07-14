// Test file to verify our fixes work with persistent authentication
const { fetchTraktListItems, initTraktApi } = require('./src/integrations/trakt');
const { TMDB_BEARER_TOKEN } = require('./src/config');

async function testPersistentAuth() {
  console.log('=== Testing Persistent Authentication Fixes ===');
  
  // Test 1: Simulate a user with Upstash tokens
  console.log('\n1. Testing with simulated authenticated user...');
  const testConfig = {
    traktUuid: 'test-user-123',
    traktAccessToken: 'test-access-token',
    traktRefreshToken: 'test-refresh-token',
    traktExpiresAt: Date.now() + 3600000, // 1 hour from now
    upstashUrl: 'https://test-upstash.com',
    upstashToken: 'test-upstash-token',
    tmdbBearerToken: process.env.TMDB_BEARER_TOKEN || TMDB_BEARER_TOKEN || '',
    metadataSource: 'tmdb',
    tmdbLanguage: 'tr'
  };
  
  // Test 2: Check token caching
  console.log('\n2. Testing token caching...');
  const initResult1 = await initTraktApi(testConfig);
  console.log('First init result:', initResult1);
  
  const initResult2 = await initTraktApi(testConfig);
  console.log('Second init result (should use cache):', initResult2);
  
  // Test 3: Test trending movies (no auth required)
  console.log('\n3. Testing trending movies (no auth)...');
  const trendingResult = await fetchTraktListItems('trakt_trending_movies', testConfig, 0, 'rank', 'asc', false, null, 'movie', null, false);
  console.log('Trending movies result:', trendingResult ? 'Success' : 'Failed');
  
  // Test 4: Test user watchlist (auth required)
  console.log('\n4. Testing user watchlist (auth required)...');
  const watchlistResult = await fetchTraktListItems('trakt_watchlist', testConfig, 0, 'rank', 'asc', false, null, 'all', null, false);
  console.log('Watchlist result:', watchlistResult ? 'Success' : 'Failed');
  
  // Test 5: Test with no auth
  console.log('\n5. Testing with no authentication...');
  const noAuthConfig = {
    metadataSource: 'tmdb',
    tmdbLanguage: 'tr'
  };
  
  const noAuthResult = await fetchTraktListItems('trakt_trending_movies', noAuthConfig, 0, 'rank', 'asc', false, null, 'movie', null, false);
  console.log('No auth trending result:', noAuthResult ? 'Success' : 'Failed');
  
  console.log('\n=== Test Complete ===');
  console.log('If you see "Success" for trending movies, the basic functionality is working.');
  console.log('For user lists, you need valid Trakt authentication tokens.');
}

// Run the test
testPersistentAuth().catch(console.error);
