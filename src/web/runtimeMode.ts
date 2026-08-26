// Runtime mode resolution as pure functions: no browser or Vite dependency so
// the rules stay testable under node:test. `runtime.ts` binds them to the
// actual environment.
export type AppRuntimeMode = 'live' | 'demo'

export function resolveRuntimeMode(input: {
  appMode?: string
  dev: boolean
  search: string
}): AppRuntimeMode {
  // Dedicated screenshot and UI-test builds bake the mode in at build time.
  if (input.appMode === 'demo') return 'demo'
  // `?demo=1` is a dev-only showcase switch; production builds must ignore it
  // so a stray query parameter can never fake a connection on a real deploy.
  if (input.dev && new URLSearchParams(input.search).has('demo')) return 'demo'
  return 'live'
}

export function shouldStartLocalRuntime(mode: AppRuntimeMode): boolean {
  return mode === 'live'
}

export function isReadOnlyRuntime(mode: AppRuntimeMode): boolean {
  return mode === 'demo'
}

/**
 * Starts the local Worker lifecycle only when the runtime allows local runtime access.
 * Kept pure so the demo isolation boundary is covered without a browser.
 */
export function startLocalRuntimeIfEnabled(enabled: boolean, connect: () => void): boolean {
  if (!enabled) return false
  connect()
  return true
}
