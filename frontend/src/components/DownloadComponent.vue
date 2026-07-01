<template>
  <div class="download-container">
    <!-- Estimated job time + expand toggle -->
    <div class="timer-section">
      <div class="time-display">{{ formattedTime }}</div>
      <span v-if="showWarning || showTinyWarning" class="warn-badge" :title="warnTitle">⚠</span>
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
      <p v-if="showWarning" class="warn-note">{{ warningText }}</p>
      <button
        v-if="showTinyWarning"
        class="warn-note tiny"
        :class="{ active: tinyHighlight }"
        @click="toggleTinyHighlight"
      >
        <span>{{ tinyText }}</span>
        <span class="warn-action">{{ tinyHighlight ? t('hideParts') : t('showParts') }}</span>
      </button>
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

// Handling-time warning: many cut-out parts cost real time the machine estimate
// ignores — each must be removed by hand. Driven by the COUNT, not the size.
const SMALL_PARTS_WARN = 10        // warn from this many parts on
const SECONDS_PER_SMALL_PART = 5   // ~ removal time per part

const smallParts = computed(() => stats.value?.smallParts || 0)
const showWarning = computed(() => smallParts.value >= SMALL_PARTS_WARN)
const warningText = computed(() =>
  t('smallPartsNote', { n: smallParts.value, time: fmtTime(smallParts.value * SECONDS_PER_SMALL_PART) }))

// Grid-fall warning: very small parts can drop through the bed grid; clicking the
// note highlights them in the viewer (off by default — only when the user checks).
const TINY_PARTS_WARN = 1          // warn once there is at least this many
const tinyParts = computed(() => stats.value?.tinyParts || 0)
const showTinyWarning = computed(() => tinyParts.value >= TINY_PARTS_WARN)
const tinyText = computed(() => t('tinyPartsNote', { n: tinyParts.value }))

const tinyHighlight = ref(false)
const toggleTinyHighlight = () => {
  tinyHighlight.value = !tinyHighlight.value
  eventBus.emit('tiny-highlight-changed', tinyHighlight.value)
}

// Combined tooltip for the ⚠ badge (both warnings, if active).
const warnTitle = computed(() =>
  [showWarning.value ? warningText.value : null, showTinyWarning.value ? tinyText.value : null]
    .filter(Boolean).join('\n'))

// One row per operation type that has any length. Colours mirror the viewer.
const rows = computed(() => {
  const s = stats.value
  if (!s) return []
  const defs = [
    { key: 'cut',     label: t('opCut'),           len: s.cutLen,     time: s.cutTime,     color: '#2f6df0' },
    { key: 'engrave', label: t('opVectorEngrave'), len: s.engraveLen, time: s.engraveTime, color: '#e0413a' },
    { key: 'raster',  label: t('opRasterEngrave'), len: s.rasterLen,  time: s.rasterTime,  color: '#00a000' },
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
// A fresh design drops any active highlight (the viewer resets its overlay too).
const onLinesUpdated = () => { tinyHighlight.value = false }

onMounted(() => {
  eventBus.on('toolpath-stats', onStats)
  eventBus.on('lines-updated', onLinesUpdated)
})
onBeforeUnmount(() => {
  eventBus.off('toolpath-stats', onStats)
  eventBus.off('lines-updated', onLinesUpdated)
})
</script>

<style scoped>
.download-container {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
  padding: 16px 20px;
  /* Without a cap, a long warning sentence (e.g. the tiny-parts note) would
     force the whole floating island wider instead of wrapping. */
  max-width: 300px;
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
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-strong);
  cursor: pointer;
  font-size: 20px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.2s ease, background 0.2s ease;
}
.expand-btn:hover:not(:disabled) { background: var(--hover-bg); }
.expand-btn.open { transform: rotate(180deg); }
.expand-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* Small-parts handling warning */
.warn-badge {
  font-size: 18px;
  line-height: 1;
  color: #e0a800;
  cursor: default;
}
.warn-note {
  margin: 8px 0 0;
  padding: 7px 9px;
  border-radius: 7px;
  background: rgba(224, 168, 0, 0.12);
  border: 1px solid rgba(224, 168, 0, 0.45);
  color: var(--text-strong);
  font-size: 11.5px;
  line-height: 1.35;
}
/* The grid-fall note is a button: click to highlight the parts in the viewer. */
.warn-note.tiny {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  text-align: left;
  cursor: pointer;
  font-family: inherit;
}
.warn-note.tiny:hover { background: rgba(224, 168, 0, 0.2); }
.warn-note.tiny.active {
  background: rgba(255, 140, 0, 0.18);
  border-color: #ff8c00;
}
.warn-action {
  align-self: flex-start;
  font-weight: 600;
  color: #d99500;
  text-decoration: underline;
}
.warn-note.tiny.active .warn-action { color: #ff8c00; }

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
