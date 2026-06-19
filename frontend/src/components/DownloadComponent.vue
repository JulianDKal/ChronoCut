<template>
  <div class="download-container">
    <!-- Estimated job time + expand toggle -->
    <div class="timer-section">
      <div class="time-display">{{ formattedTime }}</div>
      <button
        class="expand-btn"
        :class="{ open: expanded }"
        :disabled="!hasStats"
        :title="t('estTime')"
        @click="expanded = !expanded"
      >▾</button>
    </div>

    <!-- Per-operation breakdown (distance + time) -->
    <div v-if="expanded && hasStats" class="breakdown">
      <table class="breakdown-table">
        <thead>
          <tr>
            <th>{{ t('operation') }}</th>
            <th class="num">{{ t('distance') }}</th>
            <th class="num">{{ t('time') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.key">
            <td><span class="dot" :style="{ background: row.color }"></span>{{ row.label }}</td>
            <td class="num">{{ row.dist }}</td>
            <td class="num">{{ row.time }}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td>{{ t('total') }}</td>
            <td class="num">{{ totalDist }}</td>
            <td class="num">{{ formattedTime }}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <!-- Download Button -->
    <button class="download-btn" @click="handleDownload">
      <span class="download-text">{{ t('download') }}</span>
    </button>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import eventBus from '../eventBus'
import { t } from '../translations'

// Full toolpath stats (lengths + per-operation times), from the viewer.
const stats = ref(null)
const expanded = ref(false)

const hasStats = computed(() => !!stats.value && stats.value.totalTime > 0)

// MM:SS, or --:-- when there is nothing yet.
const fmtTime = (sec) => {
  if (!sec || sec <= 0) return '--:--'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}
// mm, switching to metres once it gets long.
const fmtDist = (mm) => (mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Math.round(mm)} mm`)

const formattedTime = computed(() => fmtTime(stats.value?.totalTime))

// One row per operation type that has any length. Colours mirror the viewer.
const rows = computed(() => {
  const s = stats.value
  if (!s) return []
  const defs = [
    { key: 'engrave', label: t('opVectorEngrave'), len: s.engraveLen, time: s.engraveTime, color: '#e0413a' },
    { key: 'raster',  label: t('opRasterEngrave'), len: s.rasterLen,  time: s.rasterTime,  color: '#00a000' },
    { key: 'cut',     label: t('opCut'),           len: s.cutLen,     time: s.cutTime,     color: '#2f6df0' },
    { key: 'other',   label: t('opOther'),         len: s.otherLen,   time: s.otherTime,   color: '#b07cff' },
    { key: 'travel',  label: t('opTravel'),        len: s.travelLen,  time: s.travelTime,  color: '#9aa0a6' },
  ]
  return defs
    .filter((d) => d.len > 0.05)
    .map((d) => ({ key: d.key, label: d.label, color: d.color, dist: fmtDist(d.len), time: fmtTime(d.time) }))
})

const totalDist = computed(() => {
  const s = stats.value
  if (!s) return fmtDist(0)
  return fmtDist((s.engraveLen || 0) + (s.rasterLen || 0) + (s.cutLen || 0) + (s.otherLen || 0) + (s.travelLen || 0))
})

const handleDownload = () => {
  // Handled in the ThreeViewer component.
  eventBus.emit('save_pdf_request')
}

const onStats = (s) => { stats.value = s || null }

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
  gap: 8px;
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

/* Expand / collapse arrow */
.expand-btn {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border: 1px solid var(--ctrl-border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-strong);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.2s ease, background 0.2s ease;
}
.expand-btn:hover:not(:disabled) { background: var(--hover-bg); }
.expand-btn.open { transform: rotate(180deg); }
.expand-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* Breakdown table */
.breakdown {
  width: 100%;
}
.breakdown-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  color: var(--text-strong);
}
.breakdown-table th {
  font-weight: 600;
  color: var(--text-muted);
  text-align: left;
  padding: 3px 6px;
  border-bottom: 1px solid var(--ctrl-border);
}
.breakdown-table td {
  padding: 4px 6px;
  white-space: nowrap;
}
.breakdown-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.breakdown-table tfoot td {
  border-top: 1px solid var(--ctrl-border);
  font-weight: 600;
}
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
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
