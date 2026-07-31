# Calibration Protocol Sources

This document records the authoritative sources behind OpenConfigurator's
sensor calibration implementation and the date each fact was verified. It is
the calibration counterpart to `docs/ESC-PROTOCOL-SOURCES.md`.

Verified: 2026-07-31 (against node-mavlink@2.3.0 / mavlink-mappings@1.0.22-20260311).

## PX4 `[cal]` STATUSTEXT protocol

- **QGroundControl `SensorsComponentController`** — the GCS-side parser this
  implementation mirrors: prefix `"[cal] "`, lines
  `calibration started: <ver> <type>`, `<side> orientation detected`,
  `<side> side done, rotate to a different side`, `<side> side already completed`,
  `progress <N>`, `calibration done: <type>`, `calibration failed`,
  `calibration cancelled`. Supported firmware cal version = 2.
  Source: `qgroundcontrol/src/AutoPilotPlugins/PX4/SensorsComponentController.cc`.
- **Sides** are `down/up/left/right/front/back`. For the compass, the visible
  sides are gated by the `CAL_MAG_SIDES` bitmask
  (bit0=back, bit1=front, bit2=left, bit3=right, bit4=up, bit5=down; default 63).
- Start command: `MAV_CMD_PREFLIGHT_CALIBRATION (241)` with
  gyro=param1, mag=param2, groundPressure=param3, accel=param5=1, level=param5=2.
  Cancel: the same command with all parameters 0.
- Implemented in `src/server/mavlink/calProtocol.ts` (pure parser) and
  `src/server/mavlink/CalibrationSession.ts` (state machine).

## ArduPilot interactive accelerometer calibration

- **`MAV_CMD_PREFLIGHT_CALIBRATION (241)` param5**: 1 = interactive six-position,
  2 = level trim (AHRS_TRIM_*), 4 = simple one-shot.
- **`MAV_CMD_ACCELCAL_VEHICLE_POS (42429)`**: the FC requests each orientation
  by sending COMMAND_LONG with param1 = position; the GCS echoes the same
  COMMAND_LONG (param1 = position) to confirm placement. Terminal sentinels in
  param1: `16777215` = SUCCESS, `16777216` = FAILED.
  Positions: 1=LEVEL, 2=LEFT, 3=RIGHT, 4=NOSEDOWN, 5=NOSEUP, 6=BACK.
- Sources: MAVLink `ardupilotmega.xml` (`MAV_CMD_ACCELCAL_VEHICLE_POS`,
  `ACCELCAL_VEHICLE_POS` enum); ArduPilot firmware `AP_AccelCal.cpp` /
  `GCS_Common.cpp`; ArduPilot MethodicConfigurator
  `ARCHITECTURE_accelerometer_calibration.md`; Mission Planner
  `GCSViews/ConfigurationView/Setup/Accel.cs`.
- Note: some GCS/firmware combinations also accept a COMMAND_ACK for 42429 as
  the confirmation. This implementation uses the COMMAND_LONG echo (the
  MethodicConfigurator/Mission Planner path) and isolates the send behind a
  single session method; SITL verification is listed below.

## ArduPilot onboard compass calibration

- **Start** `MAV_CMD_DO_START_MAG_CAL (42424)` (mask=0 = all compasses,
  retry=0, autosave=0, delay=0, autoreboot=0). This implementation uses
  autosave=0 so the operator reviews quality before accepting.
- **Progress** `MAG_CAL_PROGRESS (191)` — ardupilotmega dialect only. Fields:
  `compass_id`, `cal_mask`, `cal_status`, `attempt`, `completion_pct`.
- **Report** `MAG_CAL_REPORT (192)` — present in the `common` dialect. Fields:
  `compass_id`, `cal_mask`, `cal_status`, `autosaved`, `fitness`, `ofs_x/y/z`.
- **Accept** `MAV_CMD_DO_ACCEPT_MAG_CAL (42425)`; **Cancel**
  `MAV_CMD_DO_CANCEL_MAG_CAL (42426)`.
- `MAG_CAL_STATUS`: 0..3 = in-progress states, 4 = SUCCESS, 5 = FAILED,
  6 = BAD_ORIENTATION, 7 = BAD_RADIUS.
- Sources: MAVLink `ardupilotmega.xml` / `common.xml`; ArduPilot
  `AP_Compass_Calibration.cpp`; ArduPilot compass calibration wiki.
- Dialect registration (`src/server/mavlink/codec.ts`): only message 191 is
  merged from `ardupilotmega.REGISTRY`; 192 stays `common.MagCalReport` so
  every shared id keeps its `common` definition.

## Quality thresholds (heuristic, advisory only)

- `src/web/utils/magCalibrationQuality.ts` fitness buckets
  (good <8, acceptable <16, marginal <25, poor otherwise) and the 600 mGauss
  offset-magnitude warning are **heuristics** aligned with Mission Planner /
  ArduPilot wiki guidance (lower fitness is better; large offsets indicate
  interference or a poor mount). They were not copied from a specific source
  line and never override the firmware `cal_status`.
- `src/web/utils/magInterference.ts` uses Earth's field band 0.25–0.65 Gauss
  and a sliding-window standard-deviation threshold as an advisory only; it is
  never a hard gate for starting calibration.

## SITL / HIL acceptance matrix

Hardware-free tests (node:test) do NOT constitute HIL validation. The
following must be exercised on SITL and real hardware before claiming full
validation:

| Environment | Scenario | Evidence to observe |
|---|---|---|
| PX4 SITL | accel six-position | ordered sides, progress, done, one param refresh |
| PX4 SITL | mag + CAL_MAG_SIDES | hidden sides match the param, real cancel |
| PX4 SITL | gyro/baro/level | correct encoding; no "done" from the initial ACK alone |
| ArduCopter SITL | accel six-position | correct 42429 target, idempotent repeats, success/failure sentinel |
| ArduCopter SITL | simple/level/gyro/baro | ACK-only shows accepted/ack_only |
| ArduCopter SITL | mag single/multi compass | cal_mask, failure status, report, accept, autosaved, reboot prompt |
| Two browsers | owner/observer | observer cannot act; owner reconnect reclaims; snapshot replays |
| Weak link | dropped ACK / duplicate 191/192/42429 | no start retransmit, recoverable follow-ups, seq idempotent |
| Real PX4 | accel/mag/cancel | physical attitude matches UI; link drop terminates safely |
| Real ArduCopter | accel/mag | multi-sensor save and post-reboot parameter/calibration state |

Until this matrix is completed on hardware, delivery notes must state that the
feature is **not yet HIL-validated**.
