# ArduPilot Flight Controller Adaptation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> **For Codex:** Use the `executing-plans` skill, preserve the existing dirty worktree, and stop at every hardware-in-the-loop checkpoint.

**Goal:** Make OpenConfigurator safely identify and configure ArduPilot vehicles, with ArduCopter 4.7 on the connected MicoAir743v2 as the first acceptance target, while preserving existing PX4 behavior.

**Architecture:** Keep the common MAVLink transport and message normalization, then add a framework-agnostic vehicle profile selected from HEARTBEAT `autopilot` and `type`. The server owns stack-specific command encoding and capability checks; the React UI renders profile-provided modes and parameter groups instead of importing PX4 constants directly. Implement ArduCopter first, model Plane/Rover as explicit unsupported profiles until tested.

**Tech Stack:** TypeScript 6, Node.js, node-mavlink, Express/WebSocket, React 19, zustand, tsx tests, ArduPilot SITL and serial hardware-in-the-loop.

---

## 1. Exploration findings and scope

### Connected hardware evidence (2026-07-29)

- Chrome showed a stable serial link on `COM12`, about 10.6 KB/s inbound, 100% displayed link quality, and complete synchronization of 1,222 parameters.
- FC STATUSTEXT identified `ArduCopter V4.7.0 (1511f271)`, `MicoAir743v2`, `Frame: QUAD/X`, and the active PreArm failures.
- Common telemetry already works: ATTITUDE, IMU, magnetometer, barometer, SERVO_OUTPUT_RAW, SYS_STATUS/STATUSTEXT, and parameter transfer.
- HEARTBEAT `custom_mode=0` is displayed as `Mode 0`; for ArduCopter this is Stabilize. The current decoder always applies PX4's packed main/sub-mode layout.
- AUTOPILOT_VERSION is always labeled `PX4 vX.Y.Z`, regardless of HEARTBEAT `autopilot`.
- The frame/settings page only looks for PX4 `SYS_AUTOSTART`; ArduPilot exposes `FRAME_CLASS` and `FRAME_TYPE`.
- The actuator page only looks for PX4 `PWM_MAIN_*`, `PWM_AUX_*`, and `CA_ROTOR*`. ArduPilot exposes `SERVOx_FUNCTION`, `FRAME_*`, and `MOT_*`.
- Unmounting the actuator page sends PX4 `MAV_CMD_ACTUATOR_TEST` stop commands. The connected ArduPilot returned `MAV_RESULT_UNSUPPORTED` for command 310. ArduPilot motor test must use `MAV_CMD_DO_MOTOR_TEST` (209).
- PID, EKF, serial-port, sensor-orientation, and flight-log pages are PX4-specific even though the generic parameter browser works.
- Current baseline is green: `npm run typecheck` and `npm run test:protocol`.

### First-release boundary

Ship and test:

- ArduPilot detection and correct firmware identity.
- ArduCopter mode display and mode switching.
- Existing common telemetry and safe arm/takeoff/land/RTL command paths.
- ArduCopter frame, actuator mapping, motor test, PID, EKF, serial-port, and sensor-orientation parameter views.
- Capability-gated calibration UI.
- PX4 regression coverage.

Defer behind explicit “not supported yet” capabilities:

- ArduPlane, Rover, Sub, Tracker, and custom firmware write operations.
- ArduPilot DataFlash `.BIN` analysis in the existing ULog analyzer.
- Mission/fence/rally editing.
- Automatic real-hardware arming, takeoff, or motor-spin tests.

### Considered designs

1. **Recommended: shared vehicle profile and server command adapter.** Moderate initial change, one UI, protocol decisions remain safety-auditable, and Plane/Rover can be added without scattering firmware checks.
2. **Conditional checks inside each page.** Smallest first patch, but mode encoding, motor-test semantics, and parameter names become duplicated and difficult to audit.
3. **Separate ArduPilot bridge and page tree.** Strong isolation, but duplicates transport, telemetry, WebSocket, state, and most UI; too much maintenance for the current scope.

## 2. Protocol references

