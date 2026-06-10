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

const container = ref(null)
const canvas    = ref(null)
let scene, camera, renderer, controls
let rectangleFrame
let drawingGroup       // THREE.Group for imported geometry
let canvWidth, canvHeight
const margin = 20      // mm padding around the cutter frame

// Cutter state — default to Edgar 1000×700 mm
let cutterW = 1000
let cutterH = 700

// Opacity of the faint full-design preview drawn under the playback progress
const PREVIEW_OPACITY = 0.2

// Playback state — a solid line that grows smoothly along the toolpath length.
// Built in drawObjects(), advanced in handleProgressUpdate().
//   positions      : mutable vertex buffer of the progress line (partial tip moves)
//   truePositions  : pristine copy used to restore the tip when progress advances
//   segLen / cumLen: per-segment and cumulative lengths (mm), in draw order
//   total          : total toolpath length (mm)
//   lastPartial    : index of the segment whose tip vertex is currently moved
let playback = null

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

  // Initial camera matched to default cutter; updateCamera() refines it.
  // The camera must sit directly IN FRONT of its target (same x/y, offset only
  // in z) — otherwise the orthographic projection is oblique and the scene
  // looks sheared / "rotated in 3D".
  const cx = cutterW / 2
  const cy = -cutterH / 2
  camera = new THREE.OrthographicCamera(-margin, cutterW + margin, margin, -(cutterH + margin), 0.1, 10000)
  camera.position.set(cx, cy, 5)
  camera.lookAt(cx, cy, 0)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableZoom   = true
  controls.enablePan    = true
  controls.enableRotate = false
  controls.screenSpacePanning = true
  controls.target.set(cx, cy, 0)

  drawCutterFrame()
  updateCamera()
  animate()
}

// ── Camera ────────────────────────────────────────────────────────────────────
const updateCamera = () => {
  if (!camera || !renderer) return
  const aspect = canvWidth / canvHeight

  // Fit the cutter area (with margin) while preserving canvas aspect ratio.
  // Try fitting height first; if the resulting width is narrower than the cutter, fit width.
  let viewH = cutterH + margin * 2
  let viewW = viewH * aspect
  if (viewW < cutterW + margin * 2) {
    viewW = cutterW + margin * 2
    viewH = viewW / aspect
  }

  const cx = cutterW / 2
  const cy = -cutterH / 2
  camera.left   = cx - viewW / 2
  camera.right  = cx + viewW / 2
  camera.top    = cy + viewH / 2
  camera.bottom = cy - viewH / 2
  camera.updateProjectionMatrix()
  renderer.setSize(canvWidth, canvHeight)
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
  const cx = cutterW / 2
  const cy = -cutterH / 2
  // Keep the camera directly in front of the (new) target — no oblique view.
  camera.position.set(cx, cy, 5)
  camera.lookAt(cx, cy, 0)
  controls.target.set(cx, cy, 0)
  controls.update()
  drawCutterFrame()
  updateCamera()
}

// ── Lines / objects update ────────────────────────────────────────────────────
const handleLinesUpdate = (lines) => {
  drawObjects(lines)
}

