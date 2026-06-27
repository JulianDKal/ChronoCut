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
import { buildToolpath, isGreen, SPEED_MM_S, fixColors, computeDoubleRemoval, rotateData, removeWhite, rampSegments, annotateRuns, movePolyline } from '../toolpath'

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

// Cutter state — default to Edgar 1000×700 mm
let cutterW = 1000
let cutterH = 700

// Retained so we can rebuild the toolpath when a toggle changes without
// re-fetching from the backend.
let currentData = null
let optimizePath = true     // default: optimise path order (printer-like shortest travel)
let rasterBlock  = false   // draw raster regions as a filling block vs scan lines
let debugColors  = false   // colour every segment randomly (to count them)
let showTravel   = true    // draw the dotted "Leerwege" (travel) moves
let speedGradient = false  // debug: colour segments by speed (accel debugging)
let lineMaterial = null    // toolpath line material (for live travel show/hide)
let showRulers   = true    // CAD-style rulers along the top + left edges (mm)
let lastRulerSig = ''      // redraw the rulers only when the view actually changes
let tinyBoxes = []         // bounding boxes of parts small enough to fall through the grid
let showTinyHighlight = false  // highlight those parts in the viewer (on demand)
let tinyHighlightGroup = null

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
const lineRGB = (hex) => adjustForTheme(hexToRGB(hex))
const themedColor = (hex) => { const [r, g, b] = lineRGB(hex); return new THREE.Color(r, g, b) }

// Playback state for the single toolpath line. The reveal axis is TIME (so the
// head moves slower through engraves than rapid travels), driven entirely by the
// shader's uProgress uniform.
//   material : the ShaderMaterial whose uProgress uniform we advance
//   total    : total toolpath duration (s)
//   segCount : number of line segments (debug / stats)
let playback = null

// Playback clock — the reveal is advanced per render frame by real elapsed time
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
  renderer.setSize(canvWidth, canvHeight)
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

  headMarker = makeHeadMarker()
  scene.add(headMarker)

  applyFrustum()
  frameBox(bedBox())   // start framed on the bed; loading a file re-frames it
  animate()
}

// ── Theme ─────────────────────────────────────────────────────────────────────
let isDark = false
const THEME = {
  light: { bg: 0xeceef1, bed: 0xffffff, border: 0xd6d9dd },
  dark:  { bg: 0x1e1f22, bed: 0x2a2c30, border: 0x3a3d42 },
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
  renderer.setSize(canvWidth, canvHeight)
}

const bedBox = () => ({ minX: 0, maxX: cutterW, minY: -cutterH, maxY: 0 })

// Centre the view on `box` and zoom so it fits with a little padding.
// Reserve space at the bottom for the floating timeline/download dock so the
// print area is never framed behind it.
const BOTTOM_INSET_PX = 132

