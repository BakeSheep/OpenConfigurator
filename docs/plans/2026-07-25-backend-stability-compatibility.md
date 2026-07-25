# Backend Stability and Compatibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Resolve every backend compatibility, stability, safety-boundary, lifecycle, protocol, deployment, and test gap identified in the 2026-07-25 backend audit while preserving the current localhost frontend workflow.

**Architecture:** Keep `src/shared/` as the only frontend/backend contract, but make every external input runtime-validated. Give each physical connection and MAVLink session an explicit generation and lifecycle so stale asynchronous work cannot affect a newer connection. Treat a serial-port open as transport readiness and a validated, selected autopilot heartbeat as vehicle readiness. Keep localhost zero-configuration; make remote control explicit and authenticated.

**Tech Stack:** Node.js, TypeScript, Express 5, `ws`, `serialport`, `node-mavlink`, built-in `node:test`/`assert`, existing `tsx` runtime.

---

### Task 1: Add deterministic backend test entry points

**Files:**
- Modify: `package.json`
- Create: `src/server/connection/ConnectionManager.test.ts`
- Create: `src/server/connection/SerialConnection.test.ts`
- Create: `src/server/connection/BluetoothWorker.test.ts`
- Create: `src/server/index.test.ts`
- Extend: `src/server/mavlink/MavlinkBridge.test.ts`

**Steps:**
1. Add a single backend test script that runs every server test.
2. Add injectable factories/timers only where required to test native-port and retry behavior without hardware.
3. Write failing coverage for late serial open success/failure, close-time write errors, close failures, reconnect cancellation, duplicate clients, invalid WS input, parser garbage, v1 negotiation, multi-system target selection, command ACK timeouts, parameter echo confirmation, and cleanup.
4. Run each focused test before implementation and confirm the intended failure.

### Task 2: Make serial transport lifecycle cancellation-safe

**Files:**
- Modify: `src/server/connection/SerialConnection.ts`
- Test: `src/server/connection/SerialConnection.test.ts`

**Steps:**
1. Replace the loose `_connected`/`port` pair with explicit `idle/opening/open/closing` state and an operation generation.
2. Retain the provisional `SerialPort` while opening. If timeout or cancellation wins, wait for late open and immediately close it; absorb late errors through an always-present internal error handler.
3. Make `disconnect()` idempotent, bounded, and observable. Set closing state before pending writes can emit public errors; reject/log actual close failures rather than discarding the handle silently.
4. Replace the ineffective `_draining` flag with a bounded frame queue. Coalesce replaceable manual-control traffic at the bridge boundary, preserve command/heartbeat priority, and emit overflow diagnostics.
5. Verify no open handle, unhandled `error`, timer, listener, or pending callback survives disconnect.

### Task 3: Make Bluetooth discovery and reconnect deterministic

**Files:**
- Modify: `src/server/connection/BluetoothConnection.ts`
- Modify: `src/server/connection/BluetoothWorker.ts`
- Test: `src/server/connection/BluetoothWorker.test.ts`

**Steps:**
1. Track the active reconnect/open promise and generation; `disconnect()` must invalidate and await all in-flight work.
2. Store the provisional `SerialConnection` before awaiting open so teardown can reach it.
3. Require proof of a validated vehicle heartbeat for vehicle readiness; raw bytes only prove transport activity.
4. Fail closed when VID/PID/address/path matching is ambiguous. Never select an arbitrary outgoing SPP device.
5. Make Windows-specific enumeration explicit and add best-effort Linux `/dev/rfcomm*` and macOS `/dev/cu.*` recognition without weakening exact path matching.
6. Preserve the last reconnect error and surface a structured terminal reason.

### Task 4: Serialize connection lifecycle and enforce hard liveness

**Files:**
- Modify: `src/server/connection/ConnectionManager.ts`
- Test: `src/server/connection/ConnectionManager.test.ts`

**Steps:**
1. Route spontaneous close/error cleanup through the same serialized operation chain as explicit connect/disconnect.
2. Add a connection generation so callbacks from an old link cannot change new-link state.
3. Expose transport-open separately from vehicle-ready while retaining the existing `connected` compatibility field at the WebSocket boundary.
4. Use monotonic time and enforce an absolute autopilot-heartbeat deadline. Other MAVLink activity may provide a short congestion grace period but can never suppress the hard deadline indefinitely.
5. Preserve and broadcast structured error/retry details.

### Task 5: Bound and negotiate the MAVLink codec session

**Files:**
- Modify: `src/server/mavlink/codec.ts`
- Modify: `src/server/mavlink/MavlinkBridge.ts`
- Test: `src/server/mavlink/MavlinkBridge.test.ts`

**Steps:**
1. Introduce a per-connection codec session with its own TX sequence, detected inbound protocol, parser generation, and packet-loss counters.
2. Put a hard bound on unframed/partial input and discard no-STX garbage. Recreate the parser for every physical session.
3. Start in compatibility mode, support MAVLink 1 output, and upgrade to MAVLink 2 only after observed/capability-confirmed support or explicit configuration.
4. Support optional MAVLink 2 signing via environment configuration, validate inbound signatures/replay timestamps, reject unknown incompatibility flags, and sign outbound frames when configured.
5. Attach splitter/parser error listeners and rebuild the session rather than allowing stream errors to terminate the process.

