import { useEffect, useRef } from 'react'
import { availableModes } from '../../shared/vehicleProfiles'
import type { ClientMessage } from '../../shared/types'
import { useConnectionStore } from '../stores/connectionStore'
import {
  NON_REPEATABLE_ACTIONS,
  useGamepadStore,
  type GamepadActionId,
  type GamepadMapping,
} from '../stores/gamepadStore'
import { useTelemetryStore } from '../stores/telemetryStore'

// Gamepad actions map to semantic mode names per autopilot family; the id of
// the resolved profile mode option is sent through set_flight_mode and the
// server performs the stack-specific command encoding.
const actionModeNames: Partial<Record<GamepadActionId, { px4: string; ardupilot: string }>> = {
  manual: { px4: 'Manual', ardupilot: 'Stabilize' },
  altitude: { px4: 'Altitude', ardupilot: 'AltHold' },
  position: { px4: 'Position', ardupilot: 'PosHold' },
  mission: { px4: 'Mission', ardupilot: 'Auto' },
  hold: { px4: 'Hold', ardupilot: 'Loiter' },
  rtl: { px4: 'RTL', ardupilot: 'RTL' },
  land: { px4: 'Land', ardupilot: 'Land' },
  stabilized: { px4: 'Stabilized', ardupilot: 'Stabilize' },
  acro: { px4: 'Acro', ardupilot: 'Acro' },
}

/**
 * Owns the browser Gamepad polling loop for the lifetime of the application.
 * Keeping this at App level prevents manual-control input from stopping when
 * the user leaves the gamepad settings tab to arm or monitor the vehicle.
 */
