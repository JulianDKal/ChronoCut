// Minimal reactive translations for the app. `locale` is a Vue ref, and `t(key)` reads it
// while resolving — so calling t() in a template/computed makes that spot
// re-render automatically when the language changes. The choice is persisted in
// localStorage. Flags are inline SVG (emoji flags render as bare letters on
// Windows, so we ship real little flags instead).

import { ref, computed } from 'vue'

const FLAG_DE = `<svg viewBox="0 0 5 3" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="5" height="3" fill="#000000"/>
  <rect y="1" width="5" height="1" fill="#DD0000"/>
  <rect y="2" width="5" height="1" fill="#FFCE00"/>
</svg>`

// Simplified Union Jack (the outer SVG clips the overflowing diagonals).
const FLAG_GB = `<svg viewBox="0 0 60 30" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
  <rect width="60" height="30" fill="#012169"/>
  <path d="M0,0 L60,30 M60,0 L0,30" stroke="#ffffff" stroke-width="6"/>
  <path d="M0,0 L60,30 M60,0 L0,30" stroke="#C8102E" stroke-width="4"/>
  <path d="M30,0 V30 M0,15 H60" stroke="#ffffff" stroke-width="10"/>
  <path d="M30,0 V30 M0,15 H60" stroke="#C8102E" stroke-width="6"/>
</svg>`

export const LANGS = [
  { code: 'de', label: 'Deutsch', flag: FLAG_DE },
  { code: 'en', label: 'English', flag: FLAG_GB },
]

