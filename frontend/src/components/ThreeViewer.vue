<template>
  <div ref="container" class="three-container">
    <canvas ref="canvas" style="width: 100%; height: 100%; display: block;"></canvas>
    <!-- CAD rulers (top + left), drawn in 2D over the WebGL canvas -->
    <canvas ref="rulerCanvas" class="ruler-canvas"></canvas>
  </div>
</template>

<style scoped>
.three-container {
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
}
.ruler-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;   /* clicks pass through to the 3D canvas */
}
</style>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import * as THREE from 'three'
import eventBus from '../eventBus'
import { buildToolpath, isGreen, isRasterColor, categorize, SPEED_MM_S, fixColors, computeDoubleRemoval, rotateData, removeWhite, detectFixColors, detectRemoveWhite, detectTinySegments, removeTinySegments, rampSegments, annotateRuns, movePolyline, accelFor, cornerPenaltyFor, moveExtraTime, DEFAULT_PATH_ORDER, dist, setTessellationTolerance, RASTER_BITMAP_MARK } from '../toolpath'
import { getStoredDark } from '../theme'
import { getStoredViewSettings, TESSELLATION_TOL_BY_KEY } from '../viewSettings'

// Restored once here (module scope, evaluated on first import) rather than
// read individually per variable below - same "self-source on mount, don't
// only wait for a broadcast" reasoning as getStoredDark(), so this stays
// correct even if ViewToggles ever mounts after ThreeViewer or not at all.
const restoredViewSettings = getStoredViewSettings()
setTessellationTolerance(TESSELLATION_TOL_BY_KEY[restoredViewSettings.tessellation] ?? TESSELLATION_TOL_BY_KEY.normal)

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const container = ref(null)
const canvas    = ref(null)
const rulerCanvas = ref(null)
let scene, camera, renderer, controls
let rectangleFrame
let drawingGroup       // THREE.Group for imported geometry
let highlightGroup     // overlay group for the Remove-Doubles highlight
let headMarker         // little laser print-head icon at the current head position
let canvWidth, canvHeight
const VIEW_REF_HALF_H = 400  // world half-height (mm) of the frustum at zoom 1
let contentBox = null        // bbox of the last loaded design (for re-framing)

// Cutter state - default to Edgar 1000×700 mm
let cutterW = 1000
let cutterH = 700

// Retained so we can rebuild the toolpath when a toggle changes without
// re-fetching from the backend.
let currentData = null
// Defaults below are restored from localStorage (see viewSettings.js) so a
// reload comes back exactly as left; ViewToggles re-broadcasts the same
// values once on its own mount (its state is the interactive source of truth
// after that), which is what live-updates these while the page stays open.
let optimizePath = restoredViewSettings.pathOrder    // algorithm id: 'file' | 'nn' | '2opt' (see toolpath.js)
let rasterMode   = restoredViewSettings.rasterMode   // 'lines' (scan lines) | 'block' (filled) | 'outline'
let debugColors  = restoredViewSettings.debugColors  // colour every segment randomly (to count them)
let showTravel   = restoredViewSettings.showTravel   // draw the dotted "Leerwege" (travel) moves
let speedGradient = restoredViewSettings.speedGradient // debug: colour segments by speed (accel debugging)
let lineMaterial = null    // toolpath line material (for live travel show/hide)
let showRulers   = restoredViewSettings.showRulers   // CAD-style rulers along the top + left edges (mm)
let lastRulerSig = ''      // redraw the rulers only when the view actually changes
let tinyBoxes = []         // bounding boxes of parts small enough to fall through the grid
let showTinyHighlight = false  // highlight those parts in the viewer (on demand)
let tinyHighlightGroup = null

// Per-colour (cut/vector-engrave/raster/other - mirrors the breakdown panel's
// rows) view-only visibility, driven by the eye buttons on those rows in
// DownloadComponent. Purely cosmetic: hidden kinds are skipped when building
// the drawn geometry below, but the toolpath timeline (runTime/headRun) keeps
// advancing through them unchanged, so the estimated time and the playback
// clock never depend on what's currently shown.
let hiddenKinds = new Set()
// [{ k, minX, minY, maxX, maxY }] sorted by k = time bin index; see lasedBox().
let revealBins = []
let dragging = false   // true while the user is panning/zooming by hand

// Head speeds + raster pitch from the selected printer/material (profiles.js).
// Default to the placeholders until a material is chosen.
let currentSpeeds = SPEED_MM_S
let currentRasterPitch = undefined   // undefined → buildToolpath default
let currentAccel = 0                 // mm/s² (0 → constant-speed timing)

// Travel "Leerwege" are drawn as dotted gray lines: dash on/off length in mm.
const TRAVEL_DASH = 3
const TRAVEL_GAP  = 2

// Opacity of the faint full-design preview drawn under the playback progress
const PREVIEW_OPACITY = 0.2

// Colour helpers. In dark mode, dark line colours (black, dark blue, …) are
// lightened so they stay visible on the dark background.
const hexToRGB = (hex) => {
  const c = hex || '#000000'
  return [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255]
}
const adjustForTheme = ([r, g, b]) => {
  if (!isDark) return [r, g, b]
  const lum = 0.299 * r + 0.587 * g + 0.114 * b
  if (lum < 0.55) {
    const t = ((0.55 - lum) / 0.55) * 0.75   // mix toward white, more for darker colours
    return [r + (1 - r) * t, g + (1 - g) * t, b + (1 - b) * t]
  }
  return [r, g, b]
}
// Bitmap raster scan lines carry a MARKER colour (toolpath.js's
// RASTER_BITMAP_MARK), not a real one - a fixed hex can't work in both themes
// (white vanishes on the light theme's white bed, a mid gray looks washed out
// on the dark theme's dark bed). Resolve it to a real colour per theme instead.
const lineRGB = (hex) => {
  if (hex && hex.toLowerCase() === RASTER_BITMAP_MARK) {
    return isDark ? [1, 1, 1] : [0.25, 0.25, 0.25]
  }
  return adjustForTheme(hexToRGB(hex))
}
const themedColor = (hex) => { const [r, g, b] = lineRGB(hex); return new THREE.Color(r, g, b) }

// Playback state for the single toolpath line. The reveal axis is TIME (so the
// head moves slower through engraves than rapid travels), driven entirely by the
// shader's uProgress uniform.
//   material : the ShaderMaterial whose uProgress uniform we advance
//   total    : total toolpath duration (s)
//   segCount : number of line segments (debug / stats)
let playback = null

// Playback clock - the reveal is advanced per render frame by real elapsed time
// (×speed) for smooth motion, instead of coarse integer slider steps.
let pbPlaying = false
let pbSpeed   = 1
let pbTime    = 0            // current head time along the toolpath (seconds)
const pbClock = new THREE.Clock()

// ── Init ──────────────────────────────────────────────────────────────────────
const initThree = () => {
  scene = new THREE.Scene()

  canvWidth  = container.value.clientWidth
  canvHeight = container.value.clientHeight

  renderer = new THREE.WebGLRenderer({ canvas: canvas.value, antialias: true })
  // updateStyle=false: keep the canvas's own `width/height: 100%` CSS instead
  // of letting three pin it to a pixel size. While the sidebar is being
  // dragged the container resizes every frame, and a canvas pinned to the
  // PREVIOUS size leaves a strip of un-painted container for a frame.
  renderer.setSize(canvWidth, canvHeight, false)
  container.value.appendChild(renderer.domElement)
  applyTheme()

  // Orthographic camera looking straight at the z=0 plane. Fitting is done via
  // camera.zoom + controls (so zoom-to-cursor and panning compose cleanly).
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000)
  camera.position.set(0, 0, 5)
  camera.lookAt(0, 0, 0)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableZoom   = true
  controls.enablePan    = true
  controls.enableRotate = false
  controls.screenSpacePanning = true
  controls.zoomToCursor = true   // wheel zooms toward the mouse, not the centre
  // Left AND right drag pan (rotate is disabled, so left was otherwise unused).
  controls.mouseButtons = {
    LEFT:   THREE.MOUSE.PAN,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT:  THREE.MOUSE.PAN,
  }

  // Any hands-on interaction wins over a running camera flight - being unable
  // to interrupt an animation is worse than not having one.
  controls.addEventListener('start', () => { camFlight = null; dragging = true })
  controls.addEventListener('end', () => { dragging = false })
  // Render straight away while dragging instead of waiting for the next
  // animation frame. OrbitControls already applies a pan synchronously inside
  // its pointermove handler, so by the time this fires the camera is exact -
  // only the PICTURE was a frame behind, which is what made the content look
  // like it trails the cursor. Browsers coalesce pointermove to one per frame,
  // so this does not multiply the render count.
  controls.addEventListener('change', () => {
    if (!dragging || !renderer) return
    updateHeadMarker()
    renderer.render(scene, camera)
    drawRulers()
  })

  headMarker = makeHeadMarker()
  scene.add(headMarker)

  applyFrustum()
  frameBox(bedBox())   // start framed on the bed; loading a file re-frames it
  animate()
}

