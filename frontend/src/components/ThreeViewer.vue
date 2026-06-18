<template>
  <div ref="container" class="three-container">
    <canvas ref="canvas" style="width: 100%; height: 100%; display: block;"></canvas>
  </div>
</template>

<style scoped>
.three-container {
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
}
</style>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import * as THREE from 'three'
import eventBus from '../eventBus'
import { buildToolpath, flattenPrim, isGreen, SPEED_MM_S } from '../toolpath'

const container = ref(null)
const canvas    = ref(null)
let scene, camera, renderer, controls
let rectangleFrame
let drawingGroup       // THREE.Group for imported geometry
let canvWidth, canvHeight
const VIEW_REF_HALF_H = 400  // world half-height (mm) of the frustum at zoom 1
let contentBox = null        // bbox of the last loaded design (for re-framing)

// Cutter state — default to Edgar 1000×700 mm
let cutterW = 1000
let cutterH = 700

// Retained so we can rebuild the toolpath when a toggle changes without
// re-fetching from the backend.
let currentData = null
let optimizePath = false
let rasterBlock  = false   // draw raster regions as a filling block vs scan lines
let debugColors  = false   // colour every segment randomly (to count them)

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
  // Rebuild the design so line/fill colours re-adjust for the new theme, while
  // keeping the current playback position.
  if (currentData) {
    const savedTime = pbTime
    const wasPlaying = pbPlaying
    drawObjects(currentData)
    pbTime = playback ? Math.min(savedTime, playback.total) : 0
    pbPlaying = wasPlaying
    revealAtTime(pbTime)
    emitTick()
  }
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
const frameBox = (box, pad = 1.12) => {
  if (!camera || !box || !isFinite(box.minX)) return
  const cx = (box.minX + box.maxX) / 2
  const cy = (box.minY + box.maxY) / 2
  const bw = Math.max(1, box.maxX - box.minX)
  const bh = Math.max(1, box.maxY - box.minY)
  const aspect = canvWidth / canvHeight
  const viewW = VIEW_REF_HALF_H * aspect * 2
  const viewH = VIEW_REF_HALF_H * 2
  camera.zoom = Math.min(viewW / (bw * pad), viewH / (bh * pad))
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
  cutterW = cutter.widthMm
  cutterH = cutter.heightMm
  drawCutterFrame()
  // Re-frame on the content if a design is loaded, otherwise on the new bed.
  frameBox(contentBox || bedBox())
}

