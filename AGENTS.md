# AGENTS.md — MicoConfigurator (px4-web-gcs)

Web-based PX4 ground control station. Browser SPA talks to a local Node.js backend over WebSocket + REST; the backend talks to the flight controller over MAVLink v2 on a serial/Bluetooth COM port. Read `HANDOVER.md` for the full feature inventory before touching sensitive areas (MAVLink, connection, flight control).

## Stack

- Frontend: React 19 + TypeScript + Vite 8 + Tailwind CSS 4 (dark-first, MicoAir-style design system in `src/web/index.css`)
- 3D: three.js + @react-three/fiber · Charts: recharts · State: zustand · Routing: react-router (HashRouter)
- Backend: Node.js + Express 5 + ws · Serial: serialport · MAVLink: hand-rolled v1/v2 parser in `src/server/mavlink/`

## Layout

```
src/
  shared/         # Types + constants shared by frontend AND backend (MAVLink msgs, WS protocol, command IDs, PX4 modes)
  server/         # Node.js backend (NOT bundled by Vite - runs via tsx)
    index.ts                    # Express + WS server on :3000, serves dist/ in prod, SPA fallback
    connection/                 # ConnectionManager, SerialConnection, BluetoothConnection
    mavlink/                    # MavlinkParser (v1/v2 framing + CRC), MavlinkBridge (msg handlers + WS bridge)
  web/            # React SPA (bundled by Vite)
    main.tsx, App.tsx           # Entry + routes (8 pages under pages/)
    hooks/useWebSocket.ts       # Single WS connection + message dispatch to stores
    stores/                     # zustand: connection, telemetry, sensor, parameter, gamepad, theme
    components/                 # layout (Topbar/TelemetryBar/StatusBar/Sidebar), telemetry, ekf, ConnectDialog
    types/web-serial.d.ts       # Web Serial type shims (USB + BT SPP)
    vite-env.d.ts               # vite/client types - do NOT delete, fixes import.meta.env + css imports
```

## Commands

```bash
npm run dev          # concurrently: vite (5173) + tsx watch server (3000)
npm run dev:web      # frontend only
npm run dev:server   # backend only
npm run build        # vite build -> dist/ (server is NOT compiled, runs via tsx)
npm start            # production: tsx src/server/index.ts (serves dist/ on :3000)
npm run test:protocol# protocol unit test: tsx src/server/mavlink/MavlinkBridge.test.ts
npx tsc --noEmit     # typecheck (strict) - run before claiming a change is done
```

Dev proxy: Vite proxies `/api` and `/ws` to `http://localhost:3000` (see `vite.config.ts`).

## Architecture rules

- **`src/shared/` is the only shared surface.** Anything used by both frontend and backend must live here and stay framework-agnostic (no React, no Node-only imports). Frontend imports backend-safe types via `../../shared/types`; backend does the same.
- **Server code never imports from `src/web/`** and vice versa; both go through `src/shared/`.
- **Single WebSocket.** `useWebSocket` is mounted once in `App.tsx`, owns the connection, and dispatches `ServerMessage`s into zustand stores. Pages/components read from stores, never open their own sockets.
- **Message protocol** is the `ServerMessage` / `ClientMessage` union in `src/shared/types.ts`. Adding a message type means updating that union AND the dispatch in `useWebSocket.handleMessage` AND the emit in `MavlinkBridge`.
- **MAVLink framing** is hand-rolled (no lib). `MavlinkParser` handles v1/v2 + CRC; `CRC_EXTRA` table must match the message IDs handled in `MavlinkBridge.handleMessage`. When adding a message handler, verify the msg ID, CRC extra, and payload field offsets against the MAVLink common.xml spec — several offsets here are subtle (e.g. RC_CHANNELS channels start at payload offset 5, after time_boot_ms(4)+chancount(1)).

## Conventions

- **Styling**: use CSS variables from `src/web/index.css` (`var(--accent)`, `var(--bg-secondary)`, …), not hardcoded colors, so light/dark theme works. Component primitives: `.mc-card`, `.mc-btn` (+ `-primary`/`-ghost`/`-danger`/`-success`), `.mc-input`, `.mc-select`, `.mc-section-title`, `.mc-mono`. Theme is toggled via `data-theme="light"` on `<html>` (see `themeStore`).
- **State**: zustand stores expose actions; call them directly (`useFooStore.getState().setX(...)`) or via hooks. Don't duplicate WS-driven data in component state — put it in a store.
- **RAF/interval loops in React**: keep the loop callback stable (mount once) and read latest values via refs, otherwise every store update re-creates the callback and tears down/restarts the loop each frame (see `JoystickPage` for the corrected pattern).
- **Logging**: server uses `console.log/error` with `[Server]`/`[WS]`/`[API]` prefixes. Frontend uses `console.log/error` with `[WS]`/`[Connect]`/`[FC]` prefixes.
- **TypeScript**: `strict: true`, `noUnusedLocals: false`. Keep it that way — `tsc --noEmit` must pass.

## Gotchas

- **Express 5** uses `/{*splat}` for catch-all routes, not `*`. The SPA fallback in `src/server/index.ts` relies on this.
- **Bluetooth SPP on Windows**: each paired device creates two COM ports (incoming `_LOCALMFG&0000` — not openable, and outgoing `_VID&.._PID&..` — the usable one). `BluetoothConnection.findPortByIds` parses VID/PID from the pnpId and prefers the outgoing port. Don't "simplify" this matching.
- **Web Serial** requires Chrome/Edge 89+ over HTTPS or localhost. `navigator.serial.requestPort()` is used for both USB and BT SPP device selection.
- **Safety-critical UI**: arming requires double-click confirmation (3s timeout, see `FlightControlPage`); motor test requires an explicit "props removed" checkbox (`MotorPage`); joystick RC override must be manually enabled. Preserve these guards.
- **`MAV_CMD_DO_MOTOR_TEST` instance is 1-based** (motor 1..N), not 0-based.
- **MAVLink msg #245 = EXTENDED_SYS_STATE**, #241 = AUTOPILOT_VERSION. Several comments in the codebase previously confused these.
- `HANDOVER.md` documents intended architecture and UI design tokens — consult it for design decisions, but trust the code over the doc where they differ.
