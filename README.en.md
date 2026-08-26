# OpenConfigurator

<p align="center">
  <img src="public/favicon.svg" width="88" alt="OpenConfigurator logo" />
</p>

<p align="center">
  A browser-only, local-data flight-controller configurator and GCS for PX4 and ArduPilot.
</p>

<p align="center">
  <a href="https://bakesheep.github.io/OpenConfigurator/"><b>Use online</b></a> ·
  <a href="README.md">中文说明</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a>
</p>

> [!WARNING]
> OpenConfigurator is pre-release software, not a certified aviation safety system. Remove every propeller before using motor or ESC controls, and validate changes on real hardware in a controlled environment.

<p align="center">
  <img src="docs/screenshots/dashboard.en.jpg" alt="OpenConfigurator dashboard demo" />
</p>

## Features

- **Overview** (dashboard): real-time telemetry, connection status, and flight commands.
- **Flight** (flight operations): arm/disarm, flight commands, and mission control.
- **Airframe & calibration** (airframe / sensors / calibration / power / safety / ports): airframe selection, sensor setup, calibration wizards, power and safety configuration, port mapping.
- **Propulsion** (motor mapping / motor test / ESC): motor mapping, motor testing, and AM32 ESC parameters.
- **Control input** (receiver / joystick): channel monitoring, mapping, and configuration.
- **Tuning** (parameters / PID / EKF): parameter browsing/comparison, PID, and EKF status.
- **Flight data** (messages / status / terminal / waveforms): MAVLink messages, system status, NSH terminal, and live waveforms.
- **Flight logs** (logs / analysis): ULog / DataFlash download and local offline analysis.

## Privacy and deployment model

OpenConfigurator is a static SPA. Its host serves only HTML, JavaScript, CSS, and bundled assets. The browser connects directly to a flight controller on the same computer through Web Serial. MAVLink bytes, telemetry, parameters, calibration state, logs, and analysis results stay inside the current browser tab and are never uploaded to the deployment server.

- Each tab owns one local serial port and Dedicated Worker. There are no accounts, shared control, or cross-browser sessions.
- The native device picker requires a user click. Reloading only lists prior browser grants; it never opens or occupies a port automatically.
- Log downloads use temporary local OPFS artifacts. They are consumed on save/analysis and removed on disconnect, eviction, or the next startup.
- MAVLink signing secrets live only in connection memory and are cleared on disconnect or reload.
- Production CSP is `connect-src 'none'`. There are no third-party fonts, map tiles, analytics, REST calls, or WebSockets.

Many users can open the same HTTPS deployment and connect their own local controllers. The host sees only normal static-resource GET requests.

## Support

| Target | Support |
|---|---|
| Browsers | Desktop Chromium; Web Serial requires an HTTPS secure context or localhost |
| PX4 | Connection, telemetry, parameters, tuning, calibration, flight operations, ULog, NSH terminal, and ESC paths |
| ArduPilot | ArduCopter is the target for safety-critical writes; other recognized classes keep common display and DataFlash logs while unsupported writes remain disabled |
| AM32 ESC | Parameters via ArduPilot raw passthrough, PX4 `SERIAL_CONTROL`, or direct 19200-baud serial; no firmware flashing |
| Out of scope | Firefox, Safari, mobile browsers, automatic connection, and Electron packages |

The stack is identified only from HEARTBEAT. Every sensitive write is re-checked in the local Worker against the live connection, target, vehicle capabilities, armed state, and safety epoch. A `COMMAND_ACK` alone is never treated as proof of physical state.

See [flight-controller compatibility](docs/FLIGHT-CONTROLLER-COMPATIBILITY.md), [ESC compatibility](docs/ESC-COMPATIBILITY.md), and the [HIL checklist](docs/HIL-CHECKLIST.md).

## Development

Environment requirements, setup, common commands, architecture, and deployment instructions live in [CONTRIBUTING.md](CONTRIBUTING.md). See [Architecture](docs/ARCHITECTURE.md) for detailed constraints.

OpenConfigurator is licensed under the [MIT License](LICENSE) and is not affiliated with PX4, ArduPilot, MAVLink, MicoAir, or QGroundControl.
