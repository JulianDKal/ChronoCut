import { CALIBRATION, rasterSpeedForPct } from './calibration'
import { t } from './translations'

// Printer / material profiles loaded at startup from GET /api/printers, which
// returns the contents of every *.xml in backend/printers/. Each file is
// self-contained: a root <printer …> with specs + a <materials> block of presets.
//
// If the request fails or files are malformed we fall back to the built-in
// defaults so the app always works.

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const DEFAULT_PROFILES = {
  printers: [
    {
      id: 'edgar', name: 'Edgar', powerW: 60,
      bedWidth: 1000, bedHeight: 700, maxSpeed: 500, accel: 3000,
      materials: [
        { name: 'Plywood', thicknesses: [
          { id: 'ply3', label: '3 mm',
            cut:     { speed: 30,  unit: 'mm/s', power: 80 },
            engrave: { speed: 80,  unit: 'mm/s', power: 40 },
            raster:  { speed: 200, unit: 'mm/s', power: 35, pitch: 0.6 } },
        ] },
      ],
    },
  ],
}

const num = (el, attr, dflt) => {
  const n = parseFloat(el?.getAttribute(attr))
  return isFinite(n) ? n : dflt
}
const str = (el, attr, dflt = '') => el?.getAttribute(attr) ?? dflt

function parseOp(el) {
  if (!el) return null
  let pitch
  if (el.hasAttribute('pitch')) pitch = num(el, 'pitch', 0.6)
  else if (el.hasAttribute('dpi')) pitch = 25.4 / num(el, 'dpi', 42)
  return { speed: num(el, 'speed', 0), unit: str(el, 'unit', 'mm/s'), power: num(el, 'power', 0), pitch }
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('XML parse error')
  return doc
}

function parseThickness(el) {
  return {
    id: str(el, 'id') || str(el, 'value'),
    label: str(el, 'value') || str(el, 'id'),
    cut: parseOp(el.querySelector('cut')),
    engrave: parseOp(el.querySelector('engrave')),
    raster: parseOp(el.querySelector('raster')),
  }
}

// A material family groups thickness presets. Falls back to treating a flat
// <material> (with cut/engrave/raster directly) as a single thickness.
function parseFamily(m) {
  const tEls = [...m.querySelectorAll('thickness')]
  const thicknesses = tEls.length
    ? tEls.map(parseThickness)
    : [{ id: str(m, 'id') || str(m, 'name'), label: str(m, 'name') || str(m, 'id') || '–',
         cut: parseOp(m.querySelector('cut')), engrave: parseOp(m.querySelector('engrave')),
         raster: parseOp(m.querySelector('raster')) }]
  return { name: str(m, 'name') || str(m, 'id'), thicknesses }
}

// Parse one self-contained printer file: root <printer> attributes + its
// <materials>/<material>/<thickness> presets.
function parsePrinter(root) {
  return {
    id: str(root, 'id'), name: str(root, 'name') || str(root, 'id'),
    powerW: num(root, 'powerW', 0),
    bedWidth: num(root, 'bedWidth', 1000), bedHeight: num(root, 'bedHeight', 700),
    maxSpeed: num(root, 'maxSpeed', 500), accel: num(root, 'accel', 0),
    materials: [...root.querySelectorAll('material')].map(parseFamily),
  }
}

// The backend lists every *.xml in backend/printers/ and returns their contents
// (GET /api/printers). Each is a self-contained printer file (specs + presets),
// so adding a printer = dropping a file in that folder - no index needed.
export async function loadProfiles() {
  try {
    const res = await fetch(`${API_URL}/api/printers`)
    if (!res.ok) throw new Error(`/api/printers → ${res.status}`)
    const { printers: xmls } = await res.json()
    const printers = []
    for (const xml of (xmls || [])) {
      try {
        const root = parseXml(xml).querySelector('printer')
        if (root) printers.push(parsePrinter(root))
      } catch (e) {
        console.warn('[profiles] bad printer xml:', e.message)
      }
    }
    if (printers.length) return { printers }
  } catch (e) {
    console.warn('[profiles] using built-in defaults:', e.message)
  }
  return DEFAULT_PROFILES
}

