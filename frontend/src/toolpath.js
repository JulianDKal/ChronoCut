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

// Default head speeds (mm/s). Used as a FALLBACK when no printer/material profile
// is selected; otherwise buildToolpath receives resolved speeds via opts.speeds.
export const SPEED_MM_S = {
  engrave: 80,   // red vector engrave
  raster:  200,  // raster (green/grayscale) engrave
  cut:     30,   // blue layer
  other:   60,   // anything uncategorised
  travel: 250,   // rapid moves between paths (no beam)
}

// Raster (boustrophedon engraving) parameters — green and grayscale content is
// engraved by scanning horizontally back and forth over its bounding box.
const RASTER_PITCH    = 0.6   // mm between scan lines (vertical step)
const RASTER_OVERSCAN = 50    // mm of accel/decel space added on each side (5 cm)
const RASTER_MAX_ROWS = 1200  // safety cap (pitch grows if a region is huge)
const RASTER_GREEN    = '#00a000'  // colour of green-region scan lines
const RASTER_GRAY     = '#555555'  // colour of grayscale-image scan lines
const RASTER_SPLIT_GAP = 20   // mm — green raster groups farther apart than this get their own box

// Hand-removal heuristic: every closed cut contour is a part that must be picked
// out by hand, so what drives the extra handling time is the COUNT, not the size.
// The size filter is kept (tunable) but set effectively "off" so all parts count.
const SMALL_PART_MM = 1e6

// Grid-fall heuristic: a part this small (≈ 1.5 × 0.8 cm or less) can drop through
// the cutter's honeycomb/slat grid; retrieving it costs time. These get the
// separate "may fall through" warning and the optional viewer highlight.
const TINY_PART_W = 15   // mm — larger side
const TINY_PART_H = 8    // mm — shorter side

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

// Time (s) to traverse a path of length L at target speed v (mm/s) with finite
// acceleration a (mm/s²), assuming the head starts and ends at rest. With a<=0
// this is just constant-speed L/v. On short paths the head never reaches v
// (triangular profile); otherwise it's a trapezoid.
export function rampedTime(L, v, a) {
  if (!v || v <= 0 || L <= 0) return 0
  if (!a || a <= 0) return L / v
  const dAcc = (v * v) / (2 * a)          // distance to ramp 0→v
  if (2 * dAcc <= L) return 2 * (v / a) + (L - 2 * dAcc) / v   // trapezoid
  return 2 * Math.sqrt(L / a)             // triangle (peak < v)
}

// Direction change (between consecutive segments) sharper than this forces the
// head to a full stop — the velocity profile restarts from rest. Catches raster
// turnarounds (180°) and the vertical step between scan rows (90°), which is
// exactly where a real machine decelerates, stops and reverses.
const CORNER_COS = Math.cos((60 * Math.PI) / 180)   // > 60° turn ⇒ stop

// Speed (mm/s) at distance s along a run of length S that starts and ends at
// rest, with target speed v and acceleration a (trapezoid, or triangle when the
// run is too short to reach v).
function speedAt(s, S, v, a) {
  const dAcc = (v * v) / (2 * a)
  if (2 * dAcc <= S) {
    if (s < dAcc)     return Math.sqrt(2 * a * s)
    if (s > S - dAcc) return Math.sqrt(Math.max(0, 2 * a * (S - s)))
    return v
  }
  const half = S / 2
  return s <= half ? Math.sqrt(2 * a * s) : Math.sqrt(Math.max(0, 2 * a * (S - s)))
}

// Time (s) + average speed (mm/s) to traverse the sub-interval [s0,s1] of a run
// of length S that starts/ends at rest. Split at the trapezoid/triangle phase
// boundaries; within an accel/decel phase Δt = |Δv| / a, within cruise Δt = L/v.
function profileSeg(s0, s1, S, v, a) {
  const len = s1 - s0
  if (len <= 0) return { dt: 0, vavg: v }
  if (!a || a <= 0 || !v || v <= 0) return { dt: v > 0 ? len / v : 0, vavg: v }
  const dAcc = (v * v) / (2 * a)
  const bounds = 2 * dAcc <= S ? [dAcc, S - dAcc] : [S / 2]
  const pts = [s0]
  for (const b of bounds) if (b > s0 && b < s1) pts.push(b)
  pts.push(s1)
  let dt = 0
  for (let k = 0; k < pts.length - 1; k++) {
    const x0 = pts[k], x1 = pts[k + 1], xm = (x0 + x1) / 2
    const cruise = 2 * dAcc <= S && xm >= dAcc && xm <= S - dAcc
    if (cruise) dt += (x1 - x0) / v
    else dt += Math.abs(speedAt(x1, S, v, a) - speedAt(x0, S, v, a)) / a
  }
  return { dt, vavg: dt > 0 ? len / dt : v }
}

