<template>
  <div class="download-container">
    <!-- Estimated job time -->
    <div class="timer-section">
      <div class="time-display">{{ formattedTime }}</div>
    </div>

    <!-- Download Button -->
    <button class="download-btn" @click="handleDownload">
      <span class="download-text">Download</span>
    </button>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import eventBus from '../eventBus'

// Predicted job duration (seconds), from the toolpath stats.
const elapsedTime = ref(0)

const formattedTime = computed(() => {
  if (!elapsedTime.value || elapsedTime.value <= 0) return '--:--'
  const minutes = Math.floor(elapsedTime.value / 60)
  const seconds = Math.floor(elapsedTime.value % 60)
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
})

const handleDownload = () => {
  // Handled in the ThreeViewer component.
  eventBus.emit('save_pdf_request')
}

const onStats = (stats) => { elapsedTime.value = Math.round(stats?.totalTime ?? 0) }

onMounted(() => eventBus.on('toolpath-stats', onStats))
onBeforeUnmount(() => eventBus.off('toolpath-stats', onStats))
</script>

<style scoped>
.download-container {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
  padding: 16px 20px;
}

/* Timer Section */
.timer-section {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
}

.time-display {
  font-size: 32px;
  font-weight: 700;
  font-family: 'Courier New', monospace;
  color: var(--text-strong);
  letter-spacing: 2px;
  font-variant-numeric: tabular-nums;
}

/* Download Button */
.download-btn {
  width: 100%;
  padding: 12px 20px;
  background: #00ADC6;
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
  transition: background 0.2s ease, transform 0.2s ease;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.download-btn:hover {
  background: #0093A8;
  transform: translateY(-1px);
}

.download-btn:active {
  transform: translateY(0);
}

.download-text {
  font-size: 14px;
}
</style>
