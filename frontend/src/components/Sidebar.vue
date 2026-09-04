<template>
  <div class="sidebar-container">
    <!-- Top Button Group -->
    <div class="button-group top-buttons">
      <button class="upload-btn" @click="handleUpload" :disabled="isLoading">
        <!-- Drawn, not a font glyph, same reasoning as the play/pause and
             download icons: an up-arrow into a tray, mirroring the download
             button's own icon (arrow + tray), just flipped. -->
        <svg class="upload-icon" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
          <path d="M12 13V3m0 0l-4 4m4-4l4 4" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" />
        </svg>
        <span class="upload-btn-text">{{ isLoading ? t('uploading') : t('upload') }}</span>
      </button>

      <!-- Cutter / Material / Thickness - shared styled dropdown component -->
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
        :detail="familyDetail"
        searchable
        :search-placeholder="t('searchMaterial')"
        :empty-text="t('noMatch')"
      />

      <!-- Only rendered when the material actually offers a choice. With a
           single thickness the dropdown could not do anything, and the value
           itself is shown as the material's detail line instead
           (familyDetail). The thickness is still SELECTED either way -
           selectFamily picks the first one - so the speeds resolve as before. -->
      <ProfileDropdown
        v-if="hasThicknessChoice(selectedFamily)"
        :model-value="selectedThickness"
        @update:model-value="selectThickness"
        :items="selectedFamily.thicknesses"
        :placeholder="t('selectThickness')"
        label-key="label"
        item-key="id"
      />

      <!-- DPI: overrides the raster line spacing regardless of which
           material is selected. Sticky (localStorage, customProfile.js) -
           an expert setting, not tied to any one preset. -->
      <ProfileDropdown
        :model-value="selectedDpiOption"
        @update:model-value="selectDpi"
        :items="dpiOptions"
        label-key="name"
        item-key="id"
        :title="t('tipDpi')"
      />
    </div>

    <!-- Path-order algorithm (view + debug toggles live as floating buttons
         top-right; this one affects the generated toolpath). Selectable so the
         algorithms can be compared against each other and against what the
         printer's own optimiser does - see toolpath.js PATH_ORDER_ALGORITHMS. -->
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

    <!-- Custom speeds: an expert override, independent of the selected
         material/thickness - sticky across selections (customProfile.js),
         off by default so the sidebar stays exactly as minimal as before
         unless turned on. The three speed fields live in a centred MODAL
         (opened from the sliders button, only shown once the switch is on).
         It used to be a flyout anchored under the toggle row, but the sidebar
         has fixed controls below it and the panel covered them. A modal has no
         anchor it can run out of room next to, works at any window height, and
         reads as what it is: a small settings window. -->
    <div class="button-group toggle-group custom-toggle-group">
      <div class="custom-switch-row" :title="t('tipCustomMode')">
        <label class="custom-switch">
          <input type="checkbox" v-model="customMode" @change="onCustomModeChange" />
          <span class="custom-switch-track"><span class="custom-switch-thumb"></span></span>
          <span class="opt-text">{{ t('customMode') }}</span>
        </label>
        <button
          v-if="customMode"
          class="custom-settings-btn"
          :class="{ open: customSpeedsOpen }"
          :title="t('editCustomSpeeds')"
          :aria-expanded="customSpeedsOpen"
          @click="toggleCustomSpeedsMenu"
        >
          <!-- "Sliders" glyph rather than a gear: this button opens exactly 3
               adjustable values, not general app settings, and a gear's fine
               teeth read as a muddy blob at this button's small size while
               plain strokes stay crisp. -->
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"
               fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <line x1="5" y1="21" x2="5" y2="14" /><line x1="5" y1="10" x2="5" y2="3" />
            <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
            <line x1="19" y1="21" x2="19" y2="16" /><line x1="19" y1="12" x2="19" y2="3" />
            <line x1="2" y1="14" x2="8" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="16" y1="16" x2="22" y2="16" />
          </svg>
        </button>
      </div>

      <!-- Teleported to the app's portal root so the sidebar's own overflow
           clipping and stacking context can't trap it - same reason as every
           other portal in the app. Unlike those, this one is a MODAL: its
           backdrop covers the whole viewport and the dialog centres itself, so
           there is nothing to measure or reposition. -->
      <Teleport to="#cc-portal-root" defer>
        <Transition name="csp-fade" :duration="200">
          <div
            v-if="customMode && customSpeedsOpen"
            class="custom-speeds-backdrop"
            @pointerdown.self="customSpeedsOpen = false"
          >
            <div
              class="custom-speeds-dialog"
              ref="customSpeedsMenuRef"
              role="dialog"
              aria-modal="true"
              :aria-label="t('customSpeedsTitle')"
            >
              <header class="csd-head">
                <h2 class="csd-title">{{ t('customSpeedsTitle') }}</h2>
                <button class="csd-close" :title="t('close')" :aria-label="t('close')"
                        @click="customSpeedsOpen = false">
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"
                       fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                    <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
                  </svg>
                </button>
              </header>

              <p class="csd-hint">{{ t('customSpeedsHint') }}</p>

              <!-- Slider AND number field per value, bound to the same model:
                   the slider is the fast way to a rough setting, the field the
                   exact way. Three structurally identical rows, so one v-for
                   rather than three copies. -->
              <label v-for="op in CUSTOM_SPEED_OPS" :key="op.key" class="csd-row">
                <span class="csd-label">{{ t(op.label) }}</span>
                <input
                  type="range" class="csd-slider" min="1" max="100" step="1"
                  v-model.number="customSpeeds[op.key]" @change="onCustomSpeedChange"
                />
                <input
                  type="number" class="custom-speed-input" min="1" max="100" step="1"
                  v-model.number="customSpeeds[op.key]" @change="onCustomSpeedChange"
                />
                <span class="custom-speed-unit">%</span>
              </label>

              <footer class="csd-foot">
                <button class="csd-btn" :title="resetHint" @click="resetCustomSpeeds">
                  {{ t('resetToDefaults') }}
                </button>
                <button class="csd-btn csd-btn-primary" @click="customSpeedsOpen = false">{{ t('done') }}</button>
              </footer>
            </div>
          </div>
        </Transition>
      </Teleport>
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
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import eventBus from '../eventBus'
import { loadProfiles, speedsFor, applyCustomProfile, hasThicknessChoice, familyDetail } from '../profiles'
import { PATH_ORDER_ALGORITHMS } from '../toolpath'
import { getStoredViewSettings, setStoredViewSetting } from '../viewSettings'
import {
  DPI_PRESETS, DEFAULT_DPI, DEFAULT_CUSTOM_PROFILE,
  getStoredCustomProfile, setStoredCustomProfile, dpiForPreset, customSpeedsForPreset,
} from '../customProfile'
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

