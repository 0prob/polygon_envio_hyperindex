# 📊 Graph Analysis Report

**Root:** `/home/x/arb/h`

## Summary

| Metric | Value |
|--------|-------|
| Nodes | 455 |
| Edges | 478 |
| Communities | 53 |
| Hyperedges | 0 |

### Confidence Breakdown

| Level | Count | Percentage |
|-------|-------|------------|
| EXTRACTED | 403 | 84.3% |
| INFERRED | 75 | 15.7% |
| AMBIGUOUS | 0 | 0.0% |

## 🌟 God Nodes (Most Connected)

| Node | Degree | Community |
|------|--------|-----------|
| token_metadata | 42 | 0 |
| validate_envio_config | 20 | 1 |
| rpc_client | 16 | 4 |
| token_disk | 16 | 2 |
| pacing | 16 | 3 |
| curve_bootstrap | 14 | 5 |
| rpc_client.test | 14 | 6 |
| curve_factory | 13 | 7 |
| curve_metadata.test | 12 | 8 |
| validate_single_run() | 11 | 1 |

## 🔮 Surprising Connections

- **home_x_arb_h_src_effects_token_metadata_ts_fetchtokenmetahandler** → **home_x_arb_h_src_effects_token_metadata_ts_warmupcache** (calls)
- **home_x_arb_h_src_effects_token_metadata_ts** → **home_x_arb_h_src_effects_token_metadata_ts_initdb** (defines)
- **home_x_arb_h_src_effects_token_metadata_ts** → **home_x_arb_h_src_effects_token_metadata_ts_lookupregistrydecimalsbatch** (defines)
- **home_x_arb_h_src_effects_token_metadata_ts** → **home_x_arb_h_src_effects_token_metadata_ts_seedvitestregistry** (defines)
- **home_x_arb_h_src_effects_token_metadata_ts** → **home_x_arb_h_src_effects_token_metadata_ts_loadautoextratokens** (defines)

## 🏘️ Communities

### Community 0 — scheduleFailedTokensSave() (37 nodes, cohesion: 0.06)

- token_metadata
- appendToAutoExtraTokens()
- fetchTokenMetaHandler()
- flushDiscoveredDecimals()
- flushFailedTokens()
- envio/createEffect
- envio/S
- node:path/path
- node:url/fileURLToPath
- ./rpc_client/publicClient
- ../utils/constants/DAI
- ../utils/constants/USDC
- ../utils/constants/USDC_E
- ../utils/constants/USDT
- ../utils/constants/WBTC
- ../utils/constants/WETH
- ../utils/constants/WMATIC
- ../utils/normalize_address/normalizeTokenAddress
- ../utils/pacing/getTokenMetaEffectRateLimit
- ../utils/rpc_errors/isNetworkError
- _…and 17 more_

### Community 1 — validate_single_run() (21 nodes, cohesion: 0.17)

- validate_envio_config
- abi_events()
- check_anonymous_events()
- check_event_exists()
- check_missing_discovery_events()
- check_type_safety()
- check_unnamed_params()
- event_signature()
- json
- os
- pathlib.Path
- re
- sys
- load_abi()
- load_yaml()
- main()
- _normalize_sig()
- print_report()
- resolve_abi_path()
- _suppressed()
- _…and 1 more_

### Community 2 — writeJsonAtomic() (17 nodes, cohesion: 0.12)

- token_disk
- appendAutoExtraEntry()
- appendDiscoveredDecimals()
- appendFailedTokens()
- appendGarbageAddresses()
- appendPoolDiscoveryDelta()
- node:fs/promises/appendFile
- node:fs/promises/mkdir
- node:fs/promises/readFile
- node:fs/promises/rename
- node:fs/promises/writeFile
- node:path/path
- loadAutoExtraEntries()
- loadDiscoveredDecimalsEntries()
- loadFailedTokenEntries()
- loadGarbageAddressEntries()
- writeJsonAtomic()