// Flatten a machine move into its traversed polyline (array of points).
export function movePolyline(m) {
  if (m.kind === 'travel') return [m.a, m.b]
  const pts = []
  for (const prim of m.prims) {
    const pp = flattenPrim(prim)
    if (pts.length) pts.push(...pp.slice(1))   // dedupe the shared join point
    else pts.push(...pp)
  }
  return pts
}

/**
 * Acceleration-aware per-segment timing for a polyline. The head starts and ends
 * at rest AND comes to rest at every sharp corner, so each raster scan line
 * accelerates from / decelerates to its turnaround. (Without this, a whole
 * serpentine is one constant-speed move and the acceleration value barely changes
 * the estimate — which is why accel "had no effect".)
 *
 * @returns {{ durs:number[], speeds:number[], total:number }}
 *   durs[i] / speeds[i] = duration (s) and average speed (mm/s) of segment i.
 */
export function rampSegments(points, v, a) {
  const n = points.length - 1
  if (n <= 0) return { durs: [], speeds: [], total: 0 }
  const segs = []
  for (let i = 0; i < n; i++) {
    const p = points[i], q = points[i + 1]
    const dx = q.x - p.x, dy = q.y - p.y
    const L = Math.hypot(dx, dy)
    segs.push({ L, ux: L > 1e-9 ? dx / L : 0, uy: L > 1e-9 ? dy / L : 0 })
  }
  // Mark vertices where the head must stop (run boundaries).
  const stop = new Array(n + 1).fill(false)
  stop[0] = true; stop[n] = true
  for (let i = 1; i < n; i++) {
    const a0 = segs[i - 1], a1 = segs[i]
    if (a0.L < 1e-9 || a1.L < 1e-9) { stop[i] = true; continue }
    if (a0.ux * a1.ux + a0.uy * a1.uy < CORNER_COS) stop[i] = true
  }
  const durs = new Array(n).fill(0)
  const speeds = new Array(n).fill(v)
  let total = 0
  for (let rs = 0; rs < n; ) {
    let re = rs + 1
    while (re < n && !stop[re]) re++          // run = segments [rs, re)
    let S = 0
    for (let k = rs; k < re; k++) S += segs[k].L
    let s0 = 0
    for (let k = rs; k < re; k++) {
      const s1 = s0 + segs[k].L
      const { dt, vavg } = profileSeg(s0, s1, S, v, a)
      durs[k] = dt; speeds[k] = vavg; total += dt
      s0 = s1
    }
    rs = re
  }
  return { durs, speeds, total }
}

/**
 * Annotate each segment of a polyline with its place in the velocity profile, so
 * the renderer can shade speed + reveal time PER FRAGMENT instead of subdividing
 * the geometry. The polyline keeps its natural tessellation (a straight line stays
 * one segment); the smooth ramp is reconstructed on the GPU from these numbers.
 *
 * @returns {Array<{ s0, s1, S, dur, runStartRel }>} one entry per segment:
 *   s0/s1       arc-length (mm) of the segment's endpoints within its run
 *   S           total length (mm) of the run (between two corner stops)
 *   dur         duration (s) of the segment under the acceleration profile
 *   runStartRel time (s) at the run's start, relative to the polyline start
 */
export function annotateRuns(points, v, a) {
  const n = points.length - 1
  const out = []
  if (n <= 0) return out

  const segL = []
  for (let i = 0; i < n; i++) {
    segL.push(Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y))
  }
  // Corner stops (same rule as rampSegments): the head rests at run boundaries.
  const stop = new Array(points.length).fill(false)
  stop[0] = true; stop[n] = true
  for (let i = 1; i < n; i++) {
    const ax = points[i].x - points[i - 1].x, ay = points[i].y - points[i - 1].y
    const bx = points[i + 1].x - points[i].x, by = points[i + 1].y - points[i].y
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by)
    if (la < 1e-9 || lb < 1e-9) { stop[i] = true; continue }
    if ((ax * bx + ay * by) / (la * lb) < CORNER_COS) stop[i] = true
  }

  let cumTime = 0   // relative to the polyline start
  for (let rs = 0; rs < n; ) {
    let re = rs + 1
    while (re < n && !stop[re]) re++          // run = segments [rs, re)
    let S = 0
    for (let k = rs; k < re; k++) S += segL[k]
    const runStartRel = cumTime
    let s0 = 0
    for (let k = rs; k < re; k++) {
      const s1 = s0 + segL[k]
      const { dt } = profileSeg(s0, s1, S, v, a)
      out[k] = { s0, s1, S, dur: dt, runStartRel }
      cumTime += dt
      s0 = s1
    }
    rs = re
  }
  return out
}

const GRAY_TOL = 0.12   // max channel spread for a colour to count as grayscale

