<template>
  <div class="sidebar-container">
    <!-- Top Button Group -->
    <div class="button-group top-buttons">
      <button class="upload-btn" @click="handleUpload" :disabled="isLoading">
        <span class="upload-btn-text">{{ isLoading ? t('uploading') : t('upload') }}</span>
      </button>

      <!-- Cutter / Material / Thickness — shared styled dropdown component -->
      <ProfileDropdown
        :model-value="selectedCutter"
        @update:model-value="selectCutter"
        :items="cutters"
        :placeholder="t('selectCutter')"
        label-key="name"
        item-key="id"
        :detail="(c) => `${c.powerW}W · ${c.bedWidth}×${c.bedHeight}mm`"
      />

      <ProfileDropdown
        :model-value="selectedFamily"
        @update:model-value="selectFamily"
        :items="materials"
        :placeholder="t('selectMaterial')"
        label-key="name"
        item-key="name"
        :detail="(f) => `${f.thicknesses.length} ${f.thicknesses.length === 1 ? t('option') : t('options')}`"
        searchable
        :search-placeholder="t('searchMaterial')"
        :empty-text="t('noMatch')"
      />

      <ProfileDropdown
        :model-value="selectedThickness"
        @update:model-value="selectThickness"
        :items="selectedFamily?.thicknesses || []"
        :placeholder="selectedFamily ? t('selectThickness') : '—'"
        label-key="label"
        item-key="id"
        :disabled="!selectedFamily"
      />
    </div>

    <!-- Path-order algorithm (view + debug toggles live as floating buttons
         top-right; this one affects the generated toolpath). Selectable so the
         algorithms can be compared against each other and against what the
         printer's own optimiser does — see toolpath.js PATH_ORDER_ALGORITHMS. -->
    <div class="button-group toggle-group" :title="t('tipOptimize')">
      <span class="opt-text">{{ t('optimizePath') }}</span>
      <ProfileDropdown
        :model-value="selectedPathOrder"
        @update:model-value="selectPathOrder"
        :items="pathOrderOptions"
        label-key="name"
        item-key="id"
      />
    </div>

    <div class="spacer"></div>

    <!-- Bottom Button Group: two-step edits (detect → confirm) with feedback -->
    <div class="button-group bottom-buttons" ref="bottomButtonsRef">
      <button
        v-for="a in EDIT_ACTIONS"
        :key="a"
        class="sidebar-btn"
        :class="{ armed: editState[a].armed }"
        :disabled="isLoading || editState[a].busy"
        :title="t(EDIT_TIP[a])"
        @click="onEditClick(a)"
      >
        <span v-if="editState[a].busy" class="btn-spinner"></span>
        <span class="btn-text">{{ editLabel(a) }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import eventBus from '../eventBus'
import { loadProfiles, speedsFor } from '../profiles'
import { PATH_ORDER_ALGORITHMS } from '../toolpath'
import { getStoredViewSettings, setStoredViewSetting } from '../viewSettings'
import { t } from '../translations'
import ProfileDropdown from './ProfileDropdown.vue'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// ── State ─────────────────────────────────────────────────────────────────────
const isLoading = ref(false)

// Printers + materials are loaded from /public XML at startup (profiles.js).
const cutters   = ref([])
const materials = ref([])      // material families of the currently selected cutter

const selectedCutter    = ref(null)
const selectedFamily    = ref(null)   // chosen material family
const selectedThickness = ref(null)   // chosen thickness preset (carries the speeds)

// Path-order algorithm (default '2opt' — closest match to the printer's own
// optimiser; see toolpath.js). Selectable in the UI for debugging/comparison.
// Only the id is kept as state; the option objects (with a translated label)
// are recomputed on every render so a language switch updates the label too.
const PATH_ORDER_LABEL_KEY = { file: 'pathOrderFile', nn: 'pathOrderNn', '2opt': 'pathOrder2opt' }
const pathOrderOptions = computed(() =>
  PATH_ORDER_ALGORITHMS.map((id) => ({ id, name: t(PATH_ORDER_LABEL_KEY[id]) })))
// Restored from localStorage (see viewSettings.js) so a reload keeps the last
// choice — ThreeViewer self-sources the same value on its own mount, this
// only needs to reflect it back into the dropdown's initial selection.
const selectedPathOrderId = ref(getStoredViewSettings().pathOrder)
const selectedPathOrder = computed(() =>
  pathOrderOptions.value.find((o) => o.id === selectedPathOrderId.value))
const selectPathOrder = (opt) => {
  selectedPathOrderId.value = opt.id
  setStoredViewSetting('pathOrder', opt.id)
  eventBus.emit('optimize-changed', opt.id)
}

// NB: the view + debug toggles (travel, rulers, raster-as-block, debug colours,
// speed gradient) now live in the floating ViewToggles component (top-right);
// they emit the same events.

// ── Cutter / Material / Thickness selection ───────────────────────────────────
// Resolve + broadcast the head speeds for the current printer + thickness preset.
const emitSpeeds = () => {
  if (!selectedCutter.value || !selectedThickness.value) return
  eventBus.emit('speeds-changed', speedsFor(selectedCutter.value, selectedThickness.value))
}

const selectCutter = (cutter) => {
  selectedCutter.value = cutter
  materials.value = cutter.materials || []
  selectedFamily.value = null
  selectedThickness.value = null
  // Bed size drives the viewer frame + fit check.
  eventBus.emit('cutter-selected', { name: cutter.name, bedWidth: cutter.bedWidth, bedHeight: cutter.bedHeight })
  // Default to this printer's first material (also picks a thickness + emits speeds).
  if (materials.value.length) selectFamily(materials.value[0])
}

const selectFamily = (fam) => {
  selectedFamily.value = fam
  selectedThickness.value = null
  // Auto-pick the first thickness so speeds are valid immediately; the user can
  // change it via the thickness dropdown.
  if (fam.thicknesses.length) selectThickness(fam.thicknesses[0])
}

const selectThickness = (th) => {
  selectedThickness.value = th
  emitSpeeds()
}

// Cancel any armed edit when clicking outside the edit buttons. (The dropdowns
// close themselves; this only guards the two-step edit actions.)
const handleDocClick = (e) => {
  if (anyArmed() && bottomButtonsRef.value && !bottomButtonsRef.value.contains(e.target)) cancelArmed()
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

    const response = await fetch(`${API_URL}/api/pdf_extraction`, { method: 'POST', body: formData })
    if (!response.ok) throw new Error('Upload failed')

    const result = await response.json()
    eventBus.emit('lines-updated', result.lines)
    resetEdits()   // a fresh design clears any armed/flashing edit state
  } catch (error) {
    console.error('Upload error:', error)
    alert(t('uploadError') + error.message)
  } finally {
    isLoading.value = false
  }
}

