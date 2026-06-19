<template>
  <div class="sidebar-container" @click.stop>
    <!-- Top Button Group -->
    <div class="button-group top-buttons">
      <button class="upload-btn" @click="handleUpload" :disabled="isLoading">
        <span class="upload-btn-text">{{ isLoading ? t('uploading') : t('upload') }}</span>
      </button>

      <!-- Cutter Dropdown -->
      <div class="dropdown-wrapper" ref="cutterRef">
        <button class="dropdown-toggle" @click="toggleDropdown('cutter')">
          <span class="btn-text">{{ selectedCutter ? selectedCutter.name : t('selectCutter') }}</span>
          <span class="arrow" :class="{ rotated: cutterOpen }">▾</span>
        </button>
        <div class="dropdown-menu" v-show="cutterOpen">
          <div
            v-for="c in cutters"
            :key="c.id"
            class="dropdown-item"
            :class="{ active: selectedCutter?.id === c.id }"
            @click="selectCutter(c)"
          >
            <span class="item-name">{{ c.name }}</span>
            <span class="item-detail">{{ c.powerW }}W · {{ c.bedWidth }}×{{ c.bedHeight }}mm</span>
          </div>
        </div>
      </div>

      <!-- Material (searchable) -->
      <div class="dropdown-wrapper" ref="materialRef">
        <button class="dropdown-toggle" @click="toggleDropdown('material')">
          <span class="btn-text">{{ selectedFamily ? selectedFamily.name : t('selectMaterial') }}</span>
          <span class="arrow" :class="{ rotated: materialOpen }">▾</span>
        </button>
        <div class="dropdown-menu" v-show="materialOpen">
          <input
            ref="materialSearchRef"
            v-model="materialSearch"
            class="dropdown-search"
            type="text"
            :placeholder="t('searchMaterial')"
            @click.stop
          />
          <div v-if="filteredFamilies.length === 0" class="dropdown-empty">{{ t('noMatch') }}</div>
          <div
            v-for="f in filteredFamilies"
            :key="f.name"
            class="dropdown-item"
            :class="{ active: selectedFamily?.name === f.name }"
            @click="selectFamily(f)"
          >
            <span class="item-name">{{ f.name }}</span>
            <span class="item-detail">{{ f.thicknesses.length }} {{ f.thicknesses.length === 1 ? t('option') : t('options') }}</span>
          </div>
        </div>
      </div>

      <!-- Thickness (depends on the chosen material) -->
      <div class="dropdown-wrapper" ref="thicknessRef">
        <button
          class="dropdown-toggle"
          :disabled="!selectedFamily"
          @click="selectedFamily && toggleDropdown('thickness')"
        >
          <span class="btn-text">{{ selectedThickness ? selectedThickness.label : (selectedFamily ? t('selectThickness') : '—') }}</span>
          <span class="arrow" :class="{ rotated: thicknessOpen }">▾</span>
        </button>
        <div class="dropdown-menu" v-show="thicknessOpen">
          <div
            v-for="t in (selectedFamily?.thicknesses || [])"
            :key="t.id"
            class="dropdown-item"
            :class="{ active: selectedThickness?.id === t.id }"
            @click="selectThickness(t)"
          >
            <span class="item-name">{{ t.label }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Toggles -->
    <div class="button-group toggle-group">
      <label class="opt-toggle" :title="t('tipRulers')">
        <input type="checkbox" v-model="showRulers" @change="onRulersChange" />
        <span class="opt-text">{{ t('showRulers') }}</span>
      </label>
      <label class="opt-toggle" :title="t('tipOptimize')">
        <input type="checkbox" v-model="optimizePath" @change="onOptimizeChange" />
        <span class="opt-text">{{ t('optimizePath') }}</span>
      </label>
      <label class="opt-toggle" :title="t('tipRaster')">
        <input type="checkbox" v-model="rasterBlock" @change="onRasterModeChange" />
        <span class="opt-text">{{ t('rasterBlock') }}</span>
      </label>
      <label class="opt-toggle" :title="t('tipShowTravel')">
        <input type="checkbox" v-model="showTravel" @change="onShowTravelChange" />
        <span class="opt-text">{{ t('showTravel') }}</span>
      </label>
      <label class="opt-toggle" :title="t('tipDebug')">
        <input type="checkbox" v-model="debugColors" @change="onDebugColorsChange" />
        <span class="opt-text">{{ t('debug') }}</span>
      </label>
      <label class="opt-toggle" :title="t('tipSpeedGradient')">
        <input type="checkbox" v-model="speedGradient" @change="onSpeedGradientChange" />
        <span class="opt-text">{{ t('speedGradient') }}</span>
      </label>
    </div>

    <div class="spacer"></div>

    <!-- Bottom Button Group -->
    <div class="button-group bottom-buttons">
      <button
        class="sidebar-btn"
        :class="{ armed: doublesArmed }"
        @click="handleRemoveDoubles"
        :disabled="isLoading"
        :title="t('tipRemoveDoubles')"
      >
        <span class="btn-text">{{ removeDoublesLabel }}</span>
      </button>
      <button class="sidebar-btn" @click="handleFixColors" :disabled="isLoading"
        :title="t('tipFixColors')">
        <span class="btn-text">{{ t('fixColors') }}</span>
      </button>
      <button class="sidebar-btn" @click="handleRemoveWhite" :disabled="isLoading"
        :title="t('tipRemoveWhite')">
        <span class="btn-text">{{ t('removeWhite') }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import eventBus from '../eventBus'
import { loadProfiles, speedsFor } from '../profiles'
import { t } from '../translations'

// ── State ─────────────────────────────────────────────────────────────────────
const isLoading = ref(false)
const cutterOpen = ref(false)
const materialOpen = ref(false)
const thicknessOpen = ref(false)
const cutterRef = ref(null)
const materialRef = ref(null)
const thicknessRef = ref(null)
const materialSearchRef = ref(null)

// Printers + materials are loaded from /public XML at startup (profiles.js).
const cutters   = ref([])
const materials = ref([])      // material families of the currently selected cutter
const materialSearch = ref('')

const selectedCutter    = ref(null)
const selectedFamily    = ref(null)   // chosen material family
const selectedThickness = ref(null)   // chosen thickness preset (carries the speeds)

const filteredFamilies = computed(() => {
  const q = materialSearch.value.trim().toLowerCase()
  return q ? materials.value.filter((f) => f.name.toLowerCase().includes(q)) : materials.value
})

// Path optimisation toggle (default off — printer cuts in file order)
const optimizePath = ref(false)
const onOptimizeChange = () => {
  eventBus.emit('optimize-changed', optimizePath.value)
}

// Draw raster engraving as a solid filling block instead of scan lines.
const rasterBlock = ref(false)
const onRasterModeChange = () => {
  eventBus.emit('raster-mode-changed', rasterBlock.value)
}

// Debug: colour every segment randomly so they are easy to count.
const debugColors = ref(false)
const onDebugColorsChange = () => {
  eventBus.emit('debug-colors-changed', debugColors.value)
}

// Show the CAD rulers along the top + left edges of the viewport.
const showRulers = ref(true)
const onRulersChange = () => {
  eventBus.emit('rulers-changed', showRulers.value)
}

// Show/hide the dotted travel "Leerwege".
const showTravel = ref(true)
const onShowTravelChange = () => {
  eventBus.emit('show-travel-changed', showTravel.value)
}

// Debug: colour segments by speed (for debugging acceleration).
const speedGradient = ref(false)
const onSpeedGradientChange = () => {
  eventBus.emit('speed-gradient-changed', speedGradient.value)
}

// ── Cutter / Material / Thickness selection ───────────────────────────────────
// Resolve + broadcast the head speeds for the current printer + thickness preset.
const emitSpeeds = () => {
  if (!selectedCutter.value || !selectedThickness.value) return
  eventBus.emit('speeds-changed', speedsFor(selectedCutter.value, selectedThickness.value))
}

const selectCutter = (cutter) => {
  selectedCutter.value = cutter
  cutterOpen.value = false
  materials.value = cutter.materials || []
  selectedFamily.value = null
  selectedThickness.value = null
  // Bed size drives the viewer frame + fit check.
  eventBus.emit('cutter-selected', { name: cutter.name, bedWidth: cutter.bedWidth, bedHeight: cutter.bedHeight })
  // Default to this printer's first material (also picks a thickness + emits speeds).
  if (materials.value.length) selectFamily(materials.value[0])
}

// Open the requested dropdown and close the others (so they never overlap).
const toggleDropdown = (which) => {
  cutterOpen.value    = which === 'cutter'    ? !cutterOpen.value    : false
  materialOpen.value  = which === 'material'  ? !materialOpen.value  : false
  thicknessOpen.value = which === 'thickness' ? !thicknessOpen.value : false
  if (materialOpen.value) nextTick(() => materialSearchRef.value?.focus())
}

const selectFamily = (fam) => {
  selectedFamily.value = fam
  materialOpen.value = false
  materialSearch.value = ''
  selectedThickness.value = null
  // Auto-pick the first thickness so speeds are valid immediately; the user can
  // change it via the thickness dropdown.
  if (fam.thicknesses.length) selectThickness(fam.thicknesses[0])
}

const selectThickness = (t) => {
  selectedThickness.value = t
  thicknessOpen.value = false
  emitSpeeds()
}

// Close dropdowns when clicking outside
const handleDocClick = (e) => {
  if (cutterRef.value && !cutterRef.value.contains(e.target))       cutterOpen.value = false
  if (materialRef.value && !materialRef.value.contains(e.target))   materialOpen.value = false
  if (thicknessRef.value && !thicknessRef.value.contains(e.target)) thicknessOpen.value = false
}

// ── Upload ────────────────────────────────────────────────────────────────────
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
  try {
    const formData = new FormData()
    formData.append('file', file)

    const response = await fetch('/api/pdf_extraction', { method: 'POST', body: formData })
    if (!response.ok) throw new Error('Upload failed')

    const result = await response.json()
    eventBus.emit('lines-updated', result.lines)
    resetDoubles()   // a fresh design clears any armed double-removal state
  } catch (error) {
    console.error('Upload error:', error)
    alert(t('uploadError') + error.message)
  } finally {
    isLoading.value = false
  }
}

// ── Remove Doubles (two-click: highlight → confirm) ───────────────────────────
// First click detects + highlights coincident red/blue cut lines (ThreeViewer
// reports the count back); the button then arms, and a second click removes them.
const doublesArmed = ref(false)
const doublesCount = ref(0)
const doublesHint  = ref('')   // brief "Keine Dopplungen" note

const removeDoublesLabel = computed(() => {
  if (doublesArmed.value) {
    const n = doublesCount.value
    return `${t('removeN')} ${n} ${n === 1 ? t('double') : t('doubles')}`
  }
  return doublesHint.value || t('removeDoubles')
})

const handleRemoveDoubles = () => {
  eventBus.emit(doublesArmed.value ? 'doubles-remove' : 'doubles-detect')
}

const onDoublesResult = ({ count, fromDetect }) => {
  doublesCount.value = count
  doublesArmed.value = count > 0
  // Only nudge "none found" when the user actually ran a detection — not when the
  // state was reset by Fix Colors or after a removal.
  if (count === 0 && fromDetect) {
    doublesHint.value = t('noDoubles')
    setTimeout(() => { doublesHint.value = '' }, 1500)
  }
}

const resetDoubles = () => { doublesArmed.value = false; doublesCount.value = 0; doublesHint.value = '' }

// ── Fix Colors / Remove White ─────────────────────────────────────────────────
const handleFixColors  = () => eventBus.emit('fix-colors')
const handleRemoveWhite = () => eventBus.emit('remove-white')

// ── Lifecycle ─────────────────────────────────────────────────────────────────
onMounted(async () => {
  document.addEventListener('click', handleDocClick)
  eventBus.on('doubles-result', onDoublesResult)
  const { printers } = await loadProfiles()
  cutters.value = printers
  // The awaits above already defer past ThreeViewer's onMounted, so its listeners
  // are registered; select the first printer (also picks its first material).
  if (cutters.value.length) selectCutter(cutters.value[0])
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocClick)
  eventBus.off('doubles-result', onDoublesResult)
})
</script>

