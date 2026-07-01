// Shared dark-mode persistence. App.vue owns the reactive `isDark` state and
// broadcasts changes via the 'theme-changed' event; components that can be
// unmounted/remounted independently of App (e.g. ThreeViewer, toggled by the
// mobile/desktop layout switch) read the stored value directly on mount
// instead of only waiting for that one-time broadcast, so they never come back
// up out of sync with the rest of the UI.
export const THEME_KEY = 'chronocut-theme'

export const getStoredDark = () => {
  try { return localStorage.getItem(THEME_KEY) === 'dark' } catch { return false }
}