// Path-order algorithm (default '2opt' - closest match to the printer's own
// optimiser; see toolpath.js). Selectable in the UI for debugging/comparison.
// Only the id is kept as state; the option objects (with a translated label)
// are recomputed on every render so a language switch updates the label too.
const PATH_ORDER_LABEL_KEY = { file: 'pathOrderFile', nn: 'pathOrderNn', '2opt': 'pathOrder2opt' }
const pathOrderOptions = computed(() =>
  PATH_ORDER_ALGORITHMS.map((id) => ({ id, name: t(PATH_ORDER_LABEL_KEY[id]) })))
// Restored from localStorage (see viewSettings.js) so a reload keeps the last
// choice - ThreeViewer self-sources the same value on its own mount, this
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

// ── Custom profile: DPI + custom speeds ─────────────────────────────────────
// customMode + customSpeeds are an expert override layer, sticky across
// selections (localStorage, customProfile.js), restored once here on mount.
// DPI is NOT sticky the same way: it simply tracks whichever preset is
// selected (see selectThickness below), falling back to DEFAULT_DPI when a
// preset carries no DPI of its own - the dropdown lets the user override it
// for the current selection, but picking a new material/thickness resets it.
const storedProfile = getStoredCustomProfile()
const dpi = ref(DEFAULT_DPI)
const customMode = ref(storedProfile.customMode)
const customSpeeds = reactive({ ...storedProfile.customSpeeds })