const frameBox = (box, pad = 1.12) => {
  if (!camera || !box || !isFinite(box.minX)) return
  const cx = (box.minX + box.maxX) / 2
  let   cy = (box.minY + box.maxY) / 2
  const bw = Math.max(1, box.maxX - box.minX)
  const bh = Math.max(1, box.maxY - box.minY)
  const aspect = canvWidth / canvHeight
  const viewW = VIEW_REF_HALF_H * aspect * 2
  const viewH = VIEW_REF_HALF_H * 2
  // Fit into (and centre within) the area ABOVE the dock.
  const inset = Math.min(BOTTOM_INSET_PX, canvHeight * 0.5)
  const usableFrac = (canvHeight - inset) / canvHeight
  camera.zoom = Math.min(viewW / (bw * pad), (viewH * usableFrac) / (bh * pad))
  // Shift the centre down in world space (→ content moves up on screen) by half
  // the reserved strip, so the box sits centred in the usable area.
  const worldPerPx = viewH / (camera.zoom * canvHeight)
  cy -= (inset / 2) * worldPerPx
  camera.position.set(cx, cy, 5)
  camera.lookAt(cx, cy, 0)
  controls.target.set(cx, cy, 0)
  camera.updateProjectionMatrix()
  controls.update()
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

  // Bed fill — white (light) / dark gray (dark).
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
  drawObjects(lines, { resetPlayback: true })   // new design → timeline back to 0
  // Centre + fit the view on the freshly loaded design.
  contentBox = computeContentBBox(lines)
  frameBox(contentBox || bedBox())
  checkFit()
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

// ── Remove white elements (watermark cleanup) ─────────────────────────────────
const handleRemoveWhite = () => {
  if (!currentData) return
  currentData = removeWhite(currentData)
  clearHighlight()
  drawObjects(currentData)
  contentBox = computeContentBBox(currentData)
  checkFit()
}

// Toggle: optimise the cut order (mimic the printer's path optimiser) vs cut in
// file order. Rebuilds from the retained data — no re-fetch.
const handleOptimizeChanged = (enabled) => {
  optimizePath = !!enabled
  if (currentData) drawObjects(currentData)
}

// Toggle: raster regions as a filling block vs scan lines. Rebuilds geometry.
const handleRasterModeChanged = (enabled) => {
  rasterBlock = !!enabled
  if (currentData) drawObjects(currentData)
}

// Toggle: colour every segment randomly (debug aid for counting). Rebuilds.
const handleDebugColorsChanged = (enabled) => {
  debugColors = !!enabled
  if (currentData) drawObjects(currentData)
}

// Toggle: show/hide the dotted travel "Leerwege". Cheap — just flips a shader
// uniform; the segments stay in the geometry so timing/head position is intact.
const handleShowTravelChanged = (enabled) => {
  showTravel = enabled !== false
  if (lineMaterial) lineMaterial.uniforms.uShowTravel.value = showTravel ? 1 : 0
}

// Toggle: colour segments by speed (debug acceleration). The gradient is computed
// per-fragment in the shader, so this is just a uniform flip — no rebuild.
const handleSpeedGradientChanged = (enabled) => {
  speedGradient = !!enabled
  if (lineMaterial) lineMaterial.uniforms.uGradient.value = speedGradient ? 1 : 0
}

// ── Edits: Fix Colors / Remove Doubles ────────────────────────────────────────
// Both mutate currentData (the single source of truth) and rebuild, so the
// changes show in the viewer AND flow into the PDF download.

const handleFixColors = () => {
  if (!currentData) return
  currentData = fixColors(currentData)
  clearHighlight()
  eventBus.emit('doubles-result', { count: 0 })  // any armed double-removal resets
  drawObjects(currentData)
}

// First click: find + highlight coincident red/blue strokes. Second click
// (sent as 'doubles-remove' once armed) deletes them. The Sidebar button owns the
// armed state; we just report the count back.
const handleDoublesDetect = () => {
  if (!currentData) { eventBus.emit('doubles-result', { count: 0 }); return }
  const { removed } = computeDoubleRemoval(currentData)
  drawHighlight(removed)
  eventBus.emit('doubles-result', { count: removed.length, fromDetect: true })
}

const handleDoublesRemove = () => {
  if (!currentData) return
  const { data, removed } = computeDoubleRemoval(currentData)
  if (removed.length > 0) currentData = data
  clearHighlight()
  drawObjects(currentData)
  eventBus.emit('doubles-result', { count: 0 })
}

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
// to the exact head position — so the tip glides between vertices (cf. the old
// program's draw_path_layer) instead of snapping vertex-by-vertex.
// Reveal the toolpath up to time `target` (seconds). Draws all completed
// segments plus a partial leading segment whose tip is interpolated to the exact
// head position, so the line grows continuously between vertices.
const revealAtTime = (target) => {
  const pb = playback
  if (!pb || pb.total <= 0) return
  // The GPU does the rest: every fragment with its time <= uProgress draws solid,
  // the rest faint — so the reveal is exact and smooth from a single uniform.
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
// velocity profile to an arc-length, then map that to a point — so the marker
// accelerates/decelerates exactly like the shader reveal.
const headPosAt = (t) => {
  const runs = playback ? playback.runs : null
  if (!runs || runs.length === 0) return null
  if (t <= runs[0].t0) return runs[0].pts[0]
  let lo = 0, hi = runs.length - 1                     // last run with t0 <= t
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (runs[m].t0 <= t) lo = m; else hi = m - 1 }
  const run = runs[lo]
  const tl = Math.max(0, Math.min(run.T, t - run.t0))  // clamp into the run (gaps park at its end)
  return xyAtArc(run, distAtTime(tl, run.S, run.v, currentAccel))
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
      const greenFill = isGreen(obj.fill || '#000000')
      for (const s of sp.toShapes(isCCW)) {
        const geo = new THREE.ShapeGeometry(s)
        const mat = new THREE.MeshBasicMaterial({
          color: themedColor(obj.fill || '#000000'),
          side: THREE.DoubleSide,
          // Green fill is engraved as a raster (below); show it faintly so the
          // animated raster lines are visible on top of it.
          transparent: greenFill,
          opacity: greenFill ? 0.3 : 1,
        })
        drawingGroup.add(new THREE.Mesh(geo, mat))
      }
    } else if (obj.type === 'img') {
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

  // Expand moves into one ordered segment stream. The GEOMETRY stays minimal —
  // a straight line is a single segment — and the velocity profile is evaluated
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
  const rasterBlocks = [] // { bbox, t0, t1, color } when "raster as block" is on
  const headRuns = []     // per run: { t0, T, S, v, pts[], cum[] } for the head marker
  let runTime = 0         // running time along the toolpath
  let headRun = null
  const flushHeadRun = () => { if (headRun) { headRuns.push(headRun); headRun = null } }

  for (const m of moves) {
    const speed = (m.category === 'raster' ? (currentSpeeds.raster ?? currentSpeeds.engrave)
                                           : currentSpeeds[m.kind]) || currentSpeeds.other || SPEED_MM_S.other

    if (m.category === 'raster' && rasterBlock && m.bbox) {
      // Engrave region as a filling block: skip the serpentine segments, record
      // the region + its time span, and advance the clock by the same duration
      // so the overall timeline is identical to the scan-line version.
      flushHeadRun()
      const dur = rampSegments(movePolyline(m), speed, currentAccel).total
      rasterBlocks.push({ bbox: m.bbox, t0: runTime, t1: runTime + dur, color: lineRGB(m.color) })
      runTime += dur
      continue
    }

    const isTravel = m.kind === 'travel'
    const pts = isTravel ? [m.a, m.b] : movePolyline(m)
    if (pts.length < 2) continue
    // annotateRuns splits the polyline at sharp corners (raster turnarounds, the
    // 90° step between scan rows) and returns, per segment, its position in the
    // run's velocity profile (s0/s1/S) plus its duration.
    const ann = annotateRuns(pts, speed, currentAccel)
    const moveStart = runTime
    const baseRgb = lineRGB(m.color)

    for (let i = 0; i < pts.length - 1; i++) {
      const info = ann[i]
      const t0run = moveStart + info.runStartRel
      if (!headRun || headRun.t0 !== t0run) {            // new run begins
        flushHeadRun()
        headRun = { t0: t0run, T: 0, S: info.S, v: speed, pts: [pts[i]], cum: [0] }
      }
      const rgb = debugColors ? [Math.random(), Math.random(), Math.random()] : baseRgb
      runTime += info.dur
      const p = pts[i], q = pts[i + 1]
      vertices.push(p.x, p.y, 0, q.x, q.y, 0)
      colors.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2])
      runDist.push(info.s0, info.s1)
      runLen.push(info.S, info.S)
      runT0.push(t0run, t0run)
      segSpeed.push(speed, speed)
      dashes.push(isTravel ? 1 : 0, isTravel ? 1 : 0)
      dists.push(info.s0, info.s1)
      headRun.pts.push(q); headRun.cum.push(info.s1); headRun.T += info.dur
    }
  }
  flushHeadRun()

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
        attribute float aDash;
        attribute float aDist;
        varying vec3 vColor;
        varying float vRunDist;
        varying float vRunLen;
        varying float vRunT0;
        varying float vSpeed;
        varying float vDash;
        varying float vDist;
        void main() {
          vColor = color;
          vRunDist = aRunDist;
          vRunLen = aRunLen;
          vRunT0 = aRunT0;
          vSpeed = aSpeed;
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
        varying float vDash;
        varying float vDist;

        // Speed (mm/s) at arc-length s in a run (rest→cruise→rest, accel uAccel).
        float speedAt(float s, float S, float v) {
          float a = uAccel;
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
          float a = uAccel;
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

  // Raster-as-block meshes: one quad per region, filled top→bottom over its time
  // span. Same uProgress drives them, so they reveal in sync with the toolpath.
  for (const blk of rasterBlocks) {
    const w = blk.bbox.maxX - blk.bbox.minX
    const h = blk.bbox.maxY - blk.bbox.minY
    if (w <= 0 || h <= 0) continue
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uProgress:     { value: 0 },
        uPreviewAlpha: { value: PREVIEW_OPACITY },
        uT0:    { value: blk.t0 },
        uT1:    { value: blk.t1 },
        uColor: { value: new THREE.Color(blk.color[0], blk.color[1], blk.color[2]) },
      },
      vertexShader: `
        varying float vY01;
        void main() {
          vY01 = 1.0 - uv.y;   // 0 at top, 1 at bottom
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
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
      `,
    })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
    mesh.position.set((blk.bbox.minX + blk.bbox.maxX) / 2, (blk.bbox.minY + blk.bbox.maxY) / 2, 0.03)
    drawingGroup.add(mesh)
    revealMaterials.push(mat)
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

  console.log(`Toolpath: ${moves.length} moves, ${segCount} segments — `
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
    const response = await fetch('/api/save_pdf', {
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

  // Top ruler — world X in [0, cutterW] only; tick at the top edge, number below.
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

  // Left ruler — world Y in [-cutterH, 0] only; tick at the left edge, number right.
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

  updateHeadMarker()   // follow the head (also keeps a constant on-screen size)
  controls.update()
  renderer.render(scene, camera)
  drawRulers()         // 2D overlay; cheap no-op when the view is unchanged
}

// ── Resize ────────────────────────────────────────────────────────────────────
const handleResize = () => {
  canvWidth  = container.value.clientWidth
  canvHeight = container.value.clientHeight
  applyFrustum()   // preserves current zoom/pan, just updates aspect
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
onMounted(() => {
  initThree()
  window.addEventListener('resize', handleResize)
  eventBus.on('lines-updated',      handleLinesUpdate)
  eventBus.on('cutter-selected',    handleCutterSelected)
  eventBus.on('speeds-changed',     handleSpeedsChanged)
  eventBus.on('rotate-design',      handleRotateDesign)
  eventBus.on('remove-white',       handleRemoveWhite)
  eventBus.on('save_pdf_request',   handleDownloadRequest)
  eventBus.on('optimize-changed',   handleOptimizeChanged)
  eventBus.on('raster-mode-changed', handleRasterModeChanged)
  eventBus.on('debug-colors-changed', handleDebugColorsChanged)
  eventBus.on('show-travel-changed', handleShowTravelChanged)
  eventBus.on('speed-gradient-changed', handleSpeedGradientChanged)
  eventBus.on('rulers-changed',     handleRulersChanged)
  eventBus.on('tiny-highlight-changed', handleTinyHighlight)
  eventBus.on('fix-colors',         handleFixColors)
  eventBus.on('doubles-detect',     handleDoublesDetect)
  eventBus.on('doubles-remove',     handleDoublesRemove)
  eventBus.on('playback_playpause', handlePlayPause)
  eventBus.on('playback_speed',     handleSpeed)
  eventBus.on('playback_seek',      handleSeek)
  eventBus.on('theme-changed',      handleThemeChanged)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  eventBus.off('lines-updated',      handleLinesUpdate)
  eventBus.off('cutter-selected',    handleCutterSelected)
  eventBus.off('speeds-changed',     handleSpeedsChanged)
  eventBus.off('rotate-design',      handleRotateDesign)
  eventBus.off('remove-white',       handleRemoveWhite)
  eventBus.off('save_pdf_request',   handleDownloadRequest)
  eventBus.off('optimize-changed',   handleOptimizeChanged)
  eventBus.off('raster-mode-changed', handleRasterModeChanged)
  eventBus.off('debug-colors-changed', handleDebugColorsChanged)
  eventBus.off('show-travel-changed', handleShowTravelChanged)
  eventBus.off('speed-gradient-changed', handleSpeedGradientChanged)
  eventBus.off('rulers-changed',     handleRulersChanged)
  eventBus.off('tiny-highlight-changed', handleTinyHighlight)
  eventBus.off('fix-colors',         handleFixColors)
  eventBus.off('doubles-detect',     handleDoublesDetect)
  eventBus.off('doubles-remove',     handleDoublesRemove)
  eventBus.off('playback_playpause', handlePlayPause)
  eventBus.off('playback_speed',     handleSpeed)
  eventBus.off('playback_seek',      handleSeek)
  eventBus.off('theme-changed',      handleThemeChanged)
  if (renderer) renderer.dispose()
})
</script>
