<template>
  <div class="m-app">
    <!-- Floating controls (top-right) - the SAME components as the desktop
         view, in their own absolutely-positioned row. They used to sit in the
         page flow with the language switcher nudged into place via top/right on
         a position:relative element; a wrapper is what the desktop layout
         already does (.top-right-controls) and it survives the components
         changing their own class names. -->
    <div class="m-floating">
      <ThemeToggle :is-dark="isDark" @toggle="$emit('toggle-theme')" />
      <LanguageSwitcher />
    </div>

    <!-- Header -->
    <header class="m-header">
      <img class="m-logo" src="/logo.svg" alt="ChronoCut" />
      <div class="m-titles">
        <h1 class="m-title">ChronoCut</h1>
        <p class="m-tagline">{{ t('mobileTagline') }}</p>
      </div>
    </header>

    <!-- Upload -->
    <button class="m-upload" :disabled="isLoading" @click="handleUpload">
      <svg class="upload-icon" viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
        <path d="M12 13V3m0 0l-4 4m4-4l4 4" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" />
      </svg>
      <span>{{ isLoading ? t('uploading') : t('upload') }}</span>
    </button>
    <p v-if="fileName" class="m-filename">{{ fileName }}</p>

    <!-- Printer / Material / Thickness - shared styled dropdowns -->
    <div class="m-fields">
      <ProfileDropdown
        :model-value="selectedCutter"
        @update:model-value="onCutter"
        :items="cutters"
        :placeholder="t('selectCutter')"
        label-key="name"
        item-key="id"
        :detail="(c) => `${c.powerW}W · ${c.bedWidth}×${c.bedHeight}mm`"
      />
      <ProfileDropdown
        :model-value="selectedFamily"
        @update:model-value="onFamily"
        :items="materials"
        :placeholder="t('selectMaterial')"
        label-key="name"
        item-key="name"
        :detail="familyDetail"
        searchable
        :search-placeholder="t('searchMaterial')"
        :empty-text="t('noMatch')"
      />
      <!-- Hidden unless the material offers a real choice - see the same
           dropdown in Sidebar.vue for why. -->
      <ProfileDropdown
        v-if="hasThicknessChoice(selectedFamily)"
        :model-value="selectedThickness"
        @update:model-value="onThickness"
        :items="selectedFamily.thicknesses"
        :placeholder="t('selectThickness')"
        label-key="label"
        item-key="id"
      />
    </div>

    <!-- Path-order algorithm (same selector as the desktop sidebar) -->
    <div class="m-fields" :title="t('tipOptimize')">
      <ProfileDropdown
        :model-value="selectedPathOrder"
        @update:model-value="selectPathOrder"
        :items="pathOrderOptions"
        :placeholder="t('optimizePath')"
        label-key="name"
        item-key="id"
      />
    </div>

    <!-- Combined cleanup (Fix Colors + Remove White + Remove Doubles in one) -->
    <button class="m-clean" :disabled="!hasData || cleaning" @click="cleanAll">
      <span v-if="cleaning" class="m-spinner"></span>
      <span>{{ cleaning ? t('cleaning') : (flash || t('cleanAll')) }}</span>
    </button>

    <!-- Time estimate + breakdown + download -->
    <section class="m-result">
      <div class="m-time">{{ formattedTime }}</div>
      <p class="m-est-label">{{ t('estTime') }}</p>

      <p v-if="!hasData" class="m-hint">{{ t('noFileHint') }}</p>

      <table v-if="hasStats" class="m-breakdown">
        <tbody>
          <tr v-for="row in rows" :key="row.key">
            <td><span class="m-dot" :style="{ background: row.color }"></span>{{ row.label }}</td>
            <td class="m-num">{{ row.time }}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td>{{ t('total') }}</td>
            <td class="m-num">{{ formattedTime }}</td>
          </tr>
        </tfoot>
      </table>

      <p v-if="showWarning" class="m-warn">{{ warningText }}</p>
      <p v-if="showTinyWarning" class="m-warn">{{ tinyText }}</p>

      <button class="m-download" :disabled="!hasData" @click="handleDownload">
        {{ t('download') }}
      </button>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { loadProfiles, speedsFor, hasThicknessChoice, familyDetail } from '../profiles'
