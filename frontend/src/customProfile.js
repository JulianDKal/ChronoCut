// Persistence for the "custom profile" override layer on top of the normal
// material/thickness-driven speeds (see profiles.js speedsFor()). Same
// pattern as theme.js/viewSettings.js/layout.js: one key, read once on
// mount, tolerant of storage being unavailable.
//
// Custom MODE (the on/off switch) and the three speed VALUES are all sticky in
// localStorage. What the values do on a new material/thickness depends on
// whether the user has edited them:
//
//   untouched -> reseeded from the newly-selected preset
//                (customSpeedsForPreset below), exactly like DPI already
//                behaves (dpiForPreset), so the fields always show something
//                that would actually cut the selected material;
//   edited    -> a MANUAL material/thickness change still reseeds them (that
//                is the user asking for the new material's numbers), but the
//                automatic first selection on startup does NOT - hand-dialled
//                values survive a reload.
//
// customSpeedsEdited tracks that distinction. "Reset" in the dialog restores
// the preset's own numbers and clears the flag again.
import { rasterPctForSpeed } from './calibration'

export const CUSTOM_PROFILE_KEY = 'chronocut-custom-profile-v2'

// DPI choices offered in the sidebar dropdown (matches the values Epilog's
// own presets actually use most - see backend/printers/*.xml).
export const DPI_PRESETS = [200, 300, 600, 1200]
export const DEFAULT_DPI = 600   // fallback when a preset carries no dpi/pitch of its own

export const DEFAULT_CUSTOM_PROFILE = {
  customMode: false,
  // Set once the user changes a speed by hand; cleared by "Reset" and by a
  // manual material/thickness change. Decides whether the startup selection is
  // allowed to overwrite the stored values - see Sidebar.vue.
  customSpeedsEdited: false,
  // % of the printer's max speed - exactly how the original Epilog software's
  // speed dial (and the XML presets' own unit="%" values) express it, NOT mm/s.
  // Only a fallback for when no preset is selected yet; normally the values
  // come from the selected preset (customSpeedsForPreset).
  customSpeeds: { cut: 30, engrave: 80, raster: 100 },
}

export function getStoredCustomProfile() {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_PROFILE_KEY) || '{}')
    return {
      ...DEFAULT_CUSTOM_PROFILE,
      ...raw,
      customSpeeds: { ...DEFAULT_CUSTOM_PROFILE.customSpeeds, ...(raw.customSpeeds || {}) },
    }
  } catch {
    return { ...DEFAULT_CUSTOM_PROFILE, customSpeeds: { ...DEFAULT_CUSTOM_PROFILE.customSpeeds } }
  }
}

// Merges a partial patch into the stored profile (customSpeeds merges one
// level deep too, so setStoredCustomProfile({ customSpeeds: { cut: 40 } })
// doesn't clobber engrave/raster) and persists the result.
export function setStoredCustomProfile(patch) {
  const cur = getStoredCustomProfile()
  const next = {
    ...cur,
    ...patch,
    customSpeeds: { ...cur.customSpeeds, ...(patch.customSpeeds || {}) },
  }
  try {
    localStorage.setItem(CUSTOM_PROFILE_KEY, JSON.stringify(next))
  } catch { /* storage unavailable - the override just won't persist */ }
  return next
}

// DPI -> pitch uses the exact same formula profiles.js's parseOp() already
// applies to a preset's own `dpi=".."` XML attribute, so a DPI override
// behaves identically to a preset that shipped with that DPI baked in.
export const pitchForDpi = (dpi) => 25.4 / dpi

// The DPI a freshly-selected thickness preset implies: its own raster pitch
// converted back to dpi (round-trips exactly - parseOp computed the pitch the
// same way from the XML's dpi="…" attribute), or DEFAULT_DPI when the preset
// carries no raster pitch at all.
export function dpiForPreset(thicknessPreset) {
  const pitch = thicknessPreset?.raster?.pitch
  if (!pitch || !isFinite(pitch) || pitch <= 0) return DEFAULT_DPI
  const d = Math.round(25.4 / pitch)
  return d > 0 ? d : DEFAULT_DPI
}

// ── Preset -> custom speeds ─────────────────────────────────────────────────
// The custom fields are percentages of the printer's max speed; a preset op is
// either already a percentage (unit="%", which every real preset in
// backend/printers/*.xml uses) or an absolute mm/s value. Converting back:
//
//   vector  %  = mm/s / printer.maxSpeed * 100
//   raster  %  = rasterPctForSpeed(mm/s)   - raster runs on its OWN speed
//                scale (roughly 7x the vector one), so dividing by maxSpeed
//                would be badly wrong here. See calibration.js.
//
// Clamped to the 1..100 the dialog's inputs accept, and rounded, since both the
// slider and the number field step in whole percent.
const clampPct = (v) => Math.max(1, Math.min(100, Math.round(v)))

function pctForOp(op, maxSpeed, isRaster) {
  if (!op || !isFinite(op.speed) || op.speed <= 0) return null
  if (op.unit === '%') return clampPct(op.speed)
  return clampPct(isRaster ? rasterPctForSpeed(op.speed) : (op.speed / maxSpeed) * 100)
}

// The custom speeds a freshly-selected thickness preset implies. Anything the
// preset does not specify keeps the built-in fallback, so the dialog never ends
// up with an empty field.
export function customSpeedsForPreset(thicknessPreset, printer) {
  const max = printer?.maxSpeed || 500
  const d = DEFAULT_CUSTOM_PROFILE.customSpeeds
  return {
    cut: pctForOp(thicknessPreset?.cut, max, false) ?? d.cut,
    engrave: pctForOp(thicknessPreset?.engrave, max, false) ?? d.engrave,
    raster: pctForOp(thicknessPreset?.raster, max, true) ?? d.raster,
  }
}