// ── Playback progress ─────────────────────────────────────────────────────────
// Reveals the toolpath as a solid line that grows *smoothly* along its length.
// Whole completed segments are drawn, plus a partial leading segment interpolated
// to the exact head position — so the tip glides between vertices (cf. the old
// program's draw_path_layer) instead of snapping vertex-by-vertex.
const handleProgressUpdate = (progress) => {
  const pb = playback
  if (!pb || pb.segCount === 0 || pb.total <= 0) return

  const target = pb.total * (Math.min(100, Math.max(0, progress)) / 100)

  // Restore the previously-moved tip vertex to its true position.
  if (pb.lastPartial >= 0) {
    const b = pb.lastPartial * 6
    pb.positions[b + 3] = pb.truePositions[b + 3]
    pb.positions[b + 4] = pb.truePositions[b + 4]
    pb.lastPartial = -1
  }

  // Count fully-completed segments (cumulative length within target).
  let full = 0
  while (full < pb.segCount && pb.cumLen[full] <= target) full++

  let drawnSegs = full
  if (full < pb.segCount) {
    const segStart = full > 0 ? pb.cumLen[full - 1] : 0
    const rem = target - segStart
    if (rem > 0 && pb.segLen[full] > 0) {
      const f = rem / pb.segLen[full]
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

// ── Draw imported geometry ────────────────────────────────────────────────────
const drawObjects = (data) => {
  if (!data || data.length === 0) return
  if (drawingGroup) scene.remove(drawingGroup)

  drawingGroup = new THREE.Group()

  // Straight lines and flattened curves are collected, in draw order, into one
  // ordered segment stream. It feeds two things:
  //   • a faint full-design preview (always visible)
  //   • the playback "progress" line that grows smoothly along the path length
  const vertices = []   // xyz per vertex (2 per segment)
  const colors   = []   // rgb per vertex
  const segLen   = []   // length (mm) of each segment, in order

  const pushSeg = (x1, y1, x2, y2, hex) => {
    vertices.push(x1, y1, 0, x2, y2, 0)
    const c = hex || '#000000'
    const r = parseInt(c.slice(1, 3), 16) / 255
    const g = parseInt(c.slice(3, 5), 16) / 255
    const b = parseInt(c.slice(5, 7), 16) / 255
    colors.push(r, g, b, r, g, b)
    segLen.push(Math.hypot(x2 - x1, y2 - y1))
  }

  data.forEach(obj => {
    // ── Straight lines ──────────────────────────────────────────────────
    if (obj.type === 'l') {
      pushSeg(obj.x1, obj.y1, obj.x2, obj.y2, obj.color)
    }

    // ── Cubic bezier curves → flattened into line segments ──────────────
    else if (obj.type === 'c') {
      const curve = new THREE.CubicBezierCurve(
        new THREE.Vector2(obj.x1, obj.y1),
        new THREE.Vector2(obj.x2, obj.y2),
        new THREE.Vector2(obj.x3, obj.y3),
        new THREE.Vector2(obj.x4, obj.y4)
      )
      const pts = curve.getPoints(20) // sample 20 points along the curve
      if (pts.length < 2) {
        console.warn('Not enough points sampled from curve')
        return
      }
      for (let i = 0; i < pts.length - 1; i++) {
        pushSeg(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, obj.color)
      }
    }

    // ── Filled paths (text outlines, filled shapes) ─────────────────────
    else if (obj.type === 'fp') {
      // ShapePath handles multi-subpath correctly (holes in letters, etc.).
      // NOTE: ShapePath has no closePath(); each moveTo starts a new subpath,
      // and fills auto-close. The 'Z' commands are intentionally ignored.
      const sp = new THREE.ShapePath()
      for (const cmd of obj.path) {
        if      (cmd.cmd === 'M') sp.moveTo(cmd.x, cmd.y)
        else if (cmd.cmd === 'L') sp.lineTo(cmd.x, cmd.y)
        else if (cmd.cmd === 'C') sp.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y)
      }
      // Holes are resolved by containment, so isCCW choice doesn't matter here.
      const shapes = sp.toShapes(false)
      for (const s of shapes) {
        const geo = new THREE.ShapeGeometry(s)
        const mat = new THREE.MeshBasicMaterial({
          color: obj.fill || '#000000',
          side: THREE.DoubleSide,
        })
        drawingGroup.add(new THREE.Mesh(geo, mat))
      }
    }

    // ── Raster images (engraving bitmaps) ───────────────────────────────
    else if (obj.type === 'img') {
      const texture = new THREE.TextureLoader().load(obj.data)
      // obj.x/obj.y is the top-left corner (x right, y down as negative).
      const geo = new THREE.PlaneGeometry(obj.w, obj.h)
      const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: false })
      const mesh = new THREE.Mesh(geo, mat)
      // centre of the image: x + w/2, y - h/2
      mesh.position.set(obj.x + obj.w / 2, obj.y - obj.h / 2, obj.is_background ? -0.1 : 0.01)
      drawingGroup.add(mesh)
    }

    // ── MediaBox (informational, ignored — cutter defines the frame) ────
    else if (obj.type === 'mbox') {
      // no-op
    }
  })

  // Build the line geometry (faint preview + smooth playback progress line).
  playback = null
  if (vertices.length > 0) {
    const pos = new Float32Array(vertices)
    const col = new Float32Array(colors)

    // 1) Faint full-design preview — static, always visible.
    const previewGeo = new THREE.BufferGeometry()
    previewGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    previewGeo.setAttribute('color',    new THREE.BufferAttribute(col, 3))
    const previewMat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: PREVIEW_OPACITY,
    })
    drawingGroup.add(new THREE.LineSegments(previewGeo, previewMat))

    // 2) Playback progress line — solid, grows along the path length. Its own
    //    mutable position buffer lets us slide the leading tip between vertices.
    const progPositions = pos.slice()           // mutable copy (tip moves)
    const progGeo = new THREE.BufferGeometry()
    const posAttr = new THREE.BufferAttribute(progPositions, 3)
    posAttr.setUsage(THREE.DynamicDrawUsage)
    progGeo.setAttribute('position', posAttr)
    progGeo.setAttribute('color', new THREE.BufferAttribute(col.slice(), 3))
    progGeo.setDrawRange(0, 0)                   // nothing drawn until progress > 0
    const progMat = new THREE.LineBasicMaterial({ vertexColors: true })
    const progLine = new THREE.LineSegments(progGeo, progMat)
    progLine.position.z = 0.05                   // sit just in front of the preview
    progLine.renderOrder = 1
    drawingGroup.add(progLine)

    // Cumulative lengths for length-based reveal.
    const segCount = segLen.length
    const cumLen = new Float32Array(segCount)
    let acc = 0
    for (let i = 0; i < segCount; i++) { acc += segLen[i]; cumLen[i] = acc }

    playback = {
      line: progLine,
      posAttr,
      positions: progPositions,
      truePositions: pos,
      segLen,
      cumLen,
      total: acc,
      segCount,
      lastPartial: -1,
    }
  }

  scene.add(drawingGroup)

  const fp  = data.filter(o => o.type === 'fp').length
  const img = data.filter(o => o.type === 'img').length
  console.log(`Drew ${data.length} objects — ${fp} filled paths, ${img} images, `
            + `${segLen.length} toolpath segments (${playback ? playback.total.toFixed(1) : 0} mm)`)
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
  controls.update()
  renderer.render(scene, camera)
}

// ── Resize ────────────────────────────────────────────────────────────────────
const handleResize = () => {
  canvWidth  = container.value.clientWidth
  canvHeight = container.value.clientHeight
  updateCamera()
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
onMounted(() => {
  initThree()
  window.addEventListener('resize', handleResize)
  eventBus.on('lines-updated',     handleLinesUpdate)
  eventBus.on('cutter-selected',   handleCutterSelected)
  eventBus.on('save_pdf_request',  handleDownloadRequest)
  eventBus.on('playback_progress', handleProgressUpdate)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  eventBus.off('lines-updated',     handleLinesUpdate)
  eventBus.off('cutter-selected',   handleCutterSelected)
  eventBus.off('save_pdf_request',  handleDownloadRequest)
  eventBus.off('playback_progress', handleProgressUpdate)
  if (renderer) renderer.dispose()
})
</script>
