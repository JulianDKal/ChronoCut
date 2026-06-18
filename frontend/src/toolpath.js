// Machine toolpath construction.
//
// Mirrors the ordering logic of the old PyQt program (Reference/old version of
// the program.py, AnalysisThread.run): classify paths by colour, run the
// engrave phase before the cut phase, optionally nearest-neighbour optimise the
// order within each phase, and insert travel ("Leerwege") moves between paths.
//
// Geometry is kept as PRIMITIVES — a path is a list of line ('L') and cubic
// bezier ('C') primitives. Beziers stay beziers all the way through; they are
// only tessellated (adaptively, by arc length) at render time. Coordinates are
// in viewer space (mm, origin top-left, y negative downward). The print head
// starts at the top-left (0,0).

// Default head speeds (mm/s). Placeholder values — wire these to the selected
// cutter/material later. Relative magnitudes drive the time estimate and the
// time-based playback reveal.
export const SPEED_MM_S = {
  engrave: 80,   // red / green layers
  cut:     30,   // blue layer
  other:   60,   // anything uncategorised
  travel: 250,   // rapid moves between paths (no beam)
}

// Raster (boustrophedon engraving) parameters — green and grayscale content is
// engraved by scanning horizontally back and forth over its bounding box.
const RASTER_PITCH    = 0.6   // mm between scan lines (vertical step)
const RASTER_OVERSCAN = 6     // mm of accel/decel space added on each side
const RASTER_MAX_ROWS = 1200  // safety cap (pitch grows if a region is huge)
const RASTER_GREEN    = '#00a000'  // colour of green-region scan lines
const RASTER_GRAY     = '#555555'  // colour of grayscale-image scan lines

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

export function categorize(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  if (b > 0.8 && r < 0.2) return 'blue'
  if (r > 0.8 && b < 0.2) return 'red'
  if (g > 0.5 && r < 0.4) return 'green'
  return 'other'
}

// True for fill colours engraved as a raster (currently green text/fills).
export const isGreen = (hex) => categorize(hex || '#000000') === 'green'

// Map a colour category to a machine operation (drives speed + travel grouping).
export function kindOf(category) {
  if (category === 'blue')  return 'cut'
  if (category === 'other') return 'other'
  return 'engrave' // red, green
}

// ── Primitive helpers ─────────────────────────────────────────────────────────
const primStart = (p) => (p.t === 'L' ? p.a : p.p0)
const primEnd   = (p) => (p.t === 'L' ? p.b : p.p3)

function reversePrim(p) {
  if (p.t === 'L') return { t: 'L', a: p.b, b: p.a }
  return { t: 'C', p0: p.p3, p1: p.p2, p2: p.p1, p3: p.p0 } // reverse control points
}

function reversePath(path) {
  path.prims = path.prims.reverse().map(reversePrim)
  const s = path.start; path.start = path.end; path.end = s
  return path
}

