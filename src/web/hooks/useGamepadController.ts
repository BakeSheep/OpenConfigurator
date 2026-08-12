import { useEffect, useRef } from 'react'
import i18next from 'i18next'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import type { ClientMessage } from '../../shared/types'
import { useConnectionStore } from '../stores/connectionStore'
import {
  useGamepadStore,
  type GamepadActionId,
  type GamepadMapping,
} from '../stores/gamepadStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import {
  canRepeatGamepadAction,
  requiresGamepadArmHold,
  resolveGamepadArmHoldTransition,
  resolveGamepadModeAction,
} from '../utils/gamepadActions'
import { smoothGamepadThrottle } from './gamepadThrottle'

/**
 * Owns the browser Gamepad polling loop for the lifetime of the application.
 * Keeping this at App level prevents manual-control input from stopping when
 * the user leaves the gamepad settings tab to arm or monitor the vehicle.
 */
export function useGamepadController(send: (message: ClientMessage) => boolean) {
  const t = i18next.t.bind(i18next)
  const rafRef = useRef(0)
  const lastAxisSendRef = useRef(0)
  const lastButtonFireRef = useRef<Record<number, number>>({})
  const previousButtonsRef = useRef<boolean[]>([])
  const armHoldStartRef = useRef<Record<number, number>>({})
  const armHoldSafetyKeyRef = useRef('')
  // null means manual input has not produced an active frame yet. The first
  // frame must start at the physical stick position rather than slewing from
  // an arbitrary default, which could command a transient non-zero throttle.
  const smoothedThrottleRef = useRef<number | null>(null)
  const sendRef = useRef(send)
  sendRef.current = send

  useEffect(() => useConnectionStore.subscribe((state) => {
    if (state.status === 'disconnected' && useGamepadStore.getState().enabled) {
      smoothedThrottleRef.current = null
      useGamepadStore.getState().setEnabled(false)
    }
  }), [])

  useEffect(() => useTelemetryStore.subscribe((state) => {
    if (
      state.vehicleIdentity !== null
      &&
      !vehicleCapabilities(state.vehicleIdentity).writeOperations
      && useGamepadStore.getState().enabled
    ) {
      smoothedThrottleRef.current = null
      useGamepadStore.getState().setEnabled(false)
    }
  }), [])

  useEffect(() => {
    const fireAction = (action: GamepadActionId, button: number, armingConfirmed = false) => {
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
        if (!armingConfirmed) return
        const connection = useConnectionStore.getState()
        const telemetry = useTelemetryStore.getState()
        const caps = vehicleCapabilities(telemetry.vehicleIdentity)
        const liveSafetyKey = `${connection.safetyAuthorityId ?? '-'}:${connection.safetyEpoch}`
        if (
          !connection.vehicleReady
          || !connection.canControl
          || connection.safetyAuthorityId === null
          || armHoldSafetyKeyRef.current !== liveSafetyKey
          || !caps.writeOperations
          || !caps.arm
          || telemetry.status?.armed === true
          || telemetry.preflightCheck === false
          || telemetry.sensorsHealthy === false
        ) return
        const sent = sendRef.current({
          type: 'command',
          cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
          params: [1, 0, 0, 0, 0, 0, 0],
          safetyConfirmation: 'arm',
          expectedSafetyEpoch: connection.safetyEpoch,
          expectedSafetyAuthorityId: connection.safetyAuthorityId,
        })
        gamepadActions.setActionNotice(sent
          ? t('joystick.actionNotice.armSent', { button })
          : t('joystick.actionNotice.sendFailed', { button }))
        if (!sent) gamepadActions.setEnabled(false)
        return
      }
      if (action === 'disarm' || action === 'toggle_arm') {
        const sent = armCommand(false)
        gamepadActions.setActionNotice(sent
          ? t('joystick.actionNotice.disarmSent', { button })
          : t('joystick.actionNotice.sendFailed', { button }))
        if (!sent) gamepadActions.setEnabled(false)
        return
      }
      const option = resolveGamepadModeAction(
        action,
        useTelemetryStore.getState().vehicleIdentity,
      )
      if (!option) {
        gamepadActions.setActionNotice(t('joystick.actionNotice.modeNotSupported', { button }))
        return
      }
      const sent = sendRef.current({
        type: 'set_flight_mode',
        data: { modeId: option.id },
      })
      gamepadActions.setActionNotice(sent
        ? t('joystick.actionNotice.modeSwitch', { button, mode: option.name })
        : t('joystick.actionNotice.sendFailed', { button }))
      if (!sent) gamepadActions.setEnabled(false)
    }

    const pollGamepad = () => {
      const current = useGamepadStore.getState()
      const connection = useConnectionStore.getState()
      const profileWritable = vehicleCapabilities(
        useTelemetryStore.getState().vehicleIdentity,
      ).writeOperations
      const controllerConnected = connection.vehicleReady && connection.canControl && profileWritable
      const gamepads = navigator.getGamepads()
      const gamepad = gamepads[0] || gamepads[1] || gamepads[2] || gamepads[3]

      if (gamepad) {
        if (!current.connected) current.setConnected(true, gamepad.id)
        const rawButtons = gamepad.buttons.map((button) => button.pressed)
        const liveSafetyKey = `${connection.safetyAuthorityId ?? '-'}:${connection.safetyEpoch}`
        if (liveSafetyKey !== armHoldSafetyKeyRef.current) {
          armHoldSafetyKeyRef.current = liveSafetyKey
          armHoldStartRef.current = {}
          // A held button must be released before it can start confirmation in
          // the new authority epoch.
          previousButtonsRef.current = rawButtons
        }
        current.setAxes(Array.from(gamepad.axes))
        current.setButtons(rawButtons)

        if (current.enabled && controllerConnected) {
          const now = Date.now()
          const buttonDelay = 1000 / Math.max(1, current.advanced.buttonFrequencyHz)
          rawButtons.forEach((pressed, index) => {
            const assignment = current.buttonAssignments[index]
            const downTransition = pressed && !previousButtonsRef.current[index]
            const armed = useTelemetryStore.getState().status?.armed ?? false
            const requiresArmHold = assignment && requiresGamepadArmHold(assignment.action, armed)
            if (requiresArmHold) {
              const transition = resolveGamepadArmHoldTransition(
                pressed,
                previousButtonsRef.current[index] ?? false,
                armHoldStartRef.current[index],
                now,
              )
              if (transition.kind === 'started') {
                armHoldStartRef.current[index] = transition.startedAt
                current.setActionNotice(t('joystick.actionNotice.armHoldToConfirm', { button: index }))
              } else if (transition.kind === 'confirmed') {
                delete armHoldStartRef.current[index]
                lastButtonFireRef.current[index] = now
                fireAction(assignment.action, index, true)
              } else if (transition.kind === 'cancelled') {
                delete armHoldStartRef.current[index]
                current.setActionNotice(t('joystick.actionNotice.armCancelled', { button: index }))
              }
              return
            }
            delete armHoldStartRef.current[index]
            // Arm-class actions fire on the press edge only, regardless of any
            // (legacy/corrupted) repeat flag: holding a button must never
            // re-send arm/disarm at the button frequency.
            const repeatDue = pressed
              && assignment?.repeat
              && canRepeatGamepadAction(assignment.action)
              && now - (lastButtonFireRef.current[index] ?? 0) >= buttonDelay
            if (assignment && (downTransition || repeatDue)) {
              lastButtonFireRef.current[index] = now
              fireAction(assignment.action, index)
            }
          })

          const axisDelay = 1000 / Math.max(1, current.advanced.axisFrequencyHz)
          if (useGamepadStore.getState().enabled && now - lastAxisSendRef.current >= axisDelay) {
            const deltaSeconds = Math.min((now - lastAxisSendRef.current) / 1000, 0.1)
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
            const smoothedThrottle = smoothGamepadThrottle(
              throttle,
              smoothedThrottleRef.current,
              deltaSeconds,
              current.advanced.throttleSmoothing,
            )
            throttle = smoothedThrottle.output
            const sent = sendRef.current({
              type: 'manual_control',
              data: {
                x: toManualAxis(-axis('pitch')),
                y: toManualAxis(axis('roll')),
                z: Math.round((Math.max(-1, Math.min(1, throttle)) + 1) * 500),
                r: toManualAxis(axis('yaw')),
                buttons: 0,
              },
            })
            if (sent) {
              lastAxisSendRef.current = now
              smoothedThrottleRef.current = smoothedThrottle.next
            } else {
              smoothedThrottleRef.current = null
              current.setActionNotice(t('joystick.actionNotice.controlSendFailed'))
              current.setEnabled(false)
            }
          }
        } else {
          // A disable or loss of the FC controller lease ends this input
          // stream. Re-enabling must initialize from the then-current stick.
          smoothedThrottleRef.current = null
          armHoldStartRef.current = {}
        }
        previousButtonsRef.current = rawButtons
      } else {
        smoothedThrottleRef.current = null
        armHoldStartRef.current = {}
        if (current.connected) current.setConnected(false)
        previousButtonsRef.current = []
      }
      rafRef.current = requestAnimationFrame(pollGamepad)
    }

    rafRef.current = requestAnimationFrame(pollGamepad)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])
}
