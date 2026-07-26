# OpenConfigurator

OpenConfigurator is a local-first, browser-based ground control station for PX4. A React SPA communicates with a local Node.js service over REST and one WebSocket; the service communicates with the flight controller over MAVLink v1/v2 using USB serial or Bluetooth SPP.

[中文说明](README.md) · [Architecture](docs/ARCHITECTURE.md) · [Deployment](docs/DEPLOYMENT.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

> [!WARNING]
> OpenConfigurator is pre-release software and is not a certified aviation safety system. Remove all propellers before bench testing, validate changes with real hardware in a controlled environment, and retain a manual takeover path.

## Features

- USB serial and Bluetooth SPP discovery, connection, recovery, and diagnostics
- MAVLink v1/v2 negotiation with optional MAVLink 2 signing
- Live attitude, GPS, battery, IMU, pressure, optical-flow, rangefinder, and EKF telemetry
- PX4 parameter synchronization, editing, confirmation, search, grouping, and export
- Sensor monitoring and basic calibration commands, EKF setup, and PID tuning
- Actuator mapping, guarded motor testing, RC monitoring, and gamepad input
- Guarded arm/disarm/takeoff/land/RTL commands and flight-mode switching
- Runtime validation, a single-controller lease, and read-only observers

See the [roadmap](docs/ROADMAP.md) for work that is not implemented yet.

## Quick start

Requirements: Node.js `^20.19.0` or `>=22.12.0`, npm, and a supported PX4 serial or paired Bluetooth SPP connection. Chrome or Edge 89+ is recommended for the Web Serial device picker.

```bash
git clone https://github.com/BakeSheep/OpenConfigurator.git
cd OpenConfigurator
npm install
npm run dev
```

Open <http://localhost:5173>. For a local production build:

```bash
npm ci
npm run build
npm start
```

Then open <http://localhost:3000>.

| Command | Purpose |
|---|---|
| `npm run dev` | Start the frontend and backend development servers |
| `npm run typecheck` | Run strict TypeScript checks |
| `npm run test:server` | Run all hardware-free backend regression tests |
| `npm run test:protocol` | Run the MAVLink protocol test suite |
| `npm run build` | Type-check and build the frontend |
| `npm start` | Serve the production application |

## Safety and deployment

The server binds to `127.0.0.1` by default. Remote mode requires an explicit opt-in, a token of at least 32 bytes, an exact Origin allowlist, and an HTTPS/WSS reverse proxy. See [deployment documentation](docs/DEPLOYMENT.md) and [.env.example](.env.example).

Do not bypass the propeller-removal motor-test confirmation, arm/disarm confirmation, or manual gamepad enable switch. Passing automated tests is not equivalent to hardware-in-the-loop or flight validation.

## Contributing and license

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change. Report vulnerabilities according to [SECURITY.md](SECURITY.md), not in a public issue.

No open-source license has been selected yet. Until a license file is added, all rights are reserved and this repository is not ready for a final public release. See the [open-source release checklist](docs/OPEN_SOURCE_CHECKLIST.md).
