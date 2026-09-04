<template>
  <div class="view-toggles" ref="root">
    <!-- Reset view: re-centre + re-fit, flown to rather than snapped to. Now a
         flyout because there are three things worth framing, not one - the
         whole design, only what has been lasered so far, or only the colours
         still visible. Same shape as the raster/curve/debug controls below;
         the last-used target is remembered and marked active. -->
    <div class="vt-popover">
      <button
        class="vt-btn"
        aria-haspopup="true"
        :aria-expanded="focusOpen"
        @click="toggleMenu('focus')"
      >
        <span class="vt-icon" v-html="ICON_RESET"></span>
        <span class="vt-tip" v-show="!focusOpen">{{ t('resetView') }}</span>
      </button>

      <Transition name="slide-fade" :duration="220">
        <div v-if="focusOpen" class="vt-menu">
          <button
            v-for="f in focusOptions"
            :key="f.key"
            class="vt-item"
            :class="{ active: state.focusMode === f.key }"
            @click="focus(f.key)"
          >
            <span class="vt-radio"></span>
            <span>{{ t(f.label) }}</span>
          </button>
        </div>
      </Transition>
    </div>

    <!-- Simple view toggles -->
    <button
      v-for="tg in simpleToggles"
      :key="tg.key"
      class="vt-btn"
      :class="{ active: state[tg.key] }"
      :aria-pressed="state[tg.key]"
      @click="toggle(tg)"
    >
      <span class="vt-icon" v-html="tg.icon"></span>
      <span class="vt-tip">{{ t(tg.label) }}</span>
    </button>

    <!-- Raster control: filled block vs outline-only block (flyout) -->
    <div class="vt-popover">
      <button
        class="vt-btn"
        :class="{ active: rasterActive }"
        aria-haspopup="true"
        :aria-expanded="rasterOpen"
        @click="toggleMenu('raster')"
      >
        <span class="vt-icon" v-html="ICON_RASTER"></span>
        <span class="vt-tip" v-show="!rasterOpen">{{ t('rasterBlock') }}</span>
      </button>

      <!-- Slides out from behind the button toward the left, the direction
           it actually opens in, rather than popping into place. -->
      <Transition name="slide-fade" :duration="220">
        <div v-if="rasterOpen" class="vt-menu">
          <button
            v-for="r in rasterOptions"
            :key="r.key"
            class="vt-item"
            :class="{ active: state.rasterMode === r.key }"
            @click="setRaster(r.key)"
          >
            <span class="vt-radio"></span>
            <span>{{ t(r.label) }}</span>
          </button>
        </div>
      </Transition>
    </div>

    <!-- Curve fidelity: how finely beziers are tessellated for viewing (flyout).
         Only affects rendering smoothness, not the time estimate. -->
    <div class="vt-popover">
      <button
        class="vt-btn"
        :class="{ active: state.tessellation !== 'normal' }"
        aria-haspopup="true"
        :aria-expanded="tessOpen"
        @click="toggleMenu('tess')"
      >
        <span class="vt-icon" v-html="ICON_TESS"></span>
        <span class="vt-tip" v-show="!tessOpen">{{ t('curveFidelity') }}</span>
      </button>

      <Transition name="slide-fade" :duration="220">
        <div v-if="tessOpen" class="vt-menu">
          <button
            v-for="q in tessOptions"
            :key="q.key"
            class="vt-item"
            :class="{ active: state.tessellation === q.key }"
            @click="setTessellation(q.key)"
          >
            <span class="vt-radio"></span>
            <span>{{ t(q.label) }}</span>
          </button>
        </div>
      </Transition>
    </div>

    <!-- Debug control: segment colours vs speed gradient (flyout) -->
    <div class="vt-popover">
      <button
        class="vt-btn"
        :class="{ active: debugActive }"
        aria-haspopup="true"
        :aria-expanded="debugOpen"
        @click="toggleMenu('debug')"
      >
        <span class="vt-icon" v-html="ICON_DEBUG"></span>
        <span class="vt-tip" v-show="!debugOpen">{{ t('debug') }}</span>
      </button>

      <Transition name="slide-fade" :duration="220">
        <div v-if="debugOpen" class="vt-menu">
          <button
            v-for="d in debugOptions"
            :key="d.key"
            class="vt-item"
            :class="{ active: state[d.key] }"
            @click="toggleKey(d.key, d.event)"
          >
            <span class="vt-radio"></span>
            <span>{{ t(d.label) }}</span>
          </button>
        </div>
      </Transition>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, computed, onMounted, onBeforeUnmount } from 'vue'
