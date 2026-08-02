# OpenConfigurator

<p align="center">
  <img src="public/favicon.svg" width="88" alt="OpenConfigurator logo" />
</p>

<p align="center">
  A local-first desktop and web ground control station for PX4 and ArduPilot.
</p>

<p align="center">
  <a href="https://bakesheep.github.io/OpenConfigurator/"><b>Live demo</b></a> ·
  <a href="https://github.com/BakeSheep/OpenConfigurator/releases/latest"><b>Latest Release</b></a> ·
  <a href="README.md">中文说明</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="THIRD_PARTY_NOTICES.md">Third-party notices</a>
</p>

OpenConfigurator combines a React SPA, a local Node.js service, and an optional Electron desktop shell. The browser or desktop client uses REST plus one WebSocket; the service owns USB serial/Bluetooth SPP, MAVLink v1/v2, log transfer, and ESC sessions.

> [!TIP]
> The [live demo](https://bakesheep.github.io/OpenConfigurator/) is a static, read-only preview: every value is synthetic, there is no backend, no device can be connected, and no write operation is performed. Download the desktop build from the [latest Release](https://github.com/BakeSheep/OpenConfigurator/releases/latest).

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="Flight overview workspace with demo data" width="860" />
</p>

> [!WARNING]
> OpenConfigurator is pre-release software, not a certified aviation safety system. Remove all propellers before connecting to motor or ESC controls, and validate changes on real hardware in a controlled environment.

## Current capabilities

- USB serial and Windows Bluetooth SPP discovery, reconnect, diagnostics, and target selection
- MAVLink v1/v2 negotiation, optional MAVLink 2 signing, telemetry, parameter sync, and single-controller leasing
- PX4 and ArduPilot identification from HEARTBEAT with profile-specific modes, parameters, capabilities, and safety gates
- Frame and actuator views, sensor calibration, PID/EKF/serial configuration, RC monitoring, gamepad input, and guarded flight commands
- PX4 ULog browsing and analysis; ArduPilot DataFlash listing, download, erase-all, and `.bin` analysis
- AM32 ESC settings over ArduPilot passthrough, PX4 `SERIAL_CONTROL`, or direct 19200-baud serial, including multi-ESC reads, batch writes, and full read-back verification
- Windows x64 Electron desktop prerelease using the same frontend and local service

PX4 is supported across the existing configuration surfaces. ArduCopter 4.7 is the current ArduPilot acceptance target. ArduPlane, Rover, Sub, and Tracker remain read-only for safety-critical operations. ArduPilot compass calibration, frame writes, and mission/fence/rally editing are not implemented.

The ESC page is settings-only: it does not flash firmware or edit startup tones. Its software path recognizes AM32 signatures `0x1F06`, `0x3506`, and `0x1506` with layout revisions 1–3. Check the [hardware validation matrix](docs/ESC-COMPATIBILITY.md) before use; code support is not a hardware-safety guarantee.

## Workspaces

| Workspace | Contents |
|---|---|
| Overview | Attitude, flight state, key telemetry, and system health |
| Flight control | Preflight checks, mode switching, and guarded flight commands |
| Vehicle setup | Frame, sensors, actuators, ESC, receiver, gamepad, and ports |
| Tuning & diagnostics | Parameters, PID, EKF, waveforms, MAVLink messages, and flight logs |

The following images are synthetic demo-mode captures:

| Flight control | Tuning & diagnostics |
|---|---|
| ![Flight control](docs/screenshots/flight.png) | ![Parameter management](docs/screenshots/diagnostics.png) |

| Live waveforms | Vehicle setup |
|---|---|
| ![Live waveforms](docs/screenshots/waveforms.png) | ![Vehicle setup](docs/screenshots/settings.png) |

## Quick start

Development and build requirements: Node.js `>=22.12.0`, npm, and Chrome or Edge 89+ for the Web Serial picker. The picker is available only on HTTPS or localhost.

```bash
git clone https://github.com/BakeSheep/OpenConfigurator.git
cd OpenConfigurator
npm ci
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` and `/ws` to the local server on port `3000`.

For a local production build:

```bash
npm run build
npm start
```

Open <http://localhost:3000>. To view synthetic demo data only, run `npm run dev:web` and open <http://localhost:5173/?demo=1>.

### Windows desktop prerelease

The Electron package bundles the runtime, so end users do not need Node.js or npm. Version `1.0.0-beta.1` currently produces a Windows x64 portable EXE:

```bash
npm run dist:win
```

Artifacts are written to `release/` with a `-portable.exe` suffix. Use `npm run dist:win:dir` for an unpacked build, `npm run test:desktop` to smoke-test it, and `npm run desktop` to launch a development desktop instance. The desktop shell starts the service on a random `127.0.0.1` port and ignores remote-deployment environment variables.

| Command | Purpose |
|---|---|
| `npm run dev` | Start frontend and backend development servers |
| `npm run dev:web` | Start only the Vite frontend |
| `npm run dev:server` | Start only the Node.js backend |
| `npm run typecheck` | Run strict TypeScript checks |
| `npm run test:server` | Run hardware-free regression tests |
| `npm run test:protocol` | Run MAVLink and ESC protocol tests |
| `npm run test:desktop` | Smoke-test the unpacked desktop build |
| `npm run build` | Type-check and build the frontend |
| `npm run build:desktop` | Build the frontend and Electron main process |
| `npm run desktop` | Build and launch a desktop development instance |
| `npm run dist:win` | Build a Windows x64 portable EXE |
| `npm start` | Serve the production application |

## Architecture

```text
Browser / Electron + React SPA
          │ REST + WebSocket
          ▼
Express / ws ── validation / controller lease
          │
          ├─ MAVLink bridge ── PX4 / ArduPilot
          └─ ESC service ───── passthrough / SERIAL_CONTROL / direct serial
```

- `src/shared/` is the framework-free frontend/backend boundary for protocol types, vehicle profiles, and ESC layouts.
- `src/web/` contains the four workspaces, components, WebSocket dispatch, and Zustand stores.
- `src/server/` owns HTTP/WS, connection lifecycle, MAVLink, log transfer, and ESC sessions.
- `src/server/mavlink/codec.ts` is the only MAVLink framing, CRC, and signing entry point.
- `electron/main.ts` starts the packaged local service and loads the bundled frontend.

## Safety and limitations

- Remove all propellers before motor tests or ESC reads/writes.
- Arming keeps its explicit confirmation; gamepad RC override must be enabled manually.
- `transportOpen` means only that a serial transport is open; `vehicleReady` requires a valid heartbeat from the selected target.
- ESC sessions pin the controller lease; do not disconnect the flight controller or ESC power during writes.
- Remote mode requires HTTPS/WSS, a strong random token, an exact Origin allowlist, and network isolation.
- Unlisted or unvalidated combinations are not compatibility, airworthiness, or flight-safety guarantees.

## Documentation and license

- [Architecture](docs/ARCHITECTURE.md)
- [ESC compatibility](docs/ESC-COMPATIBILITY.md)
- [ESC protocol sources](docs/ESC-PROTOCOL-SOURCES.md)
- [Contributing](CONTRIBUTING.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

OpenConfigurator is licensed under the [MIT License](LICENSE). The project is not affiliated with PX4, ArduPilot, MAVLink, MicoAir, or QGroundControl.
