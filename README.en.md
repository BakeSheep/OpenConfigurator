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

## Privacy and deployment model

OpenConfigurator is a static SPA. Its host serves only HTML, JavaScript, CSS, and bundled assets. The browser connects directly to a flight controller on the same computer through Web Serial. MAVLink bytes, telemetry, parameters, calibration state, logs, and analysis results stay inside the current browser tab and are never uploaded to the deployment server.

- Each tab owns one local serial port and Dedicated Worker. There are no accounts, shared control, or cross-browser sessions.
- The native device picker requires a user click. Reloading only lists prior browser grants; it never opens or occupies a port automatically.
- Log downloads use temporary local OPFS artifacts. They are consumed on save/analysis and removed on disconnect, eviction, or the next startup.
- MAVLink signing secrets live only in connection memory and are cleared on disconnect or reload.
- Production CSP is `connect-src 'none'`. There are no third-party fonts, map tiles, analytics, REST calls, or WebSockets.

Many users can open the same HTTPS deployment and connect their own local controllers. The host sees only normal static-resource GET requests.

## Support

- Desktop Chromium browsers. Web Serial requires an HTTPS secure context or localhost.
- PX4 connection, telemetry, parameters, tuning, calibration, flight operations, ULog, NSH terminal, and ESC paths.
- ArduCopter is the ArduPilot target for safety-critical writes. Other recognized classes keep common display and DataFlash support while unsupported writes remain disabled.
- AM32 settings through ArduPilot raw passthrough, PX4 `SERIAL_CONTROL`, or direct 19200-baud serial. Firmware flashing is not provided.
- Firefox, Safari, mobile browsers, automatic connection, and Electron packages are out of scope.

The stack is identified only from HEARTBEAT. Every sensitive write is re-checked in the local Worker against the live connection, target, vehicle capabilities, armed state, and safety epoch. A `COMMAND_ACK` alone is never treated as proof of physical state.

See [flight-controller compatibility](docs/FLIGHT-CONTROLLER-COMPATIBILITY.md), [ESC compatibility](docs/ESC-COMPATIBILITY.md), and the [HIL checklist](docs/HIL-CHECKLIST.md).

## Development

Node.js `>=22.12.0` and npm are required for development, tests, and builds only. Node is not part of production runtime.

```bash
git clone https://github.com/BakeSheep/OpenConfigurator.git
cd OpenConfigurator
npm install
npm run dev
```

Open <http://localhost:5173>, then use the connect button to invoke the native picker. Development-only synthetic data is available at <http://localhost:5173/?demo=1>.

| Command | Purpose |
|---|---|
| `npm run dev` | Start Vite |
| `npm run typecheck` | TypeScript checks |
| `npm run test:runtime` | Worker, Web Serial, artifact, and protocol tests |
| `npm run test:protocol` | MAVLink, log transfer, calibration, and ESC protocol tests |
| `npm run test:ui` | Playwright UI and accessibility regressions |
| `npm run build` | Produce portable static `dist/` |
| `npm start` | Preview the production build |

## Deployment

```bash
npm run build
docker build -t openconfigurator .
docker run --rm -p 8080:8080 openconfigurator
```

`dist/` works on any static host. Public deployments must add HTTPS at a reverse proxy, CDN, or hosting platform because plain public HTTP is not a Web Serial secure context. The included Nginx image serves static files and security headers only; it has no application API.

## Architecture

```text
HTTPS static host
        │ static GET only
        ▼
React SPA ── Web Serial ── local flight controller
    │
    └─ Dedicated Worker
       ├─ MAVLink codec / signing / target and safety gates
       ├─ parameters / calibration / terminal / flight commands
       ├─ FTP / DataFlash ── temporary OPFS artifacts
       └─ AM32 ESC sessions
```

- `src/shared/`: framework-independent RuntimeCommand/RuntimeEvent types, vehicle profiles, protocol constants, and ESC layouts.
- `src/web/`: React workspaces, main-thread Web Serial transport, root `useLocalRuntime`, and Zustand stores.
- `src/local-runtime/`: Dedicated Worker, MAVLink, log transfer, calibration, terminal, and ESC services.

See [Architecture](docs/ARCHITECTURE.md) for detailed constraints. OpenConfigurator is licensed under the [MIT License](LICENSE) and is not affiliated with PX4, ArduPilot, MAVLink, MicoAir, or QGroundControl.
