# ArduPilot Support Notes

OpenConfigurator identifies ArduPilot vehicles from the HEARTBEAT identity
(`autopilot` + `type`) and drives a framework-agnostic vehicle profile. This
document tracks ArduPilot-specific behavior and the deferred DataFlash log
service design.

## Current status (first milestone)

Supported for **ArduCopter 4.7** (MicoAir743v2 acceptance target):

- Autopilot/vehicle identity and family-aware firmware label (`ArduPilot vX.Y.Z`).
- Flight-mode display and mode switching via raw `custom_mode` numbers.
- Common telemetry (attitude, IMU, mag, baro, servo output, SYS_STATUS/STATUSTEXT).
- Frame view from `FRAME_CLASS`/`FRAME_TYPE`; actuator mapping from `SERVOx_FUNCTION`.
- Motor test via `MAV_CMD_DO_MOTOR_TEST` (209), 1-based instance, percent throttle.
- PID (`ATC_*`/`PSC_*`), EKF3 source (`EK3_SRC1_*`), serial (`SERIALx_*`) and
  board orientation (`AHRS_ORIENTATION`) parameter views.
- Capability-gated calibration (gyro, baro, level accel).

Explicitly **not supported yet** (read-only or hidden behind capabilities):

- ArduPlane, Rover, Sub, Tracker and custom firmware write operations.
- ArduPilot DataFlash `.BIN` download and analysis.
- Compass (mag) calibration (needs the `DO_START_MAG_CAL` protocol).
- Mission/fence/rally editing.
- Frame writes.

## DataFlash logs (deferred design)

PX4 stores ULog files on the SD card, browsable over MAVLink FTP under
`PX4_ULOG_LOG_DIRECTORY` (`/fs/microsd/log`). ArduPilot instead exposes
DataFlash logs over a dedicated MAVLink log-transfer protocol. The flight-log
page therefore shows an explicit "not implemented in this milestone" state for
ArduPilot rather than an empty PX4 directory or a `.ulg` parse error.

A later milestone should implement:

1. **Listing** — `LOG_REQUEST_LIST` → `LOG_ENTRY` responses to enumerate logs
   (id, size, UTC time). Handle sparse/again-requested ranges.
2. **Download** — `LOG_REQUEST_DATA` → `LOG_DATA` (90-byte chunks). Track
   received offsets, re-request gaps, and support **resumable** downloads on a
   dropped Bluetooth link (mirror the FTP download's offset bookkeeping).
3. **Erase / deletion policy** — `LOG_ERASE` wipes *all* logs (there is no
   per-log delete). Gate it behind the same explicit multi-file confirmation
   used for FTP deletion, and make the "erase all" scope unmistakable in the UI.
4. **`.BIN` parsing** — evaluate a parser before adding a dependency:
   - License compatibility (MIT-compatible preferred).
   - Browser/worker support (parse off the main thread, like `ulogWorker`).
   - Large-file behavior (streaming/chunked parse; multi-hundred-MB logs).
   Do **not** add a parser dependency until these are confirmed.

Until then, `logSupport(identity)` reports `format: 'dataflash'` with
`browse/analyze/allowDelete = false` and `logPath = null` for ArduPilot.

## Protocol references

- ArduPilot: Get and Set FlightMode — https://ardupilot.org/dev/docs/mavlink-get-set-flightmode.html
- ArduPilot: Getting and Setting Parameters — https://ardupilot.org/dev/docs/mavlink-get-set-params.html
- ArduPilot: Requesting Data From The Autopilot — https://ardupilot.org/dev/docs/mavlink-requesting-data.html
- MAVLink common messages (DO_SET_MODE, DO_MOTOR_TEST, LOG_*) — https://mavlink.io/en/messages/common.html