### Community 3 — runWithConcurrency() (17 nodes, cohesion: 0.24)

- pacing
- applyHyperSyncPacingEnv()
- bridgeIndexerEnvAliases()
- getCurveMetaEffectRateLimit()
- getHistoricalMetaEffectRateLimit()
- getMetadataConcurrency()
- getProgressOnBlockStride()
- getRecommendedFullBatchSize()
- getRecommendedFullBatchSizeForRpm()
- getRpmTarget()
- getRpmTargetFromEnv()
- getTokenMetaEffectRateLimit()
- isLowQuota()
- isVeryLowQuota()
- parseRpmTarget()
- rpmFromEnv()
- runWithConcurrency()

### Community 4 — resetPublicClientForTest() (17 nodes, cohesion: 0.16)

- rpc_client
- buildHttpTransport()
- buildPublicClient()
- get()
- getAlchemyApiKey()
- getRpcTransportTuning()
- getRpcUrls()
- ../utils/pacing/getRpmTarget
- viem/chains/polygon
- viem/createPublicClient
- viem/fallback
- viem/http
- viem/HttpTransport
- viem/PublicClient
- parseRpcUrlList()
- redactRpcUrl()
- resetPublicClientForTest()

### Community 5 — bootstrapRegistryPage() (15 nodes, cohesion: 0.14)

- curve_bootstrap
- bootstrapCurvePools()
- bootstrapRegistryPage()
- ../effects/curve_metadata/curveFeeToBps
- ../effects/curve_metadata/fetchCurveMetadata
- ../effects/curve_metadata/isCurveMetadataEmpty
- ../effects/curve_registry_bootstrap/fetchCurveRegistryPage
- envio/indexer
- ../utils/curve_registry/CURVE_REGISTRY_SOURCES
- ../utils/curve_registry/curveDiscoveryProtocol
- ../utils/entity_writes/setTokenMetasIfMissing
- ../utils/factory_token_meta/resolveTokenMetasBatch
- ../utils/pacing/getMetadataConcurrency
- ../utils/pacing/runWithConcurrency
- ../utils/pool_meta_entity/poolMetaEntity

### Community 6 — snapshotEnv() (15 nodes, cohesion: 0.13)

- rpc_client.test
- ./rpc_client/buildPublicClient
- ./rpc_client/getRpcTransportTuning
- ./rpc_client/getRpcUrls
- ./rpc_client/parseRpcUrlList
- ./rpc_client/PUBLIC_FALLBACK_RPC_URLS
- ./rpc_client/redactRpcUrl
- ./rpc_client/resetPublicClientForTest
- vitest/afterEach
- vitest/beforeEach
- vitest/describe
- vitest/expect
- vitest/it
- restoreEnv()
- snapshotEnv()

### Community 7 — registerCurvePoolAdded() (14 nodes, cohesion: 0.16)

- curve_factory
- handleCurvePoolAdded()
- ../effects/curve_metadata/curveFeeToBps
- ../effects/curve_metadata/fetchCurveMetadata
- ../effects/curve_metadata/isCurveMetadataEmpty
- envio/Effect
- envio/indexer
- ../utils/curve_registry/curveDiscoveryProtocol
- ../utils/entity_writes/setTokenMetasIfMissing
- ../utils/factory_token_meta/resolveTokenMetasBatch
- ../utils/pool_meta_entity/poolMetaEntity
- nCoinsFromEventParams()
- poolAddressFromEventParams()
- registerCurvePoolAdded()

### Community 8 — mockCurveReads() (13 nodes, cohesion: 0.15)

- curve_metadata.test
- ./curve_metadata/curveDiscoveryPoolType
- ./curve_metadata/curveFeeToBps
- ./curve_metadata/curvePoolTypeFromGamma
- ./curve_metadata/fetchCurveMetadataHandler
- ./curve_metadata/isCurveMetadataEmpty
- ./curve_metadata/resolveCurveNCoins
- vitest/beforeEach
- vitest/describe
- vitest/expect
- vitest/it
- vitest/vi
- mockCurveReads()