import eventBus from '../eventBus'
import { t } from '../translations'
import { getStoredViewSettings, setStoredViewSetting, TESSELLATION_TOL_BY_KEY } from '../viewSettings'

// Floating view toggles (top-right). Restored from localStorage (same pattern
// as the theme/language toggles) so a reload comes back exactly as left,
// see viewSettings.js. Every change below is persisted immediately, and the
// restored values are re-broadcast once on mount (see onMounted at the
// bottom) so ThreeViewer/App.vue - which only react to these events, they
// don't read storage themselves, pick up the restored state on first load.
const state = reactive(getStoredViewSettings())

const debugOpen = ref(false)
const rasterOpen = ref(false)
const tessOpen = ref(false)
const focusOpen = ref(false)
const root = ref(null)
const debugActive  = computed(() => state.debugColors || state.speedGradient)
const rasterActive = computed(() => state.rasterMode !== 'lines')

const icon = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`

const ICON_TRAVEL = icon('<line x1="3" y1="12" x2="21" y2="12" stroke-dasharray="3 3"/>')
const ICON_RULER  = icon('<rect x="3" y="8" width="18" height="8" rx="1"/><path d="M7 8 v3 M11 8 v4 M15 8 v3 M19 8 v4" stroke-width="1.4"/>')
const ICON_RASTER = icon('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9 h16 M4 13 h16 M4 17 h16" stroke-width="1.4"/>')
const ICON_DEBUG  = icon('<rect x="8" y="9" width="8" height="10" rx="4"/><path d="M12 9 V19"/><path d="M9 5 l1.5 3 M15 5 l-1.5 3"/><path d="M8 12 H5 M8 16 H6 M16 12 H19 M16 16 H18"/>')
const ICON_TESS   = icon('<path d="M3 17 Q9 17 9 12 T15 7 T21 7"/>')
const ICON_RESET  = icon('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 8 v8 M8 12 h8" stroke-width="1.6"/>')

const simpleToggles = [
  { key: 'showTravel', label: 'showTravel', event: 'show-travel-changed', icon: ICON_TRAVEL },
  { key: 'showRulers', label: 'showRulers', event: 'rulers-changed',      icon: ICON_RULER },
]

const rasterOptions = [
  { key: 'block',   label: 'rasterFilled'  },
  { key: 'outline', label: 'rasterOutline' },
]
const debugOptions = [
  { key: 'debugColors',   label: 'dbgSegments', event: 'debug-colors-changed' },
  { key: 'speedGradient', label: 'dbgSpeed',    event: 'speed-gradient-changed' },
]
// mm tolerance passed to setTessellationTolerance() - lower = more segments per
// curve = closer-fitting polyline. 'normal' matches the machine's own precision;
// the finer levels are for eyeballing small/simple designs up close.
// What the reset button frames. 'all' is the original behaviour.
const focusOptions = [
  { key: 'all',     label: 'focusAll' },
  { key: 'lasered', label: 'focusLasered' },
  { key: 'visible', label: 'focusVisible' },
]
const tessOptions = [
  { key: 'normal', label: 'tessNormal', tol: TESSELLATION_TOL_BY_KEY.normal },
  { key: 'fine',   label: 'tessFine',   tol: TESSELLATION_TOL_BY_KEY.fine },
  { key: 'ultra',  label: 'tessUltra',  tol: TESSELLATION_TOL_BY_KEY.ultra },
]

const emit = (key, event) => { setStoredViewSetting(key, state[key]); eventBus.emit(event, state[key]) }

// Frame the chosen target and remember it as the button's mode. ThreeViewer
// does the actual framing (and falls back to the whole design when the chosen
// target is empty - nothing lasered yet, every colour hidden).
const focus = (mode) => {
  state.focusMode = mode
  setStoredViewSetting('focusMode', mode)
  focusOpen.value = false
  eventBus.emit('reset-view', mode)
}

// Only one flyout open at a time.
const toggleMenu = (which) => {
  const next = { raster: false, debug: false, tess: false, focus: false }
  const flag = { raster: rasterOpen, debug: debugOpen, tess: tessOpen, focus: focusOpen }
  next[which] = !flag[which].value
  rasterOpen.value = next.raster
  debugOpen.value = next.debug
  tessOpen.value = next.tess
  focusOpen.value = next.focus
}

const toggle = (tg) => {
  state[tg.key] = !state[tg.key]
  debugOpen.value = false
  rasterOpen.value = false
  tessOpen.value = false
  focusOpen.value = false
  emit(tg.key, tg.event)
}

// Raster: "filled" and "outline" are mutually exclusive; clicking the active one
// turns it off (→ back to normal scan lines).
const setRaster = (mode) => {
  state.rasterMode = state.rasterMode === mode ? 'lines' : mode
  setStoredViewSetting('rasterMode', state.rasterMode)
  eventBus.emit('raster-mode-changed', state.rasterMode)
}

// Debug modes are mutually exclusive: turning one on turns the other off (and a
// second click on the active one turns it back off → neither active).
const toggleKey = (key, event) => {
  const turningOn = !state[key]
  if (turningOn) {
    for (const o of debugOptions) {
      if (o.key !== key && state[o.key]) {
        state[o.key] = false
        emit(o.key, o.event)
      }
    }
  }
  state[key] = turningOn
  emit(key, event)
}

// Curve fidelity: passed straight to toolpath.js's tessellation tolerance.
const setTessellation = (key) => {
  state.tessellation = key
  setStoredViewSetting('tessellation', key)
  const opt = tessOptions.find((o) => o.key === key)
  eventBus.emit('tessellation-changed', opt.tol)
}

// Close all flyouts on an outside click.
const onDocClick = (e) => {
  if (root.value && !root.value.contains(e.target)) {
    debugOpen.value = false; rasterOpen.value = false
    tessOpen.value = false; focusOpen.value = false
  }
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  // Re-broadcast the restored settings once: ThreeViewer also self-sources
  // them directly on its own mount (belt-and-suspenders, same reasoning as
  // theme.js), but App.vue's debug/gradient overlay flags only exist as
  // event listeners with no storage-reading of their own - this is what
  // brings THOSE back in sync after a reload.
  eventBus.emit('show-travel-changed', state.showTravel)
  eventBus.emit('rulers-changed', state.showRulers)
  eventBus.emit('raster-mode-changed', state.rasterMode)
  eventBus.emit('debug-colors-changed', state.debugColors)
  eventBus.emit('speed-gradient-changed', state.speedGradient)
  eventBus.emit('tessellation-changed', tessOptions.find((o) => o.key === state.tessellation)?.tol ?? TESSELLATION_TOL_BY_KEY.normal)
})
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<style scoped>
.view-toggles {
  /* Placement now comes from the shared .top-right-controls column in
     App.vue, this is just the (still vertical) group of its own 4 buttons. */
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* Button, hover hint and flyout now live in src/theme.css - shared with
   ThemeToggle and LanguageSwitcher, which are part of the same column. Only
   the group's own layout stays here. */
</style>
