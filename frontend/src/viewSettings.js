// Shared persistence for the floating view-toggle settings (travel, rulers,
// raster display mode, debug modes, curve fidelity) and the path-order
// algorithm — same pattern as theme.js: a single source of truth so
// components that can mount independently of each other (ThreeViewer,
// ViewToggles, Sidebar, MobileApp) never come back up out of sync with what
// was last chosen. All of it lives under one localStorage key as a JSON blob,
// since it's always read/written as "the current view settings" as a unit.
import { DEFAULT_PATH_ORDER } from './toolpath'

export const VIEW_SETTINGS_KEY = 'chronocut-view-settings'

export const DEFAULT_VIEW_SETTINGS = {
  showTravel: true,
  showRulers: true,
  rasterMode: 'lines',       // 'lines' | 'block' | 'outline'
  debugColors: false,
  speedGradient: false,
  tessellation: 'normal',    // 'normal' | 'fine' | 'ultra' — see TESSELLATION_TOL_BY_KEY
  pathOrder: DEFAULT_PATH_ORDER,
}

// Curve-fidelity presets (mm bezier-flatness tolerance) — the single source
// both ViewToggles.vue (menu options) and ThreeViewer.vue (restoring on
// mount) resolve a stored 'tessellation' key against.
export const TESSELLATION_TOL_BY_KEY = { normal: 0.2, fine: 0.05, ultra: 0.01 }

export function getStoredViewSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_SETTINGS_KEY) || '{}')
    return { ...DEFAULT_VIEW_SETTINGS, ...raw }
  } catch {
    return { ...DEFAULT_VIEW_SETTINGS }
  }
}

export function setStoredViewSetting(key, value) {
  try {
    const cur = getStoredViewSettings()
    cur[key] = value
    localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify(cur))
  } catch { /* private browsing, quota, ... — setting just won't persist */ }
}