### Community 9 — resolveTokenMetaSlots() (12 nodes, cohesion: 0.23)

- factory_token_meta
- cachedTokenMeta()
- ../effects/token_metadata/fetchTokenMeta
- ../effects/token_metadata/lookupRegistryDecimalsBatch
- ../effects/token_metadata/preloadTokenDecimalsDefault
- envio/Effect
- ./normalize_address/normalizeTokenAddress
- ./pacing/getMetadataConcurrency
- ./pacing/runWithConcurrency
- resolveFactoryPairTokenMetas()
- resolveTokenMetasBatch()
- resolveTokenMetaSlots()

### Community 10 — resolveCurveNCoins() (12 nodes, cohesion: 0.23)

- curve_metadata
- curveDiscoveryPoolType()
- curveFeeToBps()
- curvePoolTypeFromGamma()
- fetchCurveMetadataHandler()
- envio/createEffect
- envio/S
- ./rpc_client/publicClient
- ../utils/pacing/getCurveMetaEffectRateLimit
- viem/parseAbi
- isCurveMetadataEmpty()
- resolveCurveNCoins()

### Community 11 — registerDodoEvent() (12 nodes, cohesion: 0.18)

- dodo_factory
- handleDodoPool()
- ../effects/dodo_metadata/dodoFeeToBps
- ../effects/dodo_metadata/fetchDodoMetadata
- ../effects/dodo_metadata/isDodoMetadataEmpty
- envio/Effect
- envio/indexer
- ../utils/entity_writes/setTokenMetasIfMissing
- ../utils/factory_token_meta/resolveFactoryPairTokenMetas
- ../utils/guards/shouldSkipFactoryPool
- ../utils/pool_meta_entity/poolMetaEntity
- registerDodoEvent()

### Community 12 — vitest/vi (12) (11 nodes, cohesion: 0.18)

- token_metadata.test
- ./rpc_client/publicClient
- ./token_metadata/fetchTokenMetaHandler
- ./token_metadata/lookupRegistryDecimalsBatch
- ./token_metadata/resetTokenMetadataCachesForTest
- viem/ContractFunctionZeroDataError
- vitest/beforeEach
- vitest/describe
- vitest/expect
- vitest/it
- vitest/vi

### Community 13 — writeTokenRegistryDb() (11 nodes, cohesion: 0.27)

- generate-polygon-tokens
- fetchList()
- node:path/path
- node:url/fileURLToPath
- ../src/utils/token_disk.ts/loadAutoExtraEntries
- ../src/utils/token_disk.ts/loadDiscoveredDecimalsEntries
- loadDiscoveredTokens()
- loadExtraTokens()
- loadFromPoolsFile()
- main()
- writeTokenRegistryDb()

### Community 14 — vitest/it (14) (11 nodes, cohesion: 0.18)

- guards.test
- ./constants/APESWAP_V2_FACTORY
- ./constants/QUICKSWAP_V2_FACTORY
- ./constants/USDC
- ./constants/WETH
- ./constants/ZERO_ADDRESS
- ./guards/isLikelyGarbagePair
- ./guards/shouldSkipFactoryPool
- vitest/describe
- vitest/expect
- vitest/it

### Community 15 — mockFeeReads() (10 nodes, cohesion: 0.20)

- dodo_metadata.test
- ./dodo_metadata/dodoFeeToBps
- ./dodo_metadata/fetchDodoMetadataHandler
- ./dodo_metadata/isDodoMetadataEmpty
- vitest/beforeEach
- vitest/describe
- vitest/expect
- vitest/it
- vitest/vi
- mockFeeReads()

### Community 16 — readFeeBigint() (10 nodes, cohesion: 0.24)