// ── Theme ─────────────────────────────────────────────────────────────────────
// Read the persisted preference directly (not just via the 'theme-changed' event)
// so a fresh mount - e.g. coming back from the mobile layout, which unmounts and
// remounts this component, always starts in sync with the rest of the UI.
let isDark = getStoredDark()
const THEME = {
  light: { bg: 0xdde1e7, bed: 0xffffff, border: 0xd0d4da },
  dark:  { bg: 0x17181b, bed: 0x2a2c30, border: 0x3a3d42 },
}

const applyTheme = () => {
  if (!scene || !renderer) return
  const t = isDark ? THEME.dark : THEME.light
  scene.background = new THREE.Color(t.bg)
  renderer.setClearColor(t.bg)
  drawCutterFrame()   // redraw bed with themed colours
}

const handleThemeChanged = (dark) => {
  isDark = !!dark
  applyTheme()
  // Rebuild the design so line/fill colours re-adjust for the new theme.
  // drawObjects preserves the current playback position by default.
  if (currentData) drawObjects(currentData)
}

// ── Camera ────────────────────────────────────────────────────────────────────
// Frustum is a fixed reference size (aspect-corrected); all fitting/zoom is done
// through camera.zoom so OrbitControls' zoom-to-cursor and pan work naturally.
const applyFrustum = () => {
  if (!camera || !renderer) return
  const aspect = canvWidth / canvHeight
  camera.left   = -VIEW_REF_HALF_H * aspect
  camera.right  =  VIEW_REF_HALF_H * aspect
  camera.top    =  VIEW_REF_HALF_H
  camera.bottom = -VIEW_REF_HALF_H
  camera.updateProjectionMatrix()
  renderer.setSize(canvWidth, canvHeight, false)   // see initThree for updateStyle=false
}

const bedBox = () => ({ minX: 0, maxX: cutterW, minY: -cutterH, maxY: 0 })

// Centre the view on `box` and zoom so it fits with a little padding.
//
// Only things that genuinely FLOAT over the canvas get a reserved strip. The
// playback/download dock no longer does (it sits in normal flow below the
// viewer, so the container is already the free area, reserving for it here
// as well used to push the workspace visibly too high). The top-right control
// column still does float, so the workspace centres between the sidebar and
// that column rather than the window edge: 42px of button + 16px of margin,
// plus a little breathing room.
const RIGHT_INSET_PX = 72

// Where the camera would have to sit for `box` to fill the usable area.
const framingFor = (box, pad = 1.12) => {
  const cx0 = (box.minX + box.maxX) / 2
  const cy = (box.minY + box.maxY) / 2
  const bw = Math.max(1, box.maxX - box.minX)
  const bh = Math.max(1, box.maxY - box.minY)
  const aspect = canvWidth / canvHeight
  const viewW = VIEW_REF_HALF_H * aspect * 2
  const viewH = VIEW_REF_HALF_H * 2
  // Fit into (and centre within) the area LEFT of the floating control column.
  const inset = Math.min(RIGHT_INSET_PX, canvWidth * 0.4)
  const usableFrac = (canvWidth - inset) / canvWidth
  const zoom = Math.min((viewW * usableFrac) / (bw * pad), viewH / (bh * pad))
  // Look at a point half the reserved strip to the RIGHT of the box centre, so
  // the box lands centred in the usable area instead of the full canvas.
  const worldPerPx = viewW / (zoom * canvWidth)
  return { zoom, cx: cx0 + (inset / 2) * worldPerPx, cy }
}

const applyFraming = ({ zoom, cx, cy }) => {
  camera.zoom = zoom
  camera.position.set(cx, cy, 5)
  camera.lookAt(cx, cy, 0)
  controls.target.set(cx, cy, 0)
  camera.updateProjectionMatrix()
  controls.update()
}

const frameBox = (box, pad = 1.12) => {
  if (!camera || !box || !isFinite(box.minX)) return
  camFlight = null            // a jump beats an in-flight animation
  applyFraming(framingFor(box, pad))
}

// ── Animated framing ─────────────────────────────────────────────────────────
// Same destination as frameBox, flown to instead of jumped to. Zoom is
// interpolated GEOMETRICALLY (exp of the lerped log), not linearly: zoom is a
// scale factor, so a linear ramp from 0.4 to 8 spends most of the flight
// already zoomed in and lands in a rush. In log space every step scales the
// view by the same factor, which is what reads as an even zoom.
const FLIGHT_MS = 520
let camFlight = null

const easeInOutCubic = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2)

const flyToBox = (box, pad = 1.12) => {
  if (!camera || !box || !isFinite(box.minX)) return
  const to = framingFor(box, pad)
  const from = { zoom: camera.zoom, cx: controls.target.x, cy: controls.target.y }
  // Already there (within a pixel and a per-mille of zoom): don't animate a
  // no-op, it just looks like a stutter.
  const worldPerPx = (VIEW_REF_HALF_H * (canvWidth / canvHeight) * 2) / (camera.zoom * canvWidth)
  if (Math.abs(Math.log(to.zoom / from.zoom)) < 0.001 &&
      Math.hypot(to.cx - from.cx, to.cy - from.cy) < worldPerPx) return
  camFlight = { from, to, t0: performance.now() }
}

// Advanced once per frame from animate().
const stepCamFlight = () => {
  if (!camFlight) return
  const u = Math.min(1, (performance.now() - camFlight.t0) / FLIGHT_MS)
  const e = easeInOutCubic(u)
  const { from, to } = camFlight
  applyFraming({
    zoom: Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * e),
    cx: from.cx + (to.cx - from.cx) * e,
    cy: from.cy + (to.cy - from.cy) * e,
  })
  if (u >= 1) camFlight = null
}

// Bounding box of all loaded content (vectors, filled paths, images).
const computeContentBBox = (data) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const grow = (x, y) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  for (const o of data) {
    if (o.type === 'l') { grow(o.x1, o.y1); grow(o.x2, o.y2) }
    else if (o.type === 'c') { grow(o.x1, o.y1); grow(o.x2, o.y2); grow(o.x3, o.y3); grow(o.x4, o.y4) }
    else if (o.type === 'fp') {
      for (const c of o.path) {
        if ('x'  in c) grow(c.x,  c.y)
        if ('x1' in c) grow(c.x1, c.y1)
        if ('x2' in c) grow(c.x2, c.y2)
      }
    } else if (o.type === 'img') { grow(o.x, o.y); grow(o.x + o.w, o.y - o.h) }
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

// ── Cutter frame ──────────────────────────────────────────────────────────────
// The bed is drawn as a subtle "sheet of paper": a fill, a soft drop shadow
// offset to the bottom-right, and a thin light border (no hard black frame).
// Origin (0,0) = top-left corner.  X → right, Y → down (negative).
// Build a soft drop-shadow mesh: a blurred black rectangle drawn to a canvas and
// mapped onto a plane sized so its solid core matches the bed, offset to the
// bottom-left. The opaque bed fill (drawn on top) hides the part under the bed.
const makeBedShadow = () => {
  const cw = 512
  const ch = Math.max(64, Math.round(cw * cutterH / cutterW))
  const margin = 56          // canvas px padding around the rect for the blur
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, cw, ch)
  ctx.filter = 'blur(26px)'
  ctx.fillStyle = '#000000'
  ctx.fillRect(margin, margin, cw - 2 * margin, ch - 2 * margin)

  const tex = new THREE.CanvasTexture(canvas)
  tex.minFilter = THREE.LinearFilter

  // World size so the solid (pre-blur) rect maps exactly onto the bed.
  const planeW = cutterW * cw / (cw - 2 * margin)
  const planeH = cutterH * ch / (ch - 2 * margin)
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(planeW, planeH),
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false,
      opacity: isDark ? 0.55 : 0.22,
    }),
  )
  // Centre on the bed, then offset toward the bottom-left.
  mesh.position.set(cutterW / 2 - 18, -cutterH / 2 - 18, -0.4)
  return mesh
}

