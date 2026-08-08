# Verified Code Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix every confirmed, currently reachable defect in `docs/plan/2026-08-08-verified-code-review.md`, plus low-risk hardening items that do not require a product-policy decision.

**Architecture:** Preserve the existing REST/WS boundary, single App-owned WebSocket, vehicle-profile gates, and ESC session ownership model. Apply fixes in subsystem-sized batches with regression tests before or alongside each implementation; safety commands remain fail-closed and are never replayed after reconnect.

**Tech Stack:** TypeScript 6, React 19, Zustand, Express 5, `ws`, `serialport`, node-mavlink, uPlot, Node test runner/tsx.

---

### Task 1: Correct ESC stream framing and response correlation

**Files:**
- Modify: `src/server/esc/fourWay.ts`
- Modify: `src/server/esc/msp.ts`
- Modify: `src/server/esc/EscDetector.ts`
- Modify: `src/server/esc/ArduPilotRawTransport.ts`
- Modify: `src/server/esc/DirectSerialTransport.ts`
- Modify: `src/server/esc/Px4SerialControlTransport.ts`
- Test: `src/server/esc/fourWay.test.ts`
- Test: `src/server/esc/msp.test.ts`
- Test: `src/server/esc/EscDetector.test.ts`
- Test: transport-specific ESC tests

**Steps:**
1. Change frame probes to return `null` until the complete frame is buffered and let 4-way probing skip bounded leading garbage.
2. Add fragmented-response tests that fail under the old behavior.
3. Reject MSP responses whose command does not match the request.
4. Give the production direct raw transport the same single-wire echo handling required by direct AM32 links.
5. Make abort listeners one-shot and add a final defensive `buffered.length >= length` guard in every transport pump.
6. Run the ESC codec, detector, service, and transport tests.

### Task 2: Tighten HTTP/Origin boundaries without changing remote-mode auth

**Files:**
- Modify: `src/server/validation.ts`
- Modify: `src/server/index.ts`
- Modify: `electron/main.ts`
- Test: `src/server/index.test.ts`
- Test: `src/server/validation.test.ts`

**Steps:**
1. Add an explicit `allowDevOrigin` server configuration flag; default it from development mode and force it off in Electron.
2. Permit loopback port 5173 only when that flag is true.
3. Add a small bounded per-address limiter for connection scan/debug GET routes and hide detailed debug-port metadata outside development.
4. Add regression tests for production 5173 rejection and HTTP rate limiting.
5. Run boundary tests.

### Task 3: Bound download and parameter-cache resources

**Files:**
- Modify: `src/server/mavlink/MavlinkFtp.ts`
- Modify: `src/server/mavlink/MavlinkLogTransfer.ts`
- Modify: `src/server/mavlink/MavlinkBridge.ts`
- Test: matching MAVLink tests

**Steps:**
1. Introduce a shared 512 MiB maximum accepted download size and reject oversized FTP/DataFlash metadata before opening a `.part` file.
2. Bound `parameterValues` with deterministic oldest-entry eviction and a diagnostic warning.
3. Add oversized-file and cache-bound regression tests.
4. Run FTP, log-transfer, and bridge tests.

