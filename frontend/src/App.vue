<template>
  <!-- .cc-theme carries the shared light/dark tokens for BOTH layouts. -->
  <div class="cc-theme" :class="{ dark: isDark }">
    <!-- Mobile: a plain, single-column version (no 3D viewer) -->
    <MobileApp v-if="isMobile" :is-dark="isDark" @toggle-theme="toggleTheme" />

    <div v-else class="app-container" :class="{ resizing: resizingSidebar }">
    <!-- Sidebar - Left. Width is user-draggable (persisted); the handle on its
         right edge starts the drag, double-click resets to the default. -->
    <aside class="sidebar" :style="{ width: sidebarWidth + 'px' }">
      <Sidebar />
      <div
        class="sidebar-resizer"
        :class="{ dragging: resizingSidebar }"
        role="separator"
        aria-orientation="vertical"
        @pointerdown="startSidebarResize"
        @dblclick="resetSidebarWidth"
      ></div>
    </aside>

    <!-- Main Content Area -->
    <div class="main-content">
      <!-- Three.js Viewer fills the whole area -->
      <div class="viewer-container">
        <ThreeViewer />

        <!-- Debug overlay (top-left) - toggled by the sidebar "Debug" switch -->
        <div v-show="showDebug" class="hud-chip debug-overlay">{{ t('segments') }}: {{ segmentCount.toLocaleString() }}</div>

        <!-- Speed-gradient legend (top-left) - toggled by the sidebar switch -->
        <div v-show="showGradient" class="hud-chip speed-legend">
          <span>{{ t('slow') }}</span>
          <div class="speed-bar"></div>
          <span>{{ t('fast') }}</span>
        </div>

        <!-- Top-right controls: theme, language, view toggles, one floating
             column instead of two separate ones. -->
        <div class="top-right-controls">
          <ThemeToggle :is-dark="isDark" @toggle="toggleTheme" />
          <LanguageSwitcher />
          <ViewToggles />
        </div>

        <!-- Fit / rotate banner (top-centre) -->
        <div v-if="fit && !fit.ok" class="fit-banner" :class="{ error: !fit.canRotate }">
          <template v-if="fit.canRotate">
            <span class="fit-msg">{{ t('fitRotate', { dw: fit.design.w, dh: fit.design.h, bw: fit.bed.w, bh: fit.bed.h }) }}</span>
            <button class="fit-btn" @click="rotate('ccw')">{{ t('rotateLeft') }}</button>
            <button class="fit-btn" @click="rotate('cw')">{{ t('rotateRight') }}</button>
          </template>
          <span v-else class="fit-msg">{{ t('tooBig', { dw: fit.design.w, dh: fit.design.h, bw: fit.bed.w, bh: fit.bed.h }) }}</span>
        </div>
      </div>

      <!-- Bottom dock: ONE container holding two groups, playback on the
           left, result + export on the right, parted by a single hairline.
           Neither group draws a box of its own; boxing them inside a bar that
           is already a box reads as encapsulating the controls twice.

           The separator + result/export group are wrapped in .dock-right,
           not for anything visual, purely so DownloadComponent's breakdown
           popover has a positioning ancestor whose box spans EXACTLY "from
           the separator to the dock's true right edge" and whose top edge is
           flush with the dock's own top border (see the CSS notes on
           .dock-right and .breakdown for how). -->
      <div class="dock" :class="{ 'is-disabled': !hasContent }">
        <PlayBack />
        <div class="dock-right">
          <span class="dock-sep" aria-hidden="true"></span>
          <DownloadComponent />
        </div>
      </div>
    </div>
    </div>

    <!-- Teleport target for floating UI (e.g. PlayBack's speed menu) that must
         escape an ancestor's `overflow: hidden` but still needs the theme's
         CSS custom properties (--dropdown-bg etc.), which only cascade within
         .cc-theme: teleporting straight to <body> would lose them. -->
    <div id="cc-portal-root"></div>
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
import { THEME_KEY, getStoredDark } from './theme'
import {
  SIDEBAR_DEFAULT_WIDTH, clampSidebarWidth,
  getStoredSidebarWidth, setStoredSidebarWidth,
} from './layout'

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

// Dark mode (the viewer reacts via the 'theme-changed' event, and also reads the
// stored value directly on its own mount - see theme.js - so it stays in sync
// even when it's unmounted/remounted, e.g. by the mobile/desktop layout switch).
const isDark = ref(getStoredDark())
const toggleTheme = () => {
  isDark.value = !isDark.value
  localStorage.setItem(THEME_KEY, isDark.value ? 'dark' : 'light')
  eventBus.emit('theme-changed', isDark.value)
}

// ── Sidebar resize ──────────────────────────────────────────────────────────
// The sidebar starts at the viewport's left edge, so the pointer's clientX IS
// the width being asked for, no offset bookkeeping needed. Width is applied
// live (the viewer re-fits itself via its ResizeObserver) and only written to
// storage when the drag ends, so a drag isn't hundreds of localStorage writes.
const sidebarWidth = ref(getStoredSidebarWidth())
const resizingSidebar = ref(false)

const onSidebarResizeMove = (e) => { sidebarWidth.value = clampSidebarWidth(e.clientX) }

const endSidebarResize = () => {
  if (!resizingSidebar.value) return
  resizingSidebar.value = false
  window.removeEventListener('pointermove', onSidebarResizeMove)
  window.removeEventListener('pointerup', endSidebarResize)
  window.removeEventListener('pointercancel', endSidebarResize)
  setStoredSidebarWidth(sidebarWidth.value)
}

const startSidebarResize = (e) => {
  e.preventDefault()          // don't start a text selection / native drag
  resizingSidebar.value = true
  window.addEventListener('pointermove', onSidebarResizeMove)
  window.addEventListener('pointerup', endSidebarResize)
  window.addEventListener('pointercancel', endSidebarResize)
}

const resetSidebarWidth = () => {
  sidebarWidth.value = SIDEBAR_DEFAULT_WIDTH
  setStoredSidebarWidth(sidebarWidth.value)
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
  endSidebarResize()   // drops any listeners still attached mid-drag
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

/* While dragging the sidebar edge, keep the resize cursor everywhere and stop
   the pointer from selecting text as it sweeps across the UI. */
.app-container.resizing {
  cursor: col-resize;
  user-select: none;
}

/* Sidebar Styles, width comes from the inline :style (user-draggable, see
   layout.js), so it is deliberately not set here. flex:0 0 auto stops the
   flex row from shrinking it back below that width. */
.sidebar {
  position: relative;
  flex: 0 0 auto;
  background-color: var(--panel-bg);
  display: flex;
  flex-direction: column;
  /* Border AND shadow, same as .dock (below) - both toolbars separate
     themselves from the viewer the same way, this one on the right edge
     instead of the top. */
  border-right: 1px solid var(--panel-border);
  box-shadow: 2px 0 5px rgba(0, 0, 0, 0.1);
  /* Higher than .dock's (65, below) so the sidebar's own subtree, including
     this shadow, sits IN FRONT of the dock where the two meet at the
     bottom-left corner - the shadow bleeding rightward off the sidebar's
     edge should show over the dock, not get hidden beneath it. */
  z-index: 70;
  transition: background-color 0.25s ease;
}

/* Drag handle on the sidebar's right edge. Wider than the line it draws, so
   it is comfortably grabbable without looking like a thick border. */
.sidebar-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  right: -3px;
  width: 7px;
  z-index: 20;
  cursor: col-resize;
  background: transparent;
  transition: background 0.15s ease;
}
.sidebar-resizer::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 1px;
  background: transparent;
  transition: background 0.15s ease;
}
.sidebar-resizer:hover::after,
.sidebar-resizer.dragging::after { background: #00ADC6; }

/* Main Content Area (right of sidebar) */
.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Three.js Viewer Container - fills the area; controls float on top.
   The background matches the WebGL scene's clear colour so that a frame in
   which the canvas doesn't yet cover the container (dragging the sidebar
   resizes it continuously) shows the viewer's own colour rather than a white
   flash of the page underneath. */
