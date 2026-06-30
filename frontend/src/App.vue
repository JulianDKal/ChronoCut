<template>
  <!-- .cc-theme carries the shared light/dark tokens for BOTH layouts. -->
  <div class="cc-theme" :class="{ dark: isDark }">
    <!-- Mobile: a plain, single-column version (no 3D viewer) -->
    <MobileApp v-if="isMobile" :is-dark="isDark" @toggle-theme="toggleTheme" />

    <div v-else class="app-container">
    <!-- Sidebar - Left -->
    <aside class="sidebar">
      <Sidebar />
    </aside>

    <!-- Main Content Area -->
    <div class="main-content">
      <!-- Three.js Viewer fills the whole area -->
      <div class="viewer-container">
        <ThreeViewer />

        <!-- Debug overlay (top-left) — toggled by the sidebar "Debug" switch -->
        <div v-show="showDebug" class="hud-chip debug-overlay">{{ t('segments') }}: {{ segmentCount.toLocaleString() }}</div>

        <!-- Speed-gradient legend (top-left) — toggled by the sidebar switch -->
        <div v-show="showGradient" class="hud-chip speed-legend">
          <span>{{ t('slow') }}</span>
          <div class="speed-bar"></div>
          <span>{{ t('fast') }}</span>
        </div>

        <!-- Dark-mode toggle (floating, top-right) -->
        <ThemeToggle :is-dark="isDark" @toggle="toggleTheme" />

        <!-- Language switcher (floating, beneath the dark-mode toggle) -->
        <LanguageSwitcher />

        <!-- Floating view toggles (top-right): travel, rulers, raster, debug -->
        <ViewToggles />

        <!-- Fit / rotate banner (top-centre) -->
        <div v-if="fit && !fit.ok" class="fit-banner" :class="{ error: !fit.canRotate }">
          <template v-if="fit.canRotate">
            <span class="fit-msg">{{ t('fitRotate', { dw: fit.design.w, dh: fit.design.h, bw: fit.bed.w, bh: fit.bed.h }) }}</span>
            <button class="fit-btn" @click="rotate('ccw')">{{ t('rotateLeft') }}</button>
            <button class="fit-btn" @click="rotate('cw')">{{ t('rotateRight') }}</button>
          </template>
          <span v-else class="fit-msg">{{ t('tooBig', { dw: fit.design.w, dh: fit.design.h, bw: fit.bed.w, bh: fit.bed.h }) }}</span>
        </div>

        <!-- Floating control islands over the preview -->
        <div class="floating-dock" :class="{ 'is-disabled': !hasContent }">
          <div class="island island--timeline">
            <PlayBack />
          </div>
          <div class="island island--download">
            <DownloadComponent />
          </div>
        </div>
      </div>
    </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import ThreeViewer from './components/ThreeViewer.vue'
import Sidebar from './components/Sidebar.vue'
import MobileApp from './components/MobileApp.vue'
import PlayBack from './components/PlayBack.vue'
import DownloadComponent from './components/DownloadComponent.vue'
import LanguageSwitcher from './components/LanguageSwitcher.vue'
import ThemeToggle from './components/ThemeToggle.vue'
import ViewToggles from './components/ViewToggles.vue'
import eventBus from './eventBus'
import { t } from './translations'

// Mobile vs. desktop layout. On a narrow viewport we render the plain MobileApp
// instead of the full 3D-viewer layout. Kept reactive so rotating a phone or
// resizing a window switches between the two.
const mobileMq = window.matchMedia('(max-width: 768px)')
const isMobile = ref(mobileMq.matches)
const onMqChange = (e) => { isMobile.value = e.matches }

// Controls are greyed out / disabled until a file has been uploaded.
const hasContent = ref(false)
const onLinesUpdated = () => { hasContent.value = true }

// Debug: number of line segments in the current toolpath.
const segmentCount = ref(0)
const onStats = (stats) => { segmentCount.value = stats?.segments ?? 0 }

// The sidebar "Debug" toggle shows/hides the segment overlay (same event that
// drives random-segment-colouring in the viewer).
const showDebug = ref(false)
const onDebugToggled = (on) => { showDebug.value = !!on }

// Speed-gradient legend visibility (driven by the sidebar "Speed-Gradient" toggle).
const showGradient = ref(false)
const onGradientToggled = (on) => { showGradient.value = !!on }

// Fit check: the viewer reports whether the design fits the bed (and if a 90°
// rotation would help). null = unknown/ok-and-cleared.
const fit = ref(null)
const onFitStatus = (s) => { fit.value = s }
const rotate = (dir) => eventBus.emit('rotate-design', dir)

// Dark mode (the viewer reacts via the 'theme-changed' event). The preference is
// persisted across reloads in localStorage.
const THEME_KEY = 'chronocut-theme'
const isDark = ref(localStorage.getItem(THEME_KEY) === 'dark')
const toggleTheme = () => {
  isDark.value = !isDark.value
  localStorage.setItem(THEME_KEY, isDark.value ? 'dark' : 'light')
  eventBus.emit('theme-changed', isDark.value)
}