export function categorize(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  if (b > 0.8 && r < 0.2) return 'blue'
  if (r > 0.8 && b < 0.2) return 'red'
  if (g > 0.5 && r < 0.4) return 'green'
  // grayscale (black / white / any gray) is raster-engraved, like a bitmap.
  if (Math.max(r, g, b) - Math.min(r, g, b) < GRAY_TOL) return 'gray'
  return 'other'
}

// Colours engraved as a raster (green fills + any grayscale content).
export const isGreen = (hex) => categorize(hex || '#000000') === 'green'
export const isGray  = (hex) => categorize(hex || '#000000') === 'gray'
export const isRasterColor = (hex) => { const c = categorize(hex || '#000000'); return c === 'green' || c === 'gray' }

// Map a colour category to a machine operation (drives speed + travel grouping).
export function kindOf(category) {
  if (category === 'blue')  return 'cut'
  if (category === 'other') return 'other'
  return 'engrave' // red, green, gray
}

// ── Edits (Fix Colors / Remove Doubles) ───────────────────────────────────────
// Both operate on the raw extraction object list and return new data so the
// caller can swap it in as the single source of truth (and export it).

// Canonical pure colours each near-colour snaps to.
const PURE_RED   = '#ff0000'
const PURE_BLUE  = '#0000ff'
const PURE_GREEN = '#00ff00'

/**
 * Snap near-pure colours to their canonical value, reusing the same
 * categorisation that drives cut/engrave routing:
 *   strokes (l/c)  almost-red  → #ff0000,  almost-blue → #0000ff
 *   fills   (fp)   almost-green → #00ff00
 * Everything else is left untouched. Returns a new array (shallow-copied items).
 */
export function fixColors(data) {
  // Only clone (i.e. "change") an object when the colour ACTUALLY differs from the
  // pure target — so re-running is idempotent and the changed-count is truthful
  // (a file that is already pure red/blue/green reports 0 fixed).
  return data.map((obj) => {
    if (obj.type === 'l' || obj.type === 'c') {
      const cat = categorize(obj.color || '#000000')
      if (cat === 'red')  return obj.color === PURE_RED  ? obj : { ...obj, color: PURE_RED }
      if (cat === 'blue') return obj.color === PURE_BLUE ? obj : { ...obj, color: PURE_BLUE }
    } else if (obj.type === 'fp') {
      if (isGreen(obj.fill)) return obj.fill === PURE_GREEN ? obj : { ...obj, fill: PURE_GREEN }
    }
    return obj
  })
}

// ── Remove Doubles (smart overlap removal) ────────────────────────────────────
// Detects red/blue stroke segments lying on top of one another — including
// PARTIAL overlaps — and removes the redundant coverage. Blue (cut) wins over
// red (engrave): wherever red overlaps blue, the red part is dropped because the
// cut already removes that material there. Returns { data, removed }:
//   data    — new object list with the redundant coverage gone
//   removed — line segments [{x1,y1,x2,y2}] that were removed (for highlighting)

const OVERLAP_EPS = 0.02   // mm — ignore sub-epsilon slivers

// ── 1D interval helpers (along a line) ────────────────────────────────────────
function mergeIv(list) {
  if (list.length === 0) return []
  const s = list.map(x => x.slice()).sort((a, b) => a[0] - b[0])
  const out = [s[0]]
  for (let i = 1; i < s.length; i++) {
    const last = out[out.length - 1]
    if (s[i][0] <= last[1] + 1e-7) last[1] = Math.max(last[1], s[i][1])
    else out.push(s[i])
  }
  return out
}
function subtractIv(A, B) {            // A, B merged → A minus B
  let segs = A.map(x => x.slice())
  for (const [b0, b1] of B) {
    const next = []
    for (const [a0, a1] of segs) {
      if (b1 <= a0 || b0 >= a1) { next.push([a0, a1]); continue }   // disjoint
      if (b0 > a0) next.push([a0, b0])
      if (b1 < a1) next.push([b1, a1])
    }
    segs = next
  }
  return segs.filter(([s, e]) => e - s > OVERLAP_EPS)
}
function intersectIv(A, B) {
  const out = []
  for (const [a0, a1] of A) for (const [b0, b1] of B) {
    const s = Math.max(a0, b0), e = Math.min(a1, b1)
    if (e - s > OVERLAP_EPS) out.push([s, e])
  }
  return mergeIv(out)
}
function doubledIv(list) {             // regions covered by ≥2 of the raw intervals
  const ev = []
  for (const [s, e] of list) { ev.push([s, 1]); ev.push([e, -1]) }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out = []; let cov = 0, start = 0
  for (const [x, d] of ev) {
    const prev = cov; cov += d
    if (prev < 2 && cov >= 2) start = x
    else if (prev >= 2 && cov < 2 && x - start > OVERLAP_EPS) out.push([start, x])
  }
  return out
}