export function useGamepadController(send: (message: ClientMessage) => void) {
  const rafRef = useRef(0)
  const lastAxisSendRef = useRef(0)
  const lastButtonFireRef = useRef<Record<number, number>>({})
  const previousButtonsRef = useRef<boolean[]>([])
  const smoothedThrottleRef = useRef(0)
  const sendRef = useRef(send)
  sendRef.current = send

  useEffect(() => useConnectionStore.subscribe((state) => {
    if ((!state.vehicleReady || !state.canControl) && useGamepadStore.getState().enabled) {
      useGamepadStore.getState().setEnabled(false)
    }
  }), [])

  useEffect(() => {
    const fireAction = (action: GamepadActionId, button: number) => {
      if (action === 'none') return
      const gamepadActions = useGamepadStore.getState()
      const armed = useTelemetryStore.getState().status?.armed ?? false
      const armCommand = (arm: boolean) => sendRef.current({
        type: 'command',
        cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
        params: [arm ? 1 : 0, 0, 0, 0, 0, 0, 0],
        safetyConfirmation: arm ? 'arm' : 'disarm',
      })

      if (action === 'arm' || (action === 'toggle_arm' && !armed)) {
        // Physical controller arming mirrors an RC transmitter's arm switch:
        // a single deliberate press fires immediately, no double-press
        // confirmation. Button presses only reach here when the user has
        // manually enabled gamepad control on a ready, controllable vehicle.
        armCommand(true)
        gamepadActions.setActionNotice(`B${button}：已发送解锁指令`)
        return
      }
      if (action === 'disarm' || action === 'toggle_arm') {
        armCommand(false)
        gamepadActions.setActionNotice(`B${button}：已发送上锁指令`)
        return
      }
      const modeNames = actionModeNames[action]
      if (modeNames) {
        const identity = useTelemetryStore.getState().vehicleIdentity
        const targetName = identity?.family === 'px4'
          ? modeNames.px4
          : identity?.family === 'ardupilot' ? modeNames.ardupilot : null
        const option = targetName
          ? availableModes(identity).find((candidate) => candidate.name === targetName)
          : undefined
        if (!option) {
          gamepadActions.setActionNotice(`B${button}：当前飞控不支持该模式切换`)
          return
        }
        sendRef.current({
          type: 'set_flight_mode',
          data: { modeId: option.id },
        })
        gamepadActions.setActionNotice(`B${button}：切换至 ${option.name}`)
      }
    }

    const pollGamepad = () => {
      const current = useGamepadStore.getState()
      const connection = useConnectionStore.getState()
      const controllerConnected = connection.vehicleReady && connection.canControl
      const gamepads = navigator.getGamepads()
      const gamepad = gamepads[0] || gamepads[1] || gamepads[2] || gamepads[3]

      if (gamepad) {
        if (!current.connected) current.setConnected(true, gamepad.id)
        const rawButtons = gamepad.buttons.map((button) => button.pressed)
        current.setAxes(Array.from(gamepad.axes))
        current.setButtons(rawButtons)

        if (current.enabled && controllerConnected) {
          const now = Date.now()
          const buttonDelay = 1000 / Math.max(1, current.advanced.buttonFrequencyHz)
          rawButtons.forEach((pressed, index) => {
            const assignment = current.buttonAssignments[index]
            const downTransition = pressed && !previousButtonsRef.current[index]
            // Arm-class actions fire on the press edge only, regardless of any
            // (legacy/corrupted) repeat flag: holding a button must never
            // re-send arm/disarm at the button frequency.
            const repeatDue = pressed
              && assignment?.repeat
              && !NON_REPEATABLE_ACTIONS.has(assignment.action)
              && now - (lastButtonFireRef.current[index] ?? 0) >= buttonDelay
            if (assignment && (downTransition || repeatDue)) {
              lastButtonFireRef.current[index] = now
              fireAction(assignment.action, index)
            }
          })

          const axisDelay = 1000 / Math.max(1, current.advanced.axisFrequencyHz)
          if (now - lastAxisSendRef.current >= axisDelay) {
            const deltaSeconds = Math.min((now - lastAxisSendRef.current) / 1000, 0.1)
            lastAxisSendRef.current = now
            const shape = (value: number) => {
              let result = value
              if (current.advanced.useDeadband) {
                if (Math.abs(result) < current.deadzone) return 0
                result = Math.sign(result) * (Math.abs(result) - current.deadzone) / (1 - current.deadzone)
              }
              result = result * (1 - current.expo) + result ** 3 * current.expo
              if (current.advanced.circleCorrection) {
                const limited = Math.max(-Math.PI / 4, Math.min(Math.PI / 4, result))
                result = Math.tan(Math.asin(limited))
              }
              return Math.max(-1, Math.min(1, result))
            }
            const axis = (key: keyof Pick<GamepadMapping, 'roll' | 'pitch' | 'yaw' | 'throttle'>) =>
              shape(gamepad.axes[current.mapping[key]] ?? 0)
            const toManualAxis = (value: number) => Math.round(Math.max(-1, Math.min(1, value)) * 1000)
            let throttle = -axis('throttle')
            if (current.advanced.throttleModeCenterZero) throttle = Math.max(0, throttle) * 2 - 1
            if (current.advanced.throttleSmoothing) {
              const maxStep = deltaSeconds
              const difference = throttle - smoothedThrottleRef.current
              smoothedThrottleRef.current += Math.max(-maxStep, Math.min(maxStep, difference))
              throttle = smoothedThrottleRef.current
            } else {
              smoothedThrottleRef.current = throttle
            }
            sendRef.current({
              type: 'manual_control',
              data: {
                x: toManualAxis(-axis('pitch')),
                y: toManualAxis(axis('roll')),
                z: Math.round((Math.max(-1, Math.min(1, throttle)) + 1) * 500),
                r: toManualAxis(axis('yaw')),
                buttons: 0,
              },
            })
          }
        }
        previousButtonsRef.current = rawButtons
      } else if (current.connected) {
        current.setConnected(false)
        previousButtonsRef.current = []
      }
      rafRef.current = requestAnimationFrame(pollGamepad)
    }

    rafRef.current = requestAnimationFrame(pollGamepad)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])
}
