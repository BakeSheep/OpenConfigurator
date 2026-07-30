# AGENTS.md — OpenConfigurator

Local-first Web GCS for PX4 and ArduPilot. The React SPA uses REST plus one WebSocket to a Node.js backend; the backend owns serial/Bluetooth connections, MAVLink, log transfer, and ESC sessions. Treat the current code and README as the feature inventory.

## Stack and layout

- React 19, TypeScript, Vite 8, Tailwind CSS 4, Zustand, react-router, three.js, Recharts/uPlot
- Node.js, Express 5, `ws`, `serialport`, `node-mavlink`
- `src/shared/`: the only frontend/backend shared surface; framework-agnostic types, protocol unions, vehicle profiles, ESC layouts
- `src/web/`: four routed workspaces, components, stores, `useWebSocket`
- `src/server/`: HTTP/WS boundary, validation, connection manager, MAVLink bridge/log transfer, ESC service/transports

## Commands

```bash
npm run dev
npm run typecheck
npm run test:server
npm run test:protocol
npm run build
npm start
```

Vite serves `:5173` and proxies `/api` and `/ws` to `:3000`. Production runs `tsx src/server/index.ts` and serves `dist/`.

## Architecture rules

- Never import `src/web/` from the server or `src/server/` from the frontend. Put shared, framework-free code in `src/shared/`.
- `useWebSocket` is mounted once in `App.tsx`. Pages use stores and the shared send function; they never create sockets.
- A new wire message normally requires the union in `src/shared/types.ts`, runtime validation, server handler/emit, `useWebSocket` dispatch, and tests.
- MAVLink framing, CRC, dialect lookup, signing, parser state, sequence numbers, and serialization go only through `src/server/mavlink/codec.ts`.
- `transportOpen` is not `vehicleReady`. Safety-critical writes additionally require a recognized target, supported vehicle capability, and controller lease.
- PX4/ArduPilot behavior comes from `src/shared/vehicleProfiles.ts`; never infer a stack from parameter names or send cross-stack parameters.
- Unknown stacks and unimplemented ArduPilot vehicle classes stay read-only. Current ArduPilot write support targets ArduCopter.

## ESC rules

- ESC configuration is settings-only: do not add firmware erase/flash or startup-tone claims without an explicit product decision and safety design.
- ESC sessions are owned by `EscService`/`EscSessionManager`; they pin the controller lease and isolate incompatible MAVLink mutations.
- Supported paths are ArduPilot raw passthrough, PX4 `SERIAL_CONTROL`, and direct 19200-baud serial. Do not reuse raw transports outside the session manager.
- Parameter writes require a recognized AM32 MCU and layout, preserve unknown EEPROM bytes, and verify the complete written block by reading it back.
- Update `docs/ESC-COMPATIBILITY.md` for hardware evidence and `docs/ESC-PROTOCOL-SOURCES.md` for new protocol facts.

## UI and state

- Use variables and `.mc-*` primitives from `src/web/index.css`; do not hardcode theme colors.
- Put WS-driven persistent data in Zustand stores, not component-local mirrors.
- Keep RAF/interval callbacks stable and read changing values through refs.
- Preserve the four top-level workspaces and query-string subnavigation unless a requested redesign says otherwise.

## Safety invariants

- Arming requires confirmation; motor tests require the props-removed checkbox; ESC operations require props removed and uninterrupted power; RC override requires manual enablement.
- `MAV_CMD_DO_MOTOR_TEST` uses a 1-based motor instance.
- Do not offer ArduPilot compass calibration through the PX4 calibration path.
- DataFlash erase removes all ArduPilot logs and must retain its explicit erase-all confirmation.
- Never treat `COMMAND_ACK` alone as proof of physical state; observe the relevant telemetry/state transition.

## Gotchas

- Express 5 catch-all syntax is `/{*splat}`.
- Windows Bluetooth SPP exposes incoming and outgoing COM ports; prefer the outgoing `_VID&.._PID&..` port and keep the current `pnpId` matching.
- Web Serial requires Chrome/Edge 89+ and HTTPS or localhost.
- MAVLink message 245 is `EXTENDED_SYS_STATE`; 148 is `AUTOPILOT_VERSION` from the `standard` dialect.
- Before completion, run `npm run typecheck` and relevant tests. Hardware-free tests do not constitute HIL validation.
