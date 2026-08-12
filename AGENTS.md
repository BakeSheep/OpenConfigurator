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

## Frontend design system

The interface is a compact operational workspace, not a collection of independent landing pages. New screens must preserve a predictable reading order, expose the current state before actions, and remove explanatory copy that does not change a decision.

### Layout contract

- Keep the four top-level workspaces in the app shell. Use `WorkspaceFrame` for the single page `h1`, then `SectionNav` and `SectionFrame` for settings/diagnostics subsections. An active section has one `h2`; embedded pages must not render another workspace header or `h1`.
- Inside a section, order content as: section heading/status, task navigation, blockers or safety notice, primary content, secondary details. Put the primary action beside the heading or at the end of the form; do not scatter equivalent actions across cards.
- Use the standard workspace width and spacing tokens. Dense data views may opt into a documented wide/full variant; ordinary forms and status cards must not invent their own max-width, centering, or page padding.
- At constrained widths, subsection navigation becomes a horizontal, scroll-into-view row above the content. Never keep a navigation column if it pushes the active content outside the viewport.
- Dashboard and flight-operation shells remain visible while disconnected so operators can learn the layout and inspect placeholders. Disable commands and show their nearby reason; do not replace the whole workspace with a connection waiting panel.

### Components and styling

- Use semantic tokens from `src/web/styles/tokens.css` and shared `.mc-*` primitives. Never hardcode theme colors, shadows, radii, z-index values, or arbitrary type sizes in page components.
- Prefer the typed React primitives: `Button`/`IconButton`, `Card` anatomy, `Field`, `Notice`/`Badge`, `Dialog`/`ConfirmDialog`, `PageTabs`, `Toolbar`, and `StatePanel`. Extend a primitive when a reusable state is missing instead of creating a one-page imitation.
- Do not combine legacy `.mc-btn`, `.mc-input`, or `.mc-select` sizing with Tailwind size/padding overrides. Select a supported component size or density variant so the cascade has one owner.
- Follow the spacing scale (4, 8, 12, 16, 24, 32px) and the shared type scale. Keep card padding, heading size, control height, and section gaps consistent across sibling pages.
- Reserve filled accent color for the current selection or primary action. Use neutral surfaces for structure and semantic foreground/tint/solid/on-color token pairs for status; never place white text on a foreground token intended for text.

### Content and visual hierarchy

- Persistent copy should be limited to the task name, current state, action consequence or safety condition, and one recovery action. Delete feature-list introductions and descriptions that repeat the navigation label.
- A section description is at most one concise line and appears only when it changes the operator's decision. Put protocol background and advanced explanation in contextual help or `details`.
- Field help contains only units, valid range, write timing, and restart requirements. Empty/error/disabled copy follows “what happened → why → next step” and offers one primary recovery action.
- Safety text is never removed, but it appears once immediately beside the dangerous action. Confirmation body names the target and consequence; the checkbox or gesture states the operator's explicit commitment without repeating the paragraph.
- Localize editorial labels, states, errors, and actions in both Chinese and English. MAVLink names, parameter identifiers, units, and other protocol terms may remain English.

### Responsive and accessibility baseline

- Verify 360, 768, 1024, and 1440px viewports in Chinese/English and light/dark themes. There must be no root horizontal overflow; intentional data scrolling must be bounded, visibly signposted, named as a region, and keyboard focusable.
- Clamp popovers to the viewport. Dialogs use a scrollable body, visible footer, `100dvh`-safe maximum height, initial focus, Tab trapping, Escape close, and focus return.
- Every page has exactly one `h1`; the active subsection has an `h2`. Forms have programmatic labels and error descriptions. Tabs implement roving focus, Arrow/Home/End keys, `aria-controls`, and a labelled tabpanel.
- Preserve visible `:focus-visible` treatment. Normal text and button labels meet 4.5:1 contrast, non-text controls meet 3:1, and `prefers-reduced-motion` disables non-essential loops and movement.
- Use `StatePanel` consistently for loading, read-only, unsupported, empty, and error states, but not as a blanket replacement for useful offline UI. Route/workspace errors must provide a recovery path.

### State and safety implementation

- Put WebSocket-driven persistent data in Zustand stores, not component-local mirrors. Clear or rebind target-specific drafts and confirmations when the server authority, safety epoch, selected target, readiness, or controller ownership changes.
- Keep RAF/interval callbacks stable and read changing values through refs. Derived telemetry must honor stale timestamps; offline placeholders must never present cached values as live.
- A visible enabled control is not authorization. Every mutation re-reads live connection, target, capability, controller, and authority state immediately before sending; the server remains authoritative.
- Preserve arming confirmation, props-removed gates, uninterrupted ESC power confirmation, manual RC override enablement, and target-bound destructive confirmations. Emergency disarm/stop paths must remain immediate.

### Frontend verification

- Before completion, run `npm run typecheck`, relevant unit/protocol tests, and the Playwright UI suite for layout-sensitive changes. Add focused coverage for new query navigation, keyboard interaction, disconnected rendering, responsive overflow, and serious/critical axe findings.
- Treat screenshots as evidence, not the sole acceptance test. Check geometry at the supported breakpoints and at browser zoom/DPR combinations that reduce effective content width.

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