import { buildToolpath, fixColors, removeWhite, computeDoubleRemoval, PATH_ORDER_ALGORITHMS } from '../toolpath'
import { getStoredViewSettings, setStoredViewSetting } from '../viewSettings'
import { t } from '../translations'
import ProfileDropdown from './ProfileDropdown.vue'
import LanguageSwitcher from './LanguageSwitcher.vue'
import ThemeToggle from './ThemeToggle.vue'

defineProps({ isDark: { type: Boolean, default: false } })
defineEmits(['toggle-theme'])

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

// ── State ──────────────────────────────────────────────────────────────────
const isLoading = ref(false)
const cleaning = ref(false)
const flash = ref('')
const fileName = ref('')

const cutters = ref([])
const materials = ref([])
const selectedCutter = ref(null)
const selectedFamily = ref(null)
const selectedThickness = ref(null)

const data = ref(null)          // current (edited) extraction objects

// Path-order algorithm - selectable for debugging/comparison, see toolpath.js.
const PATH_ORDER_LABEL_KEY = { file: 'pathOrderFile', nn: 'pathOrderNn', '2opt': 'pathOrder2opt' }
const pathOrderOptions = computed(() =>
  PATH_ORDER_ALGORITHMS.map((id) => ({ id, name: t(PATH_ORDER_LABEL_KEY[id]) })))
// Shared with the desktop sidebar's storage key, so the choice made on one
// layout still shows up after switching to the other.
const selectedPathOrderId = ref(getStoredViewSettings().pathOrder)
const selectedPathOrder = computed(() =>
  pathOrderOptions.value.find((o) => o.id === selectedPathOrderId.value))
const selectPathOrder = (opt) => {
  selectedPathOrderId.value = opt.id
  setStoredViewSetting('pathOrder', opt.id)
}

const hasData = computed(() => Array.isArray(data.value) && data.value.length > 0)

// ── Selection cascade (same auto-pick behaviour as the desktop sidebar) ──────
const pickThickness = () => { selectedThickness.value = selectedFamily.value?.thicknesses?.[0] || null }
const onCutter = (c) => {
  selectedCutter.value = c
  materials.value = c?.materials || []
  selectedFamily.value = materials.value[0] || null
  pickThickness()
}
const onFamily = (f) => { selectedFamily.value = f; pickThickness() }
const onThickness = (th) => { selectedThickness.value = th }

// ── Time estimate (same engine as the 3D viewer, just no rendering) ──────────
const speedOpts = computed(() =>
  (selectedCutter.value && selectedThickness.value)
    ? speedsFor(selectedCutter.value, selectedThickness.value)
    : null)

const stats = computed(() => {
  if (!hasData.value || !speedOpts.value) return null
  try {
    return buildToolpath(data.value, { optimize: selectedPathOrderId.value, ...speedOpts.value }).stats
  } catch (e) {
    console.error('toolpath error:', e)
    return null
  }
})
const hasStats = computed(() => !!stats.value && stats.value.totalTime > 0)

const fmtTime = (sec) => {
  if (!sec || sec <= 0) return '--:--'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}
const formattedTime = computed(() => fmtTime(stats.value?.totalTime))

