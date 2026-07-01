<template>
  <div class="playback-container">
    <div class="controls-wrapper">
      <!-- Play / Pause -->
      <button class="play-btn" @click="handlePlayPause" :aria-label="isPlaying ? 'Pause' : 'Play'">
        <span class="play-icon" :class="{ 'is-play': !isPlaying }">{{ isPlaying ? '⏸' : '▶' }}</span>
      </button>

      <!-- Current time -->
      <span class="time-label">{{ formatTime(currentTime) }}</span>

      <!-- Timeline -->
      <div class="playback-bar-container">
        <div class="playback-bar-wrapper">
          <input
            type="range"
            min="0"
            max="100"
            step="any"
            v-model.number="progress"
            class="playback-slider"
            @input="handleProgressChange"
            @mousedown="handleSliderMouseDown"
            @mouseup="handleSliderMouseUp"
          />
          <div class="playback-bar">
            <div class="playback-progress" :style="{ width: progress + '%' }"></div>
          </div>
        </div>
      </div>

      <!-- Total time -->
      <span class="time-label">{{ formatTime(totalTime) }}</span>

      <!-- Speed dropdown: fixed presets + a custom value. Styled to match the
           sidebar's material/cutter dropdown (ProfileDropdown), just flipped
           to open upward — it lives at the bottom of the screen, so opening
           down would run off-screen. -->
      <div class="speed-control" ref="speedRef">
        <span class="speed-label">{{ t('speed') }}</span>
        <button
          class="speed-toggle"
          :class="{ open: speedOpen, 'dir-up': openUp, 'dir-down': speedOpen && !openUp }"
          @click="toggleSpeedMenu"
        >
          <span class="speed-value">{{ speedLabel }}x</span>
          <span class="arrow" :class="{ rotated: speedOpen }">▾</span>
        </button>

        <!-- Teleported to the app's theme-scoped portal root (not <body>):
             the playback island clips overflow (for its rounded corners), so
             a child-positioned menu would get cut off however it opened —
             but body is outside .cc-theme, which is where --dropdown-bg etc.
             are defined, so plain <body> would render an unstyled menu.
             Fixed-positioned + measured in JS instead. -->
        <Teleport to="#cc-portal-root" defer>
          <div
            class="speed-menu"
            ref="menuRef"
            v-show="speedOpen"
            :class="{ 'dir-up': openUp, 'dir-down': !openUp }"
            :style="menuStyle"
          >
            <button
              v-for="p in SPEED_PRESETS"
              :key="p"
              class="speed-item"
              :class="{ active: speed === p }"
              @click="choosePreset(p)"
            >{{ p }}x</button>
            <input
              ref="customInputRef"
              type="number"
              min="0.1"
              step="0.1"
              class="speed-custom-input"
              :placeholder="t('customSpeed')"
              v-model="customSpeedInput"
              @keydown.enter="applyCustomSpeed"
              @click.stop
            />
          </div>
        </Teleport>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onBeforeUnmount, onMounted } from 'vue'
import eventBus from '../eventBus'
import { t } from '../translations'

// State
const isPlaying = ref(false)
const progress = ref(0)     // 0..100, reflects the head position on the toolpath
const speed = ref(1.0)
const isDragging = ref(false)

const totalTime = ref(0)    // seconds — from toolpath stats
const currentTime = computed(() => (progress.value / 100) * totalTime.value)

// Speed is picked from a small dropdown (fixed presets + a free-form custom
// value) rather than a slider — presets cover the "watch it fly by" range;
// custom covers everything else.
const SPEED_PRESETS = [0.5, 1, 2, 4, 8, 16]
const speedOpen = ref(false)
const speedRef = ref(null)
const menuRef = ref(null)
const customInputRef = ref(null)
const customSpeedInput = ref('')
// The menu is teleported out of the island (see template) because it clips
// overflow for its rounded corners — a child-positioned menu would get cut
// off whichever way it opened. Position it in the viewport instead, flipped
// to whichever side (above/below the toggle) actually has room. It touches
// the toggle with zero gap (like ProfileDropdown's top:100%) so the two look
// like one seamless control — just flipped, opening up instead of down.
const menuStyle = ref({ position: 'fixed', top: '-9999px', left: '-9999px' })
const openUp = ref(true)