- dodo_metadata
- dodoFeeToBps()
- fetchDodoMetadataHandler()
- envio/createEffect
- envio/S
- ./rpc_client/publicClient
- ../utils/pacing/getHistoricalMetaEffectRateLimit
- viem/parseAbi
- isDodoMetadataEmpty()
- readFeeBigint()

### Community 17 — readVaultPoolTokens() (10 nodes, cohesion: 0.24)

- balancer_metadata
- fetchBalancerMetadataHandler()
- envio/createEffect
- envio/S
- ./rpc_client/publicClient
- ../utils/constants/BALANCER_VAULT
- ../utils/pacing/getHistoricalMetaEffectRateLimit
- viem/parseAbi
- isRetryableRpcError()
- readVaultPoolTokens()

### Community 18 — ./woofi_bootstrap/fetchWooFiTokensHandler (10 nodes, cohesion: 0.20)

- woofi_bootstrap.test
- ../utils/constants/USDC
- ../utils/constants/WMATIC
- ../utils/constants/WOOFI_PP_V2
- vitest/beforeEach
- vitest/describe
- vitest/expect
- vitest/it
- vitest/vi
- ./woofi_bootstrap/fetchWooFiTokensHandler

### Community 19 — vitest/vi (19) (10 nodes, cohesion: 0.20)

- curve_registry_bootstrap.test
- ./curve_registry_bootstrap/fetchCurveRegistryPageHandler
- ../utils/constants/CURVE_REGISTRY_LEGACY
- ../utils/constants/USDC
- ../utils/constants/USDT
- vitest/beforeEach
- vitest/describe
- vitest/expect
- vitest/it
- vitest/vi

### Community 20 — vitest/vi (20) (10 nodes, cohesion: 0.20)

- balancer_metadata.test
- ./balancer_metadata/fetchBalancerMetadataHandler
- ../utils/constants/BALANCER_VAULT
- ../utils/constants/USDC
- ../utils/constants/WETH
- vitest/beforeEach
- vitest/describe
- vitest/expect
- vitest/it
- vitest/vi

### Community 21 — lookupV3FactoryStartBlock() (9 nodes, cohesion: 0.22)

- constants
- bootstrapMaticRatePerUnit()
- lookupAlgebraFactoryProtocol()
- lookupAlgebraFactoryStartBlock()
- lookupIndexedContractStartBlock()
- lookupV2FactoryProtocol()
- lookupV2FactoryStartBlock()
- lookupV3FactoryProtocol()
- lookupV3FactoryStartBlock()

### Community 22 — mergeTokensDiff() (9 nodes, cohesion: 0.22)

- woofi
- ../effects/woofi_bootstrap/fetchWooFiTokens
- envio/indexer
- ../utils/constants/WOOFI_PP_V2
- ../utils/constants/WOOFI_PP_V2_DEPLOY_BLOCK
- ../utils/entity_writes/setTokenMetasIfMissing
- ../utils/factory_token_meta/resolveTokenMetasBatch
- ../utils/pool_meta_entity/poolMetaEntity
- mergeTokensDiff()

### Community 23 — fetchWooFiTokensHandler() (8 nodes, cohesion: 0.25)

- woofi_bootstrap
- fetchWooFiTokensHandler()
- envio/createEffect
- envio/S
- ./rpc_client/publicClient
- ../utils/constants/MAJOR_TOKENS
- ../utils/pacing/getHistoricalMetaEffectRateLimit
- viem/parseAbi

### Community 24 — vitest/it (8 nodes, cohesion: 0.25)

- pacing.test
- ./pacing/getMetadataConcurrency
- ./pacing/getRecommendedFullBatchSize
- ./pacing/getTokenMetaEffectRateLimit
- ./pacing/isLowQuota
- vitest/describe
- vitest/expect
- vitest/it

### Community 25 — vitest/vi (25) (8 nodes, cohesion: 0.25)