// Cluster line segments that lie on the same infinite line, robustly. Hard
// quantisation buckets split collinear lines that straddle a grid boundary
// (a common cause of "partial overlap not detected"); instead we cluster by
// ADJACENCY — first by undirected angle, then by perpendicular offset — so
// near-identical lines always end up together.
//
// Each returned group has: a representative direction u=(ux,uy), normal
// n=(nx,ny), offset c, and the blue/red interval lists along the line. A point
// at parameter t reconstructs as  t*u + c*n.
const ANGLE_TOL = 0.012   // rad ≈ 0.7°
const C_TOL     = 0.08    // mm perpendicular distance

function clusterLines(segs) {
  const items = segs.map(s => {
    let a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1)   // undirected angle in [0, π)
    if (a < 0) a += Math.PI
    if (a >= Math.PI) a -= Math.PI
    return { s, a }
  })
  items.sort((p, q) => p.a - q.a)

  // 1) cluster by angle (adjacency)
  const angClusters = []
  let cur = []
  for (const it of items) {
    if (cur.length && it.a - cur[cur.length - 1].a > ANGLE_TOL) { angClusters.push(cur); cur = [] }
    cur.push(it)
  }
  if (cur.length) angClusters.push(cur)
  // merge near-horizontal lines split across the 0 / π wrap
  if (angClusters.length > 1) {
    const first = angClusters[0], last = angClusters[angClusters.length - 1]
    if (first[0].a <= ANGLE_TOL && Math.PI - last[last.length - 1].a <= ANGLE_TOL) {
      angClusters[0] = last.concat(first)
      angClusters.pop()
    }
  }

  const groups = []
  for (const cl of angClusters) {
    // representative direction via doubled-angle averaging (no up/down ambiguity)
    let s2 = 0, c2 = 0
    for (const it of cl) { s2 += Math.sin(2 * it.a); c2 += Math.cos(2 * it.a) }
    const arep = Math.atan2(s2, c2) / 2
    const ux = Math.cos(arep), uy = Math.sin(arep)
    const nx = -uy, ny = ux
    const arr = cl.map(it => {
      const s = it.s
      const ta = ux * s.x1 + uy * s.y1, tb = ux * s.x2 + uy * s.y2
      return { s, c: nx * s.x1 + ny * s.y1, iv: [Math.min(ta, tb), Math.max(ta, tb)] }
    })
    arr.sort((p, q) => p.c - q.c)
    // 2) sub-cluster by perpendicular offset
    let sub = []
    const flush = () => {
      if (!sub.length) return
      const g = { ux, uy, nx, ny, c: 0, blue: [], red: [], blueColor: null, redColor: null }
      let cSum = 0
      for (const e of sub) {
        cSum += e.c
        if (e.s.cat === 'blue') { g.blue.push(e.iv); g.blueColor ??= e.s.color }
        else                    { g.red.push(e.iv);  g.redColor  ??= e.s.color }
      }
      g.c = cSum / sub.length
      groups.push(g)
      sub = []
    }
    for (const e of arr) {
      if (sub.length && e.c - sub[sub.length - 1].c > C_TOL) flush()
      sub.push(e)
    }
    flush()
  }
  return groups
}

function curveGeom(o) {
  const q = (v) => Math.round(v / 0.05)
  const fwd = [o.x1, o.y1, o.x2, o.y2, o.x3, o.y3, o.x4, o.y4].map(q).join(',')
  const rev = [o.x4, o.y4, o.x3, o.y3, o.x2, o.y2, o.x1, o.y1].map(q).join(',')
  return fwd < rev ? fwd : rev
}
function curveSegs(o) {
  const pts = flattenPrim({ t: 'C', p0: { x: o.x1, y: o.y1 }, p1: { x: o.x2, y: o.y2 },
                            p2: { x: o.x3, y: o.y3 }, p3: { x: o.x4, y: o.y4 } })
  const segs = []
  for (let i = 0; i < pts.length - 1; i++) {
    segs.push({ x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y })
  }
  return segs
}

/**
 * Smart double removal. See header above.
 * @returns {{ data: Array, removed: Array<{x1,y1,x2,y2}> }}
 */