onMounted(() => {
  mobileMq.addEventListener('change', onMqChange)
  eventBus.on('lines-updated', onLinesUpdated)
  eventBus.on('toolpath-stats', onStats)
  eventBus.on('debug-colors-changed', onDebugToggled)
  eventBus.on('speed-gradient-changed', onGradientToggled)
  eventBus.on('fit-status', onFitStatus)
  // Sync the viewer to the stored theme. This runs after the child ThreeViewer's
  // onMounted, so its 'theme-changed' listener is already registered.
  if (isDark.value) eventBus.emit('theme-changed', true)
})
onBeforeUnmount(() => {
  mobileMq.removeEventListener('change', onMqChange)
  eventBus.off('lines-updated', onLinesUpdated)
  eventBus.off('toolpath-stats', onStats)
  eventBus.off('debug-colors-changed', onDebugToggled)
  eventBus.off('speed-gradient-changed', onGradientToggled)
  eventBus.off('fit-status', onFitStatus)
})
</script>

<style scoped>
/* Theme tokens now live in src/theme.css on the shared .cc-theme wrapper. */
.cc-theme { height: 100%; }

.app-container {
  display: flex;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
}

/* Sidebar Styles */
.sidebar {
  width: 250px;
  background-color: var(--panel-bg);
  display: flex;
  flex-direction: column;
  box-shadow: 2px 0 5px rgba(0, 0, 0, 0.1);
  z-index: 10;
  transition: background-color 0.25s ease;
}

/* Main Content Area (right of sidebar) */
.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Three.js Viewer Container — fills the area; controls float on top */
.viewer-container {
  flex: 1;
  position: relative;
  overflow: hidden;
}

/* ── HUD chips (debug overlay + speed-gradient legend) ──────────────────────
   Shared style so the two debug read-outs look identical. Inset to clear the
   minimal top/left rulers. */
.hud-chip {
  position: absolute;
  left: 30px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border-radius: 7px;
  background: rgba(0, 0, 0, 0.55);
  color: #e8eaed;
  font-family: 'Courier New', monospace;
  font-size: 12px;
  line-height: 1;
  pointer-events: none;
  user-select: none;
}
/* The two debug read-outs are mutually exclusive, so they share the same spot. */
.debug-overlay { top: 30px; }
.speed-legend  { top: 30px; }
.speed-bar {
  width: 90px;
  height: 8px;
  border-radius: 4px;
  background: linear-gradient(90deg,
    hsl(240, 100%, 50%), hsl(180, 100%, 50%), hsl(120, 100%, 50%),
    hsl(60, 100%, 50%), hsl(0, 100%, 50%));
}

/* ── Fit / rotate banner ────────────────────────────────────────────────── */
.fit-banner {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 25;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: calc(100% - 140px);
  padding: 10px 16px;
  border-radius: 10px;
  background: var(--card-bg);
  border: 1px solid var(--panel-border);
  box-shadow: var(--panel-shadow);
  font-size: 13px;
  color: var(--text-strong);
}
.fit-banner.error { border-color: #DE041F; color: #DE041F; }
.fit-msg { white-space: nowrap; }
.fit-btn {
  flex-shrink: 0;
  padding: 6px 12px;
  border: none;
  border-radius: 6px;
  background: #00ADC6;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s ease;
}
.fit-btn:hover { background: #0093A8; }

/* ── Floating control dock ──────────────────────────────────────────────── */
.floating-dock {
  position: absolute;
  left: 24px;
  right: 24px;
  bottom: 24px;
  display: flex;
  align-items: flex-end;   /* each island keeps its own height */
  gap: 16px;
  z-index: 10;
  /* Let clicks pass through to the canvas everywhere except on the islands. */
  pointer-events: none;
  transition: opacity 0.25s ease, filter 0.25s ease;
}

.island {
  pointer-events: auto;
  background: var(--card-bg);
  border-radius: 14px;
  border: 1px solid var(--panel-border);
  box-shadow: var(--panel-shadow);
  overflow: hidden;
}

.island--timeline { flex: 1 1 auto; min-width: 0; }
.island--download { flex: 0 0 auto; }

/* Until something is uploaded: keep the card backgrounds correct, just disable
   interaction and fade the controls inside (so the timeline doesn't look tinted). */
.floating-dock.is-disabled .island {
  pointer-events: none;
}
.floating-dock.is-disabled .island > * {
  opacity: 0.45;
}

/* Responsive */
@media (max-width: 768px) {
  .sidebar { width: 200px; }
  .floating-dock {
    left: 12px;
    right: 12px;
    bottom: 12px;
    flex-direction: column;
  }
}
</style>