const drawCutterFrame = () => {
  if (rectangleFrame) {
    scene.remove(rectangleFrame)
    rectangleFrame.traverse(o => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) { o.material.map?.dispose(); o.material.dispose() }
    })
  }
  const t = isDark ? THEME.dark : THEME.light
  const group = new THREE.Group()
  const L = 0, R = cutterW, T = 0, B = -cutterH

  // Soft drop shadow (bottom-left).
  group.add(makeBedShadow())

  // Bed fill - white (light) / dark gray (dark).
  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(cutterW, cutterH),
    new THREE.MeshBasicMaterial({ color: t.bed }),
  )
  fill.position.set(cutterW / 2, -cutterH / 2, -0.2)
  group.add(fill)

  // Thin subtle outline.
  const verts = new Float32Array([
    L, T, 0,  R, T, 0,   R, T, 0,  R, B, 0,
    R, B, 0,  L, B, 0,   L, B, 0,  L, T, 0,
  ])
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
  const border = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: t.border }))
  border.position.z = -0.1
  group.add(border)

  rectangleFrame = group
  scene.add(group)
}

// ── Cutter selection ──────────────────────────────────────────────────────────
const handleCutterSelected = (cutter) => {
  cutterW = cutter.bedWidth
  cutterH = cutter.bedHeight
  drawCutterFrame()
  // Re-frame on the content if a design is loaded, otherwise on the new bed.
  frameBox(contentBox || bedBox())
  checkFit()
}

// ── Material/printer speeds ───────────────────────────────────────────────────
const handleSpeedsChanged = ({ speeds, rasterPitch, accel } = {}) => {
  if (speeds) currentSpeeds = speeds
  currentRasterPitch = rasterPitch
  currentAccel = accel || 0
  if (currentData) drawObjects(currentData)   // keeps timeline position
}

// ── Fit check (does the design fit the bed, maybe only rotated?) ──────────────
const checkFit = () => {
  if (!contentBox) { eventBus.emit('fit-status', { ok: true }); return }
  const bw = contentBox.maxX - contentBox.minX
  const bh = contentBox.maxY - contentBox.minY
  const TOL = 0.5  // mm slack
  const fitsAsIs = bw <= cutterW + TOL && bh <= cutterH + TOL
  const fitsRot  = bw <= cutterH + TOL && bh <= cutterW + TOL
  if (fitsAsIs) eventBus.emit('fit-status', { ok: true })
  else eventBus.emit('fit-status', {
    ok: false, canRotate: fitsRot,
    design: { w: Math.round(bw), h: Math.round(bh) },
    bed: { w: cutterW, h: cutterH },
  })
}

// ── Lines / objects update ────────────────────────────────────────────────────
const handleLinesUpdate = (lines) => {
  currentData = lines
  clearHighlight()
  showTinyHighlight = false                      // fresh design → drop the at-risk overlay
  hiddenKinds.clear()                             // fresh design → every colour visible again
  drawObjects(lines, { resetPlayback: true })   // new design → timeline back to 0
  // Centre + fit the view on the freshly loaded design.
  contentBox = computeContentBBox(lines)
  frameBox(contentBox || bedBox())
  checkFit()
}

// Reset the view: re-centre + re-fit, flown to rather than snapped to.
//
//   all      - the whole design (or the bare bed if nothing is loaded), the
//              same framing a fresh upload already gets
//   lasered  - only what the playback head has already burned
//   visible  - only the colours that are not hidden via the breakdown panel
//
// A mode with nothing to show (nothing lasered yet, every colour hidden) falls
// back to the full design rather than framing an empty box.
const handleResetView = (mode) => {
  const box = (mode === 'lasered' && lasedBox(pbTime))
           || (mode === 'visible' && visibleContentBBox())
           || contentBox
           || bedBox()
  flyToBox(box)
}

// Bounding box of the content that is currently DRAWN, i.e. with the colours
// hidden in the breakdown panel left out. Derived from the source objects with
// the same kind mapping the draw pass uses, so it cannot drift from what is on
// screen.
const visibleContentBBox = () => {
  if (!currentData || hiddenKinds.size === 0) return contentBox
  const visible = currentData.filter((o) => {
    if (o.type === 'img') return !hiddenKinds.has('raster')
    if (o.type === 'fp') return !hiddenKinds.has(fpKindGroup(o.fill))
    const cat = categorize(o.color || '#000000')
    const group = cat === 'blue' ? 'cut' : cat === 'red' ? 'engrave'
                : (cat === 'green' || cat === 'gray') ? 'raster' : 'other'
    return !hiddenKinds.has(group)
  })
  return visible.length ? computeContentBBox(visible) : null
}

// Bounding box of everything already burned at time `t`.
//
// The reveal itself happens per-fragment on the GPU from a single uniform, so
// there is no CPU-side list of "what is visible now" to read. Building one per
// segment would cost megabytes on a big file, so drawObjects instead buckets
// the drawn segments into fixed time bins (REVEAL_BIN_S) and keeps one box per
// bin - a few thousand boxes for the longest jobs. Framing is padded anyway, so
// the bin granularity is invisible.
const REVEAL_BIN_S = 0.25
const lasedBox = (t) => {
  if (!revealBins || !revealBins.length || !(t > 0)) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const last = Math.floor(t / REVEAL_BIN_S)
  for (const b of revealBins) {
    if (b.k > last) break
    if (b.minX < minX) minX = b.minX
    if (b.minY < minY) minY = b.minY
    if (b.maxX > maxX) maxX = b.maxX
    if (b.maxY > maxY) maxY = b.maxY
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

// ── Per-colour visibility (breakdown panel's eye buttons) ─────────────────────
// Maps a toolpath move/fill to the same cut/engrave/raster/other bucket the
// breakdown panel groups its rows by.
const kindGroupOf = (m) => {
  if (m.category === 'raster') return 'raster'
  if (m.category === 'blue') return 'cut'
  if (m.category === 'red') return 'engrave'
  return 'other'
}
const fpKindGroup = (fillHex) => {
  const cat = categorize(fillHex || '#000000')
  if (cat === 'blue') return 'cut'
  if (cat === 'red') return 'engrave'
  if (cat === 'green' || cat === 'gray') return 'raster'
  return 'other'
}

const handleKindVisibilityChanged = ({ kind, hidden } = {}) => {
  if (!kind) return
  if (hidden) hiddenKinds.add(kind); else hiddenKinds.delete(kind)
  if (currentData) drawObjects(currentData)
}

// ── Rotate the whole design 90° (offered when it only fits rotated) ───────────
const handleRotateDesign = (dir) => {
  if (!currentData) return
  currentData = rotateData(currentData, dir === 'ccw' ? 'ccw' : 'cw')
  clearHighlight()
  drawObjects(currentData)
  contentBox = computeContentBBox(currentData)
  frameBox(contentBox || bedBox())
  checkFit()
}

// Toggle: optimise the cut order (mimic the printer's path optimiser) vs cut in
// file order. Rebuilds from the retained data - no re-fetch.
const handleOptimizeChanged = (algo) => {
  optimizePath = algo || 'file'
  if (currentData) drawObjects(currentData)
}

// Raster regions: scan lines / filled block / outline-only block. Rebuilds geometry.
const handleRasterModeChanged = (mode) => {
  rasterMode = (mode === 'block' || mode === 'outline') ? mode : 'lines'
  if (currentData) drawObjects(currentData)
}

// Curve viewing fidelity (bezier flatness tolerance, mm). Only affects how
// closely rendered curves hug the true path - not the time estimate.
const handleTessellationChanged = (tolMm) => {
  setTessellationTolerance(tolMm)
  if (currentData) drawObjects(currentData)
}

// Toggle: colour every segment randomly (debug aid for counting). Rebuilds.
const handleDebugColorsChanged = (enabled) => {
  debugColors = !!enabled
  if (currentData) drawObjects(currentData)
}

// Toggle: show/hide the dotted travel "Leerwege". Cheap - just flips a shader
// uniform; the segments stay in the geometry so timing/head position is intact.
const handleShowTravelChanged = (enabled) => {
  showTravel = enabled !== false
  if (lineMaterial) lineMaterial.uniforms.uShowTravel.value = showTravel ? 1 : 0
}

// Toggle: colour segments by speed (debug acceleration). The gradient is computed
// per-fragment in the shader, so this is just a uniform flip - no rebuild.
const handleSpeedGradientChanged = (enabled) => {
  speedGradient = !!enabled
  if (lineMaterial) lineMaterial.uniforms.uGradient.value = speedGradient ? 1 : 0
}

// ── Edits: Fix Colors / Remove White / Remove Doubles ─────────────────────────
// Unified two-step flow driven by the sidebar:
//   'edit-detect' → highlight what WOULD change + report the count (no mutation)
//   'edit-apply'  → perform it (mutates currentData → flows into the PDF export)
//   'edit-cancel' → just drop the highlight
// The result is reported back as 'edit-result' { action, count, phase }.
const handleEditDetect = ({ action }) => {
  if (!currentData) { eventBus.emit('edit-result', { action, count: 0, phase: 'detect' }); return }
  let count = 0, segs = []
  if (action === 'doubles')      { const r = computeDoubleRemoval(currentData); segs = r.removed; count = r.removed.length }
  else if (action === 'colors')  { const r = detectFixColors(currentData);      segs = r.segs;    count = r.count }
  else if (action === 'white')   { const r = detectRemoveWhite(currentData);     segs = r.segs;    count = r.count }
  else if (action === 'tinysegs') { const r = detectTinySegments(currentData);   segs = r.segs;    count = r.count }
  drawHighlight(segs)
  eventBus.emit('edit-result', { action, count, phase: 'detect' })
}

const handleEditApply = ({ action }) => {
  if (!currentData) { eventBus.emit('edit-result', { action, count: 0, phase: 'applied' }); return }
  let count = 0
  if (action === 'doubles') {
    const { data, removed } = computeDoubleRemoval(currentData)
    count = removed.length
    if (count > 0) currentData = data
  } else if (action === 'colors') {
    const fixed = fixColors(currentData)
    for (let i = 0; i < fixed.length; i++) if (fixed[i] !== currentData[i]) count++
    if (count > 0) currentData = fixed
  } else if (action === 'white') {
    const before = currentData.length
    currentData = removeWhite(currentData)
    count = before - currentData.length
  } else if (action === 'tinysegs') {
    const before = currentData.length
    currentData = removeTinySegments(currentData)
    count = before - currentData.length
  }
  clearHighlight()
  drawObjects(currentData)
  contentBox = computeContentBBox(currentData)
  checkFit()
  eventBus.emit('edit-result', { action, count, phase: 'applied' })
}

const handleEditCancel = () => clearHighlight()

// Magenta overlay over the removed pieces, drawn above everything else.
const drawHighlight = (segs) => {
  clearHighlight()
  if (!segs || segs.length === 0) return
  const verts = []
  for (const s of segs) verts.push(s.x1, s.y1, 0, s.x2, s.y2, 0)
  if (!verts.length) return
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
  const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xff00ff }))
  line.position.z = 0.2   // above the toolpath line (z 0.05) and content
  highlightGroup = new THREE.Group()
  highlightGroup.add(line)
  scene.add(highlightGroup)
}

