// Parameters whose raw write can disable a protection outright. Keep this
// classification shared so the UI confirmation and Worker authorization can
// never drift apart.
const SENSITIVE_PARAM_PATTERNS: readonly RegExp[] = [
  /^CBRK_/,
  /^ARMING_/,
  /^BRD_SAFETY/,
  /^MOT_SAFE_/,
  /^DISARM_DELAY$/,
  /^COM_ARM/,
  /^FS_/,
  /^COM_(?:LOW_BAT_ACT|RC_LOSS_T|DL_LOSS_T)$/,
  /^NAV_(?:RCL_ACT|DLL_ACT)$/,
  /_FS_(?:LOW|CRT)_ACT$/,
  /^SERVO\d+_FUNCTION$/,
  /^PWM_(?:MAIN|AUX)_FUNC\d+$/,
]

export function isSensitiveParameter(id: string): boolean {
  return SENSITIVE_PARAM_PATTERNS.some((pattern) => pattern.test(id))
}