- factory_token_meta.test
- ./factory_token_meta/resolveFactoryPairTokenMetas
- ./factory_token_meta/resolveTokenMetasBatch
- vitest/beforeEach
- vitest/describe
- vitest/expect
- vitest/it
- vitest/vi

### Community 26 — fetchCurveRegistryPageHandler() (8 nodes, cohesion: 0.25)

- curve_registry_bootstrap
- fetchCurveRegistryPageHandler()
- envio/createEffect
- envio/S
- ./rpc_client/publicClient
- ../utils/constants/CURVE_REGISTRY_LEGACY
- ../utils/pacing/getHistoricalMetaEffectRateLimit
- viem/parseAbi

### Community 27 — vitest/vi (7 nodes, cohesion: 0.29)

- entity_writes.test
- ./entity_writes/setTokenMetaEntriesIfMissing
- ./entity_writes/setTokenMetasIfMissing
- vitest/describe
- vitest/expect
- vitest/it
- vitest/vi

### Community 28 — persistFactoryPoolMeta() (7 nodes, cohesion: 0.29)

- factory_pool_handler
- ./entity_writes/setTokenMetasIfMissing
- ./factory_token_meta/resolveFactoryPairTokenMetas
- ./indexer_protocol/IndexerProtocol
- ./indexer_protocol/PoolMetaWritePayload
- ./pool_meta_entity/poolMetaEntity
- persistFactoryPoolMeta()

### Community 29 — warmUpCache() (6 nodes, cohesion: 0.33)

- initDb()
- loadAutoExtraTokens()
- loadDiscoveredDecimals()
- lookupRegistryDecimalsBatch()
- seedVitestRegistry()
- warmUpCache()

### Community 30 — shouldPersistTokenMeta() (6 nodes, cohesion: 0.53)

- entity_writes
- ./safe_decimals/safeDecimals
- setTokenMetaEntriesIfMissing()
- setTokenMetaIfMissing()
- setTokenMetasIfMissing()
- shouldPersistTokenMeta()

### Community 31 — vitest/vi (31) (6 nodes, cohesion: 0.33)

- factory_pool_handler.test
- ./factory_pool_handler/persistFactoryPoolMeta
- vitest/describe
- vitest/expect
- vitest/it
- vitest/vi

### Community 32 — vitest/it (32) (6 nodes, cohesion: 0.33)

- rpc_errors.test
- ./rpc_errors/isNetworkError
- ./rpc_errors/isQuotaError
- vitest/describe
- vitest/expect
- vitest/it

### Community 33 — shouldSkipFactoryPool() (6 nodes, cohesion: 0.47)

- guards
- ./constants/KNOWN_FACTORIES_SET
- ./constants/ZERO_ADDRESS
- isLikelyGarbagePair()
- isLikelyGarbagePairInternal()
- shouldSkipFactoryPool()

### Community 34 — main() (6 nodes, cohesion: 0.33)

- update-token-registry
- child_process/spawn
- node:fs/promises/rename
- node:fs/promises/writeFile
- node:path/path
- main()

### Community 35 — ../utils/pool_meta_entity/poolMetaEntity (6 nodes, cohesion: 0.33)

- balancer
- ../effects/balancer_metadata/fetchBalancerMetadata
- envio/indexer
- ../utils/entity_writes/setTokenMetasIfMissing
- ../utils/factory_token_meta/resolveTokenMetasBatch
- ../utils/pool_meta_entity/poolMetaEntity

### Community 36 — vitest/it (36) (5 nodes, cohesion: 0.40)

- curve_registry.test
- ./curve_registry/curveDiscoveryProtocol
- vitest/describe
- vitest/expect
- vitest/it

### Community 37 — ../utils/guards/isLikelyGarbagePair (5 nodes, cohesion: 0.40)

- v4
- envio/indexer
- ../utils/constants/ZERO_ADDRESS
- ../utils/factory_pool_handler/persistFactoryPoolMeta
- ../utils/guards/isLikelyGarbagePair