<style scoped>
.sidebar-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 20px 0;
  background: var(--panel-bg);
  transition: background 0.25s ease;
}

.button-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0 15px;
}

.bottom-buttons { margin-bottom: 20px; }
.spacer { flex: 1; }

/* Space between the Material dropdown and the toggles below it */
.toggle-group { margin-top: 22px; }

/* ── Optimise toggle ───────────────────────────────────────── */
.opt-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--ctrl-border);
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
}
.opt-toggle:hover { background: var(--hover-bg); }
.opt-toggle input { width: 16px; height: 16px; cursor: pointer; accent-color: #DE041F; }
.opt-text { font-size: 13px; color: var(--text-strong); }

/* ── Upload button ─────────────────────────────────────────── */
.upload-btn {
  justify-content: center;
  padding: 14px 16px;
  background: #DE041F;
  margin: 10px 0;
  border: 0 transparent;
  border-radius: 8px;
  font-size: 18px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.2s;
}
.upload-btn:hover:not(:disabled) { background: #B8031A; }
.upload-btn-text { color: #fff; }

/* ── Generic sidebar button ────────────────────────────────── */
.sidebar-btn {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: transparent;
  border: 1px solid var(--ctrl-border);
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
}
.sidebar-btn:hover:not(:disabled) { background: var(--hover-bg); }
/* Armed state: duplicates are highlighted, next click removes them. */
.sidebar-btn.armed {
  border-color: #ff00ff;
  background: rgba(255, 0, 255, 0.08);
}
.sidebar-btn.armed .btn-text { color: #c800c8; font-weight: 600; }
.btn-text { flex: 1; text-align: left; color: var(--text-strong); }

/* ── Dropdown ──────────────────────────────────────────────── */
.dropdown-wrapper {
  position: relative;
}

.dropdown-toggle {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 12px 16px;
  background: transparent;
  border: 1px solid var(--ctrl-border);
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-strong);
  cursor: pointer;
  transition: background 0.2s;
}
.dropdown-toggle:hover:not(:disabled) { background: var(--hover-bg); }
.dropdown-toggle:disabled { opacity: 0.5; cursor: not-allowed; }

/* Search field inside the material dropdown */
.dropdown-search {
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
.dropdown-empty {
  padding: 10px 16px;
  font-size: 13px;
  color: var(--text-muted);
}

.arrow {
  margin-left: auto;
  color: var(--text-muted);
  font-size: 12px;
  transition: transform 0.2s;
  display: inline-block;
}
.arrow.rotated { transform: rotate(180deg); }

.dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  background: var(--dropdown-bg);
  border: 1px solid var(--dropdown-border);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.12);
  z-index: 100;
  overflow: hidden;
}

.dropdown-item {
  display: flex;
  flex-direction: column;
  padding: 10px 16px;
  cursor: pointer;
  transition: background 0.15s;
}
.dropdown-item:hover  { background: var(--hover-bg); }
.dropdown-item.active { background: var(--active-bg); }

.item-name   { font-size: 14px; font-weight: 500; color: var(--text-strong); }
.item-detail { font-size: 11px; color: var(--text-muted); margin-top: 1px; }
</style>