.viewer-container {
  flex: 1;
  position: relative;
  overflow: hidden;
  background: var(--viewer-bg);
}

/* ── Top-right controls (theme, language, view toggles) ─────────────────────
   One floating column: each child component (ThemeToggle/LanguageSwitcher/
   ViewToggles) no longer positions itself, this wrapper does, so they stack
   as ordinary flex items instead of three independently-placed overlays. */
.top-right-controls {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
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

/* ── Bottom dock (playback + result/export) ──────────────────────────────
   The horizontal counterpart of the sidebar: a chrome panel in the very same
   --panel-bg, carrying raised --ctrl-bg cards exactly like the sidebar
   carries its white dropdowns. Together the two frame the viewer in an L of
   chrome, and the dock stops reading as a stray strip.

   It lives in normal flow as a sibling of .viewer-container inside the
   .main-content flex column, so the viewer shrinks to make room rather than
   being covered, and align-items is `center`, never `stretch`, so the two
   groups keep their own heights instead of one dictating the other's.

   The dock is the ONLY container: the groups inside it are bare, separated by
   .dock-sep alone. Giving them borders as well put a box inside a box.

   Right padding lives on .dock-right below, not here: see that rule for why. */
.dock {
  /* position + z-index mirror .sidebar's own (above), for two reasons at
     once: it's what lets DownloadComponent's breakdown panel (teleported to
     #cc-portal-root, z-index:60) sit BEHIND this once they're genuine
     siblings instead of ancestor/descendant (see the long comment on
     .breakdown in DownloadComponent.vue for why the ancestor/descendant
     version could never work no matter the numbers) - and it's LOWER than
     .sidebar's 70, so the sidebar's own subtree (including ITS shadow)
     paints in front of the dock at their shared bottom-left corner, not the
     other way round. */
  position: relative;
  z-index: 65;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 9px 0 9px 18px;
  background: var(--panel-bg);
  /* Border AND shadow, same as .sidebar (below) - both toolbars separate
     themselves from the viewer the same way, this one just mirrored to the
     top edge instead of the right. */
  border-top: 1px solid var(--panel-border);
  /* Same shadow as .sidebar, mirrored to point up instead of right - the
     dock sits at the bottom edge, so it casts its separation-from-the-viewer
     shadow upward the way the sidebar casts its own rightward. */
  box-shadow: 0 -2px 5px rgba(0, 0, 0, 0.1);
  transition: background 0.25s ease;
}

/* Purely a positioning device (see the template comment), no visual styling
   of its own. `align-self: stretch` overrides the dock's own
   `align-items: center` just for this one item, so THIS box's own height
   matches the dock's full content height instead of shrink-wrapping its
   (shorter, centred) content, which in turn means its top edge sits exactly
   at the dock's own top edge.

   DownloadComponent's breakdown panel is teleported out to #cc-portal-root
   (see its own CSS note for why), so it no longer positions itself against
   this box via CSS containment - it measures it instead
   (`.closest('.dock-right').getBoundingClientRect()`), giving the same
   result (flush with the dock's actual top border, spanning exactly the
   width from .dock-sep to the dock's right edge) without needing this to be
   its containing block. position:relative isn't actually required for that
   lookup (`.closest` is a plain class-name walk, unrelated to CSS
   positioning) - it's just not worth removing since nothing depends on it
   being gone either. padding-right replaces the dock's own former right
   padding for this side, so the visual spacing is unchanged. */
.dock-right {
  position: relative;
  flex: 0 0 auto;
  align-self: stretch;
  display: flex;
  align-items: center;
  gap: 14px;
  padding-right: 18px;
}

/* The single hairline parting playback from result+export. align-self:stretch
   now spans .dock-right's full (dock-height) box, not just this section's
   own shorter content height, a taller, more visible divider line. */
.dock-sep {
  flex: 0 0 auto;
  width: 1px;
  align-self: stretch;
  margin: 4px 0;
  background: var(--ctrl-border);
}

/* Until something is uploaded: block interaction and fade the card CONTENTS
   while leaving the card backgrounds intact, a tinted, half-transparent card
   reads as broken rendering, whereas faded contents read as "not ready yet". */
.dock.is-disabled > * { pointer-events: none; }
.dock.is-disabled :deep(.controls-wrapper),
.dock.is-disabled :deep(.dl-row) { opacity: 0.45; }

/* Responsive */
/* No .sidebar width override here: the inline (draggable) width would win over
   it anyway, and below 768px MobileApp renders instead of this layout. */
@media (max-width: 768px) {
  .dock {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
}
</style>
