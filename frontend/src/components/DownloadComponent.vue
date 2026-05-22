<template>
  <div class="download-container">
    <div class="framed-box">
      <!-- Timer Icon and Time -->
      <div class="timer-section">
        <div class="time-display">{{ formattedTime }}</div>
      </div>
    
      <!-- Download Button -->
      <button class="download-btn" @click="handleDownload">
        <span class="download-text">Download</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import eventBus from '../eventBus'

// Sample time data (can be updated from props later)
const elapsedTime = ref(125) // seconds - example: 2 minutes 5 seconds

// Format time as MM:SS
const formattedTime = computed(() => {
  const minutes = Math.floor(elapsedTime.value / 60)
  const seconds = elapsedTime.value % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
})

// Download handler (no functionality yet)
const handleDownload = () => {
  //event handled in ThreeViewer component
  eventBus.emit('save_pdf_request');
}

// Optional: Allow time to be updated from parent component
const updateTime = (newTime) => {
  elapsedTime.value = newTime
}

// Expose methods to parent if needed
defineExpose({
  updateTime
})
</script>

<style scoped>
.download-container {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 15px;
  margin-right: 50px;
  margin-left: 50px;
}

.framed-box {
  width: 100%;
  height: 100%;
  background: #ffffff;
  border: 2px solid #dee2e6;
  border-radius: 12px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  gap: 15px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
  transition: all 0.3s ease;
}

/* Timer Section */
.timer-section {
  text-align: center;
  flex: 1;
  display: flex;
  flex-direction:row;
  justify-content: left;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.time-display {
  font-size: 32px;
  font-weight: 700;
  font-family: 'Courier New', monospace;
  color: #2c3e50;
  letter-spacing: 2px;
  background: #ffffff;
  padding: 8px 16px;
  border-radius: 8px;
  /* box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.1); */
}

/* Divider */
.divider {
  width: 80%;
  height: 1px;
  background: linear-gradient(to right, transparent, #cbd5e0, transparent);
}

/* Download Button */
.download-btn {
  width: 100%;
  padding: 12px 20px;
  background: #70D2FF;
  color: white;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 16px;
  font-weight: 600;
  transition: all 0.3s ease;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.download-text {
  font-size: 14px;
}


/* Responsive */
@media (max-width: 768px) {
  .framed-box {
    padding: 15px;
  }
  
  .time-display {
    font-size: 24px;
  }
  
  .timer-icon {
    font-size: 36px;
  }
  
  .download-btn {
    padding: 10px 15px;
  }
}
</style>