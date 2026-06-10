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

// Retained so we can rebuild the toolpath when the optimise toggle changes
// without re-fetching from the backend.
let currentData = null
let optimizePath = false

// Travel "Leerwege" are drawn as dotted gray lines: dash on/off length in mm.
const TRAVEL_DASH = 3
const TRAVEL_GAP  = 2

// Opacity of the faint full-design preview drawn under the playback progress
const PREVIEW_OPACITY = 0.2

// Playback state — a solid line that grows smoothly along the toolpath, in
// machine order (engrave → cut, with travels). The reveal axis is TIME so the
// head moves slower through engraves than rapid travels.
//   positions      : mutable vertex buffer of the progress line (partial tip moves)
//   truePositions  : pristine copy used to restore the tip when progress advances
//   segDur / cumDur : per-segment and cumulative durations (s), in draw order
//   total          : total toolpath duration (s)
//   lastPartial    : index of the segment whose tip vertex is currently moved
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
  scene.background = new THREE.Color(0xffffff)

  canvWidth  = container.value.clientWidth
  canvHeight = container.value.clientHeight

  renderer = new THREE.WebGLRenderer({ canvas: canvas.value, antialias: true })
  renderer.setSize(canvWidth, canvHeight)
  renderer.setClearColor(0xffffff)
  container.value.appendChild(renderer.domElement)

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
  drawCutterFrame()
  frameBox(bedBox())   // start framed on the bed; loading a file re-frames it
  animate()
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
// Origin (0,0) = top-left corner.  X → right, Y → down (negative).
const drawCutterFrame = () => {
  if (rectangleFrame) scene.remove(rectangleFrame)

  const L = 0, R = cutterW, T = 0, B = -cutterH
  const verts = new Float32Array([
    L, T, 0,  R, T, 0,
    R, T, 0,  R, B, 0,
    R, B, 0,  L, B, 0,
    L, B, 0,  L, T, 0,
  ])
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
  rectangleFrame = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x000000 }))
  scene.add(rectangleFrame)
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
  if (!pb || pb.segCount === 0 || pb.total <= 0) return
  target = Math.min(pb.total, Math.max(0, target))

  // Restore the previously-moved tip vertex to its true position.
  if (pb.lastPartial >= 0) {
    const b = pb.lastPartial * 6
    pb.positions[b + 3] = pb.truePositions[b + 3]
    pb.positions[b + 4] = pb.truePositions[b + 4]
    pb.lastPartial = -1
  }

  // Count fully-completed segments (cumulative duration within target time).
  let full = 0
  while (full < pb.segCount && pb.cumDur[full] <= target) full++

  let drawnSegs = full
  if (full < pb.segCount) {
    const segStart = full > 0 ? pb.cumDur[full - 1] : 0
    const rem = target - segStart
    if (rem > 0 && pb.segDur[full] > 0) {
      // Constant speed within a segment → time fraction == length fraction.
      const f = rem / pb.segDur[full]
      const b = full * 6
      const x1 = pb.truePositions[b],     y1 = pb.truePositions[b + 1]
      const x2 = pb.truePositions[b + 3], y2 = pb.truePositions[b + 4]
      pb.positions[b + 3] = x1 + (x2 - x1) * f
      pb.positions[b + 4] = y1 + (y2 - y1) * f
      pb.lastPartial = full
      drawnSegs = full + 1
    }
  }

  pb.posAttr.needsUpdate = true
  pb.line.geometry.setDrawRange(0, drawnSegs * 2)
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
      // isCCW=true: MuPDF glyph outer contours are CCW (positive area) and
      // holes (letter counters) are CW — so the outer fills and the counter is
      // a hole. (false wrongly fills the counter, e.g. the eye of an 'e'.)
      const greenFill = isGreen(obj.fill || '#000000')
      for (const s of sp.toShapes(true)) {
        const geo = new THREE.ShapeGeometry(s)
        const mat = new THREE.MeshBasicMaterial({
          color: obj.fill || '#000000',
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

  // Expand moves into an ordered segment stream feeding (a) a faint preview and
  // (b) the time-based playback line. Travels become gray dotted dashes; their
  // per-dash duration is scaled so the whole travel still consumes its true time.
  const vertices = []   // xyz per vertex (2 per segment)
  const colors   = []   // rgb per vertex
  const segDur   = []   // duration (s) of each segment, in order

  const colorRGB = (hex) => {
    const c = hex || '#000000'
    return [parseInt(c.slice(1,3),16)/255, parseInt(c.slice(3,5),16)/255, parseInt(c.slice(5,7),16)/255]
  }
  const pushSeg = (x1, y1, x2, y2, rgb, dur) => {
    vertices.push(x1, y1, 0, x2, y2, 0)
    colors.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2])
    segDur.push(dur)
  }

  for (const m of moves) {
    const speed = SPEED_MM_S[m.kind] || SPEED_MM_S.other

    if (m.kind === 'travel') {
      // Dotted travel: emit on-dashes only, distributing the full travel time
      // across them so reveal timing stays accurate despite the gaps.
      const a = m.a, b = m.b
      const full = Math.hypot(b.x - a.x, b.y - a.y)
      if (full < 1e-6) continue
      const ux = (b.x - a.x) / full, uy = (b.y - a.y) / full
      const rgb = colorRGB(m.color)
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
      const rgb = colorRGB(m.color)
      for (const prim of m.prims) {
        const pts = flattenPrim(prim)
        for (let i = 0; i < pts.length - 1; i++) {
          const p = pts[i], q = pts[i + 1]
          pushSeg(p.x, p.y, q.x, q.y, rgb, Math.hypot(q.x - p.x, q.y - p.y) / speed)
        }
      }
    }
  }

  // ── Faint design preview — built from the RAW vectors (all colours, incl.
  //    green) so the original design stays visible under the toolpath. Green is
  //    engraved as a raster in the toolpath, so this is the only place its
  //    actual shape is shown.
  {
    const dVerts = [], dCols = []
    const pushPreview = (x1, y1, x2, y2, hex) => {
      dVerts.push(x1, y1, 0, x2, y2, 0)
      const rgb = colorRGB(hex)
      dCols.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2])
    }
    for (const obj of data) {
      if (obj.type === 'l') {
        pushPreview(obj.x1, obj.y1, obj.x2, obj.y2, obj.color)
      } else if (obj.type === 'c') {
        const pts = flattenPrim({
          t: 'C',
          p0: { x: obj.x1, y: obj.y1 }, p1: { x: obj.x2, y: obj.y2 },
          p2: { x: obj.x3, y: obj.y3 }, p3: { x: obj.x4, y: obj.y4 },
        })
        for (let i = 0; i < pts.length - 1; i++) {
          pushPreview(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, obj.color)
        }
      }
    }
    if (dVerts.length > 0) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(dVerts), 3))
      geo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(dCols), 3))
      const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: PREVIEW_OPACITY })
      drawingGroup.add(new THREE.LineSegments(geo, mat))
    }
  }

  // ── Playback progress line — solid, grows along the toolpath in machine
  //    order. Its own mutable position buffer lets us slide the leading tip
  //    between vertices for a smooth reveal.
  playback = null
  if (vertices.length > 0) {
    const pos = new Float32Array(vertices)
    const col = new Float32Array(colors)
    const progPositions = pos.slice()
    const progGeo = new THREE.BufferGeometry()
    const posAttr = new THREE.BufferAttribute(progPositions, 3)
    posAttr.setUsage(THREE.DynamicDrawUsage)
    progGeo.setAttribute('position', posAttr)
    progGeo.setAttribute('color', new THREE.BufferAttribute(col.slice(), 3))
    progGeo.setDrawRange(0, 0)
    const progLine = new THREE.LineSegments(progGeo, new THREE.LineBasicMaterial({ vertexColors: true }))
    progLine.position.z = 0.05    // sit just in front of the preview
    progLine.renderOrder = 1
    drawingGroup.add(progLine)

    // Cumulative durations for the time-based reveal.
    const segCount = segDur.length
    const cumDur = new Float32Array(segCount)
    let acc = 0
    for (let i = 0; i < segCount; i++) { acc += segDur[i]; cumDur[i] = acc }

    playback = {
      line: progLine, posAttr, positions: progPositions, truePositions: pos,
      segDur, cumDur, total: acc, segCount, lastPartial: -1,
    }
  }

  scene.add(drawingGroup)

  // Reset the playback clock to the start whenever the geometry is rebuilt.
  pbTime = 0
  pbPlaying = false
  revealAtTime(0)
  emitTick()

  // Publish stats so the playback panel can show total time / lengths.
  eventBus.emit('toolpath-stats', { ...stats, optimized: optimizePath })

  console.log(`Toolpath: ${moves.length} moves, ${segDur.length} segments — `
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
  eventBus.on('playback_playpause', handlePlayPause)
  eventBus.on('playback_speed',     handleSpeed)
  eventBus.on('playback_seek',      handleSeek)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  eventBus.off('lines-updated',      handleLinesUpdate)
  eventBus.off('cutter-selected',    handleCutterSelected)
  eventBus.off('save_pdf_request',   handleDownloadRequest)
  eventBus.off('optimize-changed',   handleOptimizeChanged)
  eventBus.off('playback_playpause', handlePlayPause)
  eventBus.off('playback_speed',     handleSpeed)
  eventBus.off('playback_seek',      handleSeek)
  if (renderer) renderer.dispose()
})
</script>
