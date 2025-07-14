const zlib = require('zlib');

const configData = 'H4sIAAAAAAAAA71aSY-r2JL-K1esk7zMhtyBDTa2GYzBGFpXFsNhMKOZTelKvXu7lnrT2_oD3Yvq9dtV9a5_zPsJLZyZd8ihbr1-T5VKKUWcGM75Ik5ARORPkFPGG3CFHiD8gjQ-geZoi-ThrI7TlgCgIYsOuoOq0nfZZ8YGh30Ep0h_FsAohRIwQdEe7JIoCVM-jjkuhWAU5kF3UJP5LgecClR6kYAceoDAdR25Sy9W4rVojCIqx2vmfiL65i5WYhGzdQuRMyGVz3wvmztExnjM1uVMWrCEjFmonPGoND1fxVrMyNiORUrSPVTSjV5aWIi0J0Zl3scefojFcxHL5xCTTQmXz0ImnRPU1icbHiKPLCqbu0GM-9jD5M5bHkbxXLpiJvTOgbnappCIKVKLuZ16uVy6GBErZ4G5P-3JgEJWc8OxwaHYdQ0XDEdU3tD7dEdSw1JDhAZ2A6Laik8I7EFdx0Uu-tAD5KG46zg4FbgO4fsB5TMMiTFEgBMBgwDfIR2fJIFPPomynle0eTOJYhiK0gQ1e1wwalDlTgagB8hyapDFOcVwTu1U0B2UgcbxncbZF23lTRyTwJPCrZOHrRPeqBNvUzlJw3oeqOsnF-Vtmj7RNRBUoI5eL_BDGVegZpvvqN_sad9UwMn4oQRVA91BaVw3SuWDCnr4l0feU1mUbepUp6zoYlA_7-QLuY6K_iu1qUDux3n4kvsL_Xv2CnhFloHcd5q4yOuXUi-XvwhnvnvqncaLpv0-EwKnK6q4uclXTu4X2Snz3Ynj5DmNkxYhdAc5cTFRahhFcBrH4O23tC8qYfPLHr41U1ThfeX4cVGfnv5kbR170Kc7KHXqxih9pwFT8GAIRsLIDEYJHUEfyNkDit5jBGk_IVxLT46HHn56ufeHn6DIqaVHIB4CJ63B3UTZ387-TJjMzSPgJd-ZQ3AdQR4Q9AGd3WMYakOfX2H1T1PPzG7q38TuHzHyCrLPbzntewtN1f5jBt4K6R8c4tHmHzRxB4GqKioBNF4U5-GTuleGn8L_n3m4H1j-5wTG32v1RTb4E5F-mZ_-RKjfTmZ_4tnfSbZ_AgSf76Ao9n2Qb6dbPL1a3km5b2XnV7n9Vfaf0nLdVCCLi_tnDc-pv63SU1OUMIqcgjjNUlD9EYGnKIHzoodvfjr58RhPwp_uoApkRQf857N8uoO8tm6KbCLITvYI6cu0C-nSgnt9mkf6B-FGSEEV53__eR6gX_8jBx9-_ctvvyTOH5J__3ivdL2d36EVKOv4TYc9QHz-gQO__QzyOAX5h02RAT_-IDxuNn7jvfoALeLffgbVBzV1mqCostSpUufDHuRJVeTxCH70ufC46Qm__AefDm9xvkoJ0PLXv-Y-yHyQxO99wLzN9DKPQ2pR_vrXx5h78xXzLcN7HxcPkOb41yJ1qulNlYEq_BJ7P31-jj0J-LGjX0vwJQDf-QJ6gCqnbkKQgg9_-_nf_vt9DydO9dsv__Pzb78k77j5KfwmNf_5plfj__3LmIIMfJieQf7hbz__-7_-2JVvqn3Pm09hOzH_1-849E2drzz6prJXLn1T10u3vlT1Mhm8QORlTvgO-_fjIvv1r2OcTFERZ2VRNcBnfb_Ib-5_KwdM9HjK328u3kFPJQErKtsnSgeqqSCCHiD0HrufweiMREkEoSkGJZDpY7YIC-gBipqmrB8-fvT8HI69Iq_hMg_vg9Rppqd7r8g-kij2EZ9-CYq8L_Pbp3gZc04NjCr9RsXzdu5BGkRF3QD_Jr4iapF9_pkdXPy4jZVoDQtGdQRsKVrSjDgXu2R3dVl9PteTTW6kFSugLRscKnshrg855rUMfsSWatAAcyamFto07tamZ_m8aqlDu7cZBweiT-xwRsttUaPiNSbZHqMccG_j2JUrA_R0pVH5wjBViuFdt0A41_fToMpMz--UGFUqTAntovCkUeC8pVSvM3wdz_a8n_tmUbshMitmARep2FWlAHbUyaFQu1moKR1JtkIzU3siH3s4FzGP8NNCbmGFO7kdDEaQede26VSlHo-nwBTkMpFP1EovpQHHtLNyljWqZkqVOzMoARrCH33XRZzFyc99sh29IMK1eUTi62JL-6o3C9aVeggq8tTUYIT9lHYpIq_JU0V7yIF0x3Esg4ZmFFHPrsFY0q2cMHlzcml65zNZRpVUMHpLDZ_53moGsJIBVQujpnUmGNNmAGX2VGCO5jb0S7jd4ic3gBmJadwRZfK9SW5cispRkeuHtUuq6tEvhniWllsyAhveLflEVTO-9ZNI8oyY1bUxvGjeNWQkIobndA8Tl2HTitdzLBPH407uxxhmtm6Sl2pajMShJGnGdaKzemZYJW0duZ1nEcbpARr2yThPVGKrAGceEIF0SrvQdTUs7ulBM1VedrIZkg7d5ZSZzckcZ7qlxBxTrFNcY-XaEUeXU4ulHaa-yMKnA30gSlo_dJedYSKuw1dbid6GmSnniB6sWLeQL0mXNFix1gq22PfhCYALhlj-LiyyjGcFIY5W1mZu7KSkVrnwVBirRcOKFyXIHMWqPEvZCdZolTvSjHajKgKr1WDZJA9junSEBc7Ox9XmtK5FZSznB-zCorNAzH1WbfoMOTK91FbNOC7VtZNK3omrSt4tturI0utwdEmu2R_lSo-3hl9nin9wR5nb8kxuLQYCW4eEiNNL_3ABVaOTVeVRtUfZeHuqbBKBA4VB89rq6MQ_S_sVs8pWhab7XdxvF4QOYxpyxeszvNEoo6lhSl9vfLk4xibn42XJm4pPVfu88dvRLxgc66orZTGAGlImWOw1zcD0dgVokdJPIEtiLRq71A7LOFpRIfD7Pgpnndzhm3NjaqjfWgjpYVWcNReF0NA0UqIyCkcuZU0tM43giLG4mEeUL2m4jyzQIS6Bf44psduLsOF4TQuvEXTjYcZumeGGSGU5X4cUsrD42XUBx2DTDaS2qIkFtuv6RegH3nHLbpvTqWma4zaT1ROM7slr4KGhwq4M5Bwm6Wy17pO0lrY18CMj8RfOtmMbwyb4gbA8Y5cql2KF8i4-ZmjBSayVy1dP9EtKPmoowyrzsRR37ircoBwRLi0_cDFL5h3iqnirZkH2QhWmXM76jO_B-D7d5cUcPXcV3VBwP1cWJqIHsEh5jJazfgD8QluBhDYKBzmxpxOx703EWwielC6VpoiiDN0Ji-zoyuhcVMZzOyMrYt7u9qOJ7Ez04quEUK0PpriQlKqIziulXG6w8-Y4E04nZAW380EQ6hRRA1h0hE7jrxt7VsthwHZLw0Cq_rCrnV7iW0sDLNsL6b4uwqxoNE7YbYyNzY2p0pTDKuZYXU9DljtyITu_sFeePawrn9nMr-PKWaXODlcu_blxmYiA91jUotqIwNZ2dmR2lp3QtNJYXbAwyB1pZLwZ7prQOlH11lxstN28lwdlF9p1OorzhqPm2qgxsrbG5KFfx0yC617fzvNaUgACjAgtV9trHg_57ijrWqYOjY4c2boIG2u_vojwReU4D6QcZqkFsVoLjXD2F3TdcSCdZXU1rqxlz7TpQF8Pnjm3sZbfHLhVLedD2JGcuuRO8RXxUl7gfSMPB_6quMBuljPRXdpyZpmOPiy3IMc51a2k_Qz1B90_K_XscpjrVjYStRSSVE1HmwI2Yiqzzv2V4Mo1SBF44xbrwwkIxWXpLPoK14MZnAcyix_bjNiWp7ZDDgzStTNBbcarZw_ziLeEccbGZ9E57HGVOoWwquX66TCncEXfEtcOwLOolPB1mQIP6Jxl6AhLEh0fLtZ42lTHvhGMw9HE--VFqfq6UOfdoJuUbAuDziAFmV7UmTqguucbRtRRAr8DO4VGl6vIx7DtedXSLhM6y1Y47J0uQUiHQO1QQD1BFFmlILrCGL0qL_IMsQ4WEbdUdezEkTubOGbbklEtBYw4jqJNVPraB7S64Q5MUfMHBlEvWKhbGV32e1w6HjvcvBQ5whODPD-AnvHiuX4JSINxzY68ciDZbo7NaV5Y7UI-Hhk_qpEGLmxxTtGsMtvyxZEHXepjdHa8EEsvVNJ9Xe8w0i0Uc5OYR2fP1K3RKaq03YxIuRrnlI1pJX9V-8MOFPOk9DwvEtkFKaa2k9D7dO8enEpwrhfyYiVnpi75a3tJjCzSVQ3fuKdKipkgdlo459Q133Rxw3Fhdjnje6_jbQxb2l67XjNhyvFNu8aX2LyKzXi7xzoRFkemaC0_q-FdgvNzgcA3Az1PMFS_ZlncUp2FV0wtyEbnYMR8OA5JHK1LFWZ36M6MgMFtKqZSxmE8AE9nQ6ME_hULFFRvDsvSJjpYG5fMqU6azYU75sIgnLbhImmvjdNlUTeHqc6gRd_PLt18XjiKxs2qCK2ra7IsPVrT5oy-Q8HMwbVGHdwILrcyydNu00Yq6ydxD6ubTINhfl5u90rdyT0h7nw6mSPkQV4f-JYrrvp1lex8KUrPrrRTmG6TEcdKua6PbBWPPIvHVudd9XBd6A6_CE6w4vFXHuXPQ22hFnogxpCUQK-hs3RvMUa-HPbb1DBW2b7wBG5IVhif1js-Pw1mxAbn7IKvk2RttLs9pxUiqA7-6jwcNHTTXdp6uByCCLURl-QradcTS4Sz5jqyTCVnKxeOhTEu6N0UW6i7S0Gxh024Ti06o8-IGSz9ZK9Fw_kYr1ew658RR9TWrqbxeDIYjJ0YKR0OYG4dgHnteZSoy7mxveB9Em6d2Sqts7Kp036pN5dgs_I3EVIN1bb0133fHSnpktJxmsf1JpfXnNI29jnAktjor-5wIEJjMDknRZAL8E42O7t4bOUN_MFOXTCjGxvVm5FzvRylh-uxOzqHmNLbNjOkgW4XkcmKgykeTlwsX-YNUTdeJPAZnzHzbrtYL4683To21gudkBiyh-cb9ajLcHocZEmA1b3ebs12N6x5SoeFfd8tUXZ13ILZZZktz52NSkd4nelG6QuRzVTanp4f1524tgvrcKKNGIl05grWQhfFHlmWAREeVKsrD7JAjILGeOBCbs9KtAbqpqYWC_rsZjsbc42zeRVP-UULRMNV6Tm8domT2hErgvc9qSBGlmU_QnfQU_U8tXt-p4T6Qc8pDuPcSW_DpVeM3zBITh4HoL6Nkt6r1J55p4r_a036tYTTp9r2uecyVZgv-cDQVM6-LR_LxqkjVydxCd1BIcgrMHW5bhwauLRxdWP49Pnujx79_fbS78DwSugfg-Srxe8gWXwhNy_5_j-QfHrUc2tp3joE0B1Ug-pxhuWkKXT3DebftRDr28jvJvh1ODXNA6fluGbzeNr1137w7_ZnP3_bJfiuyn8ifUFBe37-trJH7t-o5fu-v68jpwK3Ej4HzcdpYPURxegBxeiPGIJSHxH6I0J8pBFqhmCPXYkTiWIDiWK_V-KjAaAJ15thtBPAT56EHzd67zruFXaBk7XlvZe27vuX762WyIvw-nL4d-PoFcdT9Dyre4la8_3yq5D56VmiBk7lRdB0Z54pUzB98_wYVZ9_HFZPth7D6wexcwfVt3nuD4Lo7enO1Kavi6pRKxCACuTeYyPxuxHRtH5Ddmou3nC7zYohH9Te1Ih6r-v4I8nP0_WoHTcFywkXIU6bafUx2kE-LWg3yakzJQCnaSvwvPyoUlpw09rzaPuGzpRHmjgDBEpN99iprl7l9EFR-aF3G8XmTl22VZzHk3Mj_zGXfLp7ct_-G5zjHDzfzscW7P4Fy6c7yJnwfqTzty37X6B-HLu3t-glPId0GQYAjKJwHCMwxEMxgLk0jjqEi7ukRyIzgNPQHdSWdePU0ff3pwHObboC142TpnGRwwROo_T9E_N9XHyVfP5vDtapLywrnr2FENumcJaWQiSZImnpFmJhFmGdJcTW09g-R4k0ipi9tGN5xQ4SC33-P_NX37h6IgAA';