// Per-operation breakdown (time only - slim for mobile). Colours mirror the viewer.
const rows = computed(() => {
  const s = stats.value
  if (!s) return []
  return [
    { key: 'cut',     label: t('opCut'),           len: s.cutLen,     time: s.cutTime,     color: '#2f6df0' },
    { key: 'engrave', label: t('opVectorEngrave'), len: s.engraveLen, time: s.engraveTime, color: '#e0413a' },
    { key: 'raster',  label: t('opRasterEngrave'), len: s.rasterLen,  time: s.rasterTime,  color: '#00a000' },
    { key: 'other',   label: t('opOther'),         len: s.otherLen,   time: s.otherTime,   color: '#b07cff' },
    { key: 'travel',  label: t('opTravel'),        len: s.travelLen,  time: s.travelTime,  color: '#9aa0a6' },
  ].filter((d) => d.len > 0.05).map((d) => ({ ...d, time: fmtTime(d.time) }))
})

// Warnings (same thresholds as the desktop download panel).
const SECONDS_PER_SMALL_PART = 5
const smallParts = computed(() => stats.value?.smallParts || 0)
const showWarning = computed(() => smallParts.value >= 10)
const warningText = computed(() =>
  t('smallPartsNote', { n: smallParts.value, time: fmtTime(smallParts.value * SECONDS_PER_SMALL_PART) }))
const tinyParts = computed(() => stats.value?.tinyParts || 0)
const showTinyWarning = computed(() => tinyParts.value >= 1)
const tinyText = computed(() => t('tinyPartsNote', { n: tinyParts.value }))

// ── Upload ───────────────────────────────────────────────────────────────────
const handleUpload = () => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.svg,.pdf'
  input.onchange = async (e) => {
    const file = e.target.files[0]
    if (file) await uploadFile(file)
  }
  input.click()
}

const uploadFile = async (file) => {
  isLoading.value = true
  flash.value = ''
  try {
    const formData = new FormData()
    formData.append('file', file)
    const res = await fetch(`${API_URL}/api/pdf_extraction`, { method: 'POST', body: formData })
    if (!res.ok) throw new Error('Upload failed')
    const result = await res.json()
    data.value = result.lines
    fileName.value = file.name
  } catch (err) {
    console.error('Upload error:', err)
    alert(t('uploadError') + err.message)
  } finally {
    isLoading.value = false
  }
}

// ── Combined cleanup: Fix Colors → Remove White → Remove Doubles ─────────────
const showFlash = (text) => {
  flash.value = text
  setTimeout(() => { flash.value = '' }, 1600)
}

const cleanAll = () => {
  if (!hasData.value || cleaning.value) return
  cleaning.value = true
  // Defer so the spinner paints before the (synchronous) work runs.
  setTimeout(() => {
    let n = 0
    let d = data.value

    const fixed = fixColors(d)
    for (let i = 0; i < fixed.length; i++) if (fixed[i] !== d[i]) n++
    d = fixed

    const beforeWhite = d.length
    d = removeWhite(d)
    n += beforeWhite - d.length

    const res = computeDoubleRemoval(d)
    if (res.removed.length) { n += res.removed.length; d = res.data }

    data.value = d
    cleaning.value = false
    showFlash(n > 0 ? t('cleanAllDone', { n }) : t('cleanAllNone'))
  }, 0)
}

