// Binds the pure runtime-mode rules to the real browser/Vite environment.
// Evaluated once at module load, before React renders anything.
import { isReadOnlyRuntime, resolveRuntimeMode, shouldStartLocalRuntime } from './runtimeMode'

export const appRuntimeMode = resolveRuntimeMode({
  appMode: import.meta.env.VITE_APP_MODE,
  dev: import.meta.env.DEV,
  search: window.location.search,
})

export const localRuntimeEnabled = shouldStartLocalRuntime(appRuntimeMode)
export const readOnlyRuntime = isReadOnlyRuntime(appRuntimeMode)
export const dashboardCustomVarsStorageKey = appRuntimeMode === 'demo'
  ? 'oc-demo-dashboard-custom-vars'
  : 'oc-dashboard-custom-vars'
