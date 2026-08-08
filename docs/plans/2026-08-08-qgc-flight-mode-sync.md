# QGC Flight Mode Synchronization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Synchronize PX4 and ArduCopter selectable flight modes and gamepad mode assignments with QGroundControl without weakening profile safety checks.

**Architecture:** Store QGC mode metadata in the shared vehicle profile and derive every mode selector from `availableModes`. Persist gamepad mode actions with a firmware-qualified identifier, retain legacy semantic action compatibility, and revalidate the selected mode in the server-side encoder.

**Tech Stack:** TypeScript, React 19, Zustand, Node.js test runner through `tsx`

---

### Task 1: Shared QGC mode metadata

**Files:**
- Modify: `src/shared/constants.ts`
- Modify: `src/shared/vehicleProfiles.ts`
- Test: `src/shared/vehicleProfiles.test.ts`

**Steps:**
1. Add failing assertions for the exact QGC PX4 multirotor/fixed-wing/VTOL lists and the complete ArduCopter list.
2. Add failing assertions for new decode and command-encoding cases and for rejection of known but non-settable or vehicle-inapplicable PX4 modes.
3. Add complete PX4 recognition metadata and QGC selection/applicability flags.
4. Make `availableModes` profile- and vehicle-aware and make `encodeModeCommand` validate against it.
5. Run `npx tsx src/shared/vehicleProfiles.test.ts` and expect PASS.

### Task 2: Firmware-qualified gamepad actions

**Files:**
- Create: `src/web/utils/gamepadActions.ts`
- Create: `src/web/utils/gamepadActions.test.ts`
- Modify: `src/web/stores/gamepadStore.ts`

**Steps:**
1. Add failing tests for qualified PX4/ArduCopter action creation and parsing, cross-firmware rejection, legacy resolution, and invalid action rejection.
2. Implement action type guards, profile-qualified mode action IDs, current-profile resolution, and repeat capability checks.
3. Use the type guard while loading persisted settings and prevent mode actions from repeating.
4. Run `npx tsx src/web/utils/gamepadActions.test.ts` and expect PASS.

### Task 3: Dynamic joystick mode UI and execution

**Files:**
- Modify: `src/web/pages/JoystickPage.tsx`
- Modify: `src/web/hooks/useGamepadController.ts`
- Modify: `src/web/i18n/locales/en.ts`
- Modify: `src/web/i18n/locales/zh.ts`

**Steps:**
1. Replace hard-coded semantic mode options with `availableModes(vehicleIdentity)` options using qualified action IDs.
2. Display supported legacy assignments as their resolved dynamic modes and retain an explicit unavailable value for stale assignments.
3. Resolve every mode press against the current profile immediately before sending `set_flight_mode`.
4. Disable repeat for mode and arm-class actions.
5. Run `npm run typecheck` and resolve all errors.

### Task 4: Regression verification

**Files:**
- Verify all modified files.

**Steps:**
1. Run `npx tsx src/shared/vehicleProfiles.test.ts`.
2. Run `npx tsx src/web/utils/gamepadActions.test.ts`.
3. Run `npm run typecheck`.
4. Run `npm run test:server`.
5. Run `npm run test:protocol`.
6. Run `npm run build`.
7. Inspect `git diff --check` and the scoped diff; do not stage or commit without user authorization.