const positionSpeedMenu = () => {
  const btn = speedRef.value?.querySelector('.speed-toggle')
  if (!btn || !menuRef.value) return
  const b = btn.getBoundingClientRect()
  const m = menuRef.value
  // Same width as the toggle (like ProfileDropdown's menu matching its own
  // toggle) rather than a fixed min-width — it was noticeably wider than the
  // "16x ▾" button before.
  openUp.value = b.top - m.offsetHeight > 0
  const top = openUp.value ? b.top - m.offsetHeight : b.bottom
  menuStyle.value = { position: 'fixed', top: `${top}px`, left: `${b.left}px`, width: `${b.width}px` }
}

// Trim trailing zeros ("2x" not "2.0x"), but keep real decimals ("2.5x").
const speedLabel = computed(() => {
  const s = speed.value
  return Number.isInteger(s) ? String(s) : String(Math.round(s * 100) / 100)
})

// Format time as MM:SS
const formatTime = (seconds) => {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// ── Inbound events ────────────────────────────────────────────────────────────
// The ThreeViewer owns the playback clock (advanced per render frame) and reports
// the head position back via 'playback_tick'. We just reflect it on the slider.
const handleLinesUpdated  = () => { progress.value = 0; isPlaying.value = false }
const handleToolpathStats = (stats) => { totalTime.value = stats?.totalTime ?? 0 }
const handleTick  = (p) => { if (!isDragging.value) progress.value = p }
const handleEnded = () => { isPlaying.value = false }

// Close the menu when clicking outside it (pointerdown/capture, like the other
// dropdowns in the app, so it also closes on a click over the canvas). The menu
// itself lives under <body> (teleported), so both it and the toggle need checking.
const onDocClick = (e) => {
  if (speedRef.value?.contains(e.target)) return
  if (menuRef.value?.contains(e.target)) return
  speedOpen.value = false
}

// Keep the menu correctly placed if the window is resized while it's open.
const onWindowResize = () => { if (speedOpen.value) positionSpeedMenu() }

onMounted(() => {
  eventBus.on('lines-updated',   handleLinesUpdated)
  eventBus.on('toolpath-stats',  handleToolpathStats)
  eventBus.on('playback_tick',   handleTick)
  eventBus.on('playback_ended',  handleEnded)
  document.addEventListener('pointerdown', onDocClick, true)
  window.addEventListener('resize', onWindowResize)
})
onBeforeUnmount(() => {
  eventBus.off('lines-updated',  handleLinesUpdated)
  eventBus.off('toolpath-stats', handleToolpathStats)
  eventBus.off('playback_tick',  handleTick)
  eventBus.off('playback_ended', handleEnded)
  document.removeEventListener('pointerdown', onDocClick, true)
  window.removeEventListener('resize', onWindowResize)
})

// ── Controls ──────────────────────────────────────────────────────────────────
const handlePlayPause = () => {
  isPlaying.value = !isPlaying.value
  eventBus.emit('playback_playpause', isPlaying.value)
}

const setSpeed = (val) => {
  const v = Number(val)
  if (!isFinite(v) || v <= 0) return
  speed.value = v
  eventBus.emit('playback_speed', speed.value)
}

const toggleSpeedMenu = () => {
  speedOpen.value = !speedOpen.value
  if (speedOpen.value) {
    customSpeedInput.value = ''
    nextTick(() => {
      positionSpeedMenu()   // measure the now-visible menu and place it correctly
      customInputRef.value?.focus()
    })
  }
}

const choosePreset = (p) => {
  setSpeed(p)
  speedOpen.value = false
}

const applyCustomSpeed = () => {
  if (customSpeedInput.value === '') return
  setSpeed(customSpeedInput.value)
  speedOpen.value = false
}

const handleProgressChange = (event) => {
  progress.value = parseFloat(event.target.value)
  eventBus.emit('playback_seek', progress.value)
}

const handleSliderMouseDown = () => { isDragging.value = true }
const handleSliderMouseUp   = () => { isDragging.value = false }
</script>

<style scoped>
.playback-container {
  width: 100%;
  display: flex;
  align-items: center;     /* vertically centre the single control row */
  padding: 12px 18px;
  background: transparent;
}

.controls-wrapper {
  display: flex;
  align-items: center;     /* timeline + speed slider sit on one line */
  gap: 16px;
  width: 100%;
}

/* Play Button */
.play-btn {
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  border-radius: 50%;
  background: #00ADC6;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s ease, transform 0.2s ease;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.15);
}

.play-btn:hover {
  background: #0093A8;
  transform: scale(1.05);
}

.play-btn:active {
  transform: scale(0.95);
}

.play-icon {
  font-size: 20px;
  line-height: 1;
  color: white;
}

/* Optically centre the ▶ triangle (the pause glyph is already centred). */
.play-icon.is-play {
  padding-left: 3px;
}

/* Time labels (inline, on either side of the timeline) */
.time-label {
  flex-shrink: 0;
  min-width: 36px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

/* Playback Bar Container */
.playback-bar-container {
  flex: 1;
  min-width: 120px;
}

.playback-bar-wrapper {
  position: relative;
  width: 100%;
  height: 14px;            /* bigger hit area; bar is centred within */
  display: flex;
  align-items: center;
}

/* Hidden slider for dragging */
.playback-slider {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
  z-index: 2;
  margin: 0;
}

/* Visual bar */
.playback-bar {
  width: 100%;
  height: 6px;
  background: var(--track-bg);
  border-radius: 3px;
  position: relative;
  pointer-events: none;
}

.playback-progress {
  height: 100%;
  background: #00ADC6;
  border-radius: 3px;
  position: relative;
}

/* Timeline knob — same size/shadow as the speed-slider thumb for consistency. */
.playback-progress::after {
  content: '';
  position: absolute;
  right: -8px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  background: #00ADC6;
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

/* Speed Control — a small dropdown (fixed presets + a custom value) */
.speed-control {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.speed-label {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
}

/* Toggle mirrors .dropdown-toggle (ProfileDropdown) — same colours/border/
   radius — but flattens its TOP corners when open (the menu attaches above
   it), the mirror image of the sidebar dropdown flattening its bottom. */
.speed-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  background: var(--ctrl-bg);
  border: 1px solid var(--ctrl-border);
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;
}
.speed-toggle:hover { background: var(--ctrl-hover); }
.speed-toggle.open.dir-up {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
.speed-toggle.open.dir-down {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}

.speed-value {
  font-weight: 600;
  color: #00ADC6;
  display: inline-block;
  min-width: 1.6em;          /* reserve space so "2x"→"16x" doesn't shift layout */
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.speed-toggle .arrow {
  color: var(--text-strong);
  font-size: 15px;
  line-height: 1;
  transition: transform 0.2s;
}
.speed-toggle .arrow.rotated { transform: rotate(180deg); }

/* Mirrors .dropdown-menu (ProfileDropdown): same background/border/shadow,
   touching the toggle with zero gap so together they read as one control —
   just flipped, so it's the BOTTOM edge that's seamless (border-bottom:none,
   only the top corners rounded) instead of the top edge. position/top/left/
   width come from the inline :style (computed in JS, see positionSpeedMenu —
   width matches the toggle button exactly). */
.speed-menu {
  background: var(--dropdown-bg);
  border: 1px solid var(--dropdown-border);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
  z-index: 100;
  overflow: hidden;
}
.speed-menu.dir-up {
  border-bottom: none;
  border-radius: 8px 8px 0 0;
}
.speed-menu.dir-down {
  border-top: none;
  border-radius: 0 0 8px 8px;
}

.speed-item {
  display: block;
  width: 100%;
  padding: 10px 16px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 500;
  text-align: left;
  transition: background 0.15s;
}
.speed-item:hover { background: var(--hover-bg); }
.speed-item.active { background: var(--active-bg); }

/* Custom value — same field as the sidebar's material search (.dropdown-search),
   just Enter to apply (no separate button needed). */
.speed-custom-input {
  width: calc(100% - 16px);
  margin: 8px;
  padding: 8px 10px;
  border: 1px solid var(--dropdown-border);
  border-radius: 6px;
  background: var(--panel-bg);
  color: var(--text-strong);
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}
/* Hide the native number spinner so it doesn't crowd the small field. */
.speed-custom-input::-webkit-outer-spin-button,
.speed-custom-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.speed-custom-input { appearance: textfield; }

/* Responsive */
@media (max-width: 768px) {
  .controls-wrapper {
    flex-direction: column;
    align-items: stretch;
  }

  .playback-bar-container {
    width: 100%;
  }

  .play-btn {
    align-self: center;
  }
}
</style>