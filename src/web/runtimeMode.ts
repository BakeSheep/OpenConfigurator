// Runtime mode resolution as pure functions: no browser or Vite dependency so
// the rules stay testable under node:test. `runtime.ts` binds them to the
// actual environment.
export type AppRuntimeMode = 'live' | 'demo'

export function resolveRuntimeMode(input: {
  appMode?: string
  dev: boolean
  search: string
}): AppRuntimeMode {
  // Dedicated demo builds (GitHub Pages) bake the mode in at build time.
  if (input.appMode === 'demo') return 'demo'
  // `?demo=1` is a dev-only showcase switch; production builds must ignore it
  // so a stray query parameter can never fake a connection on a real deploy.
  if (input.dev && new URLSearchParams(input.search).has('demo')) return 'demo'
  return 'live'
}

export function shouldConnectBackend(mode: AppRuntimeMode): boolean {
  return mode === 'live'
}