const clearHighlight = () => {
  if (!highlightGroup) return
  scene.remove(highlightGroup)
  highlightGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose() })
  highlightGroup = null
}

// ── Tiny-part highlight (may fall through the grid) ───────────────────────────
// Orange boxes drawn a little larger than each at-risk part so even mm-sized ones
// are easy to spot. Toggled on demand from the download warning, not by default.
const TINY_HL_COLOR = 0xff8c00
const drawTinyHighlight = () => {
  clearTinyHighlight()
  if (!showTinyHighlight || !tinyBoxes.length) return
  const PAD = 2.5
  const verts = []
  for (const b of tinyBoxes) {
    const x0 = b.minX - PAD, x1 = b.maxX + PAD, y0 = b.minY - PAD, y1 = b.maxY + PAD
    verts.push(x0, y0, 0, x1, y0, 0,  x1, y0, 0, x1, y1, 0,
               x1, y1, 0, x0, y1, 0,  x0, y1, 0, x0, y0, 0)   // 4 edges
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
  const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: TINY_HL_COLOR }))
  line.position.z = 0.22   // above the toolpath + content
  tinyHighlightGroup = new THREE.Group()
  tinyHighlightGroup.add(line)
  scene.add(tinyHighlightGroup)
}
const clearTinyHighlight = () => {
  if (!tinyHighlightGroup) return
  scene.remove(tinyHighlightGroup)
  tinyHighlightGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose() })
  tinyHighlightGroup = null
}
const handleTinyHighlight = (on) => {
  showTinyHighlight = !!on
  drawTinyHighlight()
}

// ── Playback progress ─────────────────────────────────────────────────────────
// Reveals the toolpath as a solid line that grows *smoothly* along its length.
// Whole completed segments are drawn, plus a partial leading segment interpolated
// to the exact head position - so the tip glides between vertices (cf. the old
// program's draw_path_layer) instead of snapping vertex-by-vertex.
// Reveal the toolpath up to time `target` (seconds). Draws all completed
// segments plus a partial leading segment whose tip is interpolated to the exact
// head position, so the line grows continuously between vertices.
const revealAtTime = (target) => {
  const pb = playback
  if (!pb || pb.total <= 0) return
  // The GPU does the rest: every fragment with its time <= uProgress draws solid,
  // the rest faint - so the reveal is exact and smooth from a single uniform.
  const t = Math.min(pb.total, Math.max(0, target))
  for (const m of pb.materials) m.uniforms.uProgress.value = t
}

// Emit the current head position as a 0–100 progress so the UI slider follows.
const emitTick = () => {
  const total = playback ? playback.total : 0
  eventBus.emit('playback_tick', total > 0 ? (pbTime / total) * 100 : 0)
}

// ── Laser print-head marker ───────────────────────────────────────────────────
// A little crosshair-in-a-ring icon that sits at the current head position so the
// cutter's location is obvious during playback. Built at unit scale and rescaled
// every frame to stay a constant size on screen regardless of zoom.
const HEAD_COLOR = 0x00adc6   // teal accent
const HEAD_PX    = 11         // on-screen ring radius (px)

// Custom icon: drop a `printhead.svg` (or `printhead.png`) into frontend/public/
// and it replaces the built-in crosshair. The icon is centred on the head and
// kept a constant size on screen. Unit footprint matches the drawn marker.
const makeHeadMarker = () => {
  const g = new THREE.Group()
  const seg = []
  const N = 36, R = 1
  for (let i = 0; i < N; i++) {                       // ring outline
    const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2
    seg.push(Math.cos(a0) * R, Math.sin(a0) * R, 0, Math.cos(a1) * R, Math.sin(a1) * R, 0)
  }
  const inr = 0.35, outr = 1.7                         // crosshair (open centre)
  seg.push(-outr, 0, 0, -inr, 0, 0,  inr, 0, 0, outr, 0, 0,
            0, -outr, 0, 0, -inr, 0,  0, inr, 0, 0, outr, 0)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seg), 3))
  g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: HEAD_COLOR })))
  g.add(new THREE.Mesh(new THREE.CircleGeometry(0.18, 16),
                       new THREE.MeshBasicMaterial({ color: HEAD_COLOR })))  // centre dot
  g.position.z = 0.3   // above the toolpath line and highlight
  g.visible = false
  loadHeadIcon(g)      // swap in a custom png/svg if one is present
  return g
}

// Try printhead.svg then printhead.png from /public; on success replace the
// drawn icon with a camera-facing sprite. Silent fallback to the crosshair.
const loadHeadIcon = (group) => {
  const loader = new THREE.TextureLoader()
  const swap = (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
    sprite.scale.set(3.4, 3.4, 1)   // ≈ the crosshair footprint (unit space)
    for (const c of [...group.children]) { group.remove(c); c.geometry?.dispose?.(); c.material?.dispose?.() }
    group.add(sprite)
  }
  loader.load('/printhead.svg', swap, undefined,
    () => loader.load('/printhead.png', swap, undefined, () => {}))
}

