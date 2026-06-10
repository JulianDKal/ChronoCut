<template>
  <div class="playback-container">
    <h3 class="section-title">Playback Controls</h3>

    <div class="spacer"></div>
    
    <div class="controls-wrapper">
      <!-- Play Button -->
      <button class="play-btn" @click="handlePlayPause">
        <span class="play-icon">{{ isPlaying ? '⏸' : '▶' }}</span>
      </button>
      
      <!-- Playback Bar (Progress) -->
      <div class="playback-bar-container">
        <div class="playback-bar">
          <div 
            class="playback-progress" 
            :style="{ width: progress + '%' }"
          ></div>
        </div>
        <div class="time-labels">
          <span>0:00</span>
          <span>0:00</span>
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
          v-model="speed"
          class="speed-slider"
          @input="handleSpeedChange"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import eventBus from '../eventBus'

// State
const isPlaying = ref(false)
const progress = ref(0)
const speed = ref(1.0)

// Handlers (no functionality yet - just UI)
const handlePlayPause = () => {
  isPlaying.value = !isPlaying.value
  console.log('Play/Pause clicked - State:', isPlaying.value ? 'Playing' : 'Paused')
  // TODO: Implement playback logic
}

const handleSpeedChange = () => {
  console.log('Speed changed to:', speed.value)
  // TODO: Implement speed control logic
}

// Simulate progress for demo (remove when implementing real functionality)
setInterval(() => {
  if (isPlaying.value && progress.value < 100) {
    progress.value += 1
    eventBus.emit('playback_progress', progress.value) // Emit progress event
  } else if (progress.value >= 100) {
    isPlaying.value = false
    progress.value = 100
  }
}, 100)
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

/* Playback Bar */
.playback-bar-container {
  flex: 1;
  min-width: 200px;
}

.playback-bar {
  width: 100%;
  height: 6px;
  background: #ecf0f1;
  border-radius: 3px;
  cursor: pointer;
  overflow: hidden;
  position: relative;
}

.playback-progress {
  height: 100%;
  background: #3498db;
  border-radius: 3px;
  transition: width 0.1s linear;
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
  /* -webkit-appearance: none; */
  background: #ecf0f1;
  border-radius: 2px;
  outline: none;
}

.speed-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #3498db;
  cursor: pointer;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.speed-slider::-webkit-slider-thumb:hover {
  transform: scale(1.2);
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