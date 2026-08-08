# QGC Flight Mode Synchronization Design

## Goal

Align the selectable PX4 and ArduCopter flight-mode surfaces with QGroundControl while preserving OpenConfigurator's existing target recognition, controller-lease, and read-only safety boundaries.

## Architecture

The shared vehicle profile remains the authority for mode recognition, display, selection, and command encoding. PX4 mode metadata distinguishes modes which can be decoded from modes which QGC allows users to set, and records QGC's fixed-wing and multirotor applicability. ArduCopter keeps its complete custom-mode map and exposes every mode QGC marks settable. Other ArduPilot vehicle classes remain read-only until their command paths are implemented and tested.

Gamepad mode assignments are generated from `availableModes(vehicleIdentity)` instead of a fixed cross-firmware list. Persisted mode actions use a firmware-qualified identifier (`mode:px4:<id>` or `mode:ardupilot:copter:<id>`) so a PX4 assignment can never be interpreted as an ArduCopter mode with the same numeric value. Existing semantic assignments such as `manual`, `position`, and `rtl` remain readable and resolve only against the connected vehicle's current selectable mode list.

## Data flow and safety

1. HEARTBEAT identity selects a vehicle profile.
2. `availableModes` returns only QGC-settable modes applicable to that profile and PX4 vehicle type.
3. The top bar, flight-control page, and joystick page consume the same list.
4. A gamepad press resolves its qualified action against the current identity and current selectable list.
5. The server independently calls `encodeModeCommand`, which repeats the profile and availability check before serializing `MAV_CMD_DO_SET_MODE`.

Known but non-settable PX4 modes remain decodable for telemetry. Unknown, stale, cross-firmware, and vehicle-inapplicable mode IDs are rejected before MAVLink serialization. ArduPlane, ArduRover, ArduSub, tracker, and unknown autopilots remain read-only.

## Testing

Shared-profile tests cover the exact QGC mode lists for PX4 multirotor, fixed wing, VTOL, and ArduCopter; decoding of non-settable modes; correct command parameters; and rejection of inapplicable modes. Gamepad utility tests cover qualified identifiers, legacy resolution, corrupt storage values, and cross-firmware rejection. Completion requires type checking, relevant tests, the full server suite, protocol tests, and a production build.