// Distance travelled after time `tl` into a run of length S that starts at rest
// with target speed v and acceleration a (the inverse of the shader's timeAt).
const distAtTime = (tl, S, v, a) => {
  if (!a || a <= 0 || !v || v <= 0) return v > 0 ? Math.min(S, v * tl) : 0
  const dAcc = (v * v) / (2 * a)
  if (2 * dAcc <= S) {                       // trapezoid
    const tAcc = v / a
    const tCruiseEnd = tAcc + (S - 2 * dAcc) / v
    const Ttot = tCruiseEnd + tAcc
    if (tl <= tAcc) return 0.5 * a * tl * tl
    if (tl <= tCruiseEnd) return dAcc + v * (tl - tAcc)
    const td = Math.min(tl, Ttot) - tCruiseEnd
    return Math.min(S, (S - dAcc) + v * td - 0.5 * a * td * td)
  }
  const tPeak = Math.sqrt(S / a)             // triangle (never reaches v)
  const vPeak = a * tPeak
  if (tl <= tPeak) return 0.5 * a * tl * tl
  const td = Math.min(tl, 2 * tPeak) - tPeak
  return Math.min(S, S / 2 + vPeak * td - 0.5 * a * td * td)
}

// XY at arc-length `s` along a run's polyline (pts + cumulative arc-length cum).
const xyAtArc = (run, s) => {
  const { pts, cum } = run
  const last = cum.length - 1
  if (s <= 0) return pts[0]
  if (s >= cum[last]) return pts[last]
  let lo = 0, hi = last
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m + 1] < s) lo = m + 1; else hi = m }
  const c0 = cum[lo], c1 = cum[lo + 1]
  const f = c1 > c0 ? (s - c0) / (c1 - c0) : 0
  return { x: pts[lo].x + (pts[lo + 1].x - pts[lo].x) * f,
           y: pts[lo].y + (pts[lo + 1].y - pts[lo].y) * f }
}

// Head XY at toolpath time `t` (seconds): find the active run, invert the
// velocity profile to an arc-length, then map that to a point - so the marker
// accelerates/decelerates exactly like the shader reveal.
const headPosAt = (t) => {
  const runs = playback ? playback.runs : null
  if (!runs || runs.length === 0) return null
  if (t <= runs[0].t0) return runs[0].pts[0]
  let lo = 0, hi = runs.length - 1                     // last run with t0 <= t
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (runs[m].t0 <= t) lo = m; else hi = m - 1 }
  const run = runs[lo]
  const tl = Math.max(0, Math.min(run.T, t - run.t0))  // clamp into the run (gaps park at its end)
  return xyAtArc(run, distAtTime(tl, run.S, run.v, run.a ?? currentAccel))
}

const updateHeadMarker = () => {
  if (!headMarker) return
  const p = playback ? headPosAt(pbTime) : null
  if (!p) { headMarker.visible = false; return }
  headMarker.position.set(p.x, p.y, 0.3)
  // Keep a constant on-screen size: world units per pixel at the current zoom.
  const worldPerPx = (VIEW_REF_HALF_H * 2) / (camera.zoom * canvHeight)
  headMarker.scale.setScalar(HEAD_PX * worldPerPx)
  headMarker.visible = true
}

// ── Playback controls (driven from PlayBack.vue) ──────────────────────────────
const handlePlayPause = (playing) => {
  pbPlaying = !!playing
  if (pbPlaying && playback && pbTime >= playback.total) pbTime = 0 // restart from end
  pbClock.getDelta() // reset delta so we don't jump after a pause
}
const handleSpeed = (s) => { pbSpeed = Number(s) || 1 }
const handleSeek = (progress) => {
  if (!playback) return
  pbTime = playback.total * (Math.min(100, Math.max(0, progress)) / 100)
  revealAtTime(pbTime)
}

