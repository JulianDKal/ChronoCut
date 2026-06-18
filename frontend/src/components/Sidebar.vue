<template>
  <div class="sidebar-container" @click.stop>
    <!-- Top Button Group -->
    <div class="button-group top-buttons">
      <button class="upload-btn" @click="handleUpload" :disabled="isLoading">
        <span class="upload-btn-text">{{ isLoading ? 'Uploading…' : 'Upload' }}</span>
      </button>

      <!-- Cutter Dropdown -->
      <div class="dropdown-wrapper" ref="cutterRef">
        <button class="dropdown-toggle" @click="cutterOpen = !cutterOpen">
          <span class="btn-text">{{ selectedCutter ? selectedCutter.name : 'Select Cutter' }}</span>
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
            <span class="item-detail">{{ c.power }}W · {{ c.widthMm }}×{{ c.heightMm }}mm</span>
          </div>
        </div>
      </div>

      <!-- Material Dropdown -->
      <div class="dropdown-wrapper" ref="materialRef">
        <button class="dropdown-toggle" @click="materialOpen = !materialOpen">
          <span class="btn-text">{{ selectedMaterial ? selectedMaterial.name : 'Select Material' }}</span>
          <span class="arrow" :class="{ rotated: materialOpen }">▾</span>
        </button>
        <div class="dropdown-menu" v-show="materialOpen">
          <div
            v-for="m in materials"
            :key="m.id"
            class="dropdown-item"
            :class="{ active: selectedMaterial?.id === m.id }"
            @click="selectMaterial(m)"
          >
            <span class="item-name">{{ m.name }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Toggles -->
    <div class="button-group toggle-group">
      <label class="opt-toggle" :title="'When on, mimics the printer\'s path optimiser (shortest travel). When off, paths are cut in file order.'">
        <input type="checkbox" v-model="optimizePath" @change="onOptimizeChange" />
        <span class="opt-text">Optimize path order</span>
      </label>
      <label class="opt-toggle" :title="'Draw engraving (green/grayscale) as one solid block that fills up, instead of the back-and-forth scan lines. Faster.'">
        <input type="checkbox" v-model="rasterBlock" @change="onRasterModeChange" />
        <span class="opt-text">Raster as solid block</span>
      </label>
      <label class="opt-toggle" :title="'Debug: colour every line segment randomly so they are easy to count.'">
        <input type="checkbox" v-model="debugColors" @change="onDebugColorsChange" />
        <span class="opt-text">Debug: random segment colors</span>
      </label>
    </div>

    <div class="spacer"></div>

    <!-- Bottom Button Group -->
    <div class="button-group bottom-buttons">
      <button class="sidebar-btn" @click="handleRemoveDoubles" :disabled="isLoading">
        <span class="btn-text">Remove Doubles</span>
      </button>
      <button class="sidebar-btn" @click="handleFixColors" :disabled="isLoading">
        <span class="btn-text">Fix Colors</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import eventBus from '../eventBus'

// ── State ─────────────────────────────────────────────────────────────────────
const isLoading = ref(false)
const cutterOpen = ref(false)
const materialOpen = ref(false)
const cutterRef = ref(null)
const materialRef = ref(null)

// ── Data ──────────────────────────────────────────────────────────────────────
const cutters = [
  { id: 'edgar',  name: 'Edgar',  power: 60,  widthMm: 1000, heightMm: 700 },
  { id: 'george', name: 'George', power: 120, widthMm: 1000, heightMm: 700 },
]

const materials = [
  { id: 'plywood3',  name: 'Plywood 3mm' },
  { id: 'plywood6',  name: 'Plywood 6mm' },
  { id: 'acrylic3',  name: 'Acrylic 3mm' },
  { id: 'acrylic5',  name: 'Acrylic 5mm' },
  { id: 'cardboard', name: 'Cardboard' },
  { id: 'leather2',  name: 'Leather 2mm' },
]

const selectedCutter   = ref(null)
const selectedMaterial = ref(null)

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

// ── Cutter / Material selection ───────────────────────────────────────────────
const selectCutter = (cutter) => {
  selectedCutter.value = cutter
  cutterOpen.value = false
  eventBus.emit('cutter-selected', cutter)
}

const selectMaterial = (material) => {
  selectedMaterial.value = material
  materialOpen.value = false
  eventBus.emit('material-selected', material)
}

// Close dropdowns when clicking outside
const handleDocClick = (e) => {
  if (cutterRef.value && !cutterRef.value.contains(e.target))   cutterOpen.value = false
  if (materialRef.value && !materialRef.value.contains(e.target)) materialOpen.value = false
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
  } catch (error) {
    console.error('Upload error:', error)
    alert('Error uploading file: ' + error.message)
  } finally {
    isLoading.value = false
  }
}

// ── Misc handlers ─────────────────────────────────────────────────────────────
const handleRemoveDoubles = () => console.log('Remove Doubles clicked')
const handleFixColors     = () => console.log('Fix Colors clicked')

// ── Lifecycle ─────────────────────────────────────────────────────────────────
onMounted(() => {
  document.addEventListener('click', handleDocClick)
  // Defer so ThreeViewer has time to register its listener first
  setTimeout(() => selectCutter(cutters[0]), 0)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocClick)
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
.opt-toggle input { width: 16px; height: 16px; cursor: pointer; accent-color: #EF8C19; }
.opt-text { font-size: 13px; color: var(--text-strong); }

/* ── Upload button ─────────────────────────────────────────── */
.upload-btn {
  justify-content: center;
  padding: 14px 16px;
  background: #EF8C19;
  margin: 10px 0;
  border: 0 transparent;
  border-radius: 8px;
  font-size: 18px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.2s;
}
.upload-btn:hover:not(:disabled) { background: #d97c10; }
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
.dropdown-toggle:hover { background: var(--hover-bg); }

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