export function computeDoubleRemoval(data) {
  const out = []        // resulting objects (kept geometry)
  const removed = []    // removed pieces, as line segments (for highlight)

  // ── Lines: cluster red/blue 'l' segments onto shared infinite lines ───────
  const segs = []
  for (const o of data) {
    let cat
    if (o.type === 'l' && ((cat = categorize(o.color || '#000000')) === 'red' || cat === 'blue')) {
      if (Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 1e-9) continue   // zero-length → drop
      segs.push({ cat, color: o.color, x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2 })
    } else {
      out.push(o)                             // non red/blue lines pass straight through
    }
  }

  const ptOf = (g, t) => ({ x: t * g.ux + g.c * g.nx, y: t * g.uy + g.c * g.ny })
  const emit = (g, ivls, color, sink) => {
    for (const [t0, t1] of ivls) {
      if (t1 - t0 <= OVERLAP_EPS) continue
      const a = ptOf(g, t0), b = ptOf(g, t1)
      if (sink === 'removed') removed.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })
      else out.push({ type: 'l', x1: a.x, y1: a.y, x2: b.x, y2: b.y, color })
    }
  }

  for (const g of clusterLines(segs)) {
    const blueU = mergeIv(g.blue)
    const redU  = mergeIv(g.red)
    const outRed = subtractIv(redU, blueU)          // red minus blue coverage
    emit(g, blueU,  g.blueColor || '#0000ff', 'out')
    emit(g, outRed, g.redColor  || '#ff0000', 'out')
    // Highlight what disappeared: blue self-overlap, plus red-under-blue and red self-overlap.
    emit(g, doubledIv(g.blue), g.blueColor, 'removed')
    const redKilled = mergeIv([...intersectIv(redU, blueU), ...doubledIv(g.red)])
    emit(g, redKilled, g.redColor, 'removed')
  }

  // ── Curves: exact-duplicate removal (+ red curve under an identical blue) ──
  const blueCurveGeom = new Set()
  for (const o of out) {
    if (o.type === 'c' && categorize(o.color || '#000000') === 'blue') blueCurveGeom.add(curveGeom(o))
  }
  const keptCurve = new Set()
  const finalOut = []
  for (const o of out) {
    if (o.type === 'c') {
      const cat = categorize(o.color || '#000000')
      if (cat === 'red' || cat === 'blue') {
        const g = curveGeom(o)
        const drop = (cat === 'red' && blueCurveGeom.has(g)) || keptCurve.has(`${cat}:${g}`)
        if (drop) { for (const s of curveSegs(o)) removed.push(s); continue }
        keptCurve.add(`${cat}:${g}`)
      }
    }
    finalOut.push(o)
  }

  return {
    data: finalOut,
    removed: removed.filter(s => Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > OVERLAP_EPS),
  }
}

// ── Remove white (watermark cleanup) ──────────────────────────────────────────
// Drop near-white strokes (l/c) and fills (fp). White = nothing on a laser, so
// these are almost always watermarks/artefacts.
const WHITE_LUM = 0.95   // luminance above which a colour counts as "(near-)white"

function hexLum(hex) {
  const c = hex || '#000000'
  return 0.299 * parseInt(c.slice(1, 3), 16) / 255
       + 0.587 * parseInt(c.slice(3, 5), 16) / 255
       + 0.114 * parseInt(c.slice(5, 7), 16) / 255
}

export function removeWhite(data, lumThreshold = WHITE_LUM) {
  return data.filter((o) => {
    if (o.type === 'l' || o.type === 'c') return hexLum(o.color) <= lumThreshold
    if (o.type === 'fp') return hexLum(o.fill) <= lumThreshold
    return true
  })
}

// ── Detect helpers (preview highlight for Fix Colors / Remove White) ──────────
// Return { count, segs } where segs are line segments [{x1,y1,x2,y2}] of the
// elements that WOULD change — mirroring computeDoubleRemoval's `removed`, so the
// viewer can highlight them before the edit is applied.
function strokeSegs(o) {
  if (o.type === 'l') return [{ x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2 }]
  const pts = flattenPrim({ t: 'C', p0: { x: o.x1, y: o.y1 }, p1: { x: o.x2, y: o.y2 },
                            p2: { x: o.x3, y: o.y3 }, p3: { x: o.x4, y: o.y4 } })
  const segs = []
  for (let i = 0; i < pts.length - 1; i++) segs.push({ x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y })
  return segs
}

function fpSegs(path) {
  const segs = []
  let cx = 0, cy = 0, sx = 0, sy = 0
  for (const c of path) {
    if (c.cmd === 'M') { cx = c.x; cy = c.y; sx = cx; sy = cy }
    else if (c.cmd === 'L') { segs.push({ x1: cx, y1: cy, x2: c.x, y2: c.y }); cx = c.x; cy = c.y }
    else if (c.cmd === 'C') {
      const pts = flattenPrim({ t: 'C', p0: { x: cx, y: cy }, p1: { x: c.x1, y: c.y1 },
                                p2: { x: c.x2, y: c.y2 }, p3: { x: c.x, y: c.y } })
      for (let i = 0; i < pts.length - 1; i++) segs.push({ x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y })
      cx = c.x; cy = c.y
    } else if (c.cmd === 'Z') { segs.push({ x1: cx, y1: cy, x2: sx, y2: sy }); cx = sx; cy = sy }
  }
  return segs
}

export function detectFixColors(data) {
  let count = 0
  const segs = []
  for (const o of data) {
    if (o.type === 'l' || o.type === 'c') {
      const cat = categorize(o.color || '#000000')
      const target = cat === 'red' ? PURE_RED : cat === 'blue' ? PURE_BLUE : null
      if (target && o.color !== target) { count++; segs.push(...strokeSegs(o)) }
    } else if (o.type === 'fp' && isGreen(o.fill) && o.fill !== PURE_GREEN) {
      count++; segs.push(...fpSegs(o.path))
    }
  }
  return { count, segs }
}