try {
    const buffer = Buffer.from(configData, 'base64');
    const decompressed = zlib.gunzipSync(buffer);
    const config = JSON.parse(decompressed.toString());
    
    console.log('Configuration Analysis:');
    console.log('='.repeat(50));
    console.log('API Keys Status:');
    console.log('- apiKey (MDB):', config.apiKey ? 'SET' : 'NOT SET');
    console.log('- rpdbApiKey:', config.rpdbApiKey ? 'SET' : 'NOT SET');
    console.log('- tmdbBearerToken:', config.tmdbBearerToken ? 'SET' : 'NOT SET');
    console.log('- tmdbSessionId:', config.tmdbSessionId ? 'SET' : 'NOT SET');
    console.log('- tmdbAccountId:', config.tmdbAccountId ? 'SET' : 'NOT SET');
    console.log('');
    console.log('Trakt Configuration:');
    console.log('- traktAccessToken:', config.traktAccessToken ? 'SET' : 'NOT SET');
    console.log('- traktRefreshToken:', config.traktRefreshToken ? 'SET' : 'NOT SET');
    console.log('- traktExpiresAt:', config.traktExpiresAt ? new Date(config.traktExpiresAt).toISOString() : 'NOT SET');
    console.log('- traktUsername:', config.traktUsername ? config.traktUsername : 'NOT SET');
    console.log('');
    console.log('Settings:');
    console.log('- metadataSource:', config.metadataSource);
    console.log('- tmdbLanguage:', config.tmdbLanguage);
    console.log('- searchSources:', config.searchSources);
    console.log('- mergedSearchSources:', config.mergedSearchSources);
    console.log('');
    console.log('Lists Configuration:');
    console.log('- listOrder length:', config.listOrder?.length || 0);
    console.log('- hiddenLists length:', config.hiddenLists?.length || 0);
    console.log('- removedLists length:', config.removedLists?.length || 0);
    console.log('- customListNames entries:', Object.keys(config.customListNames || {}).length);
    console.log('');
    console.log('CRITICAL ISSUES FOUND:');
    console.log('='.repeat(50));
    
    let hasIssues = false;
    
    if (!config.traktAccessToken) {
        console.log('❌ NO TRAKT ACCESS TOKEN - This is why Trakt lists are not loading!');
        hasIssues = true;
    }
    if (!config.tmdbBearerToken) {
        console.log('❌ NO TMDB BEARER TOKEN - This will cause metadata fetching issues!');
        hasIssues = true;
    }
    if (!config.apiKey) {
        console.log('⚠️  NO MDB API KEY - MDB lists will not work');
        hasIssues = true;
    }
    if (config.traktExpiresAt && new Date(config.traktExpiresAt) < new Date()) {
        console.log('❌ TRAKT TOKEN EXPIRED - Need to re-authenticate with Trakt!');
        hasIssues = true;
    }
    
    if (!hasIssues) {
        console.log('✅ All critical configurations appear to be set correctly');
    }
    
    console.log('');
    console.log('SOLUTION:');
    console.log('='.repeat(50));
    console.log('1. You need to authenticate with Trakt.tv to get access tokens');
    console.log('2. Visit your addon configuration page and connect to Trakt');
    console.log('3. Set up TMDB Bearer Token in environment variables');
    console.log('4. Set up FANART_API_KEY in environment variables');
    
} catch (error) {
    console.error('Error decoding configuration:', error.message);
}
