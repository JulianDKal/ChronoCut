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

      <!-- Speed -->
      <div class="speed-control">
        <span class="speed-label">Speed <span class="speed-value">{{ speed }}x</span></span>
        <input
          type="range"
          min="0.5"
          max="3"
          step="0.1"
          v-model.number="speed"
          class="speed-slider"
          @input="handleSpeedChange"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onBeforeUnmount, onMounted } from 'vue'
import eventBus from '../eventBus'

// State
const isPlaying = ref(false)
const progress = ref(0)     // 0..100, reflects the head position on the toolpath
const speed = ref(1.0)
const isDragging = ref(false)

const totalTime = ref(0)    // seconds — from toolpath stats
const currentTime = computed(() => (progress.value / 100) * totalTime.value)

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

onMounted(() => {
  eventBus.on('lines-updated',   handleLinesUpdated)
  eventBus.on('toolpath-stats',  handleToolpathStats)
  eventBus.on('playback_tick',   handleTick)
  eventBus.on('playback_ended',  handleEnded)
})
onBeforeUnmount(() => {
  eventBus.off('lines-updated',  handleLinesUpdated)
  eventBus.off('toolpath-stats', handleToolpathStats)
  eventBus.off('playback_tick',  handleTick)
  eventBus.off('playback_ended', handleEnded)
})

// ── Controls ──────────────────────────────────────────────────────────────────
const handlePlayPause = () => {
  isPlaying.value = !isPlaying.value
  eventBus.emit('playback_playpause', isPlaying.value)
}

const handleSpeedChange = () => {
  eventBus.emit('playback_speed', speed.value)
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
  background: #3498db;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s ease, transform 0.2s ease;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.15);
}

.play-btn:hover {
  background: #2980b9;
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
  background: #3498db;
  border-radius: 3px;
  position: relative;
}

.playback-progress::after {
  content: '';
  position: absolute;
  right: -6px;
  top: 50%;
  transform: translateY(-50%);
  width: 12px;
  height: 12px;
  background: #3498db;
  border-radius: 50%;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.25);
}

/* Make the bar look draggable */
.playback-bar-container:hover .playback-bar {
  background: #d5dbdb;
}

/* Speed Control */
.speed-control {
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

.speed-value {
  font-weight: 600;
  color: #3498db;
}

.speed-slider {
  width: 90px;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: var(--track-bg);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}

.speed-slider::-webkit-slider-runnable-track {
  width: 100%;
  height: 4px;
  background: var(--track-bg);
  border-radius: 2px;
}

.speed-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #3498db;
  cursor: pointer;
  margin-top: -6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.speed-slider::-webkit-slider-thumb:hover {
  transform: scale(1.2);
}

/* Firefox support */
.speed-slider::-moz-range-track {
  width: 100%;
  height: 4px;
  background: var(--track-bg);
  border-radius: 2px;
}

.speed-slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #3498db;
  cursor: pointer;
  border: none;
}

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