const messages = {
  de: {
    // Sidebar
    upload: 'Hochladen',
    uploading: 'Lädt hoch…',
    selectCutter: 'Schneider wählen',
    selectMaterial: 'Material wählen',
    searchMaterial: 'Material suchen…',
    noMatch: 'Kein Treffer',
    selectThickness: 'Stärke wählen',
    option: 'Option',
    options: 'Optionen',
    showRulers: 'Lineale anzeigen',
    optimizePath: 'Pfadreihenfolge optimieren',
    rasterBlock: 'Raster als Block',
    showTravel: 'Leerwege anzeigen',
    debug: 'Debug',
    speedGradient: 'Speed-Gradient (Debug)',
    dbgSegments: 'Segmentfarben & Anzahl',
    dbgSpeed: 'Speed-Gradient',
    fixColors: 'Farben korrigieren',
    removeWhite: 'Weiß entfernen',
    removeDoubles: 'Dopplungen entfernen',
    removeN: 'Entferne',
    double: 'Dopplung',
    doubles: 'Dopplungen',
    noDoubles: 'Keine Dopplungen',
    uploadError: 'Fehler beim Hochladen der Datei: ',
    // Tooltips
    tipRulers: 'Zeigt Lineale (mm) am oberen und linken Rand des Ansichtsfensters an.',
    tipOptimize: 'Wenn aktiv, ahmt den Pfad-Optimierer des Druckers nach (kürzeste Wege). Sonst werden Pfade in Dateireihenfolge geschnitten.',
    tipRaster: 'Zeichnet Gravur (grün/Graustufen) als einen sich füllenden Block statt der Hin-und-her-Linien. Schneller.',
    tipShowTravel: 'Zeigt die Leerwege (Eilgänge ohne Laser) als gepunktete Linien an.',
    tipDebug: 'Debug: zufällige Segmentfarben + Segmentzähler (oben links).',
    tipSpeedGradient: 'Debug: färbt die Segmente nach Geschwindigkeit (blau = langsam an Ecken, rot = volle Marschgeschwindigkeit) — zum Debuggen der Beschleunigung.',
    tipRemoveDoubles: 'Sucht deckungsgleiche rote/blaue Schnittlinien. 1. Klick hebt sie hervor, 2. Klick entfernt sie.',
    tipFixColors: 'Snappt fast-rote/-blaue Linien und fast-grüne Flächen auf reines Rot/Blau/Grün.',
    tipRemoveWhite: 'Entfernt (fast) weiße Linien/Flächen (oft Wasserzeichen/Artefakte).',
    // Fit banner
    fitRotate: 'Passt nur gedreht ({dw}×{dh} mm auf {bw}×{bh} mm Bett)',
    rotateLeft: '90° ⟲ links',
    rotateRight: '90° ⟳ rechts',
    tooBig: '⚠ Design ({dw}×{dh} mm) ist größer als die Platte ({bw}×{bh} mm).',
    // Top-right controls
    toLight: 'Zu hellem Modus wechseln',
    toDark: 'Zu dunklem Modus wechseln',
    language: 'Sprache',
    // Overlays
    segments: 'Segmente',
    slow: 'langsam',
    fast: 'schnell',
    // Playback
    speed: 'Tempo',
    // Download + breakdown
    download: 'Herunterladen',
    estTime: 'Geschätzte Zeit',
    operation: 'Vorgang',
    distance: 'Strecke',
    time: 'Zeit',
    opVectorEngrave: 'Vektorgravur',
    opRasterEngrave: 'Rastergravur',
    opCut: 'Schnitt',
    opTravel: 'Leerwege',
    opOther: 'Sonstiges',
    total: 'Gesamt',
    smallPartsNote: '⚠ {n} Teile: Entnehmen & Aussortieren kostet zusätzlich ~{time}.',
    tinyPartsNote: '⚠ {n} winzige Teile (< 1,5 × 0,8 cm) können durchs Gitter fallen — Bergen kostet Zeit.',
    showParts: 'im Viewer anzeigen',
    hideParts: 'ausblenden',
  },
  en: {
    // Sidebar
    upload: 'Upload',
    uploading: 'Uploading…',
    selectCutter: 'Select Cutter',
    selectMaterial: 'Select Material',
    searchMaterial: 'Search material…',
    noMatch: 'No match',
    selectThickness: 'Select Thickness',
    option: 'option',
    options: 'options',
    showRulers: 'Show rulers',
    optimizePath: 'Optimize path order',
    rasterBlock: 'Raster as solid block',
    showTravel: 'Show travel moves',
    debug: 'Debug',
    speedGradient: 'Speed gradient (debug)',
    dbgSegments: 'Segment colours & count',
    dbgSpeed: 'Speed gradient',
    fixColors: 'Fix Colors',
    removeWhite: 'Remove White',
    removeDoubles: 'Remove Doubles',
    removeN: 'Remove',
    double: 'double',
    doubles: 'doubles',
    noDoubles: 'No doubles',
    uploadError: 'Error uploading file: ',
    // Tooltips
    tipRulers: 'Shows rulers (mm) along the top and left edges of the viewport.',
    tipOptimize: "When on, mimics the printer's path optimiser (shortest travel). When off, paths are cut in file order.",
    tipRaster: 'Draw engraving (green/grayscale) as one solid block that fills up, instead of the back-and-forth scan lines. Faster.',
    tipShowTravel: 'Shows the travel moves (rapid moves without the laser) as dotted lines.',
    tipDebug: 'Debug: random segment colours + show the segment counter (top-left).',
    tipSpeedGradient: 'Debug: colours segments by speed (blue = slow at corners, red = full march speed) — to debug acceleration.',
    tipRemoveDoubles: 'Finds coincident red/blue cut lines. 1st click highlights them, 2nd click removes them.',
    tipFixColors: 'Snaps near-red/-blue lines and near-green fills to pure red/blue/green.',
    tipRemoveWhite: 'Removes (near-)white lines/fills (often watermarks/artefacts).',
    // Fit banner
    fitRotate: 'Only fits rotated ({dw}×{dh} mm on {bw}×{bh} mm bed)',
    rotateLeft: '90° ⟲ left',
    rotateRight: '90° ⟳ right',
    tooBig: '⚠ Design ({dw}×{dh} mm) is larger than the bed ({bw}×{bh} mm).',
    // Top-right controls
    toLight: 'Switch to light mode',
    toDark: 'Switch to dark mode',
    language: 'Language',
    // Overlays
    segments: 'Segments',
    slow: 'slow',
    fast: 'fast',
    // Playback
    speed: 'Speed',
    // Download + breakdown
    download: 'Download',
    estTime: 'Estimated time',
    operation: 'Operation',
    distance: 'Distance',
    time: 'Time',
    opVectorEngrave: 'Vector engrave',
    opRasterEngrave: 'Raster engrave',
    opCut: 'Cut',
    opTravel: 'Travel',
    opOther: 'Other',
    total: 'Total',
    smallPartsNote: '⚠ {n} parts: removing & sorting adds ~{time}.',
    tinyPartsNote: '⚠ {n} tiny parts (< 1.5 × 0.8 cm) may fall through the grid — retrieving them takes time.',
    showParts: 'show in viewer',
    hideParts: 'hide',
  },
}

const STORAGE_KEY = 'chronocut-lang'
let stored = null
try { stored = localStorage.getItem(STORAGE_KEY) } catch { /* ignore */ }

export const locale = ref(messages[stored] ? stored : 'de')

export function setLocale(code) {
  if (!messages[code]) return
  locale.value = code
  try { localStorage.setItem(STORAGE_KEY, code) } catch { /* ignore */ }
}

// Translate `key`, interpolating {placeholders} from `params`. Reading
// locale.value here is what makes callers reactive to language changes.
export function t(key, params) {
  const dict = messages[locale.value] || messages.de
  let s = dict[key]
  if (s == null) s = messages.en[key] != null ? messages.en[key] : key
  if (params) s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : ''))
  return s
}

export const currentLang = computed(() => LANGS.find((l) => l.code === locale.value) || LANGS[0])