// ── Lines / objects update ────────────────────────────────────────────────────
const handleLinesUpdate = (lines) => {
  currentData = lines
  drawObjects(lines)
  // Centre + fit the view on the freshly loaded design.
  contentBox = computeContentBBox(lines)
  frameBox(contentBox || bedBox())
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
const drawObjects = (data) => {
  if (!data || data.length === 0) return
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
      // obj.x/obj.y is the top-left corner (x right, y down as negative).
      const geo = new THREE.PlaneGeometry(obj.w, obj.h)
      const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: false })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(obj.x + obj.w / 2, obj.y - obj.h / 2, obj.is_background ? -0.1 : 0.01)
      drawingGroup.add(mesh)
    }
  })

  // ── Toolpath: ordered machine moves (engrave → cut, optional optimise) ────
  const { moves, stats } = buildToolpath(data, { optimize: optimizePath })

  // Expand moves into a single ordered segment stream. Each vertex also carries
  // its cumulative TIME along the toolpath (aTime); the shader reveals every
  // fragment whose aTime <= the current head time, so one line is both the faint
  // preview and the solid played-so-far portion — no second line, no overdraw.
  // Travels become gray dotted dashes; their per-dash duration is scaled so the
  // whole travel still consumes its true time.
  const vertices = []     // xyz per vertex (2 per segment)
  const colors   = []     // rgb per vertex
  const times    = []     // cumulative time (s) at each vertex
  const rasterBlocks = [] // { bbox, t0, t1, color } when "raster as block" is on
  let runTime = 0         // running time along the toolpath

  const pushSeg = (x1, y1, x2, y2, rgb, dur) => {
    const t0 = runTime, t1 = runTime + dur
    runTime = t1
    // Debug: give each segment its own random colour so they're easy to count.
    const c = debugColors ? [Math.random(), Math.random(), Math.random()] : rgb
    vertices.push(x1, y1, 0, x2, y2, 0)
    colors.push(c[0], c[1], c[2], c[0], c[1], c[2])
    times.push(t0, t1)
  }

  for (const m of moves) {
    const speed = SPEED_MM_S[m.kind] || SPEED_MM_S.other

    if (m.category === 'raster' && rasterBlock && m.bbox) {
      // Engrave region as a filling block: skip the serpentine segments, record
      // the region + its time span, and advance the clock by the same duration
      // so the overall timeline is identical to the scan-line version.
      let len = 0
      for (const prim of m.prims) len += Math.hypot(prim.b.x - prim.a.x, prim.b.y - prim.a.y)
      const dur = len / speed
      rasterBlocks.push({ bbox: m.bbox, t0: runTime, t1: runTime + dur, color: lineRGB(m.color) })
      runTime += dur
      continue
    }

    if (m.kind === 'travel') {
      // Dotted travel: emit on-dashes only, distributing the full travel time
      // across them so reveal timing stays accurate despite the gaps.
      const a = m.a, b = m.b
      const full = Math.hypot(b.x - a.x, b.y - a.y)
      if (full < 1e-6) continue
      const ux = (b.x - a.x) / full, uy = (b.y - a.y) / full
      const rgb = lineRGB(m.color)
      const dashes = []
      for (let d = 0; d < full; d += TRAVEL_DASH + TRAVEL_GAP) {
        dashes.push([d, Math.min(d + TRAVEL_DASH, full)])
      }
      const dashLen = dashes.reduce((s, [s0, s1]) => s + (s1 - s0), 0) || full
      const fullTime = full / speed
      for (const [s0, s1] of dashes) {
        pushSeg(a.x + ux*s0, a.y + uy*s0, a.x + ux*s1, a.y + uy*s1, rgb,
                fullTime * ((s1 - s0) / dashLen))
      }
    } else {
      // Beam-on path: tessellate each primitive (lines stay lines; beziers are
      // adaptively flattened by arc length so they render as smooth curves).
      const rgb = lineRGB(m.color)
      for (const prim of m.prims) {
        const pts = flattenPrim(prim)
        for (let i = 0; i < pts.length - 1; i++) {
          const p = pts[i], q = pts[i + 1]
          pushSeg(p.x, p.y, q.x, q.y, rgb, Math.hypot(q.x - p.x, q.y - p.y) / speed)
        }
      }
    }
  }

  // ── Single toolpath line ──────────────────────────────────────────────────
  // One LineSegments holds the whole toolpath. A small shader colours each
  // fragment: solid if its time has passed (uProgress), faint otherwise. This is
  // both the preview and the played-so-far line in one cheap draw call, and the
  // reveal boundary is exact per-pixel (smooth tip) without moving any vertex.
  playback = null
  const revealMaterials = []   // all materials whose uProgress the clock advances
  const segCount = vertices.length / 6

  if (segCount > 0) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3))
    geo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(colors), 3))
    geo.setAttribute('aTime',    new THREE.BufferAttribute(new Float32Array(times), 1))

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uProgress:     { value: 0 },
        uPreviewAlpha: { value: PREVIEW_OPACITY },
      },
      vertexShader: `
        attribute vec3 color;
        attribute float aTime;
        varying vec3 vColor;
        varying float vTime;
        void main() {
          vColor = color;
          vTime = aTime;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uProgress;
        uniform float uPreviewAlpha;
        varying vec3 vColor;
        varying float vTime;
        void main() {
          float a = vTime <= uProgress ? 1.0 : uPreviewAlpha;
          gl_FragColor = vec4(vColor, a);
        }
      `,
    })

    const line = new THREE.LineSegments(geo, mat)
    line.position.z = 0.05
    drawingGroup.add(line)
    revealMaterials.push(mat)
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
    playback = { materials: revealMaterials, total: runTime, segCount }
  }

  scene.add(drawingGroup)

  // Reset the playback clock to the start whenever the geometry is rebuilt.
  pbTime = 0
  pbPlaying = false
  revealAtTime(0)
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
  try {
    const response = await fetch('/api/save_pdf')
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

  controls.update()
  renderer.render(scene, camera)
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
  eventBus.on('save_pdf_request',   handleDownloadRequest)
  eventBus.on('optimize-changed',   handleOptimizeChanged)
  eventBus.on('raster-mode-changed', handleRasterModeChanged)
  eventBus.on('debug-colors-changed', handleDebugColorsChanged)
  eventBus.on('playback_playpause', handlePlayPause)
  eventBus.on('playback_speed',     handleSpeed)
  eventBus.on('playback_seek',      handleSeek)
  eventBus.on('theme-changed',      handleThemeChanged)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  eventBus.off('lines-updated',      handleLinesUpdate)
  eventBus.off('cutter-selected',    handleCutterSelected)
  eventBus.off('save_pdf_request',   handleDownloadRequest)
  eventBus.off('optimize-changed',   handleOptimizeChanged)
  eventBus.off('raster-mode-changed', handleRasterModeChanged)
  eventBus.off('debug-colors-changed', handleDebugColorsChanged)
  eventBus.off('playback_playpause', handlePlayPause)
  eventBus.off('playback_speed',     handleSpeed)
  eventBus.off('playback_seek',      handleSeek)
  eventBus.off('theme-changed',      handleThemeChanged)
  if (renderer) renderer.dispose()
})
</script>