// Resolve a speed spec (mm/s, or % of the printer's max speed) to mm/s.
export function resolveSpeed(spec, maxSpeed) {
  if (!spec || !isFinite(spec.speed)) return null
  return spec.unit === '%' ? (spec.speed / 100) * maxSpeed : spec.speed
}

// Resolved speeds (+ raster pitch + acceleration) for buildToolpath, given the
// selected printer and a thickness preset (with cut/engrave/raster specs).
// Raster runs on a SEPARATE speed scale from the vector head - measured roughly
// 7× faster, so resolving raster-% against the vector maxSpeed is badly wrong.
// See calibration.js (rasterSpeedForPct) for the measured curve.
function resolveRasterSpeed(spec) {
  if (!spec || !isFinite(spec.speed)) return null
  return spec.unit === '%' ? rasterSpeedForPct(spec.speed) : spec.speed
}

export function speedsFor(printer, preset) {
  const max = printer?.maxSpeed || 500
  const cut = resolveSpeed(preset?.cut, max) ?? 30
  const engrave = resolveSpeed(preset?.engrave, max) ?? 80
  const raster = resolveRasterSpeed(preset?.raster) ?? engrave
  return {
    // Travel runs at a constant, camera-measured 250 mm/s - it does NOT scale
    // with the job's speed setting.
    speeds: { cut, engrave, raster, other: cut, travel: CALIBRATION.travelSpeed },
    rasterPitch: preset?.raster?.pitch ?? 0.6,
    accel: printer?.accel || CALIBRATION.vectorAccel,
  }
}

// Layers the "custom profile" expert override (see customProfile.js) on top of
// whatever speedsFor() resolved from the selected material/thickness:
//   - dpi: always a concrete number now (Sidebar.vue keeps it in sync with the
//     selected preset via dpiForPreset, or the user's own dropdown pick) -
//     replaces the raster pitch the preset would otherwise carry.
//   - customMode + customSpeeds: replace cut/engrave/raster. customSpeeds are
//     percentages of the printer's max speed, resolved exactly like the XML
//     presets' own unit="%" values - raster on its own measured curve
//     (rasterSpeedForPct), NOT against the vector maxSpeed.
export function applyCustomProfile(resolved, { dpi, customMode, customSpeeds } = {}, printer) {
  const speeds = { ...resolved.speeds }
  const rasterPitch = dpi ? 25.4 / dpi : resolved.rasterPitch

  if (customMode && customSpeeds) {
    const max = printer?.maxSpeed || 500
    speeds.cut = resolveSpeed({ speed: customSpeeds.cut, unit: '%' }, max)
    speeds.engrave = resolveSpeed({ speed: customSpeeds.engrave, unit: '%' }, max)
    speeds.raster = rasterSpeedForPct(customSpeeds.raster)
    // Matches speedsFor()'s own default relationship (other mirrors cut) -
    // "other" has no colour of its own to attach a custom field to.
    speeds.other = speeds.cut
  }

  return { speeds, rasterPitch, accel: resolved.accel }
}

// ── Material picker helpers ─────────────────────────────────────────────────
// Most materials carry exactly one thickness (37 of 54 on Edgar, 20 of 29 on
// George), and a dropdown with a single entry is a control that can't do
// anything - so the UI hides the thickness picker unless there is an actual
// choice to make.
export const hasThicknessChoice = (family) => (family?.thicknesses?.length || 0) > 1

// Detail line under a material in the picker. With a real choice it counts the
// options; with exactly one it shows THAT thickness instead, because the
// thickness dropdown is hidden in that case and the value would otherwise not
// appear anywhere in the UI. The exception is the synthetic single "thickness"
// parseFamily() invents for a flat <material> - its label is just the material
// name again, which would read as a stutter.
export function familyDetail(family) {
  const th = family?.thicknesses || []
  if (th.length === 1 && th[0].label && th[0].label !== family.name) return th[0].label
  return `${th.length} ${th.length === 1 ? t('option') : t('options')}`
}