### Community 38 — vitest/it (38) (5 nodes, cohesion: 0.40)

- normalize_address.test
- ./normalize_address/normalizeTokenAddress
- vitest/describe
- vitest/expect
- vitest/it

### Community 39 — ../utils/guards/shouldSkipFactoryPool (5 nodes, cohesion: 0.40)

- v3_factory
- envio/indexer
- ../utils/constants/lookupV3FactoryProtocol
- ../utils/factory_pool_handler/persistFactoryPoolMeta
- ../utils/guards/shouldSkipFactoryPool

### Community 40 — ../utils/guards/shouldSkipFactoryPool (40) (5 nodes, cohesion: 0.40)

- v2_factory
- envio/indexer
- ../utils/constants/lookupV2FactoryProtocol
- ../utils/factory_pool_handler/persistFactoryPoolMeta
- ../utils/guards/shouldSkipFactoryPool

### Community 41 — ../utils/guards/shouldSkipFactoryPool (41) (5 nodes, cohesion: 0.40)

- algebra_factory
- envio/indexer
- ../utils/constants/lookupAlgebraFactoryProtocol
- ../utils/factory_pool_handler/persistFactoryPoolMeta
- ../utils/guards/shouldSkipFactoryPool

### Community 42 — updateIndexerProgress() (4 nodes, cohesion: 0.50)

- progress
- envio/indexer
- ../utils/pacing/getProgressOnBlockStride
- updateIndexerProgress()

### Community 43 — curveDiscoveryProtocol() (4 nodes, cohesion: 0.50)

- curve_registry
- curveDiscoveryProtocol()
- ../utils/constants/CURVE_REGISTRY_DEPLOY_BLOCK
- ../utils/constants/CURVE_REGISTRY_LEGACY

### Community 44 — isQuotaError() (3 nodes, cohesion: 0.67)

- rpc_errors
- isNetworkError()
- isQuotaError()

### Community 45 — normalizeTokenAddress() (2 nodes, cohesion: 1.00)

- normalize_address
- normalizeTokenAddress()

### Community 46 — safeDecimals() (2 nodes, cohesion: 1.00)

- safe_decimals
- safeDecimals()

### Community 47 — poolMetaEntity() (2 nodes, cohesion: 1.00)

- pool_meta_entity
- poolMetaEntity()

### Community 48 — Database (2 nodes, cohesion: 1.00)

- env.d
- Database

### Community 49 — vitest/config/defineConfig (2 nodes, cohesion: 1.00)

- vitest.config
- vitest/config/defineConfig

### Community 50 — token_registry (1 nodes, cohesion: 1.00)

- token_registry

### Community 51 — envio-env.d (1 nodes, cohesion: 1.00)

- envio-env.d

### Community 52 — indexer_protocol (1 nodes, cohesion: 1.00)

- indexer_protocol

## 🕳️ Knowledge Gaps

**Isolated nodes** (3):
- envio-env.d
- indexer_protocol
- token_registry

**Thin communities** (< 3 nodes): 8 communities

## 💰 Token Cost

| File | Tokens |
|------|--------|
| input | 0 |
| output | 0 |
| **Total** | **0** |

## ❓ Suggested Questions

1. What role does 'envio-env.d' play? It has no connections in the graph.
1. What role does 'token_registry' play? It has no connections in the graph.
1. What role does 'indexer_protocol' play? It has no connections in the graph.
1. Why is 'persistFactoryPoolMeta()' (7 nodes) loosely connected (cohesion 0.29)? Should it be split?
1. Why is 'registerCurvePoolAdded()' (14 nodes) loosely connected (cohesion 0.16)? Should it be split?
1. Why is 'mockFeeReads()' (10 nodes) loosely connected (cohesion 0.20)? Should it be split?
1. Why is 'vitest/vi' (7 nodes) loosely connected (cohesion 0.29)? Should it be split?

---
_Generated by graphify-rs_
