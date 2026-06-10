<template>
  <div class="playback-container">
    <h3 class="section-title">Playback Controls</h3>

    <div class="spacer"></div>
    
    <div class="controls-wrapper">
      <!-- Play Button -->
      <button class="play-btn" @click="handlePlayPause">
        <span class="play-icon">{{ isPlaying ? '⏸' : '▶' }}</span>
      </button>
      
      <!-- Playback Bar (Progress) - Now Draggable -->
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
            <div 
              class="playback-progress" 
              :style="{ width: progress + '%' }"
            ></div>
          </div>
        </div>
        <div class="time-labels">
          <span>{{ formatTime(currentTime) }}</span>
          <span>{{ formatTime(totalTime) }}</span>
        </div>
      </div>
      
      <!-- Speed Slider -->
      <div class="speed-control">
        <label class="speed-label">
          Speed:
          <span class="speed-value">{{ speed }}x</span>
        </label>
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
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 15px;
  background: #ffffff;
  border-radius: 8px;
}

.section-title {
  margin: 0 0 15px 0;
  font-size: 16px;
  font-weight: 600;
  color: #2c3e50;
  border-bottom: 2px solid #ecf0f1;
  padding-bottom: 8px;
}

.controls-wrapper {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
  flex: 7;
}

.spacer {
  flex: 3;
}

/* Play Button */
.play-btn {
  width: 50px;
  height: 50px;
  border-radius: 50%;
  background: #3498db;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
}

.play-btn:hover {
  background: #2980b9;
  transform: scale(1.05);
}

.play-btn:active {
  transform: scale(0.95);
}

.play-icon {
  font-size: 24px;
  color: white;
}

/* Playback Bar Container */
.playback-bar-container {
  flex: 1;
  min-width: 200px;
}

.playback-bar-wrapper {
  position: relative;
  width: 100%;
}

/* Hidden slider for dragging */
.playback-slider {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 6px;
  opacity: 0;
  cursor: pointer;
  z-index: 2;
  margin: 0;
}

/* Visual bar */
.playback-bar {
  width: 100%;
  height: 6px;
  background: #ecf0f1;
  border-radius: 3px;
  overflow: hidden;
  position: relative;
  pointer-events: none;
}

.playback-progress {
  height: 100%;
  background: #3498db;
  border-radius: 3px;
  transition: width 0.05s linear;
  position: relative;
}

.playback-progress::after {
  content: '';
  position: absolute;
  right: -4px;
  top: 50%;
  transform: translateY(-50%);
  width: 12px;
  height: 12px;
  background: #3498db;
  border-radius: 50%;
  box-shadow: 0 0 5px rgba(0, 0, 0, 0.2);
}

/* Make the bar look draggable */
.playback-bar-container:hover .playback-bar {
  background: #d5dbdb;
}

.time-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 12px;
  color: #7f8c8d;
}

/* Speed Control */
.speed-control {
  min-width: 150px;
}

.speed-label {
  display: block;
  font-size: 12px;
  color: #7f8c8d;
  margin-bottom: 5px;
}

.speed-value {
  font-weight: 600;
  color: #3498db;
  margin-left: 5px;
}

.speed-slider {
  width: 100%;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: #ecf0f1;
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}

.speed-slider::-webkit-slider-runnable-track {
  width: 100%;
  height: 4px;
  background: #ecf0f1;
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
  background: #ecf0f1;
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