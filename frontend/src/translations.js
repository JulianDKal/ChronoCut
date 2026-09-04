// Minimal reactive translations for the app. `locale` is a Vue ref, and `t(key)` reads it
// while resolving - so calling t() in a template/computed makes that spot
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
    tipDpi: 'Auflösung der Rastergravur (DPI). Folgt automatisch dem gewählten Material, kann hier für den aktuellen Job überschrieben werden.',
    customMode: 'Custom',
    tipCustomMode: 'Überschreibt die Geschwindigkeiten aus dem Material für Schnitt, Vektor- und Rastergravur mit eigenen Werten (% der Maximalgeschwindigkeit, wie in der Original-Software).',
    editCustomSpeeds: 'Eigene Geschwindigkeiten bearbeiten',
    customSpeedsTitle: 'Eigene Geschwindigkeiten',
    customSpeedsHint: 'Prozent der Maximalgeschwindigkeit, wie in der Original-Software. Startet bei den Werten des gewählten Materials und wird bei jeder neuen Auswahl wieder darauf gesetzt.',
    resetToDefaults: 'Zurücksetzen',
    resetToPreset: 'Zurück auf die Werte von {preset}',
    focusAll: 'Ganzes Werkstück',
    focusLasered: 'Nur schon Gelasertes',
    focusVisible: 'Nur sichtbare Farben',
    done: 'Fertig',
    close: 'Schließen',
    showRulers: 'Lineale anzeigen',
    optimizePath: 'Pfadreihenfolge',
    pathOrderFile: 'Aus (Dateireihenfolge)',
    pathOrderNn: 'Nearest-Neighbour (Standard)',
    pathOrder2opt: '2-opt',
    rasterBlock: 'Raster als Block',
    rasterFilled: 'Gefüllt',
    rasterOutline: 'Nur Umriss',
    showTravel: 'Leerwege anzeigen',
    debug: 'Debug',
    speedGradient: 'Speed-Gradient (Debug)',
    dbgSegments: 'Segmentfarben & Anzahl',
    dbgSpeed: 'Speed-Gradient',
    curveFidelity: 'Kurvenqualität',
    tessNormal: 'Normal',
    tessFine: 'Fein',
    tessUltra: 'Sehr fein',
    fixColors: 'Farben korrigieren',
    removeWhite: 'Weiß entfernen',
    removeDoubles: 'Dopplungen entfernen',
    noDoubles: 'Keine Dopplungen',
    doublesArmedN: 'Entferne {n} Dopplungen',
    doublesDone: 'Dopplungen entfernt',
    colorsArmedN: 'Korrigiere {n} Farben',
    colorsNone: 'Keine Farben zu korrigieren',
    colorsDone: 'Farben korrigiert',
    whiteArmedN: 'Entferne {n} weiße',
    whiteNone: 'Kein Weiß zu entfernen',
    whiteDone: 'Weiß entfernt',
    removeTinySegs: 'Winzige Segmente entfernen',
    tinySegsNone: 'Keine winzigen Segmente',
    tinySegsArmedN: 'Entferne {n} winzige Segmente',
    tinySegsDone: 'Winzige Segmente entfernt',
    cleanAll: 'Farben & Dopplungen fixen',
    cleaning: 'Bereinige…',
    cleanAllDone: '{n} bereinigt',
    cleanAllNone: 'Nichts zu bereinigen',
    mobileTagline: 'Laser-Job-Vorschau',
    noFileHint: 'Lade eine PDF- oder SVG-Datei hoch, um die Zeit zu schätzen.',
    uploadError: 'Fehler beim Hochladen der Datei: ',
    // Tooltips
    tipRulers: 'Zeigt Lineale (mm) am oberen und linken Rand des Ansichtsfensters an.',
    tipOptimize: 'Algorithmus für die Schnittreihenfolge - zum Vergleichen mit dem, was der Drucker tatsächlich tut. "2-opt" trifft das gemessene Leerweg-Budget des Druckers am besten; "Nearest-Neighbour" ist schlechter, aber schneller zu berechnen; "Aus" schneidet stur in Dateireihenfolge.',
    tipRaster: 'Zeichnet Gravur (grün/Graustufen) als einen sich füllenden Block statt der Hin-und-her-Linien. Schneller.',
    tipShowTravel: 'Zeigt die Leerwege (Eilgänge ohne Laser) als gepunktete Linien an.',
    tipDebug: 'Debug: zufällige Segmentfarben + Segmentzähler (oben links).',
    tipSpeedGradient: 'Debug: färbt die Segmente nach Geschwindigkeit (blau = langsam an Ecken, rot = volle Marschgeschwindigkeit) - zum Debuggen der Beschleunigung.',
    tipRemoveDoubles: 'Sucht deckungsgleiche rote/blaue Schnittlinien. 1. Klick hebt sie hervor, 2. Klick entfernt sie.',
    tipFixColors: 'Snappt fast-rote/-blaue Linien und fast-grüne Flächen auf reines Rot/Blau/Grün.',
    tipRemoveWhite: 'Entfernt (fast) weiße Linien/Flächen (oft Wasserzeichen/Artefakte).',
    tipRemoveTinySegs: 'Entfernt Linien/Kurven unter 0,005 mm Länge - Extraktionsrauschen, an dem der Optimierer der Maschine gelegentlich scheitert.',
    resetView: 'Ansicht zurücksetzen',
    hideColor: 'Ausblenden',
    showColor: 'Einblenden',
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
    customSpeed: 'x',
    apply: 'Übernehmen',
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
    tinyPartsNote: '⚠ {n} winzige Teile (< 1,5 × 0,8 cm) können durchs Gitter fallen. Das Bergen kostet Zeit.',
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
    tipDpi: 'Raster engrave resolution (DPI). Follows the selected material automatically, can be overridden here for the current job.',
    customMode: 'Custom',
    tipCustomMode: 'Overrides the cut, vector-engrave and raster-engrave speeds from the material with your own values (% of max speed, same as the original software).',
    editCustomSpeeds: 'Edit custom speeds',
    customSpeedsTitle: 'Custom speeds',
    customSpeedsHint: 'Percent of max speed, same as the original software. Starts from the selected material’s own values and is reset to them whenever you pick a different one.',
    resetToDefaults: 'Reset',
    resetToPreset: 'Back to the {preset} values',
    focusAll: 'Whole workpiece',
    focusLasered: 'Only what is lasered',
    focusVisible: 'Only visible colours',
    done: 'Done',
    close: 'Close',
    showRulers: 'Show rulers',
    optimizePath: 'Path order',
    pathOrderFile: 'Off (file order)',
    pathOrderNn: 'Nearest-neighbour (default)',
    pathOrder2opt: '2-opt',
    rasterBlock: 'Raster as solid block',
    rasterFilled: 'Filled',
    rasterOutline: 'Outline only',
    showTravel: 'Show travel moves',
    debug: 'Debug',
    speedGradient: 'Speed gradient (debug)',
    dbgSegments: 'Segment colours & count',
    dbgSpeed: 'Speed gradient',
    curveFidelity: 'Curve fidelity',
    tessNormal: 'Normal',
    tessFine: 'Fine',
    tessUltra: 'Ultra fine',
    fixColors: 'Fix Colors',
    removeWhite: 'Remove White',
    removeDoubles: 'Remove Doubles',
    noDoubles: 'No doubles',
    doublesArmedN: 'Remove {n} doubles',
    doublesDone: 'Doubles removed',
    colorsArmedN: 'Fix {n} colors',
    colorsNone: 'No colors to fix',
    colorsDone: 'Colors fixed',
    whiteArmedN: 'Remove {n} white',
    whiteNone: 'No white to remove',
    whiteDone: 'White removed',
    removeTinySegs: 'Remove Tiny Segments',
    tinySegsNone: 'No tiny segments',
    tinySegsArmedN: 'Remove {n} tiny segments',
    tinySegsDone: 'Tiny segments removed',
    cleanAll: 'Fix Colors & Doubles',
    cleaning: 'Cleaning…',
    cleanAllDone: '{n} cleaned',
    cleanAllNone: 'Nothing to clean',
    mobileTagline: 'Laser job preview',
    noFileHint: 'Upload a PDF or SVG file to estimate the time.',
    uploadError: 'Error uploading file: ',
    // Tooltips
    tipRulers: 'Shows rulers (mm) along the top and left edges of the viewport.',
    tipOptimize: 'Algorithm used to order the cuts - for comparing against what the printer actually does. "2-opt" best matches the printer\'s measured travel budget; "Nearest-neighbour" is worse but cheaper to compute; "Off" cuts in plain file order.',
    tipRaster: 'Draw engraving (green/grayscale) as one solid block that fills up, instead of the back-and-forth scan lines. Faster.',
    tipShowTravel: 'Shows the travel moves (rapid moves without the laser) as dotted lines.',
    tipDebug: 'Debug: random segment colours + show the segment counter (top-left).',
    tipSpeedGradient: 'Debug: colours segments by speed (blue = slow at corners, red = full march speed) - to debug acceleration.',
    tipRemoveDoubles: 'Finds coincident red/blue cut lines. 1st click highlights them, 2nd click removes them.',
    tipFixColors: 'Snaps near-red/-blue lines and near-green fills to pure red/blue/green.',
    tipRemoveWhite: 'Removes (near-)white lines/fills (often watermarks/artefacts).',
    tipRemoveTinySegs: 'Removes lines/curves under 0.005 mm long - extraction noise that occasionally trips up the machine\'s own optimiser.',
    resetView: 'Reset view',
    hideColor: 'Hide',
    showColor: 'Show',
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
    customSpeed: 'x',
    apply: 'Apply',
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
    tinyPartsNote: '⚠ {n} tiny parts (< 1.5 × 0.8 cm) may fall through the grid. Retrieving them takes time.',
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