// ── Download (current, edited drawing → backend rebuilds the PDF) ─────────────
const handleDownload = async () => {
  if (!hasData.value) return
  try {
    const res = await fetch(`${API_URL}/api/save_pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data.value),
    })
    if (!res.ok) throw new Error('Failed to save PDF')
    const blob = await res.blob()
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    const cd = res.headers.get('Content-Disposition')
    let filename = 'laser_drawing.pdf'
    if (cd) {
      const m = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)
      if (m?.[1]) filename = m[1].replace(/['"]/g, '')
    }
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)
  } catch (e) {
    console.error('Error saving PDF:', e)
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
onMounted(async () => {
  const { printers } = await loadProfiles()
  cutters.value = printers
  if (cutters.value.length) onCutter(cutters.value[0])
})
</script>

<style scoped>
.m-app {
  --red: #DE041F;
  --teal: #00ADC6;
  position: relative;
  box-sizing: border-box;
  width: 100%;
  height: 100vh;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  /* Same theming as ProfileDropdown's .dropdown-list: the default scrollbar
     ignores dark mode entirely otherwise. */
  scrollbar-width: thin;
  scrollbar-color: var(--ctrl-border) transparent;
  padding: 18px 16px 40px;
  background: var(--panel-bg);
  color: var(--text-strong);
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  display: flex;
  flex-direction: column;
  gap: 14px;
  transition: background 0.25s ease;
}
.m-app::-webkit-scrollbar { width: 8px; }
.m-app::-webkit-scrollbar-track { background: transparent; }
.m-app::-webkit-scrollbar-thumb {
  background: var(--ctrl-border);
  border-radius: 4px;
}
.m-app::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

/* The two reused controls share the top-right corner and clear the header +
   upload button below (see .m-header's padding-right). */
.m-floating {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 30;
  display: flex;
  flex-direction: row-reverse;   /* theme toggle stays rightmost, as before */
  align-items: center;
  gap: 8px;
}

/* Header */
.m-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-right: 96px;   /* clear the two floating top-right controls */
  min-height: 44px;
}
.m-logo { width: 44px; height: 44px; flex-shrink: 0; }
.m-titles { flex: 1; min-width: 0; }
.m-title { font-family: 'Inter', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 22px; font-weight: 800; line-height: 1.1; margin: 0; }
.m-tagline { font-size: 12px; color: var(--text-muted); margin: 2px 0 0; }

/* Upload */
.m-upload {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  padding: 16px;
  background: var(--red);
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 18px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.2s;
}
.m-upload:hover:not(:disabled) { background: #B8031A; }
.m-upload:disabled { opacity: 0.6; cursor: default; }
.m-upload .upload-icon { display: block; flex-shrink: 0; }
.m-filename {
  margin: -6px 2px 0;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  word-break: break-all;
}

/* Dropdowns stack */
.m-fields { display: flex; flex-direction: column; gap: 12px; }

/* Combined cleanup button */
.m-clean {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  padding: 14px;
  background: var(--ctrl-bg);
  color: var(--text-strong);
  border: 1px solid var(--ctrl-border);
  border-radius: 8px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}
.m-clean:hover:not(:disabled) { background: var(--ctrl-hover); }
.m-clean:disabled { opacity: 0.5; cursor: default; }
.m-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--ctrl-border);
  border-top-color: var(--text-strong);
  border-radius: 50%;
  animation: m-spin 0.7s linear infinite;
}
@keyframes m-spin { to { transform: rotate(360deg); } }

/* Result block */
.m-result {
  margin-top: 4px;
  padding: 18px 16px 16px;
  background: var(--ctrl-bg);
  border: 1px solid var(--ctrl-border);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.m-time {
  font-size: 44px;
  font-weight: 700;
  font-family: 'Courier New', monospace;
  letter-spacing: 2px;
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
}
.m-est-label { font-size: 12px; color: var(--text-muted); margin: 0 0 6px; }
.m-hint { font-size: 13px; color: var(--text-muted); text-align: center; margin: 4px 0 10px; }

.m-breakdown {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin: 6px 0 4px;
  color: var(--text-strong);
}
.m-breakdown td { padding: 6px 4px; }
.m-breakdown .m-num { text-align: right; font-variant-numeric: tabular-nums; color: var(--text-muted); }
.m-breakdown tfoot td {
  border-top: 1px solid var(--ctrl-border);
  font-weight: 700;
  color: var(--text-strong);
}
.m-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }

.m-warn {
  width: 100%;
  margin: 4px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(224, 168, 0, 0.12);
  border: 1px solid rgba(224, 168, 0, 0.45);
  font-size: 12px;
  line-height: 1.35;
  color: var(--text-strong);
}

.m-download {
  width: 100%;
  margin-top: 12px;
  padding: 15px;
  background: var(--teal);
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.2s;
}
.m-download:hover:not(:disabled) { background: #0093A8; }
.m-download:disabled { opacity: 0.5; cursor: default; }
</style>