### Task 4: Preserve frontend state across soft heartbeat loss and improve message safety

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/web/hooks/useWebSocket.ts`
- Modify: `src/web/stores/connectionStore.ts`
- Modify: `src/web/stores/telemetryStore.ts`
- Test: add focused utility/store tests where practical

**Steps:**
1. Treat `transportOpen && !vehicleReady` as stale/temporarily unavailable, not a physical disconnect.
2. Split JSON parse errors from message-handler failures.
3. Replace telemetry/sensor `any` payloads with `unknown`/typed payload maps and validate finite numeric values before committing them to stores.
4. Treat non-finite or non-positive battery voltage as unknown/offline.
5. Close the connection dialog only on the transition from closed transport to open transport.
6. Run typecheck and store/server-message tests.

### Task 5: Repair safety and parameter-write UI state machines

**Files:**
- Modify: `src/web/hooks/useGamepadController.ts`
- Modify: `src/web/pages/MotorPage.tsx`
- Modify: `src/web/pages/ParameterPage.tsx`
- Test: relevant hook/page utility tests

**Steps:**
1. Report failed Gamepad arm/disarm/mode sends instead of claiming delivery; do not queue them.
2. Reset motor-test confirmation when target/session readiness transitions invalidate the prior acknowledgement.
3. Add a per-entry timeout and user-cancellable exit to parameter imports.
4. Add regression tests for pure helper/state transitions where component testing is unavailable.
5. Run typecheck and targeted tests.

### Task 6: Correct sensor, PreArm, and attitude presentation

**Files:**
- Modify: `src/web/pages/SensorPage.tsx`
- Modify: `src/web/utils/prearmStatus.ts`
- Modify: `src/web/components/logs/LogAttitudeVisualizer.tsx`
- Modify: associated tests

**Steps:**
1. Display RAW_IMU counts without SI conversion and expose the correct unit label.
2. Recognize `PreArm: Healthy` as a success and add a real-text regression case.
3. Reuse `attitudeToModelRotation` in log replay and test the sign convention.
4. Move playback completion side effects out of state updaters and reduce React state updates to a bounded display cadence while the Three.js model reads a ref.
5. Run targeted UI utility tests and typecheck.

### Task 7: Harden log-analysis timelines and bounded collectors

**Files:**
- Modify: `src/web/pages/LogAnalysisPage.tsx`
- Modify: `src/web/utils/dataflashAnalysis.ts`
- Modify: `src/web/workers/ulogWorker.ts`
- Modify: associated tests

**Steps:**
1. Stabilize attitude/rate selection-group references so cursor movement does not recreate charts.
2. Normalize duration rounding and clamp mode-segment widths.
3. Treat DataFlash timestamp rollback as a new boot boundary and bound mode/armed samples.
4. Skip ULog messages without finite positive timestamps.
5. Add regression tests for duration, timestamp rollback, and invalid timestamp handling where the worker boundary permits.
6. Run log-analysis tests.

### Task 8: Fix remaining reachable UI, i18n, demo, and accessibility defects

**Files:**
- Modify: `src/web/pages/WaveformPage.tsx`
- Modify: `src/web/pages/PidTuningPage.tsx`
- Modify: `src/web/pages/FlightControlPage.tsx`
- Modify: `src/web/pages/ReceiverPage.tsx`
- Modify: `src/web/pages/MotorPage.tsx`
- Modify: `src/web/components/ConnectDialog.tsx`
- Modify: `src/web/components/logs/DataflashLogPanel.tsx`
- Modify: `src/web/components/logs/LogAttitudeVisualizer.tsx`
- Modify: `src/web/components/esc/EscDeviceCard.tsx`
- Modify: `src/web/components/sensors/GpsConfigurationPanel.tsx`
- Modify: `src/web/components/telemetry/FlightControllerTerminal.tsx`
- Modify: `src/web/components/telemetry/StatusVariableBrowser.tsx`
- Modify: `src/web/demo/demoMode.ts`
- Modify: locale files

**Steps:**
1. Pause waveform sampling while disconnected/stale.
2. Preserve invalid PID drafts and show validation feedback.
3. Move separators, channel names, status labels, and ESC/GPS strings into i18n.
4. Generate neutral/family-specific motor placeholders.
5. Add accessible names to icon-only controls.
6. Make DataFlash listing once-per-target/session with explicit refresh behavior.
7. Implement terminal backspace/C0 processing as a pure tested helper.
8. Move StatusVariableBrowser ref mutations to commit-phase effects.
9. Add demo stop cleanup and isolate its localStorage key.
10. Run component/utility tests and typecheck.

### Task 9: Remove type-hiding assertions and complete verification

**Files:**
- Modify: `src/shared/vehicleProfiles.ts`
- Modify: `src/shared/esc/layouts/am32.ts`
- Modify: `docs/plan/2026-08-08-verified-code-review.md`

**Steps:**
1. Replace narrow tuple assertions with explicit comparisons/type guards.
2. Mark fixed findings in the verified review document and record any HIL-only residual risk.
3. Run `npm run typecheck`.
4. Run `npm run test:protocol`.
5. Run `npm run test:server`; if the known 10ms timing assertion flakes, rerun its file standalone and report both results.
6. Run `npm run build`.
7. Review `git diff --check` and the complete diff; do not commit unless explicitly requested.