// ── Draw imported geometry ────────────────────────────────────────────────────
const drawObjects = (data, { resetPlayback = false } = {}) => {
  if (!data || data.length === 0) return
  // Preserve the current playback position across rebuilds (toggles, edits,
  // theme) so changing a setting doesn't snap the timeline back to the start.
  // Only a fresh file load resets it.
  const prevTotal = playback ? playback.total : 0
  const keepPos   = !resetPlayback && prevTotal > 0
  const prevFrac  = keepPos ? Math.min(1, Math.max(0, pbTime / prevTotal)) : 0
  const prevPlaying = keepPos && pbPlaying
  if (drawingGroup) scene.remove(drawingGroup)

  drawingGroup = new THREE.Group()

  // ── Static content: filled paths (text/shapes) and raster images ──────────
  // These are engraving content but not vector toolpaths, so they render fully
  // and are not part of the cut/travel playback ordering.
  data.forEach(obj => {
    if (obj.type === 'fp') {
      if (hiddenKinds.has(fpKindGroup(obj.fill))) return
      // ShapePath handles multi-subpath correctly (holes in letters, etc.).
      // ShapePath has no closePath(); each moveTo starts a new subpath and
      // fills auto-close, so the 'Z' commands are intentionally ignored.
      const sp = new THREE.ShapePath()
      for (const cmd of obj.path) {
        if      (cmd.cmd === 'M') sp.moveTo(cmd.x, cmd.y)
        else if (cmd.cmd === 'L') sp.lineTo(cmd.x, cmd.y)
        else if (cmd.cmd === 'C') sp.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y)
      }
      // Pick the fill rule from the OUTER contour's winding (the largest-area
      // subpath). Fonts wind their contours in opposite directions (TrueType
      // CW outers vs PostScript/CFF CCW outers), so a hardcoded value fills the
      // counter (e.g. the eye of an 'e') for half of all fonts. Detecting it
      // per glyph makes the fill correct regardless of the font.
      let outerAbs = 0, isCCW = true
      for (const sub of sp.subPaths) {
        const pts = sub.getPoints(16)
        let a = 0
        for (let i = 0; i < pts.length; i++) {
          const j = (i + 1) % pts.length
          a += pts[i].x * pts[j].y - pts[j].x * pts[i].y
        }
        if (Math.abs(a) > outerAbs) { outerAbs = Math.abs(a); isCCW = a > 0 }
      }
      const rasterFill = isRasterColor(obj.fill || '#000000')
      for (const s of sp.toShapes(isCCW)) {
        const geo = new THREE.ShapeGeometry(s)
        const mat = new THREE.MeshBasicMaterial({
          color: themedColor(obj.fill || '#000000'),
          side: THREE.DoubleSide,
          // Raster fills (green or grayscale) are engraved as a raster (below); show
          // them faintly so the animated raster lines are visible on top.
          transparent: rasterFill,
          opacity: rasterFill ? 0.3 : 1,
        })
        drawingGroup.add(new THREE.Mesh(geo, mat))
      }
    } else if (obj.type === 'img') {
      if (hiddenKinds.has('raster')) return   // images are always raster-engraved content
      const texture = new THREE.TextureLoader().load(obj.data)
      // obj.x/obj.y is the top-left corner (x right, y down as negative). When the
      // design was rotated, obj.rot says by how much; the plane keeps the image's
      // own dimensions and the mesh is rotated to fill the (swapped) footprint.
      const r = (((obj.rot || 0) % 360) + 360) % 360
      const swap = r === 90 || r === 270
      const geo = new THREE.PlaneGeometry(swap ? obj.h : obj.w, swap ? obj.w : obj.h)
      const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: false })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(obj.x + obj.w / 2, obj.y - obj.h / 2, obj.is_background ? -0.1 : 0.01)
      if (r) mesh.rotation.z = r * Math.PI / 180
      drawingGroup.add(mesh)
    }
  })

  // ── Toolpath: ordered machine moves (engrave → cut, optional optimise) ────
  const { moves, stats, tinyBoxes: tb } = buildToolpath(data, { optimize: optimizePath, speeds: currentSpeeds, rasterPitch: currentRasterPitch, accel: currentAccel })
  tinyBoxes = tb || []

  // Expand moves into one ordered segment stream. The GEOMETRY stays minimal:
  // a straight line is a single segment, and the velocity profile is evaluated
  // PER FRAGMENT in the shader: each vertex carries its arc-length within the run
  // (aRunDist), the run length (aRunLen), the run's start time (aRunT0) and the
  // target speed (aSpeed). From those the shader derives both the reveal time
  // (so the line grows with real acceleration) and, in gradient mode, the colour
  // (blue = slow at the corners → red = full march speed). No resampling.
  const vertices = []     // xyz per vertex (2 per segment)
  const colors   = []     // rgb per vertex (base colour; gradient overrides in shader)
  const runDist  = []     // arc-length (mm) of the vertex along its run
  const runLen   = []     // length (mm) of the run the segment belongs to
  const runT0    = []     // toolpath time (s) at the run's start
  const segSpeed = []     // target speed (mm/s) of the move
  const dashes   = []     // per vertex: 1 = dashed travel, 0 = solid beam-on
  const dists    = []     // per vertex: world distance (mm) along the run (dashing)
  const segAccel = []     // per vertex: acceleration of the move (raster uses 0)
  const rasterBlocks = [] // { bbox, t0, t1, color } when raster is shown as block/outline
  // Time-binned bounding boxes of the DRAWN, beam-on geometry - the input for
  // "focus on what is already lasered" (see lasedBox).
  const bins = new Map()
  const bin = (t, x0, y0, x1, y1) => {
    const k = Math.floor(Math.max(0, t) / REVEAL_BIN_S)
    let b = bins.get(k)
    if (!b) bins.set(k, (b = { k, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }))
    if (x0 < b.minX) b.minX = x0
    if (x1 < b.minX) b.minX = x1
    if (y0 < b.minY) b.minY = y0
    if (y1 < b.minY) b.minY = y1
    if (x0 > b.maxX) b.maxX = x0
    if (x1 > b.maxX) b.maxX = x1
    if (y0 > b.maxY) b.maxY = y0
    if (y1 > b.maxY) b.maxY = y1
  }
  const headRuns = []     // per run: { t0, T, S, v, pts[], cum[] } for the head marker
  let runTime = 0         // running time along the toolpath
  let headRun = null
  const flushHeadRun = () => { if (headRun) { headRuns.push(headRun); headRun = null } }

  for (const m of moves) {
    const speed = (m.category === 'raster' ? (currentSpeeds.raster ?? currentSpeeds.engrave)
                                           : currentSpeeds[m.kind]) || currentSpeeds.other || SPEED_MM_S.other
    // View-only: a hidden colour's moves still run through the timeline below
    // exactly as before (runTime/headRun keep advancing unconditionally) so
    // the estimate and playback clock stay correct - only the geometry that
    // would actually get DRAWN is skipped. Travel has its own dedicated
    // toggle (showTravel), so it's never affected by this one.
    const hidden = m.kind !== 'travel' && hiddenKinds.has(kindGroupOf(m))

    if (m.category === 'raster' && rasterMode !== 'lines' && m.bbox) {
      // Engrave region as a block (filled or outline-only): skip the serpentine
      // segments, record the region + its time span, and advance the clock by the
      // same duration so the overall timeline matches the scan-line version.
      flushHeadRun()
      const dur = rampSegments(movePolyline(m), speed, accelFor(m, currentAccel),
                               cornerPenaltyFor(m)).total + moveExtraTime(m)
      if (!hidden) {
        rasterBlocks.push({ bbox: m.bbox, t0: runTime, t1: runTime + dur, color: lineRGB(m.color) })
        // The block is revealed top-to-bottom over its span, so bin its rows
        // rather than dumping the whole rectangle into the first bin.
        const steps = Math.max(1, Math.ceil(dur / REVEAL_BIN_S))
        for (let i = 0; i < steps; i++) {
          const f0 = i / steps, f1 = (i + 1) / steps
          bin(runTime + dur * f0, m.bbox.minX, m.bbox.maxY + (m.bbox.minY - m.bbox.maxY) * f0,
                                  m.bbox.maxX, m.bbox.maxY + (m.bbox.minY - m.bbox.maxY) * f1)
        }
      }
      // Give the marker a run covering the block. Without one there is a time gap
      // with no run at all, and headPosAt falls back to the PREVIOUS run and parks
      // the marker at its end - the head appears to jump ahead and sit there for
      // the whole engrave. Swept at constant speed (a = 0) over the real scan path.
      const bp = movePolyline(m)
      if (bp.length > 1) {
        const bcum = [0]
        for (let i = 1; i < bp.length; i++) bcum.push(bcum[i - 1] + dist(bp[i - 1], bp[i]))
        const S = bcum[bcum.length - 1]
        headRuns.push({ t0: runTime, T: dur, S, v: S / Math.max(dur, 1e-6), a: 0, pts: bp, cum: bcum })
      }
      runTime += dur
      continue
    }

    const isTravel = m.kind === 'travel'
    const pts = isTravel ? [m.a, m.b] : movePolyline(m)
    if (pts.length < 2) continue
    // annotateRuns splits the polyline at sharp corners (raster turnarounds, the
    // 90° step between scan rows) and returns, per segment, its position in the
    // run's velocity profile (s0/s1/S) plus its duration.
    const ann = annotateRuns(pts, speed, accelFor(m, currentAccel), cornerPenaltyFor(m))
    const moveStart = runTime
    const baseRgb = lineRGB(m.color)

    for (let i = 0; i < pts.length - 1; i++) {
      const info = ann[i]
      const t0run = moveStart + info.runStartRel
      if (!headRun || headRun.t0 !== t0run) {            // new run begins
        flushHeadRun()
        // annotateRuns' timeline is authoritative: it also charges the per-corner
        // stop penalty BETWEEN runs, which `runTime += info.dur` alone does not
        // see. Without resyncing here, run t0s stop increasing monotonically and
        // headPosAt's binary search picks the wrong run - the marker then jumps
        // ahead of the drawn line.
        runTime = t0run
        headRun = { t0: t0run, T: 0, S: info.S, v: speed,
                    a: accelFor(m, currentAccel), pts: [pts[i]], cum: [0] }
      }
      const rgb = debugColors ? [Math.random(), Math.random(), Math.random()] : baseRgb
      runTime += info.dur
      const p = pts[i], q = pts[i + 1]
      if (!hidden) {
        if (!isTravel) bin(runTime, p.x, p.y, q.x, q.y)   // runTime = Zeit am Segmentende
        vertices.push(p.x, p.y, 0, q.x, q.y, 0)
        colors.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2])
        runDist.push(info.s0, info.s1)
        runLen.push(info.S, info.S)
        runT0.push(t0run, t0run)
        segSpeed.push(speed, speed)
        dashes.push(isTravel ? 1 : 0, isTravel ? 1 : 0)
        dists.push(info.s0, info.s1)
        segAccel.push(accelFor(m, currentAccel), accelFor(m, currentAccel))
      }
      headRun.pts.push(q); headRun.cum.push(info.s1); headRun.T += info.dur
    }
    runTime += moveExtraTime(m)   // keep the clock equal to stats.totalTime
  }
  flushHeadRun()
  // Sorted by time bin so lasedBox() can stop at the first bin past the cursor.
  revealBins = [...bins.values()].sort((a, b) => a.k - b.k)

  // ── Single toolpath line ──────────────────────────────────────────────────
  // One LineSegments holds the whole toolpath. A small shader colours each
  // fragment: solid if its time has passed (uProgress), faint otherwise. This is
  // both the preview and the played-so-far line in one cheap draw call, and the
  // reveal boundary is exact per-pixel (smooth tip) without moving any vertex.
  playback = null
  lineMaterial = null
  const revealMaterials = []   // all materials whose uProgress the clock advances
  const segCount = vertices.length / 6

  if (segCount > 0) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position',  new THREE.BufferAttribute(new Float32Array(vertices), 3))
    geo.setAttribute('color',     new THREE.BufferAttribute(new Float32Array(colors), 3))
    geo.setAttribute('aRunDist',  new THREE.BufferAttribute(new Float32Array(runDist), 1))
    geo.setAttribute('aRunLen',   new THREE.BufferAttribute(new Float32Array(runLen), 1))
    geo.setAttribute('aRunT0',    new THREE.BufferAttribute(new Float32Array(runT0), 1))
    geo.setAttribute('aSpeed',    new THREE.BufferAttribute(new Float32Array(segSpeed), 1))
    geo.setAttribute('aAccel',    new THREE.BufferAttribute(new Float32Array(segAccel), 1))
    geo.setAttribute('aDash',     new THREE.BufferAttribute(new Float32Array(dashes), 1))
    geo.setAttribute('aDist',     new THREE.BufferAttribute(new Float32Array(dists), 1))

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uProgress:     { value: 0 },
        uPreviewAlpha: { value: PREVIEW_OPACITY },
        uShowTravel:   { value: showTravel ? 1 : 0 },
        uGradient:     { value: speedGradient ? 1 : 0 },
        uAccel:        { value: currentAccel },
      },
      vertexShader: `
        attribute vec3 color;
        attribute float aRunDist;
        attribute float aRunLen;
        attribute float aRunT0;
        attribute float aSpeed;
        attribute float aAccel;
        attribute float aDash;
        attribute float aDist;
        varying vec3 vColor;
        varying float vRunDist;
        varying float vRunLen;
        varying float vRunT0;
        varying float vSpeed;
        varying float vAccel;
        varying float vDash;
        varying float vDist;
        void main() {
          vColor = color;
          vRunDist = aRunDist;
          vRunLen = aRunLen;
          vRunT0 = aRunT0;
          vSpeed = aSpeed;
          vAccel = aAccel;
          vDash = aDash;
          vDist = aDist;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uProgress;
        uniform float uPreviewAlpha;
        uniform float uShowTravel;
        uniform float uGradient;
        uniform float uAccel;
        varying vec3 vColor;
        varying float vRunDist;
        varying float vRunLen;
        varying float vRunT0;
        varying float vSpeed;
        varying float vAccel;
        varying float vDash;
        varying float vDist;

        // Speed (mm/s) at arc-length s in a run (rest→cruise→rest, accel uAccel).
        float speedAt(float s, float S, float v) {
          float a = vAccel;
          if (a <= 0.0 || v <= 0.0) return v;
          float dAcc = (v * v) / (2.0 * a);
          if (2.0 * dAcc <= S) {
            if (s < dAcc)     return sqrt(2.0 * a * s);
            if (s > S - dAcc) return sqrt(max(0.0, 2.0 * a * (S - s)));
            return v;
          }
          float h = S * 0.5;
          return s <= h ? sqrt(2.0 * a * s) : sqrt(max(0.0, 2.0 * a * (S - s)));
        }
        // Time (s) from the run start to arc-length s.
        float timeAt(float s, float S, float v) {
          float a = vAccel;
          if (a <= 0.0 || v <= 0.0) return v > 0.0 ? s / v : 0.0;
          float dAcc = (v * v) / (2.0 * a);
          if (2.0 * dAcc <= S) {
            float tAcc = v / a;
            float Tt = 2.0 * tAcc + (S - 2.0 * dAcc) / v;
            if (s <= dAcc)     return sqrt(2.0 * s / a);
            if (s <= S - dAcc) return tAcc + (s - dAcc) / v;
            return Tt - sqrt(2.0 * max(0.0, S - s) / a);
          }
          float Tt = 2.0 * sqrt(S / a);
          float h = S * 0.5;
          if (s <= h) return sqrt(2.0 * s / a);
          return Tt - sqrt(2.0 * max(0.0, S - s) / a);
        }
        // Fraction (0..1, hue 240→0) → blue→cyan→green→yellow→red.
        vec3 speedHue(float frac) {
          float hh = (1.0 - clamp(frac, 0.0, 1.0)) * 6.0 * (240.0 / 360.0);
          return clamp(abs(mod(hh + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
        }

        void main() {
          if (vDash > 0.5) {
            if (uShowTravel < 0.5) discard;   // travel "Leerwege" hidden
            // Dashed travel: punch out the gaps in world space (mm).
            if (mod(vDist, ${(TRAVEL_DASH + TRAVEL_GAP).toFixed(1)}) > ${TRAVEL_DASH.toFixed(1)}) discard;
          }
          float revealT = vRunT0 + timeAt(vRunDist, vRunLen, vSpeed);
          vec3 col = vColor;
          if (uGradient > 0.5) col = speedHue(speedAt(vRunDist, vRunLen, vSpeed) / max(vSpeed, 1e-3));
          float a = revealT <= uProgress ? 1.0 : uPreviewAlpha;
          gl_FragColor = vec4(col, a);
        }
      `,
    })

    const line = new THREE.LineSegments(geo, mat)
    line.position.z = 0.05
    drawingGroup.add(line)
    revealMaterials.push(mat)
    lineMaterial = mat
  }

  // Raster-as-block: one region per entry, revealed top→bottom over its time span
  // (same uProgress as the toolpath). 'block' = filled quad; 'outline' = just the
  // rectangle frame so the content underneath stays visible. Both share the same
  // reveal fragment shader (vY01: 0 at top, 1 at bottom).
  const blockFragment = `
    uniform float uProgress;
    uniform float uPreviewAlpha;
    uniform float uT0;
    uniform float uT1;
    uniform vec3  uColor;
    varying float vY01;
    void main() {
      float t = mix(uT0, uT1, vY01);   // each row engraves at its own time
      float a = t <= uProgress ? 1.0 : uPreviewAlpha;
      gl_FragColor = vec4(uColor, a);
    }
  `
  for (const blk of rasterBlocks) {
    const { minX, maxX, minY, maxY } = blk.bbox
    const w = maxX - minX, h = maxY - minY
    if (w <= 0 || h <= 0) continue
    const uniforms = {
      uProgress:     { value: 0 },
      uPreviewAlpha: { value: PREVIEW_OPACITY },
      uT0:    { value: blk.t0 },
      uT1:    { value: blk.t1 },
      uColor: { value: new THREE.Color(blk.color[0], blk.color[1], blk.color[2]) },
    }
    let obj
    if (rasterMode === 'outline') {
      // Rectangle frame (4 edges); reveals downward like the fill, interior stays clear.
      const verts = [minX, maxY, 0,  maxX, maxY, 0,   // top
                     maxX, maxY, 0,  maxX, minY, 0,   // right
                     maxX, minY, 0,  minX, minY, 0,   // bottom
                     minX, minY, 0,  minX, maxY, 0]   // left
      const y01 = [0, 0,  0, 1,  1, 1,  1, 0]         // 0 at top edge, 1 at bottom edge
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
      geo.setAttribute('aY01',     new THREE.BufferAttribute(new Float32Array(y01), 1))
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, uniforms,
        vertexShader: `
          attribute float aY01;
          varying float vY01;
          void main() { vY01 = aY01; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        `,
        fragmentShader: blockFragment,
      })
      obj = new THREE.LineSegments(geo, mat)
      obj.position.z = 0.03
      revealMaterials.push(mat)
    } else {
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, uniforms,
        vertexShader: `
          varying float vY01;
          void main() { vY01 = 1.0 - uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        `,
        fragmentShader: blockFragment,
      })
      obj = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
      obj.position.set((minX + maxX) / 2, (minY + maxY) / 2, 0.03)
      revealMaterials.push(mat)
    }
    drawingGroup.add(obj)
  }

  if (revealMaterials.length > 0) {
    // Keep the per-run profile data so the head marker can find the exact XY
    // position (with acceleration) for any playback time.
    playback = { materials: revealMaterials, total: runTime, segCount, runs: headRuns }
  }

  scene.add(drawingGroup)
  drawTinyHighlight()   // re-draw the at-risk-part overlay if it's active

  // Restore the previous playback position (or start from 0 on a fresh load).
  pbTime = playback ? playback.total * prevFrac : 0
  pbPlaying = prevPlaying && !!playback
  revealAtTime(pbTime)
  updateHeadMarker()
  emitTick()

  // Publish stats (incl. segment count for the debug overlay).
  eventBus.emit('toolpath-stats', { ...stats, optimized: optimizePath, segments: segCount })

  console.log(`Toolpath: ${moves.length} moves, ${segCount} segments - `
            + `cut ${stats.cutLen.toFixed(0)}mm, engrave ${stats.engraveLen.toFixed(0)}mm, `
            + `travel ${stats.travelLen.toFixed(0)}mm, ~${stats.totalTime.toFixed(1)}s `
            + `(optimize=${optimizePath})`)
}