// Has the user dialled these in by hand? Decides whether the automatic first
// selection at startup may overwrite them (see selectThickness / onMounted).
const customSpeedsEdited = ref(storedProfile.customSpeedsEdited)

// True only while the startup selection runs. selectCutter -> selectFamily ->
// selectThickness is the same code path for "the app just picked the first
// material" and "the user picked a material", and only the latter should throw
// away hand-dialled speeds - this flag is what tells them apart.
let bootstrapping = true

const dpiOptions = computed(() => DPI_PRESETS.map((d) => ({ id: String(d), name: `${d} DPI`, dpi: d })))
// A preset's own DPI (e.g. 400) may not be one of the four offered presets -
// still shown correctly since ProfileDropdown reads the label straight off
// whatever object it's given, not off a match in `items`.
const selectedDpiOption = computed(() =>
  dpiOptions.value.find((o) => o.dpi === dpi.value) ?? { id: String(dpi.value), name: `${dpi.value} DPI`, dpi: dpi.value })

const selectDpi = (opt) => {
  dpi.value = opt.dpi
  emitSpeeds()
}
const onCustomModeChange = () => {
  setStoredCustomProfile({ customMode: customMode.value })
  emitSpeeds()
}
// edited=true: from here on the values are the user's, not the preset's, and
// survive a reload. Cleared again by resetCustomSpeeds and by a manual
// material/thickness change.
const onCustomSpeedChange = () => {
  customSpeedsEdited.value = true
  setStoredCustomProfile({ customSpeeds: { ...customSpeeds }, customSpeedsEdited: true })
  emitSpeeds()
}

// Puts the fields back on a preset's numbers - used both by "Reset" and by a
// manual material/thickness change, which is why it clears the edited flag.
const applyPresetSpeeds = (speeds) => {
  Object.assign(customSpeeds, speeds)
  customSpeedsEdited.value = false
  setStoredCustomProfile({ customSpeeds: { ...customSpeeds }, customSpeedsEdited: false })
}

// ── Custom speeds dialog ─────────────────────────────────────────
// The 3 fields live in a centred modal (opened from the sliders button) instead
// of inline in the sidebar's normal flow - see the template comment on
// .custom-toggle-group for why. Being a modal it needs no anchor measuring: the
// backdrop covers the viewport and the dialog centres itself, so there is
// nothing to reposition on resize.
const customSpeedsMenuRef = ref(null)
const customSpeedsOpen = ref(false)

// One entry per overridable speed - keeps three structurally identical rows in
// the template down to a single v-for.
const CUSTOM_SPEED_OPS = [
  { key: 'cut', label: 'opCut' },
  { key: 'engrave', label: 'opVectorEngrave' },
  { key: 'raster', label: 'opRasterEngrave' },
]

const toggleCustomSpeedsMenu = () => { customSpeedsOpen.value = !customSpeedsOpen.value }

// Names the preset the Reset button goes back to, so it is obvious that it
// restores the MATERIAL's numbers and not some generic default.
const resetHint = computed(() => (selectedThickness.value
  ? t('resetToPreset', { preset: `${selectedFamily.value?.name ?? ''} ${selectedThickness.value.label}`.trim() })
  : t('resetToDefaults')))

// The speeds the currently-selected preset implies - what the fields get seeded
// with on a new selection, and what "Reset" goes back to. Falls back to the
// built-in defaults only while nothing is selected yet.
const presetCustomSpeeds = computed(() =>
  selectedThickness.value
    ? customSpeedsForPreset(selectedThickness.value, selectedCutter.value)
    : { ...DEFAULT_CUSTOM_PROFILE.customSpeeds })