- [ArduPilot: Get and Set FlightMode](https://ardupilot.org/dev/docs/mavlink-get-set-flightmode.html)
- [ArduPilot: Getting and Setting Parameters](https://ardupilot.org/dev/docs/mavlink-get-set-params.html)
- [ArduPilot: Requesting Data From The Autopilot](https://ardupilot.org/dev/docs/mavlink-requesting-data.html)
- [MAVLink common commands: DO_SET_MODE and DO_MOTOR_TEST](https://mavlink.io/en/messages/common.html)
- [ArduPilot SITL](https://ardupilot.org/dev/docs/using-sitl-for-ardupilot-testing.html)
- [ArduPilot parameter metadata index](https://autotest.ardupilot.org/Parameters/ArduCopter/)

## 3. Implementation tasks

### Task 1: Add stack and vehicle identity to the shared protocol

**Files:**

- Create: `src/shared/vehicleProfiles.ts`
- Create: `src/shared/vehicleProfiles.test.ts`
- Modify: `src/shared/types.ts:72-79,141-147,358-376`
- Modify: `src/server/mavlink/MavlinkBridge.ts:73-78,283-297,596-644,1878-1903`
- Modify: `src/server/mavlink/MavlinkBridge.test.ts:36-51,399-475,825-850`
- Modify: `src/web/hooks/useWebSocket.ts:202-204,313-322`
- Modify: `src/web/stores/telemetryStore.ts:49-79,106-140`

**Step 1: Write failing profile tests**

Cover these exact cases:

```ts
assert.equal(classifyAutopilot(3), 'ardupilot')
assert.equal(classifyAutopilot(12), 'px4')
assert.equal(classifyVehicleType(2), 'copter')
assert.equal(decodeFlightMode('ardupilot', 'copter', 0).name, 'Stabilize')
assert.equal(decodeFlightMode('ardupilot', 'copter', 6).name, 'RTL')
assert.equal(decodeFlightMode('px4', 'copter', 0x04040000).name, 'Mission')
```

Run: `npx tsx src/shared/vehicleProfiles.test.ts`

Expected: FAIL because `vehicleProfiles.ts` does not exist.

**Step 2: Define shared identity types**

Add:

```ts
export type AutopilotFamily = 'px4' | 'ardupilot' | 'unknown'
export type VehicleClass = 'copter' | 'plane' | 'rover' | 'sub' | 'tracker' | 'unknown'

export interface VehicleIdentity {
  autopilotId: number
  vehicleTypeId: number
  family: AutopilotFamily
  vehicleClass: VehicleClass
}
```

Include `identity` in target/status data and `family`/`vehicleClass` in `AutopilotVersionData`. Do not infer PX4 when the value is unknown.

**Step 3: Implement pure classification and mode decoding**

`vehicleProfiles.ts` must contain:

- MAV_AUTOPILOT mapping for ArduPilotMega (3) and PX4 (12).
- MAV_TYPE mapping sufficient for Copter, Plane, Rover, Sub, and Tracker.
- ArduCopter mode table for documented `custom_mode` values.
- The existing PX4 packed main/sub-mode decoder.
- Unknown fallback as `Mode <raw>` without enabling write capabilities.

**Step 4: Preserve HEARTBEAT identity in the bridge**

Store both `hb.autopilot` and `hb.type` for every discovered target. Emit the selected identity in `target` and `status`. Pass the identity into mode decoding.

**Step 5: Make AUTOPILOT_VERSION labels family-aware**

Expected labels:

- `ArduPilot v4.7.0`
- `PX4 v1.17.0`
- `Autopilot vX.Y.Z` for unknown families

Keep raw board/vendor/product fields; do not hardcode MicoAir from STATUSTEXT.

**Step 6: Dispatch identity into zustand**

Store selected identity independently of the parameter set and clear it on target reset/disconnect. UI must never reuse a prior vehicle's profile after reconnect.

**Step 7: Run tests**

Run:

```bash
npx tsx src/shared/vehicleProfiles.test.ts
npm run test:protocol
npm run typecheck
```

Expected: all PASS; existing PX4 version and target tests updated without losing coverage.

**Step 8: Commit**

```bash
git add src/shared/vehicleProfiles.ts src/shared/vehicleProfiles.test.ts src/shared/types.ts src/server/mavlink/MavlinkBridge.ts src/server/mavlink/MavlinkBridge.test.ts src/web/hooks/useWebSocket.ts src/web/stores/telemetryStore.ts
git commit -m "feat: identify ArduPilot vehicle profiles"
```

### Task 2: Move flight-mode encoding behind the server profile

**Files:**

- Modify: `src/shared/types.ts:434-470`
- Modify: `src/shared/constants.ts:17-27`
- Modify: `src/shared/vehicleProfiles.ts`
- Modify: `src/server/mavlink/MavlinkBridge.ts:1390-1590,2317-2330`
- Modify: `src/server/mavlink/MavlinkBridge.test.ts:475-592`
- Modify: `src/web/components/layout/Topbar.tsx:1-6,314-343`
- Modify: `src/web/pages/FlightControlPage.tsx:1-8,64-67,162-180`
- Modify: `src/web/hooks/useGamepadController.ts:1-22`

**Step 1: Write failing mode-command tests**

Verify the server builds:

```ts
// ArduCopter Loiter
params === [1, 5, 0, 0, 0, 0, 0]

// PX4 Position
params === [1, 3, 0, 0, 0, 0, 0]
```

Also verify an ArduPilot mode request made before identity is known returns `operation_error` with `unsupported_vehicle_profile`.

**Step 2: Add a semantic client message**

Use:

```ts
| { type: 'set_flight_mode'; requestId?: string; data: { modeId: number } }
```

The browser must stop constructing MAV_CMD parameters.

**Step 3: Encode by selected profile on the server**

- ArduPilot: param1 = `MAV_MODE_FLAG_CUSTOM_MODE_ENABLED` (1), param2 = raw flight-mode number, param3 = 0.
- PX4: preserve the existing main/sub-mode encoding.
- Unknown family or unimplemented vehicle class: reject before writing to serial.

**Step 4: Make mode lists profile-driven**

Topbar, flight page, and gamepad read `availableModes(identity)`. ArduCopter first release should expose only commonly safe, understood modes: Stabilize, AltHold, Loiter, PosHold, Auto, Guided, RTL, Land, and Acro.

**Step 5: Run tests**

Run:

```bash
npx tsx src/shared/vehicleProfiles.test.ts
npm run test:protocol
npm run typecheck
```

Expected: PASS; connected ArduCopter custom_mode 0 renders `Stabilize`.

**Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts src/shared/vehicleProfiles.ts src/server/mavlink/MavlinkBridge.ts src/server/mavlink/MavlinkBridge.test.ts src/web/components/layout/Topbar.tsx src/web/pages/FlightControlPage.tsx src/web/hooks/useGamepadController.ts
git commit -m "feat: adapt flight modes by autopilot profile"
```

### Task 3: Add explicit capability gating for every write surface

**Files:**

- Modify: `src/shared/vehicleProfiles.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/server/mavlink/MavlinkBridge.ts`
- Modify: `src/server/mavlink/MavlinkBridge.test.ts`
- Modify: `src/web/stores/telemetryStore.ts`
- Modify: `src/web/pages/FlightControlPage.tsx`
- Modify: `src/web/pages/SensorPage.tsx`
- Modify: `src/web/pages/MotorPage.tsx`
- Modify: `src/web/pages/PortSettingsPage.tsx`
- Modify: `src/web/pages/PidTuningPage.tsx`
- Modify: `src/web/components/ekf/EkfFusionPanel.tsx`

**Step 1: Write failing capability tests**

Define and test:

```ts
interface VehicleCapabilities {
  setMode: boolean
  arm: boolean
  guidedTakeoff: boolean
  calibrate: boolean
  motorTest: 'actuator-test' | 'motor-test' | 'none'
  frameConfig: boolean
  actuatorConfig: boolean
  pidConfig: boolean
  ekfConfig: boolean
  serialConfig: boolean
  logFormat: 'ulog' | 'dataflash' | 'unknown'
}
```

Unknown profiles must default all write fields to false and `motorTest` to `none`.

**Step 2: Compute capabilities from family and vehicle class**

Do not use the presence of a parameter alone to authorize a safety-critical command. Parameters may be stale or shared across stacks.

**Step 3: Enforce capabilities on the server**

Reject unsupported mode, calibration, motor-test, and guided-flight requests before serialization. Return a request-scoped `operation_error`.

**Step 4: Gate the UI**

Unsupported controls remain visible with a specific explanation. Do not silently hide a missing capability or render a PX4 control against ArduPilot parameters.

**Step 5: Run tests**

Run: `npm run test:protocol && npm run typecheck`

Expected: PASS; no command is serialized for an unknown family.

**Step 6: Commit**

```bash
git add src/shared/vehicleProfiles.ts src/shared/types.ts src/server/mavlink/MavlinkBridge.ts src/server/mavlink/MavlinkBridge.test.ts src/web/stores/telemetryStore.ts src/web/pages/FlightControlPage.tsx src/web/pages/SensorPage.tsx src/web/pages/MotorPage.tsx src/web/pages/PortSettingsPage.tsx src/web/pages/PidTuningPage.tsx src/web/components/ekf/EkfFusionPanel.tsx
git commit -m "feat: gate vehicle operations by capability"
```

### Task 4: Implement ArduPilot frame and actuator parameter adapters

**Files:**

- Create: `src/web/utils/vehicleConfig.ts`
- Create: `src/web/utils/vehicleConfig.test.ts`
- Modify: `src/web/pages/SettingsPage.tsx:28-80`
- Modify: `src/web/pages/MotorPage.tsx:11-148,220-280`
- Modify: `src/web/utils/px4Airframes.ts`

**Step 1: Write failing pure adapter tests**

Fixtures:

```ts
const arducopterQuadX = params({
  FRAME_CLASS: 1,
  FRAME_TYPE: 1,
  SERVO1_FUNCTION: 33,
  SERVO2_FUNCTION: 34,
  SERVO3_FUNCTION: 35,
  SERVO4_FUNCTION: 36,
  MOT_PWM_TYPE: 6,
})
```

Assert:

- Frame label is `Quad / X`.
- Motor count is 4.
- SERVO1..4 map to Motor1..4.
- PX4 fixture continues using `SYS_AUTOSTART`, `PWM_MAIN_FUNCx`, and `CA_ROTOR_COUNT`.

**Step 2: Implement family-specific read models**

Return a normalized UI model:

```ts
interface FrameConfigView {
  name: string
  motorCount: number | null
  outputChannels: Array<{
    label: string
    paramId: string
    functionValue: number
    motorInstance: number | null
  }>
  protocolLabel: string
}
```

ArduPilot output function values 33..44 map to Motor1..12. Preserve unknown function values instead of rewriting them.

**Step 3: Update frame/settings UI**

Show `FRAME_CLASS`/`FRAME_TYPE` for ArduPilot and `SYS_AUTOSTART` for PX4. Do not add frame writes in the first release.

**Step 4: Update actuator mapping UI**

Render `SERVO1_FUNCTION` through the last present `SERVOx_FUNCTION`. Writes require the existing controller lease plus `actuatorConfig` capability.

**Step 5: Run tests**

Run:

```bash
npx tsx src/web/utils/vehicleConfig.test.ts
npm run typecheck
npm run build
```

Expected: PASS; ArduPilot no longer shows “没有提供 PWM MAIN/AUX”.

**Step 6: Commit**

```bash
git add src/web/utils/vehicleConfig.ts src/web/utils/vehicleConfig.test.ts src/web/pages/SettingsPage.tsx src/web/pages/MotorPage.tsx src/web/utils/px4Airframes.ts
git commit -m "feat: show ArduPilot frame and actuator mapping"
```

### Task 5: Implement safe ArduPilot motor test

**Files:**

- Modify: `src/shared/types.ts:332-345,434-470`
- Modify: `src/server/mavlink/MavlinkBridge.ts:2232-2315`
- Modify: `src/server/mavlink/MavlinkBridge.test.ts:560-665`
- Modify: `src/web/pages/MotorPage.tsx:150-218,282-357`

**Step 1: Write failing protocol tests**

For ArduPilot motor 1 at 5%:

```ts
command = 209
params = [1, 0, 5, 2, 0, 0, 0]
```

For PX4 motor 1 preserve:

```ts
command = 310
params = [0.05, 2, 0, 0, 1101, 0, 0]
```

Verify both reject non-zero throttle without `propsRemoved: true`, while stop commands remain critical priority.

**Step 2: Branch in the server by `motorTest` capability**

- ArduPilot uses `MAV_CMD_DO_MOTOR_TEST`, 1-based instance, percent throttle, bounded timeout.
- PX4 retains `MAV_CMD_ACTUATOR_TEST`.
- Unknown profiles return `unsupported_motor_test`.

**Step 3: Fix cleanup behavior**

MotorPage cleanup may send stop commands only after the user enabled motor testing or a non-zero command was sent. Merely opening/leaving the mapping page must emit no motor-test command.

**Step 4: Preserve UI safety guards**

Keep:

- Explicit “props removed” checkbox.
- Disarmed-only gating.
- Per-command short timeout.
- Stop on pointer-up, cancel, blur, panel change, connection loss, and unmount after activation.

**Step 5: Run tests**

Run: `npm run test:protocol && npm run typecheck`

Expected: PASS; navigation to/from actuator mapping sends no command 310 or 209.

**Step 6: Hardware checkpoint**

With props still installed, verify only that controls are disabled or no command is sent. Do not spin motors.

After the user separately confirms props are removed, test one motor at the minimum UI percentage for no more than two seconds and confirm ACK/STATUSTEXT plus automatic stop.

**Step 7: Commit**

```bash
git add src/shared/types.ts src/server/mavlink/MavlinkBridge.ts src/server/mavlink/MavlinkBridge.test.ts src/web/pages/MotorPage.tsx
git commit -m "feat: support safe ArduPilot motor test"
```

### Task 6: Adapt ArduCopter PID, EKF, serial, and orientation parameters

**Files:**

- Create: `src/web/utils/parameterProfiles.ts`
- Create: `src/web/utils/parameterProfiles.test.ts`
- Modify: `src/web/pages/PidTuningPage.tsx:20-280`
- Modify: `src/web/components/ekf/EkfFusionPanel.tsx`
- Modify: `src/web/pages/PortSettingsPage.tsx:6-145`
- Modify: `src/web/pages/SensorPage.tsx:236-280`

**Step 1: Write failing profile tests**

Verify these ArduCopter mappings:

- Roll rate: `ATC_RAT_RLL_P`, `_I`, `_D`, `_FF`.
- Pitch rate: `ATC_RAT_PIT_P`, `_I`, `_D`, `_FF`.
- Yaw rate: `ATC_RAT_YAW_P`, `_I`, `_D`, `_FF`.
- EKF3 sources: `EK3_SRC1_POSXY`, `VELXY`, `POSZ`, `VELZ`, `YAW`.
- Board orientation: `AHRS_ORIENTATION`.
- Serial: `SERIALx_PROTOCOL`, `SERIALx_BAUD`, plus read-only display of available `SRx_*` rates.

Verify PX4 mappings remain unchanged.

**Step 2: Implement declarative parameter groups**

Each field definition includes id, label, bounds, step, formatting, and whether reboot is required. If metadata is unavailable, use conservative UI bounds and always preserve raw-value editing in the complete parameter page.

**Step 3: Render PID groups from the selected profile**

Do not rename ArduPilot gains to PX4 semantics. Hide an entire group only when none of its parameters are present; show individual missing fields as unavailable.

**Step 4: Render EKF3 source configuration**

Keep the existing live EKF status panel. Swap only the configuration controls by profile. Do not auto-write `AHRS_EKF_TYPE` or `EK3_ENABLE`.

**Step 5: Render ArduPilot serial ports**

Map only actual `SERIALx_*` parameters present in the downloaded set. Preserve protocol values unknown to the UI. Warn that protocol/baud changes normally require reboot.

**Step 6: Bind board orientation**

Replace the disabled PX4-only `SENS_BOARD_ROT` control with profile-selected `SENS_BOARD_ROT` or `AHRS_ORIENTATION`. Require a confirmation message that a wrong orientation is flight-critical.

**Step 7: Run tests**

Run:

```bash
npx tsx src/web/utils/parameterProfiles.test.ts
npm run typecheck
npm run build
```

Expected: PASS; ArduCopter PID, EKF, serial, and orientation sections no longer show PX4-only empty states.

**Step 8: Commit**

```bash
git add src/web/utils/parameterProfiles.ts src/web/utils/parameterProfiles.test.ts src/web/pages/PidTuningPage.tsx src/web/components/ekf/EkfFusionPanel.tsx src/web/pages/PortSettingsPage.tsx src/web/pages/SensorPage.tsx
git commit -m "feat: add ArduCopter parameter profiles"
```

### Task 7: Make calibration protocol capability-aware

**Files:**

- Modify: `src/shared/types.ts`
- Modify: `src/server/mavlink/MavlinkBridge.ts`
- Modify: `src/server/mavlink/MavlinkBridge.test.ts`
- Modify: `src/web/pages/SensorPage.tsx:32-94,137-195`

**Step 1: Add failing calibration tests**

Verify that:

- ArduCopter accepts only the calibration types explicitly implemented.
- Calibration is rejected while armed.
- COMMAND_ACK and ArduPilot STATUSTEXT advance the request-scoped state.
- Unknown families never serialize command 241.

**Step 2: Introduce a semantic calibration message**

Use:

```ts
| {
    type: 'start_calibration'
    requestId: string
    data: { kind: 'accel' | 'gyro' | 'mag' | 'baro' }
  }
```

The server maps supported kinds to stack-specific command parameters.

**Step 3: Add ArduPilot interaction handling**

Implement only documented, testable calibration flows. If accelerometer position acknowledgement is required, model it as an explicit follow-up client/server message; do not infer a position and do not advance solely on a timer.

**Step 4: Update UI copy and progress parsing**

Keep STATUSTEXT visible verbatim. Stack-specific parsers may derive progress, but a missing parser must show “waiting for flight controller” rather than a fabricated percentage.

**Step 5: Run tests**

Run: `npm run test:protocol && npm run typecheck`

Expected: PASS.

**Step 6: Hardware checkpoint**

Only exercise calibration after the user chooses the calibration type and confirms the vehicle is disarmed, stationary, and props are removed where appropriate.

**Step 7: Commit**

```bash
git add src/shared/types.ts src/server/mavlink/MavlinkBridge.ts src/server/mavlink/MavlinkBridge.test.ts src/web/pages/SensorPage.tsx
git commit -m "feat: adapt calibration flows by autopilot"
```

### Task 8: Normalize ArduPilot telemetry edge cases

**Files:**

- Modify: `src/server/mavlink/MavlinkBridge.ts:656-1205`
- Modify: `src/server/mavlink/MavlinkBridge.test.ts:850-1220`
- Modify: `src/shared/types.ts:27-53,126-147`
- Modify: `src/web/stores/telemetryStore.ts`
- Modify: `src/web/pages/DashboardPage.tsx`
- Modify: `src/web/pages/FlightControlPage.tsx:68-98`

**Step 1: Add captured-shape regression tests**

Use synthetic messages matching the connected ArduCopter observations:

- HEARTBEAT autopilot 3/type 2/custom_mode 0.
- SYS_STATUS with PreArm health bits.
- BATTERY_STATUS with unknown/zero voltage fields.
- RC_CHANNELS with absent receiver.
- EKF_STATUS_REPORT.

Do not commit raw serial captures containing unrelated traffic; commit minimal constructed fixtures.

**Step 2: Normalize unknown values**

- Never display `0.0 V · 99%` as a healthy battery without a valid voltage source.
- Preserve null/unknown channel values instead of turning absent RC inputs into valid 0 µs.
- Keep failsafe `unknown` unless a reliable stack-specific source proves a stronger state.

**Step 3: Make flight checks profile-aware**

ArduPilot PreArm STATUSTEXT and SYS_STATUS are authoritative for blocking. UI-only GPS/EKF checks may add information but must not claim the FC is ready when ArduPilot reports a PreArm failure.

**Step 4: Run tests**

Run: `npm run test:protocol && npm run typecheck && npm run build`

Expected: PASS; current PreArm failures remain visible and blocking.

**Step 5: Commit**

```bash
git add src/server/mavlink/MavlinkBridge.ts src/server/mavlink/MavlinkBridge.test.ts src/shared/types.ts src/web/stores/telemetryStore.ts src/web/pages/DashboardPage.tsx src/web/pages/FlightControlPage.tsx
git commit -m "fix: normalize ArduPilot telemetry states"
```

### Task 9: Separate PX4 ULog from ArduPilot DataFlash capabilities

**Files:**

- Modify: `src/shared/constants.ts:75-119`
- Modify: `src/web/stores/fileExplorerStore.ts`
- Modify: `src/web/pages/FlightLogsPage.tsx:1-80,330-380`
- Modify: `src/web/pages/LogAnalysisPage.tsx`
- Modify: `src/web/utils/ulogAnalysis.ts`
- Create: `docs/ARDUPILOT.md`

**Step 1: Write failing UI-model tests**

Assert:

- PX4 profile offers MAVFTP ULog browsing and `.ulg` analysis.
- ArduPilot profile reports DataFlash and does not navigate to `/fs/microsd/log`.
- Unknown profile offers neither destructive log deletion nor analysis.

**Step 2: Gate existing log services**

Rename the PX4 log-path constant to make its scope explicit. ArduPilot must show a clear “DataFlash download/analysis is not implemented in this milestone” state instead of an empty PX4 directory or `.ulg` error.

**Step 3: Document the follow-up design**

`docs/ARDUPILOT.md` should specify a later `LOG_REQUEST_LIST` / `LOG_REQUEST_DATA` / `LOG_DATA` service, resumable download behavior, `.BIN` parser choice, and deletion policy. Do not add a parser dependency until its license, browser support, and large-file behavior have been evaluated.

**Step 4: Run tests**

Run: `npm run typecheck && npm run build && npm run test:ulog`

Expected: PASS; PX4 ULog behavior remains unchanged.

**Step 5: Commit**

```bash
git add src/shared/constants.ts src/web/stores/fileExplorerStore.ts src/web/pages/FlightLogsPage.tsx src/web/pages/LogAnalysisPage.tsx src/web/utils/ulogAnalysis.ts docs/ARDUPILOT.md
git commit -m "feat: separate PX4 and ArduPilot log capabilities"
```

### Task 10: Add SITL and hardware acceptance coverage

**Files:**

- Create: `docs/ARDUPILOT-TEST-MATRIX.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ROADMAP.md`
- Modify: `README.md`
- Modify: `README.en.md`

**Step 1: Document an ArduCopter SITL matrix**

Minimum simulated cases:

- ArduCopter Quad, parameter sync, Stabilize/AltHold/Loiter mode decoding.
- Reconnect and target reset.
- Unknown/unsupported vehicle class remains read-only.
- Command denial while armed or PreArm-blocked.
- Motor-test serialization tested in unit tests only unless the simulator test is explicitly isolated.

The current backend has no UDP/TCP transport. Use a serial bridge for this milestone, or create a separate, reviewed transport plan; do not mix UDP transport work into the first adapter commits.

**Step 2: Document current MicoAir HIL checks**

Read-only checks:

- Identity: ArduCopter 4.7 / MicoAir743v2 / Quad X.
- Mode: Stabilize instead of Mode 0.
- 1,222 parameters complete without endless retry.
- ATTITUDE/IMU/baro/mag/output telemetry remains live.
- Frame and SERVO mappings render.
- No motor command occurs on page navigation.
- PreArm failures remain visible and block arm.

Write checks requiring separate user authorization:

- Parameter write and echo.
- Mode change.
- Calibration.
- Motor spin with props removed.
- Arm/disarm.

Never include takeoff in bench HIL.

**Step 3: Run the full local suite**

Run:

```bash
npm run test:server
npm run test:protocol
npm run test:ulog
npm run typecheck
npm run build
```

Expected: all PASS.

**Step 4: Perform Chrome read-only acceptance**

Inspect dashboard, flight, settings, sensors, actuators, PID, EKF, ports, parameters, messages, and logs. Record pass/fail in `docs/ARDUPILOT-TEST-MATRIX.md`. Do not activate any control during this pass.

**Step 5: Commit**

```bash
git add docs/ARDUPILOT-TEST-MATRIX.md docs/ARCHITECTURE.md docs/ROADMAP.md README.md README.en.md
git commit -m "docs: add ArduPilot acceptance matrix"
```

## 4. Release gates

Do not call the adaptation complete until all are true:

- Existing PX4 protocol tests remain green.
- ArduPilot family/type survives reconnect and target switching.
- ArduCopter mode 0 displays Stabilize and mode writes are encoded as ArduPilot custom modes.
- Unknown families and unimplemented vehicle classes are read-only.
- Opening or leaving any page sends no safety-critical command.
- Motor test keeps the props-removed guard and uses command 209 only for ArduPilot.
- Specialized pages never write PX4 parameter names to ArduPilot or vice versa.
- Current hardware PreArm failures remain visible and blocking.
- Full typecheck, build, protocol, server, and ULog test suite passes.

## 5. Execution order and review checkpoints

Implement Tasks 1-3 first and review the protocol boundary before touching UI parameter editors. Then implement Tasks 4-8 one commit at a time. Task 9 is a capability-separation milestone, not full DataFlash support. Finish with Task 10 and a read-only Chrome pass.

Before every HIL write checkpoint:

1. Show the exact MAVLink command or parameter write to the user.
2. State the physical prerequisites.
3. Obtain explicit authorization for that specific operation.
4. Observe ACK plus resulting vehicle state; an ACK alone is not proof of completion.
5. Stop immediately on unexpected mode, armed state, or STATUSTEXT.