export function detectRemoveWhite(data, lumThreshold = WHITE_LUM) {
  let count = 0
  const segs = []
  for (const o of data) {
    if ((o.type === 'l' || o.type === 'c') && hexLum(o.color) > lumThreshold) { count++; segs.push(...strokeSegs(o)) }
    else if (o.type === 'fp' && hexLum(o.fill) > lumThreshold) { count++; segs.push(...fpSegs(o.path)) }
  }
  return { count, segs }
}

// ── Rotate the whole design 90° ───────────────────────────────────────────────
// dir: 'ccw' (rotate left) | 'cw' (rotate right). After rotating, the content is
// re-anchored so its top-left corner sits back at (0,0) (x ≥ 0, y ≤ 0).
function translateObj(o, dx, dy) {
  if (o.type === 'l') return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy }
  if (o.type === 'c') return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy,
                                     x3: o.x3 + dx, y3: o.y3 + dy, x4: o.x4 + dx, y4: o.y4 + dy }
  if (o.type === 'fp') return { ...o, path: o.path.map((cmd) => {
    const n = { ...cmd }
    if ('x'  in cmd) { n.x  = cmd.x  + dx; n.y  = cmd.y  + dy }
    if ('x1' in cmd) { n.x1 = cmd.x1 + dx; n.y1 = cmd.y1 + dy }
    if ('x2' in cmd) { n.x2 = cmd.x2 + dx; n.y2 = cmd.y2 + dy }
    return n
  }) }
  if (o.type === 'img') return { ...o, x: o.x + dx, y: o.y + dy }
  return { ...o }
}