### Task 6: Lock the selected vehicle and make protocol operations transactional

**Files:**
- Modify: `src/server/mavlink/MavlinkBridge.ts`
- Modify: `src/shared/types.ts`
- Test: `src/server/mavlink/MavlinkBridge.test.ts`

**Steps:**
1. Separate vehicle discovery from target selection. Lock the first valid autopilot by default; support explicit target selection and reset all capability/parameter/stream state on an intentional switch.
2. Filter telemetry, liveness, status text, command ACK, parameters, and version messages by selected system/component rules.
3. Reject mutating client messages until a validated target is ready.
4. Add command request IDs, source-filtered ACK matching, `IN_PROGRESS` support, timeouts, and risk-aware bounded retries with incremented confirmation.
5. Add parameter-set transactions that validate 1–16 byte ASCII IDs, finite values/types, wait for matching `PARAM_VALUE` echo, compare the accepted value, and timeout/retry.
6. Add AUTOPILOT_VERSION retry/fallback, parameter count/request/deadline bounds, and legacy telemetry-stream fallback when `SET_MESSAGE_INTERVAL` is unsupported.

### Task 7: Correct telemetry semantics and bounded text assembly

**Files:**
- Modify: `src/server/mavlink/MavlinkBridge.ts`
- Modify: `src/shared/types.ts`
- Update only compile-affected consumers under: `src/web/`
- Test: `src/server/mavlink/MavlinkBridge.test.ts`

**Steps:**
1. Convert MAVLink unknown sentinels to `null`; scale GPS DOP correctly.
2. Preserve battery ID, overall/cell voltage semantics, and `voltagesExt`; do not merge independent batteries.
3. Keep raw IMU units distinct from normalized scaled/high-resolution IMU data.
4. Expose correct `OPTICAL_FLOW_RAD` field semantics while keeping deprecated aliases temporarily for frontend compatibility.
5. Report unsupported `gps_check_fail_flags` as `null`, never as a false-safe zero.
6. Key STATUSTEXT chunks by source and ID, assemble bytes before UTF-8 decoding, and enforce TTL/count/length limits.
7. Compute throughput by actual elapsed monotonic time and expose RX sequence-loss diagnostics.

### Task 8: Harden HTTP/WebSocket boundaries and controller ownership

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/shared/types.ts`
- Create: `src/server/validation.ts`
- Test: `src/server/index.test.ts`

**Steps:**
1. Validate every REST and WS message at runtime, including finite numeric/range checks, supported commands, parameter IDs, motor 1–12, payload sizes, and connection configuration.
2. Default to loopback. Enforce a strict localhost Origin allowlist; remote binding must be explicitly enabled and require an authentication token.
3. Configure small `maxPayload`, reject binary messages, attach client/server error handlers, add ping/pong expiry, per-client rate limits, maximum clients, and immediate termination for hard backpressure.
4. Add a first-writer controller lease with expiry and explicit release; observers remain read-only. Preserve compatibility by auto-claiming for the first valid mutating message.
5. Keep parameter downloads single-generation and return structured conflict/client errors instead of silently restarting global state.
6. Broadcast complete connection status/error data, add protocol-version/capability handshake, return JSON API 404s before SPA fallback, and normalize parser/body errors.

### Task 9: Add graceful shutdown and production compatibility

**Files:**
- Modify: `src/server/index.ts`
- Modify: `package.json`
- Modify: `HANDOVER.md`

**Steps:**
1. Add validated `HOST`/`PORT` configuration and clear `EADDRINUSE` diagnostics.
2. Add idempotent SIGINT/SIGTERM shutdown: stop upgrades/HTTP intake, terminate WS clients, clear batching/heartbeat/retry timers, destroy the bridge, await connection teardown, and close the server with a final bounded timeout.
3. Ensure `npm ci --omit=dev && npm start` has the required runtime (`tsx` in dependencies unless a compiled server artifact is introduced).
4. Declare the supported Node engine matching Vite/serialport requirements.
5. Make the standard build run strict type checking before Vite.

### Task 10: Completion audit and regression verification

**Files:**
- Review: all files above
- Update: `HANDOVER.md`

**Steps:**
1. Run `npm run typecheck`.
2. Run the complete backend test command, including real v1/v2 framing, garbage, CRC, signing-policy, target, retry, lifecycle, and HTTP/WS tests.
3. Run `npm run build`.
4. Start the backend on an ephemeral/alternate port and verify health, API JSON 404, allowed/rejected Origin behavior, WS handshake/status, and graceful SIGTERM output.
5. Inspect timers/listeners/handles after every test and ensure tests exit naturally.
6. Re-read every 2026-07-25 audit finding and map it to implementation plus a passing regression test or explicit supported-scope contract.
7. Confirm the pre-existing dirty worktree changes were preserved and report all files changed by this implementation.