// ── Edits (Fix Colors / Remove White / Remove Doubles) ────────────────────────
// All three share ONE two-step flow: 1st click DETECTS (the viewer highlights
// what would change and reports the count → the button arms, e.g. "Entferne 2
// Dopplungen"); 2nd click APPLIES it (then a brief success text). Clicking
// elsewhere cancels an armed action; a spinner shows while the viewer works.
const bottomButtonsRef = ref(null)

const EDIT_ACTIONS = ['doubles', 'colors', 'white']
const EDIT_TIP = { doubles: 'tipRemoveDoubles', colors: 'tipFixColors', white: 'tipRemoveWhite' }
const EDIT_CFG = {
  doubles: { idle: 'removeDoubles', armed: 'doublesArmedN', none: 'noDoubles',  done: 'doublesDone' },
  colors:  { idle: 'fixColors',     armed: 'colorsArmedN',  none: 'colorsNone', done: 'colorsDone' },
  white:   { idle: 'removeWhite',   armed: 'whiteArmedN',   none: 'whiteNone',  done: 'whiteDone' },
}
const editState = reactive({
  doubles: { armed: false, busy: false, count: 0, flash: '' },
  colors:  { armed: false, busy: false, count: 0, flash: '' },
  white:   { armed: false, busy: false, count: 0, flash: '' },
})