const resetCustomSpeeds = () => {
  applyPresetSpeeds(presetCustomSpeeds.value)
  emitSpeeds()
}

// Turning Custom off drops the sliders button too (v-if) - close the dialog with
// it rather than leaving it open with nothing left to reopen it from.
watch(customMode, (on) => { if (!on) customSpeedsOpen.value = false })

// Escape closes, like any modal. Click-outside is the backdrop's own job
// (@pointerdown.self), so no document-level pointer listener is needed.
const onCustomSpeedsKeydown = (e) => {
  if (e.key === 'Escape' && customSpeedsOpen.value) {
    e.stopPropagation()
    customSpeedsOpen.value = false
  }
}

// ── Cutter / Material / Thickness selection ───────────────────────────────────
// Resolve + broadcast the head speeds for the current printer + thickness
// preset, then layer the custom profile (DPI / custom speeds) on top.
const emitSpeeds = () => {
  if (!selectedCutter.value || !selectedThickness.value) return
  const resolved = speedsFor(selectedCutter.value, selectedThickness.value)
  const withOverrides = applyCustomProfile(
    resolved, { dpi: dpi.value, customMode: customMode.value, customSpeeds }, selectedCutter.value)
  eventBus.emit('speeds-changed', withOverrides)
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
  // DPI always follows the newly-selected preset - a manual override made for
  // the PREVIOUS selection does not carry over.
  dpi.value = dpiForPreset(th)
  // The custom speeds follow it too, with one exception: values the user
  // dialled in by hand must survive a page reload, and a reload runs this same
  // code path for the material the app auto-picks at startup. So during
  // bootstrap, hand-edited values are left alone; a MANUAL material/thickness
  // change always reseeds (that IS the user asking for the new material's
  // numbers).
  if (!bootstrapping || !customSpeedsEdited.value) {
    applyPresetSpeeds(customSpeedsForPreset(th, selectedCutter.value))
  }
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

const EDIT_ACTIONS = ['doubles', 'colors', 'white', 'tinysegs']
const EDIT_TIP = {
  doubles: 'tipRemoveDoubles', colors: 'tipFixColors', white: 'tipRemoveWhite', tinysegs: 'tipRemoveTinySegs',
}
const EDIT_CFG = {
  doubles:  { idle: 'removeDoubles',  armed: 'doublesArmedN',  none: 'noDoubles',    done: 'doublesDone' },
  colors:   { idle: 'fixColors',      armed: 'colorsArmedN',   none: 'colorsNone',   done: 'colorsDone' },
  white:    { idle: 'removeWhite',    armed: 'whiteArmedN',    none: 'whiteNone',    done: 'whiteDone' },
  tinysegs: { idle: 'removeTinySegs', armed: 'tinySegsArmedN', none: 'tinySegsNone', done: 'tinySegsDone' },
}
const editState = reactive({
  doubles:  { armed: false, busy: false, count: 0, flash: '' },
  colors:   { armed: false, busy: false, count: 0, flash: '' },
  white:    { armed: false, busy: false, count: 0, flash: '' },
  tinysegs: { armed: false, busy: false, count: 0, flash: '' },
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

  // pointerdown (capture) so the dropdowns close on ANY press outside them,
  // sidebar, preview canvas, etc., regardless of stopPropagation downstream.
  document.addEventListener('pointerdown', handleDocClick, true)
  document.addEventListener('keydown', onCustomSpeedsKeydown, true)
  eventBus.on('edit-result', onEditResult)
  const { printers } = await loadProfiles()
  cutters.value = printers
  // The awaits above already defer past ThreeViewer's onMounted, so its listeners
  // are registered; select the first printer (also picks its first material).
  if (cutters.value.length) selectCutter(cutters.value[0])
  bootstrapping = false   // ab jetzt ist jede Auswahl eine des Nutzers
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocClick, true)
  document.removeEventListener('keydown', onCustomSpeedsKeydown, true)
  eventBus.off('edit-result', onEditResult)
})
</script>