// ── PDF download ──────────────────────────────────────────────────────────────
async function handleDownloadRequest() {
  if (!currentData) return
  try {
    // Send the CURRENT (edited) drawing so Fix Colors / Remove Doubles are
    // reflected, and the backend can rebuild a faithful PDF of the whole design.
    const response = await fetch(`${API_URL}/api/save_pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentData),
    })
    if (!response.ok) throw new Error('Failed to save PDF')
    const blob = await response.blob()
    const url  = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href  = url

    const cd = response.headers.get('Content-Disposition')
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

// ── Rulers ──────────────────────────────────────────────────────────────────
// Toggle: show/hide the CAD rulers. animate() picks up the change next frame.
const handleRulersChanged = (enabled) => { showRulers = enabled !== false }

// "Nice" tick spacing (1/2/5 ×10ⁿ mm) so a major tick lands ~targetPx apart.
const niceStep = (worldPerPx, targetPx) => {
  const raw = worldPerPx * targetPx
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / pow
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * pow
}

// Draw the top + left rulers (mm) into the 2D overlay canvas. Minimal: just tick
// marks at the very top/left edge with the number beside them (below / to the
// right), and only ALONG THE BED (no ticks past the print area). Origin is the
// bed's top-left corner: X right, Y down (world y is negative down → label -wy).
// Cheap, and only redrawn when the view actually changes.
const TICK_PX = 7   // length of a ruler tick

const drawRulers = () => {
  const cv = rulerCanvas.value
  if (!cv || !camera) return

  // Skip the redraw entirely while nothing relevant changed.
  const sig = showRulers
    ? `on|${isDark}|${canvWidth}x${canvHeight}|${camera.zoom.toFixed(5)}`
      + `|${camera.position.x.toFixed(2)},${camera.position.y.toFixed(2)}|${cutterW}x${cutterH}`
    : 'off'
  if (sig === lastRulerSig) return
  lastRulerSig = sig

  const dpr = window.devicePixelRatio || 1
  const wantW = Math.round(canvWidth * dpr), wantH = Math.round(canvHeight * dpr)
  if (cv.width !== wantW || cv.height !== wantH) { cv.width = wantW; cv.height = wantH }
  const ctx = cv.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, canvWidth, canvHeight)
  if (!showRulers) return

  const tickCol = isDark ? '#7a7f87' : '#9aa0a6'
  const textCol = isDark ? '#c8ccd2' : '#5a5e66'

  const worldPerPx = (VIEW_REF_HALF_H * 2) / (camera.zoom * canvHeight)
  const worldLeft = camera.position.x - (canvWidth / 2) * worldPerPx
  const worldTop  = camera.position.y + (canvHeight / 2) * worldPerPx
  const worldBottom = worldTop - canvHeight * worldPerPx
  const step = niceStep(worldPerPx, 80)
  const fmt = (v) => (step >= 1 ? String(Math.round(v)) : v.toFixed(1))

  ctx.strokeStyle = tickCol
  ctx.fillStyle = textCol
  ctx.lineWidth = 1
  ctx.font = '10px "Courier New", monospace'

  // Top ruler - world X in [0, cutterW] only; tick at the top edge, number below.
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.beginPath()
  for (let wx = Math.ceil(Math.max(0, worldLeft) / step) * step; wx <= cutterW + 1e-6; wx += step) {
    const px = (wx - worldLeft) / worldPerPx
    if (px > canvWidth) break
    ctx.moveTo(Math.round(px) + 0.5, 0)
    ctx.lineTo(Math.round(px) + 0.5, TICK_PX)
    ctx.fillText(fmt(wx), Math.round(px), TICK_PX + 2)
  }
  ctx.stroke()

  // Left ruler - world Y in [-cutterH, 0] only; tick at the left edge, number right.
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.beginPath()
  const wyTop = Math.min(0, worldTop)
  const wyBot = Math.max(-cutterH, worldBottom)
  for (let wy = Math.floor(wyTop / step) * step; wy >= wyBot - 1e-6; wy -= step) {
    if (wy > 1e-6) continue
    const py = (worldTop - wy) / worldPerPx
    if (py < 0 || py > canvHeight) continue
    ctx.moveTo(0, Math.round(py) + 0.5)
    ctx.lineTo(TICK_PX, Math.round(py) + 0.5)
    ctx.fillText(fmt(-wy), TICK_PX + 3, Math.round(py))
  }
  ctx.stroke()
}

// ── Animate ───────────────────────────────────────────────────────────────────
const animate = () => {
  requestAnimationFrame(animate)

  // Advance the playback head by real elapsed time for smooth, frame-rate
  // independent motion.
  const dt = pbClock.getDelta()
  if (pbPlaying && playback && playback.total > 0) {
    pbTime += dt * pbSpeed
    if (pbTime >= playback.total) {
      pbTime = playback.total
      pbPlaying = false
      eventBus.emit('playback_ended')
    }
    revealAtTime(pbTime)
    emitTick()
  }

  stepCamFlight()      // animated "reset view" flight, if one is running
  updateHeadMarker()   // follow the head (also keeps a constant on-screen size)
  controls.update()
  renderer.render(scene, camera)
  drawRulers()         // 2D overlay; cheap no-op when the view is unchanged
}

// ── Resize ────────────────────────────────────────────────────────────────────
const handleResize = () => {
  if (!container.value || !renderer) return
  const w = container.value.clientWidth
  const h = container.value.clientHeight
  if (!w || !h || (w === canvWidth && h === canvHeight)) return
  canvWidth  = w
  canvHeight = h
  applyFrustum()   // preserves current zoom/pan, just updates aspect

  // Re-render synchronously, right here, don't wait for the next animate()
  // tick. renderer.setSize() (inside applyFrustum) resizes the canvas's
  // backing buffer, which clears it. The browser runs ResizeObserver
  // callbacks (this one) AFTER that frame's requestAnimationFrame callbacks
  // but BEFORE it paints, so if we leave the redraw to the next animate(),
  // this frame paints with a freshly-cleared, blank buffer once, then the
  // real content lands next frame. Dragging the sidebar fires this dozens of
  // times a second, so that one-frame gap repeats continuously and reads as
  // a flicker of the bare --viewer-bg colour. Rendering immediately closes
  // the gap within the same frame.
  updateHeadMarker()
  controls.update()
  renderer.render(scene, camera)
  drawRulers()
}

// The container can change size without the WINDOW changing size, the dock
// below it is in normal flow, so anything that alters its height resizes the
// viewer. A window-resize listener alone would miss that and leave the canvas
// stretched against a stale aspect.
let resizeObs = null

// ── Lifecycle ─────────────────────────────────────────────────────────────────
onMounted(() => {
  initThree()
  window.addEventListener('resize', handleResize)
  if (window.ResizeObserver && container.value) {
    resizeObs = new ResizeObserver(handleResize)
    resizeObs.observe(container.value)
  }
  eventBus.on('lines-updated',      handleLinesUpdate)
  eventBus.on('cutter-selected',    handleCutterSelected)
  eventBus.on('speeds-changed',     handleSpeedsChanged)
  eventBus.on('rotate-design',      handleRotateDesign)
  eventBus.on('save_pdf_request',   handleDownloadRequest)
  eventBus.on('optimize-changed',   handleOptimizeChanged)
  eventBus.on('raster-mode-changed', handleRasterModeChanged)
  eventBus.on('tessellation-changed', handleTessellationChanged)
  eventBus.on('debug-colors-changed', handleDebugColorsChanged)
  eventBus.on('show-travel-changed', handleShowTravelChanged)
  eventBus.on('speed-gradient-changed', handleSpeedGradientChanged)
  eventBus.on('rulers-changed',     handleRulersChanged)
  eventBus.on('tiny-highlight-changed', handleTinyHighlight)
  eventBus.on('reset-view',         handleResetView)
  eventBus.on('kind-visibility-changed', handleKindVisibilityChanged)
  eventBus.on('edit-detect',        handleEditDetect)
  eventBus.on('edit-apply',         handleEditApply)
  eventBus.on('edit-cancel',        handleEditCancel)
  eventBus.on('playback_playpause', handlePlayPause)
  eventBus.on('playback_speed',     handleSpeed)
  eventBus.on('playback_seek',      handleSeek)
  eventBus.on('theme-changed',      handleThemeChanged)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  resizeObs?.disconnect()
  resizeObs = null
  eventBus.off('lines-updated',      handleLinesUpdate)
  eventBus.off('cutter-selected',    handleCutterSelected)
  eventBus.off('speeds-changed',     handleSpeedsChanged)
  eventBus.off('rotate-design',      handleRotateDesign)
  eventBus.off('save_pdf_request',   handleDownloadRequest)
  eventBus.off('optimize-changed',   handleOptimizeChanged)
  eventBus.off('raster-mode-changed', handleRasterModeChanged)
  eventBus.off('tessellation-changed', handleTessellationChanged)
  eventBus.off('debug-colors-changed', handleDebugColorsChanged)
  eventBus.off('show-travel-changed', handleShowTravelChanged)
  eventBus.off('speed-gradient-changed', handleSpeedGradientChanged)
  eventBus.off('rulers-changed',     handleRulersChanged)
  eventBus.off('tiny-highlight-changed', handleTinyHighlight)
  eventBus.off('reset-view',         handleResetView)
  eventBus.off('kind-visibility-changed', handleKindVisibilityChanged)
  eventBus.off('edit-detect',        handleEditDetect)
  eventBus.off('edit-apply',         handleEditApply)
  eventBus.off('edit-cancel',        handleEditCancel)
  eventBus.off('playback_playpause', handlePlayPause)
  eventBus.off('playback_speed',     handleSpeed)
  eventBus.off('playback_seek',      handleSeek)
  eventBus.off('theme-changed',      handleThemeChanged)
  if (renderer) renderer.dispose()
})
</script>