const editLabel = (a) => {
  const s = editState[a], cfg = EDIT_CFG[a]
  if (s.flash) return s.flash
  if (s.armed) return t(cfg.armed, { n: s.count })
  return t(cfg.idle)
}

const anyArmed = () => EDIT_ACTIONS.some((a) => editState[a].armed)

// Disarm every action (optionally keeping one) + drop the preview highlight.
const cancelArmed = (keep = null) => {
  let cleared = false
  for (const a of EDIT_ACTIONS) {
    if (a === keep) continue
    if (editState[a].armed) { editState[a].armed = false; editState[a].count = 0; cleared = true }
  }
  if (cleared) eventBus.emit('edit-cancel')
}

const flashEdit = (a, text) => {
  editState[a].flash = text
  setTimeout(() => { editState[a].flash = '' }, 1500)
}

const onEditClick = (a) => {
  const s = editState[a]
  if (s.busy) return
  if (s.armed) {
    s.busy = true
    setTimeout(() => eventBus.emit('edit-apply', { action: a }), 0)   // defer so the spinner paints first
  } else {
    cancelArmed(a)                        // only one action armed at a time
    s.busy = true
    setTimeout(() => eventBus.emit('edit-detect', { action: a }), 0)
  }
}

const onEditResult = ({ action, count, phase }) => {
  const s = editState[action], cfg = EDIT_CFG[action]
  s.busy = false
  if (phase === 'detect') {
    if (count > 0) { s.armed = true; s.count = count }
    else { s.armed = false; flashEdit(action, t(cfg.none)) }
  } else {                                // applied
    s.armed = false; s.count = 0
    flashEdit(action, count > 0 ? t(cfg.done) : t(cfg.none))
  }
}

const resetEdits = () => {
  for (const a of EDIT_ACTIONS) Object.assign(editState[a], { armed: false, busy: false, count: 0, flash: '' })
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
onMounted(async () => {
  // const response = await fetch(`${API_URL}`)
  // if (!response.ok) {
  //     throw new Error(`Response status: ${response.status}`);
  //   }
  // const result = await response.json();
  
  // console.log("API response: ", result.message);

  // pointerdown (capture) so the dropdowns close on ANY press outside them —
  // sidebar, preview canvas, etc. — regardless of stopPropagation downstream.
  document.addEventListener('pointerdown', handleDocClick, true)
  eventBus.on('edit-result', onEditResult)
  const { printers } = await loadProfiles()
  cutters.value = printers
  // The awaits above already defer past ThreeViewer's onMounted, so its listeners
  // are registered; select the first printer (also picks its first material).
  if (cutters.value.length) selectCutter(cutters.value[0])
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocClick, true)
  eventBus.off('edit-result', onEditResult)
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

/* ── Path-order algorithm label ────────────────────────────── */
.opt-text { font-size: 13px; color: var(--text-strong); margin-bottom: 6px; display: block; }

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
  background: var(--ctrl-bg);
  border: 1px solid var(--ctrl-border);
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
}
.sidebar-btn:hover:not(:disabled) { background: var(--ctrl-hover); }
/* Armed state: duplicates are highlighted, next click removes them. */
.sidebar-btn.armed {
  border-color: #ff00ff;
  background: rgba(255, 0, 255, 0.08);
}
.sidebar-btn.armed .btn-text { color: #c800c8; font-weight: 600; }
.btn-text { flex: 1; text-align: left; color: var(--text-strong); }

/* Small spinner shown while an edit is detecting/applying. */
.btn-spinner {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  border: 2px solid var(--ctrl-border);
  border-top-color: var(--text-strong);
  border-radius: 50%;
  animation: btn-spin 0.7s linear infinite;
}
@keyframes btn-spin { to { transform: rotate(360deg); } }

/* The cutter / material / thickness dropdowns now live in ProfileDropdown.vue. */
</style>