// Cubic point at parameter t.
function cubicAt(p, t) {
  const mt = 1 - t
  const a = mt*mt*mt, b = 3*mt*mt*t, c = 3*mt*t*t, d = t*t*t
  return {
    x: a*p.p0.x + b*p.p1.x + c*p.p2.x + d*p.p3.x,
    y: a*p.p0.y + b*p.p1.y + c*p.p2.y + d*p.p3.y,
  }
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

// Perpendicular distance from point p to the infinite line through a–b.
function distToLine(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / Math.sqrt(len2)
}

function subdivideCubic(p0, p1, p2, p3, tol, depth, out) {
  // Flat enough when both control points sit within `tol` of the chord p0–p3.
  const d = Math.max(distToLine(p1, p0, p3), distToLine(p2, p0, p3))
  if (depth <= 0 || d <= tol) {
    out.push(p3)
    return
  }
  // de Casteljau split at t = 0.5
  const p01 = mid(p0, p1), p12 = mid(p1, p2), p23 = mid(p2, p3)
  const p012 = mid(p01, p12), p123 = mid(p12, p23)
  const m = mid(p012, p123)
  subdivideCubic(p0, p01, p012, m, tol, depth - 1, out)
  subdivideCubic(m, p123, p23, p3, tol, depth - 1, out)
}

/**
 * Tessellate a primitive into a polyline using ADAPTIVE (flatness-based)
 * subdivision: a cubic is split only where it bends away from a straight chord
 * by more than `tol` mm. Gentle curves get a handful of segments, tight ones
 * more — far fewer points than the old fixed/length-based count.
 *
 * @returns {Array<{x,y}>} points including both endpoints (line → 2 points)
 */
export function flattenPrim(p, tol = 0.2, maxDepth = 8) {
  if (p.t === 'L') return [p.a, p.b]
  const out = [p.p0]
  subdivideCubic(p.p0, p.p1, p.p2, p.p3, tol, maxDepth, out)
  return out
}

function primLength(p) {
  if (p.t === 'L') return dist(p.a, p.b)
  const pts = flattenPrim(p)
  let L = 0
  for (let i = 0; i < pts.length - 1; i++) L += dist(pts[i], pts[i + 1])
  return L
}

// Reconstruct connected paths from the flat l/c stream, keeping each item as a
// primitive. Consecutive items of the same colour whose endpoints meet merge.
function reconstructPaths(data) {
  const paths = []
  let cur = null
  const eq = (a, b) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01
  const flush = () => { if (cur && cur.prims.length) paths.push(cur); cur = null }

  for (const obj of data) {
    let prim, color
    if (obj.type === 'l') {
      color = obj.color || '#000000'
      prim = { t: 'L', a: { x: obj.x1, y: obj.y1 }, b: { x: obj.x2, y: obj.y2 } }
    } else if (obj.type === 'c') {
      color = obj.color || '#000000'
      prim = {
        t: 'C',
        p0: { x: obj.x1, y: obj.y1 }, p1: { x: obj.x2, y: obj.y2 },
        p2: { x: obj.x3, y: obj.y3 }, p3: { x: obj.x4, y: obj.y4 },
      }
    } else {
      continue // fp / img / mbox are not vector toolpaths
    }
    const cat = categorize(color)
    if (cur && cur.category === cat && eq(cur.end, primStart(prim))) {
      cur.prims.push(prim)
      cur.end = primEnd(prim)
    } else {
      flush()
      cur = { category: cat, color, prims: [prim], start: primStart(prim), end: primEnd(prim) }
    }
  }
  flush()
  return paths
}

// Accumulate points into a bounding box. Pass a box (or null) and points.
function growBox(box, pts) {
  let { minX, minY, maxX, maxY } = box || { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

// Bounding box {minX,maxX,minY,maxY} of a set of paths (uses control points,
// which bound the bezier curves). Returns null if empty.
function bboxOfPaths(paths) {
  let box = null
  for (const path of paths) {
    for (const prim of path.prims) {
      box = growBox(box, prim.t === 'L' ? [prim.a, prim.b] : [prim.p0, prim.p1, prim.p2, prim.p3])
    }
  }
  return box && isFinite(box.minX) ? box : null
}

// Bounding box of a filled-path (fp) entry, from its M/L/C command coordinates.
function bboxOfFpPath(path, box = null) {
  for (const c of path) {
    if ('x'  in c) box = growBox(box, [{ x: c.x,  y: c.y  }])
    if ('x1' in c) box = growBox(box, [{ x: c.x1, y: c.y1 }])
    if ('x2' in c) box = growBox(box, [{ x: c.x2, y: c.y2 }])
  }
  return box
}

// Bounding box of a raster image entry (top-left corner at x,y; extends right
// and downward, where down is negative y).
function bboxOfImage(img) {
  return { minX: img.x, maxX: img.x + img.w, maxY: img.y, minY: img.y - img.h }
}

/**
 * Generate a horizontal back-and-forth (boustrophedon) raster path filling a
 * bounding box, with overscan margins on each side for accel/decel. Emitted as
 * one continuous engrave move (serpentine) preceded by a travel to its start.
 */
function rasterRegion(bbox, color, lastPos) {
  const x0 = bbox.minX - RASTER_OVERSCAN   // left turnaround (with overscan)
  const x1 = bbox.maxX + RASTER_OVERSCAN   // right turnaround
  const topY = bbox.maxY                   // y is negative downward → top = max
  const botY = bbox.minY
  const height = Math.max(0, topY - botY)

  let pitch = RASTER_PITCH
  let nRows = Math.floor(height / pitch) + 1
  if (nRows > RASTER_MAX_ROWS) { nRows = RASTER_MAX_ROWS; pitch = height / (nRows - 1) }

  // Serpentine: row left→right, step down, row right→left, step down, …
  const prims = []
  let ltr = true
  for (let i = 0; i < nRows; i++) {
    const y  = topY - i * pitch
    const sx = ltr ? x0 : x1
    const ex = ltr ? x1 : x0
    prims.push({ t: 'L', a: { x: sx, y }, b: { x: ex, y } })
    if (i < nRows - 1) {
      const ny = topY - (i + 1) * pitch
      prims.push({ t: 'L', a: { x: ex, y }, b: { x: ex, y: ny } }) // vertical step
    }
    ltr = !ltr
  }

  const moves = []
  const start = { x: x0, y: topY }
  if (dist(lastPos, start) > 0.1) {
    moves.push({ kind: 'travel', color: '#888888', a: { ...lastPos }, b: start })
  }
  // The full swept rectangle (content + accel/decel overscan on both sides) is
  // carried so the viewer can optionally draw the region as one filling block
  // that matches the extent of the serpentine scan lines.
  moves.push({
    kind: 'engrave', color, category: 'raster', prims,
    bbox: { minX: x0, maxX: x1, minY: botY, maxY: topY },
  })
  const end = prims.length ? primEnd(prims[prims.length - 1]) : start
  return { moves, end }
}

/**
 * Build the ordered machine toolpath.
 *
 * Phases run in machine order: raster engrave (green vectors + grayscale images,
 * each its own bounding-box region) → red vector engrave → blue cut → other.
 * The print head starts at the top-left corner.
 *
 * @param {Array} data       extraction objects (l / c / fp / img / mbox)
 * @param {Object} opts
 * @param {boolean} opts.optimize  nearest-neighbour optimise within each vector
 *                                  phase (mimics the printer's path optimiser).
 * @returns {{ moves: Array, stats: Object }}
 *   moves: ordered list of either
 *     { kind:'cut'|'engrave'|'other', color, category, prims }   (beam-on path)
 *     { kind:'travel', color, a, b }                             (rapid move)
 *   stats: { cutLen, engraveLen, otherLen, travelLen, totalTime } (mm / seconds)
 */
export function buildToolpath(data, { optimize = false } = {}) {
  const allPaths = reconstructPaths(data)
  const greenPaths  = allPaths.filter(p => p.category === 'green')
  const vectorPaths = allPaths.filter(p => p.category !== 'green')

  // Raster regions: one box around all green content (vectors + filled text),
  // one per grayscale image.
  const regions = []
  let greenBox = bboxOfPaths(greenPaths)
  for (const obj of data) {
    if (obj.type === 'fp' && isGreen(obj.fill)) greenBox = bboxOfFpPath(obj.path, greenBox)
  }
  if (greenBox && isFinite(greenBox.minX)) regions.push({ bbox: greenBox, color: RASTER_GREEN })
  for (const obj of data) {
    if (obj.type === 'img' && obj.colorspace === 1) {
      regions.push({ bbox: bboxOfImage(obj), color: RASTER_GRAY })
    }
  }

  const moves = []
  let lastPos = { x: 0, y: 0 } // print head starts at the top-left corner

  // ── Engrave phase 1: raster regions (green + grayscale) ────────────────────
  for (const region of regions) {
    const r = rasterRegion(region.bbox, region.color, lastPos)
    for (const m of r.moves) moves.push(m)
    lastPos = r.end
  }

  // ── Vector phases: red engrave, blue cut, other ───────────────────────────
  for (const cat of ['red', 'blue', 'other']) {
    let group = vectorPaths.filter(p => p.category === cat)
    if (group.length === 0) continue

    if (optimize) {
      // Greedy nearest-neighbour, considering both endpoints (allow reversal).
      const seq = []
      let nnPos = { ...lastPos }
      while (group.length) {
        let best = 0, minD = Infinity, reverse = false
        for (let i = 0; i < group.length; i++) {
          const ds = dist(nnPos, group[i].start)
          const de = dist(nnPos, group[i].end)
          if (ds < minD) { minD = ds; best = i; reverse = false }
          if (de < minD) { minD = de; best = i; reverse = true }
        }
        let cur = group.splice(best, 1)[0]
        if (reverse) cur = reversePath(cur)
        seq.push(cur)
        nnPos = cur.end
      }
      group = seq
    }
    // (unoptimised: keep file order)

    for (const p of group) {
      if (dist(lastPos, p.start) > 0.1) {
        moves.push({ kind: 'travel', color: '#888888', a: { ...lastPos }, b: { ...p.start } })
      }
      moves.push({ kind: kindOf(cat), color: p.color, category: cat, prims: p.prims })
      lastPos = p.end
    }
  }

  // Stats + time estimate.
  const stats = { cutLen: 0, engraveLen: 0, otherLen: 0, travelLen: 0, totalTime: 0 }
  for (const m of moves) {
    let L = 0
    if (m.kind === 'travel') L = dist(m.a, m.b)
    else for (const prim of m.prims) L += primLength(prim)

    if      (m.kind === 'travel')  stats.travelLen  += L
    else if (m.kind === 'cut')     stats.cutLen     += L
    else if (m.kind === 'engrave') stats.engraveLen += L
    else                           stats.otherLen   += L
    stats.totalTime += L / (SPEED_MM_S[m.kind] || SPEED_MM_S.other)
  }
  return { moves, stats }
}