<style scoped>
.sidebar-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 10px 0 8px;
  background: var(--panel-bg);
  transition: background 0.25s ease;
  /* The sidebar's own height is fixed (stretched to the app's full height by
     App.vue's flex row), but its content isn't - Custom mode's speed fields
     (or just a lot of materials with long thickness lists further down) can
     grow taller than that. Without this, the overflow used to be silently
     clipped (.app-container has overflow:hidden) instead of reachable -
     scrolling the sidebar itself is what actually fixes that. */
  overflow-y: auto;
  overflow-x: hidden;
  /* Themed scrollbar - same reasoning/rules as ProfileDropdown's .dropdown-list
     and MobileApp's .m-app (the browser default ignores the app's theme). */
  scrollbar-width: thin;
  scrollbar-color: var(--ctrl-border) transparent;
}
.sidebar-container::-webkit-scrollbar { width: 8px; }
.sidebar-container::-webkit-scrollbar-track { background: transparent; }
.sidebar-container::-webkit-scrollbar-thumb {
  background: var(--ctrl-border);
  border-radius: 4px;
}
.sidebar-container::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

.button-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 15px;
}

.bottom-buttons { margin-bottom: 6px; }
.spacer { flex: 1; }

/* Space between the Material dropdown and the toggles below it */
.toggle-group { margin-top: 22px; }

/* ── Path-order algorithm label ────────────────────────────── */
.opt-text { font-size: 13px; color: var(--text-strong); margin-bottom: 6px; display: block; }

/* ── Custom speed override ─────────────────────────────────────────────────
   Just the switch (+ gear button once it's on) sits inline; the three speed
   fields live in a floating panel (.custom-speeds-menu, teleported - see the
   template comment), so this row never grows taller than any other row in
   the sidebar. */
.custom-toggle-group { margin-top: 14px; }

.custom-switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.custom-switch {
  display: flex;
  align-items: center;
  gap: 9px;
  cursor: pointer;
}
.custom-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.custom-switch-track {
  position: relative;
  flex-shrink: 0;
  width: 32px;
  height: 18px;
  border-radius: 9px;
  background: var(--ctrl-border);
  transition: background 0.2s ease;
}
.custom-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transition: transform 0.2s ease;
}
.custom-switch input:checked + .custom-switch-track { background: #00ADC6; }
.custom-switch input:checked + .custom-switch-track .custom-switch-thumb { transform: translateX(14px); }
.custom-switch input:focus-visible + .custom-switch-track { outline: 2px solid #00ADC6; outline-offset: 2px; }
.custom-switch .opt-text { margin-bottom: 0; }

/* Gear button that opens the floating speeds panel - only in the DOM once
   Custom is on (v-if), same footprint as any other small icon button. */
.custom-settings-btn {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--ctrl-border);
  border-radius: 6px;
  background: var(--ctrl-bg);
  color: var(--text-strong);
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease;
}
.custom-settings-btn:hover { background: var(--ctrl-hover); }
.custom-settings-btn.open { background: #00ADC6; border-color: #00ADC6; color: #fff; }

/* ── Custom-speeds dialog ───────────────────────────────────
   A real modal, not an anchored flyout: the sidebar has fixed controls below
   the Custom toggle and an anchored panel covered them at any window height.
   Teleported to #cc-portal-root (see the template comment).

   z-index 200 clears every other portal layer (ProfileDropdown/breakdown at
   60, .sidebar at 70) - a modal is meant to sit above all of them. */
.custom-speeds-backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.42);
  /* Teleported to a SIBLING of .app-container, so it does not inherit the
     app font - same fix as ProfileDropdown's .dropdown-menu. */
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
}

