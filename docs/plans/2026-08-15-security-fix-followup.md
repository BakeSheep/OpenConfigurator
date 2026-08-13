# Security Fix Follow-up Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the six security and lifecycle gaps found in the post-fix review without disturbing unrelated working-tree changes.

**Architecture:** Enforce connection authority at the server-owned port-ticket boundary, fail closed for uncached parameter writes, and bind all long-running operations to explicit transaction lifecycles. ESC recovery terminates the compromised session; log transfer uses the actual bounded request interval.

**Tech Stack:** TypeScript, Node.js, Express, WebSocket, MAVLink, node:test/tsx.

---

### Task 1: Enforce port tickets and replacement generations

**Files:**
- Modify: `src/server/connection/ConnectionManager.ts`
- Modify: `src/server/index.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/web/` connection callers as discovered
- Test: `src/server/connection/ConnectionManager.test.ts`
- Test: `src/server/index.test.ts`

1. Add failing tests for absent, expired, and type-mismatched port tickets and missing/stale replacement generations.
2. Expose the active connection generation in server status.
3. Require a live server-issued `portId`; remove raw-path fallback.
4. Update web callers to submit `portId` and replacement generation.
5. Run focused connection and boundary tests.

### Task 2: Fail closed for uncached generic parameter writes

**Files:**
- Modify: `src/server/mavlink/MavlinkBridge.ts`
- Modify: `src/server/index.ts`
- Test: `src/server/mavlink/MavlinkBridge.test.ts`
- Test: `src/server/index.test.ts`

1. Add tests for an uncached `ARMING_CHECK` write and a rejected write not claiming a lease.
2. Require both cached value and cached type before generic `param_set`.
3. Add an admission check before automatic controller claim for deterministic rejections.
4. Run focused bridge and boundary tests.

### Task 3: Correct bounded DataFlash request semantics

**Files:**
- Modify: `src/server/mavlink/MavlinkLogTransfer.ts`
- Test: `src/server/mavlink/MavlinkLogTransfer.test.ts`

1. Add a >64 KiB test whose first request ends with a short bounded chunk.
2. Use `requestEnd = reqStart + count` for completion and EOF decisions.
3. Verify the remaining interval is requested and the full file is retained.

### Task 4: Keep radio authority until the bridge transaction stops

**Files:**
- Modify: `src/server/mavlink/MavlinkBridge.ts`
- Modify: `src/server/mavlink/RadioCalibrationSessionManager.ts`
- Modify: `src/server/index.ts`
- Modify: `src/shared/types.ts` if a transaction handle type is shared
- Test: `src/server/mavlink/RadioCalibrationSessionManager.test.ts`

1. Add a test proving manager timeout cannot release the controller while writes continue.
2. Return a cancellation/status handle from `applyRadioCalibration`.
3. On timeout request cancellation, then finish only after bridge acknowledgement.
4. Run radio and bridge tests.

### Task 5: Terminate ESC sessions after unknown write state

**Files:**
- Modify: `src/server/esc/EscService.ts`
- Modify: `src/server/esc/EscSessionManager.ts`
- Test: `src/server/esc/EscService.test.ts`

1. Add tests separating precondition failures from `write_state_unknown`.
2. Run reset/exit only for unknown write state.
3. Finalize the session after recovery so cached targets cannot be reused.
4. Verify the controller pin and raw transport are released.

### Task 6: Roll back leases created by rejected requests

**Files:**
- Modify: `src/server/index.ts`
- Test: `src/server/index.test.ts`

1. Add failing direct/PX4 ESC admission tests with no prior lease.
2. Move deterministic checks before claim where possible.
3. Add a scoped rollback for a lease created by an asynchronously rejected request.
4. Verify an existing caller-owned lease is never rolled back.

### Task 7: Full verification

1. Run `npm run typecheck` and expect success.
2. Run `npm run test:server` and expect all tests to pass.
3. Run `npm run test:protocol` and expect success.
4. Run `git diff --check` and remove only whitespace introduced by this repair.