export function rotateData(data, dir = 'cw') {
  const R = dir === 'ccw' ? (x, y) => [-y, x]   // 90° counter-clockwise (left)
                          : (x, y) => [y, -x]   // 90° clockwise (right)
  let minX = Infinity, maxY = -Infinity
  const grow = (x, y) => { if (x < minX) minX = x; if (y > maxY) maxY = y }

  const tmp = data.map((o) => {
    if (o.type === 'l') {
      const a = R(o.x1, o.y1), b = R(o.x2, o.y2)
      grow(a[0], a[1]); grow(b[0], b[1])
      return { ...o, x1: a[0], y1: a[1], x2: b[0], y2: b[1] }
    }
    if (o.type === 'c') {
      const a = R(o.x1, o.y1), b = R(o.x2, o.y2), c = R(o.x3, o.y3), d = R(o.x4, o.y4)
      grow(a[0], a[1]); grow(b[0], b[1]); grow(c[0], c[1]); grow(d[0], d[1])
      return { ...o, x1: a[0], y1: a[1], x2: b[0], y2: b[1], x3: c[0], y3: c[1], x4: d[0], y4: d[1] }
    }
    if (o.type === 'fp') {
      const path = o.path.map((cmd) => {
        const n = { ...cmd }
        if ('x'  in cmd) { const p = R(cmd.x,  cmd.y);  n.x  = p[0]; n.y  = p[1]; grow(p[0], p[1]) }
        if ('x1' in cmd) { const p = R(cmd.x1, cmd.y1); n.x1 = p[0]; n.y1 = p[1]; grow(p[0], p[1]) }
        if ('x2' in cmd) { const p = R(cmd.x2, cmd.y2); n.x2 = p[0]; n.y2 = p[1]; grow(p[0], p[1]) }
        return n
      })
      return { ...o, path }
    }
    if (o.type === 'img') {
      const corners = [R(o.x, o.y), R(o.x + o.w, o.y), R(o.x, o.y - o.h), R(o.x + o.w, o.y - o.h)]
      let cx0 = Infinity, cx1 = -Infinity, cy0 = Infinity, cy1 = -Infinity
      for (const [x, y] of corners) { if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y }
      grow(cx0, cy0); grow(cx1, cy1)
      const step = dir === 'ccw' ? 90 : -90
      const rot = (((o.rot || 0) + step) % 360 + 360) % 360
      return { ...o, x: cx0, y: cy1, w: cx1 - cx0, h: cy1 - cy0, rot }   // top-left = (minX, maxY)
    }
    if (o.type === 'mbox') return { ...o, w: o.h, h: o.w }
    return { ...o }
  })

  const dx = isFinite(minX) ? -minX : 0
  const dy = isFinite(maxY) ? -maxY : 0
  return (dx === 0 && dy === 0) ? tmp : tmp.map((o) => translateObj(o, dx, dy))
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
// primitive. Primitives link by matching ENDPOINTS (a spatial lookup), not by
// sitting next to each other in the array — so reconstruction is independent of
// item order. This matters because edits like Remove Doubles rebuild the line
// list grouped by shared direction/offset (not by connectivity), which used to
// shatter closed polygons into unclosed fragments and silently zero out the
// small-/tiny-part warnings. Order-independent linking fixes that for any
// edit or extraction order.
const LINK_TOL = 0.01   // mm — matches the old adjacency tolerance

function reconstructPaths(data) {
  const prims = []
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
    prims.push({ cat, color, prim, start: primStart(prim), end: primEnd(prim) })
  }

  const n = prims.length
  const used = new Array(n).fill(false)

  // Spatial index: bucket key (category + quantised point) -> endpoints there.
  // Query checks the 3×3 neighbourhood so points straddling a bucket edge
  // within LINK_TOL still match.
  const bucketKey = (cat, x, y) => `${cat}|${Math.round(x / LINK_TOL)}|${Math.round(y / LINK_TOL)}`
  const index = new Map()
  const addEntry = (idx, which) => {
    const pt = which === 'start' ? prims[idx].start : prims[idx].end
    const k = bucketKey(prims[idx].cat, pt.x, pt.y)
    if (!index.has(k)) index.set(k, [])
    index.get(k).push({ idx, which })
  }
  for (let i = 0; i < n; i++) { addEntry(i, 'start'); addEntry(i, 'end') }

  const findMatch = (cat, x, y) => {
    const bx = Math.round(x / LINK_TOL), by = Math.round(y / LINK_TOL)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = index.get(`${cat}|${bx + dx}|${by + dy}`)
        if (!list) continue
        for (const e of list) {
          if (used[e.idx]) continue
          const pt = e.which === 'start' ? prims[e.idx].start : prims[e.idx].end
          if (Math.abs(pt.x - x) < LINK_TOL && Math.abs(pt.y - y) < LINK_TOL) return e
        }
      }
    }
    return null
  }
  const closes = (a, b) => Math.abs(a.x - b.x) < LINK_TOL && Math.abs(a.y - b.y) < LINK_TOL

  const paths = []
  for (let i = 0; i < n; i++) {
    if (used[i]) continue
    used[i] = true
    const seed = prims[i]
    const chain = [seed.prim]
    const cat = seed.cat, color = seed.color
    let head = seed.start, tail = seed.end

    // Extend forward from the tail (next primitive's start must meet our tail).
    for (;;) {
      const m = findMatch(cat, tail.x, tail.y)
      if (!m) break
      used[m.idx] = true
      let next = prims[m.idx].prim
      if (m.which === 'end') next = reversePrim(next)   // orient so its start == tail
      chain.push(next)
      tail = primEnd(next)
      if (closes(tail, head)) break                     // loop closed
    }
    // Extend backward from the head (only if not already closed into a loop).
    if (!closes(tail, head)) {
      for (;;) {
        const m = findMatch(cat, head.x, head.y)
        if (!m) break
        used[m.idx] = true
        let prev = prims[m.idx].prim
        if (m.which === 'start') prev = reversePrim(prev)   // orient so its end == head
        chain.unshift(prev)
        head = primStart(prev)
        if (closes(tail, head)) break
      }
    }
    paths.push({ category: cat, color, prims: chain, start: head, end: tail })
  }
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

