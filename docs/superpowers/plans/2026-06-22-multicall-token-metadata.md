# Implementation Plan: Multicall for fetchTokenMeta

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement multicall batching in `fetchTokenMeta` to drastically reduce RPC calls by grouping individual decimal lookups.

**Architecture:** Instead of individual `publicClient.readContract` calls, collect address requests and execute them via `publicClient.multicall`. Introduce a small buffering/wait period (e.g., via `setTimeout` or similar batching primitive) to ensure concurrent requests are bundled, or use an explicit batching mechanism if the caller supports it.

**Tech Stack:** `viem` (for `multicall`), `envio` effects system.

## Global Constraints

- Must maintain the existing `registryCache` logic.
- Must remain compatible with preload/execution phases.
- Must not introduce performance regressions for pre-cached tokens.
- Keep RPC calls optimized.

---

### Task 1: Scaffolding and Interface Updates

**Files:**
- Modify: `src/effects/token_metadata.ts`

**Interfaces:**
- Produces: `fetchTokenMetaHandler` now supports batching logic.

- [ ] **Step 1: Modify `fetchTokenMetaHandler` to buffer requests**

Instead of immediately calling `readContract`, use a buffer to collect token addresses and return promises that resolve when the multicall completes.

```typescript
// Need to add:
const pendingRequests = new Map<string, { resolve: (value: any) => void, reject: (reason: any) => void }>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;
```

- [ ] **Step 2: Commit**

```bash
git add src/effects/token_metadata.ts
git commit -m "feat(token_metadata): add batching scaffolding"
```

### Task 2: Implement Multicall Logic

**Files:**
- Modify: `src/effects/token_metadata.ts`

- [ ] **Step 1: Implement the batch execution function**

This function will:
1. Extract all addresses from `pendingRequests`.
2. Construct the `multicall` contracts array.
3. Call `publicClient.multicall`.
4. Process results and resolve/reject the pending promises.

- [ ] **Step 2: Integrate into `fetchTokenMetaHandler`**

- [ ] **Step 3: Commit**

```bash
git add src/effects/token_metadata.ts
git commit -m "feat(token_metadata): implement multicall batching"
```

### Task 3: Testing and Verification

**Files:**
- Modify: `src/effects/token_metadata.test.ts`

- [ ] **Step 1: Write a test case for multicall**

Verify that multiple `fetchTokenMeta` calls for unknown tokens result in only *one* `eth_call` (via multicall) instead of multiple.

```typescript
test("batches token metadata calls", async () => {
    // Mock publicClient.multicall
    // Trigger multiple fetchTokenMeta calls
    // Verify multicall was called once
})
```

- [ ] **Step 2: Run test**

```bash
pnpm test src/effects/token_metadata.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/effects/token_metadata.test.ts src/effects/token_metadata.ts
git commit -m "test: verify batching efficiency"
```
