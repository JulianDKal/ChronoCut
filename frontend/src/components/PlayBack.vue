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
            step="1" 
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
import { ref, computed, watch, onBeforeUnmount, onMounted } from 'vue'
import eventBus from '../eventBus'

// State
const isPlaying = ref(false)
const progress = ref(0)
const speed = ref(1.0)
const isDragging = ref(false)

const totalTime = ref(100) //For now, just an arbitray number
const currentTime = computed(() => (progress.value / 100) * totalTime.value)

onMounted(() => {
  eventBus.on('lines-updated', () => {
    progress.value = 0;
  })
})

// Format time as MM:SS
const formatTime = (seconds) => {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// Timer reference
let progressInterval = null

// Start progress animation
const startProgress = () => {
  if (progressInterval) clearInterval(progressInterval)
  progressInterval = setInterval(() => {
    if (isPlaying.value && !isDragging.value && progress.value < 100) {
      progress.value = Math.min(progress.value + 1, 100)
      eventBus.emit('playback_progress', progress.value)
      
      if (progress.value >= 100) {
        isPlaying.value = false
        stopProgress()
      }
    }
  }, 1000 / (speed.value * 10)) // Speed affects animation rate
}

// Stop progress animation
const stopProgress = () => {
  if (progressInterval) {
    clearInterval(progressInterval)
    progressInterval = null
  }
}

// Handlers
const handlePlayPause = () => {
  isPlaying.value = !isPlaying.value
  console.log('Play/Pause clicked - State:', isPlaying.value ? 'Playing' : 'Paused')
  
  if (isPlaying.value) {
    startProgress()
  } else {
    stopProgress()
  }
  
  eventBus.emit('playback_playpause', isPlaying.value)
}

const handleSpeedChange = () => {
  console.log('Speed changed to:', speed.value)
  eventBus.emit('playback_speed', speed.value)
  
  // Restart progress with new speed if playing
  if (isPlaying.value) {
    startProgress()
  }
}

const handleProgressChange = (event) => {
  progress.value = parseFloat(event.target.value)
  console.log('Progress changed to:', progress.value)
  eventBus.emit('playback_progress', progress.value)
}

const handleSliderMouseDown = () => {
  isDragging.value = true
  if (isPlaying.value) {
    // Pause temporarily while dragging
    stopProgress()
  }
}

const handleSliderMouseUp = () => {
  isDragging.value = false
  if (isPlaying.value && progress.value < 100) {
    startProgress()
  }
}

// Watch progress for external changes
watch(progress, (newValue) => {
  if (newValue >= 100) {
    isPlaying.value = false
    stopProgress()
  }
})

// Watch isPlaying to manage timer
watch(isPlaying, (newValue) => {
  if (newValue && !isDragging.value) {
    startProgress()
  } else if (!newValue) {
    stopProgress()
  }
})

// Cleanup on component unmount
onBeforeUnmount(() => {
  stopProgress()
})
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