// Single-linkage cluster a list of bounding boxes: boxes whose nearest gap is
// <= `gap` end up in the same cluster; clusters farther apart than `gap` stay
// separate. Returns one merged bbox per cluster. Chains count (A near B, B near C
// → one cluster) so contiguous content stays together but a real empty band splits.
function clusterBoxes(boxes, gap) {
  const n = boxes.length
  if (n <= 1) return boxes.slice()
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const near = (a, b) => {
    const gx = Math.max(b.minX - a.maxX, a.minX - b.maxX, 0)
    const gy = Math.max(b.minY - a.maxY, a.minY - b.maxY, 0)
    return Math.hypot(gx, gy) <= gap
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (find(i) !== find(j) && near(boxes[i], boxes[j])) parent[find(i)] = find(j)
    }
  }
  const merged = new Map()
  for (let i = 0; i < n; i++) {
    const r = find(i), b = boxes[i], m = merged.get(r)
    if (m) {
      m.minX = Math.min(m.minX, b.minX); m.minY = Math.min(m.minY, b.minY)
      m.maxX = Math.max(m.maxX, b.maxX); m.maxY = Math.max(m.maxY, b.maxY)
    } else merged.set(r, { ...b })
  }
  return [...merged.values()]
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
function rasterRegion(bbox, color, lastPos, basePitch = RASTER_PITCH) {
  const x0 = bbox.minX - RASTER_OVERSCAN   // left turnaround (with overscan)
  const x1 = bbox.maxX + RASTER_OVERSCAN   // right turnaround
  const topY = bbox.maxY                   // y is negative downward → top = max
  const botY = bbox.minY
  const height = Math.max(0, topY - botY)

  let pitch = basePitch || RASTER_PITCH
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
export function buildToolpath(data, { optimize = false, speeds = SPEED_MM_S, rasterPitch = RASTER_PITCH, accel = 0 } = {}) {
  // Resolve the head speed (mm/s) for a move, with raster getting its own speed.
  const speedFor = (m) => {
    const s = m.category === 'raster' ? (speeds.raster ?? speeds.engrave) : speeds[m.kind]
    return s || speeds.other || SPEED_MM_S.other
  }
  const allPaths = reconstructPaths(data)
  const rasterPaths = allPaths.filter(p => p.category === 'green' || p.category === 'gray')
  const vectorPaths = allPaths.filter(p => p.category !== 'green' && p.category !== 'gray')

  // Raster regions: ALL raster content — green + grayscale vectors/fills AND
  // grayscale bitmaps — is collected as PER-ELEMENT boxes and clustered by
  // proximity. So nearby content shares one raster box (bitmaps are NOT rastered
  // one-by-one) and groups farther apart than RASTER_SPLIT_GAP get their own box.
  const regions = []
  const rasterBoxes = []
  const pushBox = (b, color) => { if (b && isFinite(b.minX)) rasterBoxes.push({ ...b, color }) }
  for (const p of rasterPaths) pushBox(bboxOfPaths([p]), p.category === 'green' ? RASTER_GREEN : RASTER_GRAY)
  for (const obj of data) {
    if (obj.type === 'fp' && isRasterColor(obj.fill)) pushBox(bboxOfFpPath(obj.path), isGreen(obj.fill) ? RASTER_GREEN : RASTER_GRAY)
    else if (obj.type === 'img' && obj.colorspace === 1) pushBox(bboxOfImage(obj), RASTER_GRAY)
  }
  for (const c of clusterBoxes(rasterBoxes, RASTER_SPLIT_GAP)) regions.push({ bbox: c, color: c.color })

  const moves = []
  let lastPos = { x: 0, y: 0 } // print head starts at the top-left corner

  // ── Engrave phase 1: raster regions (green + grayscale) ────────────────────
  for (const region of regions) {
    const r = rasterRegion(region.bbox, region.color, lastPos, rasterPitch)
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

  // Return the head to the home corner (top-left, 0,0) at the end of the job.
  if (dist(lastPos, { x: 0, y: 0 }) > 0.1) {
    moves.push({ kind: 'travel', color: '#888888', a: { ...lastPos }, b: { x: 0, y: 0 } })
    lastPos = { x: 0, y: 0 }
  }

  // Stats + time estimate. Length AND time are tracked per operation type, with
  // raster engrave (green/grayscale serpentine) split out from vector engrave
  // (red) so the UI can break the total down by operation.
  const stats = {
    cutLen: 0, cutTime: 0, engraveLen: 0, engraveTime: 0, rasterLen: 0, rasterTime: 0,
    otherLen: 0, otherTime: 0, travelLen: 0, travelTime: 0, totalTime: 0,
    smallParts: 0, tinyParts: 0,
  }

  // Cut-out parts (closed blue contours). Easy to forget when judging a job: each
  // must be removed by hand (→ smallParts, drives handling time), and very small
  // ones can drop through the bed grid and need retrieving (→ tinyParts, with
  // their boxes returned so the viewer can highlight them on demand).
  const tinyBoxes = []
  for (const p of vectorPaths) {
    if (p.category !== 'blue') continue
    if (Math.hypot(p.start.x - p.end.x, p.start.y - p.end.y) > 0.5) continue   // open → not a part
    const box = bboxOfPaths([p])
    if (!box) continue
    const w = box.maxX - box.minX, h = box.maxY - box.minY
    if (Math.max(w, h) <= SMALL_PART_MM) stats.smallParts++
    if (Math.max(w, h) <= TINY_PART_W && Math.min(w, h) <= TINY_PART_H) {
      stats.tinyParts++
      tinyBoxes.push(box)
    }
  }
  for (const m of moves) {
    let L = 0
    if (m.kind === 'travel') L = dist(m.a, m.b)
    else for (const prim of m.prims) L += primLength(prim)
    // Acceleration-aware: ramps at every corner (each scan-line turnaround), so
    // the printer's accel value actually drives the estimate.
    const T = rampSegments(movePolyline(m), speedFor(m), accel).total

    if      (m.kind === 'travel')     { stats.travelLen  += L; stats.travelTime  += T }
    else if (m.kind === 'cut')        { stats.cutLen     += L; stats.cutTime     += T }
    else if (m.category === 'raster') { stats.rasterLen  += L; stats.rasterTime  += T }
    else if (m.kind === 'engrave')    { stats.engraveLen += L; stats.engraveTime += T }
    else                              { stats.otherLen   += L; stats.otherTime   += T }
    stats.totalTime += T
  }
  return { moves, stats, tinyBoxes }
}
