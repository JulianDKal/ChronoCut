<template>
  <div class="view-toggles" ref="root">
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
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, computed, onMounted, onBeforeUnmount } from 'vue'
import eventBus from '../eventBus'
import { t } from '../translations'

// Floating view toggles (top-right). State defaults match the ThreeViewer's own
// defaults, so no initial emit is needed; clicking emits the same events the
// sidebar used to send.
const state = reactive({
  showTravel: true,
  showRulers: true,
  rasterMode: 'lines',   // 'lines' | 'block' | 'outline'
  debugColors: false,
  speedGradient: false,
})

const debugOpen = ref(false)
const rasterOpen = ref(false)
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

const emit = (key, event) => eventBus.emit(event, state[key])

// Only one flyout open at a time.
const toggleMenu = (which) => {
  if (which === 'raster') { rasterOpen.value = !rasterOpen.value; debugOpen.value = false }
  else                    { debugOpen.value = !debugOpen.value; rasterOpen.value = false }
}

const toggle = (tg) => {
  state[tg.key] = !state[tg.key]
  debugOpen.value = false
  rasterOpen.value = false
  emit(tg.key, tg.event)
}

// Raster: "filled" and "outline" are mutually exclusive; clicking the active one
// turns it off (→ back to normal scan lines).
const setRaster = (mode) => {
  state.rasterMode = state.rasterMode === mode ? 'lines' : mode
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

// Close both flyouts on an outside click.
const onDocClick = (e) => {
  if (root.value && !root.value.contains(e.target)) { debugOpen.value = false; rasterOpen.value = false }
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<style scoped>
.view-toggles {
  position: absolute;
  top: 16px;
  right: 70px;            /* left column, next to the theme + language buttons */
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.vt-btn {
  position: relative;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  border: 1px solid var(--panel-border);
  background: var(--card-bg);
  color: var(--text-strong);
  box-shadow: var(--panel-shadow);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: transform 0.15s ease, background 0.2s ease, color 0.2s ease;
}
.vt-btn:hover { transform: scale(1.08); }
.vt-btn.active {
  background: #00ADC6;
  border-color: #00ADC6;
  color: #fff;
}

.vt-icon { display: flex; }
.vt-icon :deep(svg) { width: 22px; height: 22px; display: block; }

/* Tooltip — flies out to the LEFT so it never leaves the viewport edge. */
.vt-tip {
  position: absolute;
  right: calc(100% + 10px);
  top: 50%;
  transform: translateY(-50%);
  white-space: nowrap;
  padding: 5px 9px;
  border-radius: 6px;
  background: var(--card-bg);
  color: var(--text-strong);
  border: 1px solid var(--panel-border);
  box-shadow: var(--panel-shadow);
  font-size: 12px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}
.vt-btn:hover .vt-tip { opacity: 1; }

/* Debug flyout */
.vt-popover { position: relative; }
.vt-menu {
  position: absolute;
  right: calc(100% + 10px);
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  min-width: 188px;
  background: var(--dropdown-bg);
  border: 1px solid var(--dropdown-border);
  border-radius: 10px;
  box-shadow: var(--panel-shadow);
}
.vt-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-radius: 7px;
  cursor: pointer;
  color: var(--text-strong);
  font-size: 13px;
  text-align: left;
  white-space: nowrap;
}
.vt-item:hover { background: var(--hover-bg); }
/* Radio indicator (the two debug modes are mutually exclusive). */
.vt-radio {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1.5px solid var(--ctrl-border);
  display: flex;
  align-items: center;
  justify-content: center;
}
.vt-radio::after {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #00ADC6;
  transform: scale(0);
  transition: transform 0.15s ease;
}
.vt-item.active .vt-radio { border-color: #00ADC6; }
.vt-item.active .vt-radio::after { transform: scale(1); }
</style>
