// Binds the pure runtime-mode rules to the real browser/Vite environment.
// Evaluated once at module load, before React renders anything.
import { resolveRuntimeMode } from './runtimeMode'

export const appRuntimeMode = resolveRuntimeMode({
  appMode: import.meta.env.VITE_APP_MODE,
  dev: import.meta.env.DEV,
  search: window.location.search,
})
