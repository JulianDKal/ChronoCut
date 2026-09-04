// Persistence for layout the user can drag, currently just the sidebar width.
// Same shape as theme.js / viewSettings.js: one key, read once on mount,
// written when the drag ends, and tolerant of storage being unavailable
// (private browsing, quota), the preference simply won't stick.
export const SIDEBAR_WIDTH_KEY = 'chronocut-sidebar-width'

export const SIDEBAR_DEFAULT_WIDTH = 210
// Floor: the cutter/material/thickness dropdowns still need to read.
// Ceiling: past this the sidebar starts eating the viewer for no benefit.
export const SIDEBAR_MIN_WIDTH = 170
export const SIDEBAR_MAX_WIDTH = 420

export const clampSidebarWidth = (px) =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(px)))

export function getStoredSidebarWidth() {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return Number.isFinite(raw) && raw > 0 ? clampSidebarWidth(raw) : SIDEBAR_DEFAULT_WIDTH
  } catch {
    return SIDEBAR_DEFAULT_WIDTH
  }
}

export function setStoredSidebarWidth(px) {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(px)))
  } catch { /* storage unavailable, the width just won't persist */ }
}