.custom-speeds-dialog {
  width: 100%;
  max-width: 380px;
  /* Never taller than the viewport, scroll inside instead of overflowing it. */
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 18px 14px;
  background: var(--dropdown-bg);
  border: 1px solid var(--dropdown-border);
  border-radius: 12px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
}

.csd-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.csd-title {
  flex: 1;
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--text-strong);
}
.csd-close {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease;
}
.csd-close:hover { background: var(--hover-bg); color: var(--text-strong); }

.csd-hint {
  margin: -4px 0 2px;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--text-muted);
}

.csd-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.csd-label {
  flex: 0 0 96px;
  font-size: 12px;
  color: var(--text-strong);
}

/* Slider and number field are two views of ONE value - the slider for a quick
   rough setting, the field for an exact one. */
.csd-slider {
  flex: 1;
  min-width: 0;
  height: 4px;
  margin: 0;
  appearance: none;
  border-radius: 2px;
  background: var(--track-bg);
  cursor: pointer;
}
.csd-slider::-webkit-slider-thumb {
  appearance: none;
  width: 14px;
  height: 14px;
  border: 0;
  border-radius: 50%;
  background: #00ADC6;
  cursor: pointer;
}
.csd-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border: 0;
  border-radius: 50%;
  background: #00ADC6;
  cursor: pointer;
}
.csd-slider:focus-visible { outline: 2px solid #00ADC6; outline-offset: 3px; }

.csd-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--panel-border);
}
.csd-btn {
  padding: 7px 14px;
  border: 1px solid var(--ctrl-border);
  border-radius: 7px;
  background: var(--ctrl-bg);
  color: var(--text-strong);
  font-size: 12.5px;
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease;
}
.csd-btn:hover { background: var(--ctrl-hover); }
.csd-btn-primary {
  border-color: #00ADC6;
  background: #00ADC6;
  color: #fff;
}
.csd-btn-primary:hover { background: #0098AE; border-color: #0098AE; }

/* Backdrop fades, dialog scales up a touch with it - the flyout's scaleY grow
   made no sense once it stopped being anchored to anything. */
.csp-fade-enter-active,
.csp-fade-leave-active { transition: opacity 0.18s ease; }
.csp-fade-enter-from,
.csp-fade-leave-to { opacity: 0; }
.csp-fade-enter-active .custom-speeds-dialog,
.csp-fade-leave-active .custom-speeds-dialog {
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.csp-fade-enter-from .custom-speeds-dialog,
.csp-fade-leave-to .custom-speeds-dialog { transform: scale(0.94); }

@media (prefers-reduced-motion: reduce) {
  .csp-fade-enter-active,
  .csp-fade-leave-active,
  .csp-fade-enter-active .custom-speeds-dialog,
  .csp-fade-leave-active .custom-speeds-dialog { transition: none; }
}

.custom-speed-input {
  flex: 0 0 auto;
  width: 56px;
  padding: 4px 6px;
  border: 1px solid var(--ctrl-border);
  border-radius: 5px;
  background: var(--panel-bg);
  color: var(--text-strong);
  font-size: 12px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
/* Hide the native number spinner - same reasoning as PlayBack's custom-speed field. */
.custom-speed-input::-webkit-outer-spin-button,
.custom-speed-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.custom-speed-input { appearance: textfield; }
.custom-speed-unit {
  flex-shrink: 0;
  width: 12px;
  font-size: 11px;
  color: var(--text-muted);
}

/* ── Upload button ─────────────────────────────────────────── */
.upload-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 10px 14px;
  background: #DE041F;
  border: 0 transparent;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.2s;
}
.upload-btn:hover:not(:disabled) { background: #B8031A; }
.upload-icon { display: block; flex-shrink: 0; color: #fff; }
.upload-btn-text { color: #fff; }

/* ── Generic sidebar button ────────────────────────────────── */
.sidebar-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  background: var(--ctrl-bg);
  border: 1px solid var(--ctrl-border);
  border-radius: 8px;
  font-size: 13px;
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
