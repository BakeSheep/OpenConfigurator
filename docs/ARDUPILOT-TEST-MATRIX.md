# ArduPilot Acceptance Test Matrix

Status legend: ✅ pass · ⚠️ conditional/needs authorization · ⛔ not run · N/A.

Acceptance target: **ArduCopter 4.7** on **MicoAir743v2** (Quad/X), serial link.
Automated suites (`npm run test:server`, `test:protocol`, `test:ulog`,
`test:dataflash`, `typecheck`, `build`) are green as of this milestone.

## 1. ArduCopter SITL matrix (serial bridge)

The backend has **no UDP/TCP transport**. For this milestone use a serial
bridge to ArduPilot SITL (e.g. a virtual COM pair), or write a separate,
reviewed transport plan — do **not** mix UDP transport work into the adapter
commits.

| # | Case | Expectation | Status |
|---|------|-------------|--------|
| 1 | ArduCopter Quad connects, parameters sync | Identity `ardupilot/copter`; full param set completes without endless retry | ⛔ |
| 2 | Mode decode Stabilize/AltHold/Loiter | `custom_mode` 0/2/5 render as names, not `Mode N` | ⛔ |
| 3 | Reconnect and target reset | Identity cleared on drop, re-classified on reconnect | ⛔ |
| 4 | Unknown/unsupported vehicle class | Read-only; no mode/arm/motor/cal writes serialized | ✅ (unit) |
| 5 | Command denial while armed / PreArm-blocked | Motor test + calibration refused while armed; PreArm STATUSTEXT blocks arm | ✅ (unit) |
| 6 | Motor-test serialization | `MAV_CMD_DO_MOTOR_TEST` (209) params `[instance,0,pct,timeout,0,0,0]` | ✅ (unit) |

Motor-test serialization is covered by unit tests only; do not spin motors in
the simulator unless the test is explicitly isolated from hardware.

## 2. MicoAir HIL — read-only checks (no authorization required)

Performed with props installed; no control is activated.

| # | Check | Expectation | Status |
|---|-------|-------------|--------|
| 1 | Identity | ArduCopter 4.7 / MicoAir743v2 / Quad X | ⛔ |
| 2 | Mode | `custom_mode` 0 shows **Stabilize**, not `Mode 0` | ⛔ |
| 3 | Parameter sync | ~1,222 parameters complete without endless retry | ⛔ |
| 4 | Live telemetry | ATTITUDE / IMU / baro / mag / servo output stay live | ⛔ |
| 5 | Frame & actuators | `FRAME_CLASS`/`FRAME_TYPE` frame + `SERVOx_FUNCTION` mapping render | ⛔ |
| 6 | No motor command on navigation | Opening/leaving actuator page emits no 209/310 | ✅ (unit) |
| 7 | PreArm failures | Remain visible and block arm | ⛔ |
| 8 | Firmware label | Shown as `ArduPilot v4.7.0` | ⛔ |
| 9 | Logs | Flight-log page shows the DataFlash log list (id / UTC time / size), not an empty PX4 dir | ⛔ |
| 10 | Log download | A small `.bin` downloads with live progress/rate; served via `/api/logs/downloads/:id` | ⛔ |
| 11 | Log analysis | "Download & analyze" and local `.bin` open render charts (attitude/rates/battery/GPS track) | ⛔ |

## 3. MicoAir HIL — write checks (each needs separate explicit authorization)

Before every write checkpoint: show the exact MAVLink command/parameter, state
the physical prerequisites, obtain authorization for that specific operation,
observe ACK **plus** the resulting vehicle state (an ACK alone is not proof),
and stop immediately on any unexpected mode/armed/STATUSTEXT.

| # | Operation | Prerequisite | Status |
|---|-----------|--------------|--------|
| 1 | Parameter write + echo | Disarmed | ⚠️ needs authorization |
| 2 | Mode change | Disarmed, area clear | ⚠️ needs authorization |
| 3 | Calibration (gyro/baro/level accel) | Disarmed, stationary, level | ⚠️ needs authorization |
| 4 | Motor spin (one motor, min %, ≤2 s) | **Props removed**, disarmed | ⚠️ needs authorization |
| 5 | Arm / disarm | Props removed, area clear | ⚠️ needs authorization |
| 6 | Log erase (LOG_ERASE, wipes ALL logs) | No wanted logs remain; erase-all confirmed | ⚠️ needs authorization |

**Never** include takeoff in bench HIL.

## 4. Chrome read-only acceptance pass

Inspect each page without activating any control; record pass/fail here.
Demo mode (`/?demo=1`, PX4 synthetic identity) read-only pass performed for
this milestone; hardware-connected rows above remain ⛔ pending authorization.

| Page | Observed (demo, PX4) | Status |
|------|----------------------|--------|
| Dashboard | Attitude, health dots, RC bars, motor outputs, custom board live | ✅ |
| Flight control | PX4 mode list + preflight checks render; no control activated | ✅ |
| Settings (frame/actuators) | Subnav complete; frame shows "waiting for params" (demo has none) | ✅ |
| Sensors | IMU/mag/baro/GPS/flow/rangefinder tabs + live charts; cal disabled (armed) | ✅ |
| PID tuning | Renders; 0 params (demo has no param protocol) | ✅ render |
| EKF | EKF2 panel renders; toggles disabled without params | ✅ |
| Ports | Renders | ✅ |
| Parameters | Renders; empty (demo has no param sync) | ✅ render |
| Messages | 12 live message types + link stats | ✅ |
| Logs | Explorer UI renders; directory loading (demo has no MAVFTP) | ✅ render |
| Log analysis | Dropzone accepts `.ulg`/`.bin`; format-selected worker dispatch | ✅ render |

Notes: PID/Parameters/Logs empty states stem from demo mode not synthesizing
parameter sync or MAVLink FTP responses — not an ArduPilot-adapter regression.
All nine pages rendered without crashes; no React errors in console.

> Hardware-in-the-loop rows remain ⛔ until run against the connected vehicle
> with explicit per-operation authorization. Unit-covered guarantees are marked
> ✅ (unit).
