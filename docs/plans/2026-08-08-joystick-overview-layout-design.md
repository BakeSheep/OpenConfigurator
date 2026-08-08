# Joystick overview layout

## Goal

Simplify the joystick overview by removing the redundant connection-status panel and grouping the controls users tune together.

## Layout

- Keep the gamepad visualizer in the left column.
- Use one vertical stack in the right column.
- Put the enable-control card at the top of the right column.
- Show four physical stick axes in the mapping card. Each coordinate and its function selector share one compact row.
- Put deadzone and expo controls in a second card directly below it.
- Move advanced settings out of its tab and into a full-width card below the overview card.
- Collapse to a single column on narrow screens without changing state ownership.

## Mapping behavior

The UI treats Gamepad API axes 0-3 as left X, left Y, right X, and right Y. The selector assigns throttle, yaw, pitch, or roll to that physical axis. Assigning a function already used by another axis swaps the two functions, preserving a one-to-one mapping.

## Connection preset behavior

Connection presets gain an internal optional `enableGamepad` flag; the connection dialog does not expose a separate option. A preset connection records its preset ID as the active preset. When the user changes “Enable Gamepad Control” on the joystick page, that preference is written back to the active preset. Selecting the preset later restores the saved intent before any gamepad is detected. `MANUAL_CONTROL` remains gated by an attached gamepad, a ready vehicle, a writable vehicle profile, and the controller lease. Temporary gamepad loss or link reconnection preserves the intent; a final disconnect or send failure disables the current session without erasing the saved preference.

## Verification

Cover axis swapping, legacy preset behavior, and enable-intent lifecycle with unit tests. Then run TypeScript, a production build, and browser checks for layout, controls, and console errors.
