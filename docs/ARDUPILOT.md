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
- DataFlash `.BIN` log listing, download (save / analyze) and full-chip erase
  over the LOG_REQUEST_* protocol, plus in-app `.bin` analysis.

Explicitly **not supported yet** (read-only or hidden behind capabilities):

- ArduPlane, Rover, Sub, Tracker and custom firmware write operations.
- Compass (mag) calibration (needs the `DO_START_MAG_CAL` protocol).
- Mission/fence/rally editing.
- Frame writes.

## DataFlash logs

PX4 stores ULog files on the SD card, browsable over MAVLink FTP under
`PX4_ULOG_LOG_DIRECTORY` (`/fs/microsd/log`). ArduPilot instead exposes
DataFlash logs over a dedicated MAVLink log-transfer protocol. The flight-log
page renders the profile-selected surface: the MAVFTP explorer for PX4 and a
flat DataFlash log list for ArduPilot (`logSupport(identity).format`).

The log-transfer service (`src/server/mavlink/MavlinkLogTransfer.ts`) mirrors
the FTP client's structure (single active operation, quiet-timeout retries,
interval bookkeeping, a temp-file download registry served by
`GET /api/logs/downloads/:downloadId`):

1. **Listing** — `LOG_REQUEST_LIST(0, 0xFFFF)` → `LOG_ENTRY` responses enumerate
   logs (id, size, UTC time). A quiet timeout re-requests the still-missing id
   range (up to 4 attempts); `numLogs === 0` is an empty list.
2. **Download** — `LOG_REQUEST_DATA(id, ofs, count)` → `LOG_DATA` (≤ 90-byte
   chunks). Received ranges are tracked with the FTP `subtractInterval`
   bookkeeping; gaps are re-requested on a quiet timeout and 5 consecutive
   futile passes report `download_stalled`. A short chunk below the requested
   end is the authoritative end-of-log marker (`LOG_ENTRY` sizes are
   approximate for the newest, still-open log). The transfer is closed with
   `LOG_REQUEST_END`. Downloads are not resumable across a link drop (mirrors
   the FTP client): a dropped Bluetooth link fails the transfer, retryable.
3. **Erase** — `LOG_ERASE` wipes *all* logs (there is no per-log delete). The
   UI gates it behind an explicit "erase ALL logs" confirmation dialog. The
   command has no ACK, so completion is verified by polling the list until it
   reports zero logs.
4. **`.BIN` parsing** — `src/web/utils/dataflashAnalysis.ts` parses the
   self-describing DataFlash format (FMT message id 128 declares each
   message's fields; `0xA3 0x95 <id>` data frames follow) entirely in a Web
   Worker (`dataflashWorker.ts`), off the main thread like `ulogWorker`. It
   produces the same `UlogAnalysisDataset` as the ULog path, so every chart
   renders unchanged. No external parser dependency is added. Covered
   messages: `ATT` (attitude), `RATE` (rates), `RCOU` (motor outputs), `BAT`
   (battery), `GPS` (satellites/HDop/track/speed + GPS-week UTC origin),
   `POS`/`BARO` (altitude/track), `IMU` (raw accel + vibration FFT), `VIBE`,
   `MODE` (segments via the shared ArduCopter mode table), `EV` (arm/disarm +
   events), `MSG` (firmware/frame identity + events) and `PARM` (parameters).
   Corrupt bytes trigger a one-byte resync and a truncated final frame is
   ignored, so partially downloaded logs still analyze. Non-Copter vehicle
   classes decode but show `Mode <n>` until a mode table is added.

## Protocol references

- ArduPilot: Get and Set FlightMode — https://ardupilot.org/dev/docs/mavlink-get-set-flightmode.html
- ArduPilot: Getting and Setting Parameters — https://ardupilot.org/dev/docs/mavlink-get-set-params.html
- ArduPilot: Requesting Data From The Autopilot — https://ardupilot.org/dev/docs/mavlink-requesting-data.html
- MAVLink common messages (DO_SET_MODE, DO_MOTOR_TEST, LOG_*) — https://mavlink.io/en/messages/common.html
