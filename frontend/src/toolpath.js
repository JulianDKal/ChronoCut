// Machine toolpath construction.
//
// Mirrors the ordering logic of the old PyQt program (Reference/old version of
// the program.py, AnalysisThread.run): classify paths by colour, run the
// engrave phase before the cut phase, optionally nearest-neighbour optimise the
// order within each phase, and insert travel ("Leerwege") moves between paths.
//
import { CALIBRATION } from './calibration'

// Geometry is kept as PRIMITIVES - a path is a list of line ('L') and cubic
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

// Raster (boustrophedon engraving) parameters - green and grayscale content is
// engraved by scanning horizontally back and forth over its bounding box.
const RASTER_PITCH    = 0.6   // mm between scan lines (vertical step) - fallback only
// Overscan is NOT a fixed distance: it is the turnaround run-out, so it grows
// with the SQUARE of the raster speed (~0,9 mm per side at 20 %, ~22 mm at
// 100 %). rasterOverscanFor() derives it; see calibration.js.
const RASTER_MAX_ROWS = 20000 // safety cap. Was 1200, which silently capped every
                              // region taller than ~50 mm at 600 dpi (pitch grew,
                              // rows dropped) and made the estimate far too fast.
const RASTER_GREEN    = '#00a000'  // colour of green-region scan lines
// Marker colour for grayscale-image (bitmap) scan lines - NOT the actual
// rendered colour. A fixed hex can't be right in both themes (white vanishes
// on the light theme's white bed), so the viewer swaps this for a real
// per-theme colour (white on dark, dark gray on light) at render time. Kept
// exported so ThreeViewer.vue can recognise it; picked memorably far from any
// real ink colour so it's never confused with genuine content.
export const RASTER_BITMAP_MARK = '#fffffe'
const RASTER_GRAY = RASTER_BITMAP_MARK

// Hand-removal heuristic: every closed cut contour is a part that must be picked
// out by hand, so what drives the extra handling time is the COUNT, not the size.
// The size filter is kept (tunable) but set effectively "off" so all parts count.
const SMALL_PART_MM = 1e6

// Grid-fall heuristic: a part this small (≈ 1.5 × 0.8 cm or less) can drop through
// the cutter's honeycomb/slat grid; retrieving it costs time. These get the
// separate "may fall through" warning and the optional viewer highlight.
const TINY_PART_W = 15   // mm - larger side
const TINY_PART_H = 8    // mm, shorter side

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

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
// head to a full stop - the velocity profile restarts from rest. Catches raster
// turnarounds (180°) and the vertical step between scan rows (90°), which is
// exactly where a real machine decelerates, stops and reverses.
//
// MEASURED (see calibration.js): the threshold is ~28°, not 60°. The angle
// series 45–49 varies ONLY the bend angle at constant length and corner count:
// 8°/14°/20°/26° all cost 139 s optimised, 32° jumps to 154 s. A 12-sided
// polygon (30° corners) is charged full corner cost, a 48-gon (7.5°) is not.
const CORNER_COS = Math.cos((CALIBRATION.cornerAngleDeg * Math.PI) / 180)

// Extra time (s) per full stop, on top of the kinematic v/a ramp. Applied at
// every interior corner of a run.
const CORNER_PENALTY = CALIBRATION.cornerPenalty

// Raster and vector run on DIFFERENT acceleration regimes: the calibrated raster
// line overhead already contains the whole turnaround, so raster scan lines are
// modelled at constant speed (a = 0) to avoid charging the ramp twice.
export const accelFor = (m, accel) => (m.category === 'raster' ? 0 : accel)

// Same reasoning for the per-stop penalty: a scan row's turnaround is already
// paid for by the overscan run-out plus the per-line overhead, so charging
// CORNER_PENALTY again at each row end (2 per row) would double-count it -
// worth ~80 s on an 80 mm tall region at 600 dpi.
export const cornerPenaltyFor = (m) => (m.category === 'raster' ? 0 : CORNER_PENALTY)

// Extra time (s) charged on a move beyond the traversal of its own geometry:
//   travel - the fixed cost of starting the next vector;
//   raster - the SPEED-INDEPENDENT part of the per-scan-line overhead plus the
//            Y feed, once per scan row (m.rows). The speed-DEPENDENT part is
//            carried by the geometry instead, as overscan (see below).
export const moveExtraTime = (m) => {
  if (m.kind === 'travel') return m.home ? 0 : CALIBRATION.vectorStartPenalty   // home leg starts no vector
  if (m.category === 'raster' && m.rows) {
    return m.rows * (CALIBRATION.rasterLineBase + CALIBRATION.rasterYFeed * m.pitch)
  }
  return 0
}

// Overscan per side: the run-out the head needs to turn around at the end of a
// scan row. This is the part of the per-line overhead that scales with the
// raster speed - charging it as DISTANCE (rather than as time) keeps the drawn
// geometry and the estimate consistent: 2*over/v is exactly rasterLineRamp*v.
// The fixed part of the overhead stays a time and is added in moveExtraTime;
// folding it into the distance too (as this did before 60–100 % were measured)
// would draw >100 mm of overscan per side at 100 % raster speed.
function rasterOverscanFor(speed) {
  return (CALIBRATION.rasterLineRamp * speed * speed) / 2
}

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
 * the estimate - which is why accel "had no effect".)
 *
 * @returns {{ durs:number[], speeds:number[], total:number }}
 *   durs[i] / speeds[i] = duration (s) and average speed (mm/s) of segment i.
 */
export function rampSegments(points, v, a, cornerPenalty = CORNER_PENALTY) {
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
      // Charge the stop that STARTS this run (every run but the first).
      const pen = (k === rs && rs > 0) ? cornerPenalty : 0
      durs[k] = dt + pen; speeds[k] = vavg; total += dt + pen
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
export function annotateRuns(points, v, a, cornerPenalty = CORNER_PENALTY) {
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
    cumTime += (rs > 0 ? cornerPenalty : 0)   // stop that starts this run
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
  // pure target - so re-running is idempotent and the changed-count is truthful
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

// ── Remove Doubles (overlap removal) ──────────────────────────────────────────
// Removes redundant coverage where strokes lie on top of one another:
//   • same colour, exactly or partially on top → keep ONE copy
//   • red on top of blue                       → the red part goes (the cut
//                                                 already removes that material)
// Works on the REAL geometry: straight segments stay segments and beziers stay
// beziers (trimmed with de Casteljau), so nothing is degraded to the polyline
// the viewer happens to draw.
//
// Two properties matter and are guaranteed by construction:
//   1. A primitive that survives untouched is emitted from its OWN coordinates,
//      never rebuilt from a group average - so unaffected geometry is bit-identical
//      and closed contours keep closing.
//   2. Grouping compares every member against a fixed group REPRESENTATIVE, not
//      against its neighbour. Neighbour-chaining used to let hundreds of lines at
//      wildly different angles collapse into one "collinear" group.
//
// Returns { data, removed } - removed carries the dropped pieces as line segments
// for the viewer's highlight.

const OVERLAP_EPS = 0.02    // mm - ignore sub-epsilon slivers
const ANGLE_TOL   = 0.012   // rad ≈ 0.7°, max tilt against the group representative
const C_TOL       = 0.08    // mm, max perpendicular distance from the representative
const CURVE_TOL   = 0.05    // mm, how close two beziers must run to count as one

// ── 1D interval helpers ───────────────────────────────────────────────────────
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
function subtractIv(A, B) {            // A minus B (both merged)
  let segs = A.map(x => x.slice())
  for (const [b0, b1] of B) {
    const next = []
    for (const [a0, a1] of segs) {
      if (b1 <= a0 || b0 >= a1) { next.push([a0, a1]); continue }
      if (b0 > a0) next.push([a0, b0])
      if (b1 < a1) next.push([b1, a1])
    }
    segs = next
  }
  return segs
}

// ── Grouping of collinear straight segments ───────────────────────────────────
// Spatial hash on (angle, perpendicular offset). Membership is decided against
// the group's representative, which bounds a group's spread to the tolerance.
const angDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, Math.PI - d) }

function groupCollinear(segs) {
  const groups = []
  const index = new Map()                       // bucket -> group indices
  for (const s of segs) {
    let a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1)
    if (a < 0) a += Math.PI
    if (a >= Math.PI) a -= Math.PI
    const mx = (s.x1 + s.x2) / 2, my = (s.y1 + s.y2) / 2
    // Bucket with a canonical (group-independent) normal so the hash is stable.
    const ka = Math.round(a / ANGLE_TOL)
    const ca = ka * ANGLE_TOL
    const cOf = (ang, x, y) => -Math.sin(ang) * x + Math.cos(ang) * y
    const kc = Math.round(cOf(ca, mx, my) / C_TOL)

    let g = null
    outer:
    for (let da = -1; da <= 1 && !g; da++) {
      for (let dc = -1; dc <= 1; dc++) {
        const list = index.get(`${ka + da}|${kc + dc}`)
        if (!list) continue
        for (const gi of list) {
          const cand = groups[gi]
          if (angDist(a, cand.a) > ANGLE_TOL) continue
          if (Math.abs(cOf(cand.a, mx, my) - cand.c) > C_TOL) continue
          g = cand
          break outer
        }
      }
    }
    if (!g) {
      g = { a, c: cOf(a, mx, my), ux: Math.cos(a), uy: Math.sin(a), items: [] }
      groups.push(g)
      const key = `${ka}|${kc}`
      if (!index.has(key)) index.set(key, [])
      index.get(key).push(groups.length - 1)
    }
    // Project onto the group's axis; keep the ORIGINAL endpoints for emitting.
    const t1 = g.ux * s.x1 + g.uy * s.y1
    const t2 = g.ux * s.x2 + g.uy * s.y2
    g.items.push({ s, lo: Math.min(t1, t2), hi: Math.max(t1, t2), flip: t2 < t1 })
  }
  return groups
}

// ── Bezier helpers ────────────────────────────────────────────────────────────
const lerpP = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

function bezSplitRight(p, t) {                  // control points of [t,1]
  const a = lerpP(p[0], p[1], t), b = lerpP(p[1], p[2], t), c = lerpP(p[2], p[3], t)
  const d = lerpP(a, b, t), e = lerpP(b, c, t)
  return [lerpP(d, e, t), e, c, p[3]]
}
function bezSplitLeft(p, t) {                   // control points of [0,t]
  const a = lerpP(p[0], p[1], t), b = lerpP(p[1], p[2], t), c = lerpP(p[2], p[3], t)
  const d = lerpP(a, b, t), e = lerpP(b, c, t)
  return [p[0], a, d, lerpP(d, e, t)]
}
function bezSub(p, t0, t1) {                    // sub-curve on [t0,t1]
  if (t1 - t0 <= 1e-9) return null
  const q = t0 > 1e-9 ? bezSplitRight(p, t0) : p
  const tt = t0 > 1e-9 ? (t1 - t0) / (1 - t0) : t1
  return tt < 1 - 1e-9 ? bezSplitLeft(q, tt) : q
}
const bezAt = (p, t) => cubicAt({ p0: p[0], p1: p[1], p2: p[2], p3: p[3] }, t)

// Parameter on `p` closest to `pt`: coarse scan, then a short bisection refine.
function nearestT(p, pt) {
  let bt = 0, bd = Infinity
  for (let i = 0; i <= 48; i++) {
    const t = i / 48, q = bezAt(p, t)
    const d = (q.x - pt.x) ** 2 + (q.y - pt.y) ** 2
    if (d < bd) { bd = d; bt = t }
  }
  let step = 1 / 48
  for (let k = 0; k < 24; k++) {
    step /= 2
    for (const t of [bt - step, bt + step]) {
      if (t < 0 || t > 1) continue
      const q = bezAt(p, t)
      const d = (q.x - pt.x) ** 2 + (q.y - pt.y) ** 2
      if (d < bd) { bd = d; bt = t }
    }
  }
  return { t: bt, dist: Math.sqrt(bd) }
}

// Unit tangent of `p` at parameter `t` (finite difference - plenty accurate at
// the mm scale these curves live at).
function tangentAt(p, t, h = 1e-3) {
  const t0 = Math.max(0, t - h), t1 = Math.min(1, t + h)
  if (t1 - t0 < 1e-9) return { x: 0, y: 0 }
  const a = bezAt(p, t0), b = bezAt(p, t1)
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  return len > 1e-9 ? { x: dx / len, y: dy / len } : { x: 0, y: 0 }
}
// Two curves running near-parallel within CROSS_ANGLE_TOL of each other (in
// either direction - a retraced sub-curve may be reversed) at their closest
// point. Below this, a match is a genuine crossing, not shared geometry.
const CROSS_ANGLE_COS = Math.cos((20 * Math.PI) / 180)   // 20°

// Which parameter ranges of `cp` run along `other`?
//
// Sampling beats trying to solve for an affine parameter mapping: it covers full
// containment AND partial overlap, in either direction, and needs no assumption
// about how the two curves were split. Position alone isn't enough, though: two
// DIFFERENT curves that cross (e.g. two circles offset by less than CURVE_TOL at
// their nearest point, like intentionally overlapping rings) can dip within
// tolerance over a real arc near the crossing, not just a single point - so a
// match also requires the TANGENT directions to be parallel (or antiparallel).
// A transversal crossing has clearly different tangents and is correctly
// rejected; a genuinely shared/retraced curve has matching tangents throughout.
function onOther(cp, other, t) {
  const p = bezAt(cp, t)
  const { t: u, dist } = nearestT(other, p)
  if (dist > CURVE_TOL) return false
  const ta = tangentAt(cp, t), tb = tangentAt(other, u)
  const dot = ta.x * tb.x + ta.y * tb.y
  return Math.abs(dot) >= CROSS_ANGLE_COS
}

function refineBoundary(cp, other, tOff, tOn) {   // bisect towards the "on" side
  for (let k = 0; k < 18; k++) {
    const m = (tOff + tOn) / 2
    if (onOther(cp, other, m)) tOn = m; else tOff = m
  }
  return tOn
}

// A genuine shared/duplicate arc is always ANCHORED at one of cp's own
// endpoints: real duplicates come from copying a whole curve, or splitting a
// path and duplicating a piece - either way, the shared range starts where cp
// starts or ends where cp ends (verified against both passing overlap tests
// below). A match that sits entirely in cp's INTERIOR, touching neither end,
// is a coincidence, not shared geometry - and coincidences do happen: two
// circles offset by a small fraction of their radius cross at a shallow angle
// (this pair crosses at ~3°), so position AND tangent direction both stay
// within tolerance for a real stretch near each crossing even though the
// circles are genuinely different. Discarding interior-only matches is what
// tells the two situations apart; tightening CURVE_TOL can't, since at the
// exact crossing point the gap is mathematically zero regardless of tolerance.
//
// "Anchored" is measured as physical distance (mm) from cp's own start/end
// POINT, not parameter distance - a parameter epsilon doesn't scale with the
// curve's real length (a tiny parameter slice of a large arc is still several
// hundredths of a mm, which is exactly the scale a false crossing sits at).
const ANCHOR_MM = OVERLAP_EPS   // same "negligible" scale used for line slivers

// Endpoint-anchoring alone still lets one thing through: two ADJACENT curve
// primitives of the very same shape (e.g. a circle built from 4 quarter-arc
// beziers) share an exact point by construction, and are typically drawn G1-
// continuous there (matching tangents), so the same shallow-angle situation
// happens again - briefly, right at that shared joint - even though nothing
// is actually redundant (the two arcs just meet, they don't overlap). A real
// duplicate/retraced arc runs alongside the other curve for a substantial
// stretch; a joint's false match dies out within a fraction of a mm. Requiring
// a minimum matched length throws out the joint artefact while comfortably
// clearing every genuine case above (tens of mm in this file's real content).
const MIN_MATCH_MM = 0.15

function arcLen(cp, t0, t1, steps = 8) {
  let len = 0, prev = bezAt(cp, t0)
  for (let i = 1; i <= steps; i++) {
    const p = bezAt(cp, t0 + (t1 - t0) * (i / steps))
    len += Math.hypot(p.x - prev.x, p.y - prev.y)
    prev = p
  }
  return len
}

function coveredRanges(cp, other) {
  const N = 64
  const flag = []
  for (let i = 0; i <= N; i++) flag.push(onOther(cp, other, i / N))
  const out = []
  let s = null
  for (let i = 0; i <= N; i++) {
    const on = flag[i]
    if (on && s === null) s = i
    if ((!on || i === N) && s !== null) {
      const e = on ? i : i - 1
      let lo = s / N, hi = e / N
      if (s > 0) lo = refineBoundary(cp, other, (s - 1) / N, s / N)
      if (e < N) hi = refineBoundary(cp, other, (e + 1) / N, e / N)
      const dLo = Math.hypot(bezAt(cp, lo).x - cp[0].x, bezAt(cp, lo).y - cp[0].y)
      const dHi = Math.hypot(bezAt(cp, hi).x - cp[3].x, bezAt(cp, hi).y - cp[3].y)
      const anchored = dLo <= ANCHOR_MM || dHi <= ANCHOR_MM
      if (hi - lo > 1e-6 && anchored && arcLen(cp, lo, hi) >= MIN_MATCH_MM) out.push([lo, hi])
      s = null
    }
  }
  return out
}

const bboxOf = (p) => ({
  x0: Math.min(p[0].x, p[1].x, p[2].x, p[3].x), x1: Math.max(p[0].x, p[1].x, p[2].x, p[3].x),
  y0: Math.min(p[0].y, p[1].y, p[2].y, p[3].y), y1: Math.max(p[0].y, p[1].y, p[2].y, p[3].y),
})
const bboxHit = (a, b, tol) =>
  a.x0 - tol <= b.x1 && b.x0 - tol <= a.x1 && a.y0 - tol <= b.y1 && b.y0 - tol <= a.y1

function curveToSegs(p, sink) {
  const pts = flattenPrim({ t: 'C', p0: p[0], p1: p[1], p2: p[2], p3: p[3] })
  for (let i = 0; i < pts.length - 1; i++)
    sink.push({ x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y })
}

/**
 * Remove doubled / overlapping coverage. See header above.
 * @returns {{ data: Array, removed: Array<{x1,y1,x2,y2}> }}
 */
export function computeDoubleRemoval(data) {
  const out = []        // survivors, in the input's order where possible
  const removed = []    // dropped pieces, as segments for the highlight

  // Blue is processed before red so red always loses against a cut; within one
  // colour the first occurrence in the file wins.
  const rank = (o) => (categorize(o.color || '#000000') === 'blue' ? 0 : 1)
  const lines = [], curves = []
  for (const o of data) {
    const cat = (o.type === 'l' || o.type === 'c') ? categorize(o.color || '#000000') : null
    if (o.type === 'l' && (cat === 'red' || cat === 'blue')) {
      if (Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 1e-9) continue     // zero length → drop
      lines.push(o)
    } else if (o.type === 'c' && (cat === 'red' || cat === 'blue')) {
      curves.push(o)
    } else {
      out.push(o)                                                    // untouched
    }
  }
  lines.sort((a, b) => rank(a) - rank(b))
  curves.sort((a, b) => rank(a) - rank(b))

  // ── Straight segments ───────────────────────────────────────────────────────
  const segView = lines.map(o => ({ x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, o }))
  for (const g of groupCollinear(segView)) {
    let covered = []                                   // what earlier members took
    for (const it of g.items) {
      const o = it.s.o
      const keep = subtractIv([[it.lo, it.hi]], covered)
      covered = mergeIv([...covered, [it.lo, it.hi]])
      const span = it.hi - it.lo
      // Emit surviving pieces from the ORIGINAL endpoints (never from group means).
      const A = { x: o.x1, y: o.y1 }, B = { x: o.x2, y: o.y2 }
      const at = (t) => {
        const f = it.flip ? (it.hi - t) / span : (t - it.lo) / span
        return lerpP(A, B, f)
      }
      const emit = (ivs, sink) => {
        for (const [t0, t1] of ivs) {
          if (t1 - t0 <= OVERLAP_EPS) continue
          const p = at(t0), q = at(t1)
          if (sink === 'out') out.push({ ...o, x1: p.x, y1: p.y, x2: q.x, y2: q.y })
          else removed.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y })
        }
      }
      if (keep.length === 1 && keep[0][0] === it.lo && keep[0][1] === it.hi) {
        out.push(o)                                    // untouched → byte-identical
      } else {
        emit(keep, 'out')
        emit(subtractIv([[it.lo, it.hi]], keep), 'removed')
      }
    }
  }

  // ── Bezier curves ───────────────────────────────────────────────────────────
  const kept = []                                      // {cp, bbox} already placed
  for (const o of curves) {
    const cp = [{ x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 },
                { x: o.x3, y: o.y3 }, { x: o.x4, y: o.y4 }]
    const bb = bboxOf(cp)
    let ranges = [[0, 1]]                              // still-alive part of THIS curve
    for (const k of kept) {
      if (!bboxHit(bb, k.bbox, CURVE_TOL)) continue
      for (const cov of coveredRanges(cp, k.cp)) ranges = subtractIv(ranges, [cov])
      if (ranges.length === 0) break
    }
    const full = ranges.length === 1 && ranges[0][0] <= 1e-9 && ranges[0][1] >= 1 - 1e-9
    if (full) {
      out.push(o)
      kept.push({ cp, bbox: bb })
      continue
    }
    for (const [t0, t1] of subtractIv([[0, 1]], ranges)) curveToSegs(bezSub(cp, t0, t1) || cp, removed)
    for (const [t0, t1] of ranges) {
      const sub = bezSub(cp, t0, t1)
      if (!sub) continue
      const len = Math.hypot(sub[3].x - sub[0].x, sub[3].y - sub[0].y)
      if (len <= OVERLAP_EPS) continue
      out.push({ ...o, x1: sub[0].x, y1: sub[0].y, x2: sub[1].x, y2: sub[1].y,
                       x3: sub[2].x, y3: sub[2].y, x4: sub[3].x, y4: sub[3].y })
      kept.push({ cp: sub, bbox: bboxOf(sub) })
    }
  }

  return {
    data: out,
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
// elements that WOULD change - mirroring computeDoubleRemoval's `removed`, so the
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

// ── Remove Tiny Segments ──────────────────────────────────────────────────────
// Sub-0.005mm lines/curves are pure extraction noise (stray near-zero-length
// pieces some SVG/PDF sources leave behind) - real detail never gets that
// small, but a job full of them can trip up the printer's own path optimiser.
// Filled (raster) content is left alone: a "tiny segment" there is just a
// normal fine detail of the bitmap, not an artefact.
const TINY_SEGMENT_LEN = 0.005   // mm

function strokeLen(o) {
  const segs = strokeSegs(o)
  let L = 0
  for (const s of segs) L += Math.hypot(s.x2 - s.x1, s.y2 - s.y1)
  return L
}

export function detectTinySegments(data, minLen = TINY_SEGMENT_LEN) {
  let count = 0
  const segs = []
  for (const o of data) {
    if ((o.type === 'l' || o.type === 'c') && strokeLen(o) < minLen) { count++; segs.push(...strokeSegs(o)) }
  }
  return { count, segs }
}

export function removeTinySegments(data, minLen = TINY_SEGMENT_LEN) {
  return data.filter((o) => !((o.type === 'l' || o.type === 'c') && strokeLen(o) < minLen))
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

// Adaptive bezier flatness tolerance (mm) - how far a chord may bend away from
// the true curve before it gets subdivided again. Lower = more segments = a
// closer-fitting (and heavier) polyline. Exposed via setTessellationTolerance()
// so the UI can trade fidelity for performance on simple files; every call to
// flattenPrim() that doesn't pass its own `tol` picks up the current value.
let TESSELLATION_TOL = 0.2
export function getTessellationTolerance() { return TESSELLATION_TOL }
export function setTessellationTolerance(mm) {
  TESSELLATION_TOL = Math.max(0.005, Math.min(1, Number(mm) || 0.2))
}

/**
 * Tessellate a primitive into a polyline using ADAPTIVE (flatness-based)
 * subdivision: a cubic is split only where it bends away from a straight chord
 * by more than `tol` mm. Gentle curves get a handful of segments, tight ones
 * more - far fewer points than the old fixed/length-based count.
 *
 * @returns {Array<{x,y}>} points including both endpoints (line → 2 points)
 */
export function flattenPrim(p, tol = TESSELLATION_TOL, maxDepth = 8) {
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
// sitting next to each other in the array - so reconstruction is independent of
// item order. This matters because edits like Remove Doubles rebuild the line
// list grouped by shared direction/offset (not by connectivity), which used to
// shatter closed polygons into unclosed fragments and silently zero out the
// small-/tiny-part warnings. Order-independent linking fixes that for any
// edit or extraction order.
const LINK_TOL = 0.01   // mm - matches the old adjacency tolerance

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

// Bounding box of a raster image entry (top-left corner at x,y; extends right
// and downward, where down is negative y).
function bboxOfImage(img) {
  return { minX: img.x, maxX: img.x + img.w, maxY: img.y, minY: img.y - img.h }
}

// Split a filled-path command list into closed point loops (beziers flattened).
function fpLoops(path) {
  const loops = []
  let cur = [], sx = 0, sy = 0, cx = 0, cy = 0
  for (const c of path) {
    if (c.cmd === 'M') {
      if (cur.length > 1) loops.push(cur)
      cur = [{ x: c.x, y: c.y }]; sx = cx = c.x; sy = cy = c.y
    } else if (c.cmd === 'L') {
      cur.push({ x: c.x, y: c.y }); cx = c.x; cy = c.y
    } else if (c.cmd === 'C') {
      const pp = flattenPrim({ t: 'C', p0: { x: cx, y: cy }, p1: { x: c.x1, y: c.y1 },
                               p2: { x: c.x2, y: c.y2 }, p3: { x: c.x, y: c.y } })
      cur.push(...pp.slice(1)); cx = c.x; cy = c.y
    } else if (c.cmd === 'Z') {
      cur.push({ x: sx, y: sy }); loops.push(cur); cur = []; cx = sx; cy = sy
    }
  }
  if (cur.length > 1) loops.push(cur)
  return loops
}

/**
 * Per-scan-row spans of the raster content.
 *
 * MEASURED behaviour (calibration files 30–32): the head sweeps, for each scan
 * row, from the LEFTMOST to the RIGHTMOST ink IN THAT ROW.
 *   • frame with a hollow centre → full width every row (the empty middle is
 *     crossed, because there is ink on both sides)
 *   • two columns 80 mm apart    → full width (the gap is crossed)
 *   • right triangle             → row width grows with y (mean = half)
 * Taking the bounding-box width for every row makes a triangle ~60 % too slow;
 * splitting the two columns into separate regions makes them ~34 % too fast.
 *
 * @returns {Array<{ i:number, y:number, x0:number, x1:number }>} non-empty rows,
 *   top → bottom, `i` = row index (gaps in `i` mark empty bands).
 */
function rasterScanRows(loops, pitch) {
  const edges = []
  let maxY = -Infinity, minY = Infinity
  for (const { pts, color } of loops) {
    for (const p of pts) { if (p.y > maxY) maxY = p.y; if (p.y < minY) minY = p.y }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1]
      if (a.y === b.y) continue                       // horizontal edge: no crossing
      edges.push({ lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y),
                   xa: a.x, ya: a.y, dxdy: (b.x - a.x) / (b.y - a.y), color })
    }
  }
  if (!edges.length || !isFinite(maxY)) return []
  edges.sort((e, f) => f.hi - e.hi)                   // sweep top → bottom

  const height = Math.max(0, maxY - minY)
  let nRows = Math.floor(height / pitch) + 1
  if (nRows > RASTER_MAX_ROWS) { nRows = RASTER_MAX_ROWS; pitch = height / Math.max(1, nRows - 1) }

  const rows = []
  let next = 0
  let active = []
  for (let i = 0; i < nRows; i++) {
    const y = maxY - i * pitch
    while (next < edges.length && edges[next].hi >= y) active.push(edges[next++])
    if (active.length > 8 && (i & 31) === 0) active = active.filter(e => e.lo <= y)
    let lo = Infinity, hi = -Infinity, green = false
    for (const e of active) {
      if (y > e.hi || y < e.lo) continue
      const x = e.xa + (y - e.ya) * e.dxdy
      if (x < lo) lo = x
      if (x > hi) hi = x
      if (e.color === 'green') green = true
    }
    if (lo <= hi) rows.push({ i, y, x0: lo, x1: hi, green })
  }
  return rows
}

/**
 * Serpentine over a band of contiguous scan rows, each row spanning only its own
 * content (plus the calibrated overscan). Emitted as one continuous engrave move
 * preceded by a travel to its start.
 */
function rasterRegion(rows, lastPos, pitch, rasterSpeed = 0) {
  // Colour is decided PER BAND (this contiguous run of rows), not for the whole
  // file: a photo bitmap and an unrelated green icon elsewhere in the design
  // both end up in the raster pass, but only rows a green loop actually crosses
  // should render green - otherwise a single green shape anywhere in the file
  // tinted every bitmap green too.
  const color = rows.some(r => r.green) ? RASTER_GREEN : RASTER_GRAY
  const over = rasterOverscanFor(rasterSpeed)
  const topY = rows[0].y
  const botY = rows[rows.length - 1].y
  let bMinX = Infinity, bMaxX = -Infinity

  const prims = []
  let ltr = true
  let prevEnd = null
  for (const r of rows) {
    const a = r.x0 - over, b = r.x1 + over
    if (a < bMinX) bMinX = a
    if (b > bMaxX) bMaxX = b
    const sx = ltr ? a : b
    const ex = ltr ? b : a
    if (prevEnd) prims.push({ t: 'L', a: prevEnd, b: { x: sx, y: r.y } })  // step to next row
    prims.push({ t: 'L', a: { x: sx, y: r.y }, b: { x: ex, y: r.y } })
    prevEnd = { x: ex, y: r.y }
    ltr = !ltr
  }

  const moves = []
  const start = prims.length ? primStart(prims[0]) : { x: bMinX, y: topY }
  if (dist(lastPos, start) > 0.1) {
    moves.push({ kind: 'travel', color: '#888888', a: { ...lastPos }, b: { ...start } })
  }
  // The swept rectangle (content + overscan) is carried so the viewer can draw
  // the region as one block matching the extent of the scan lines.
  moves.push({
    kind: 'engrave', color, category: 'raster', prims,
    // rows/pitch drive the per-scan-line overhead in moveExtraTime().
    rows: rows.length, pitch: pitch || RASTER_PITCH,
    bbox: { minX: bMinX, maxX: bMaxX, minY: botY, maxY: topY },
  })
  const end = prims.length ? primEnd(prims[prims.length - 1]) : start
  return { moves, end }
}

// Path-order optimisation ("Pfadreihenfolge optimieren").
//
// MEASURED: the machine clearly minimises travel - 36_order_natural and
// 37_order_shuffled are the SAME geometry in a favourable and a maximally
// unfavourable file order (97 s vs 131 s unoptimised) and land on exactly the
// same 84 s once "Optimieren" is on. Plain file order is therefore out.
//
// How GOOD its tour is: greedy nearest-neighbour, not 2-opt. On the four real
// production files with a known preset, 'nn' lands at -3,1/-0,3/-0,2/-6,9 %
// against the Job Manager (Ø 2,6 %), '2opt' at -4,2/-2,0/-1,4/-7,7 %
// (Ø 3,8 %) - i.e. 2-opt finds a better tour than the machine does and
// therefore estimates too fast. 38_order_nntrap, built so that greedy drives
// 1428 mm further than 2-opt, is a tie (+1,4 % against -1,3 %) and does not
// decide it on its own.
//
// This reverses the earlier call for '2opt'. That one rested on how much travel
// time the machine's estimate leaves over once the cut time is subtracted - and
// that leftover budget is computed with the per-vector start penalty and the
// return-to-home leg, both of which changed in the 2025-09 recalibration. With
// the corrected constants the budget argument points the other way. 'nn' is
// also the conservative direction: it estimates slightly high, not low.
const TSP_MAX_PATHS = 4000   // above this, greedy only (2-opt is O(n²) per pass)
const TSP_MAX_PASSES = 20

// Selectable path-order algorithms, exposed in the UI for debugging/comparison
// against what the printer's own optimiser does:
//   'file' - no reordering, cut in file order (the pre-optimisation baseline)
//   'nn'   - greedy nearest-neighbour, the closest match to the printer's own
//            optimiser (see the MEASURED note above) - the default
//   '2opt' - nearest-neighbour seed + 2-opt improvement; a BETTER tour than the
//            printer finds, so it estimates slightly too fast
export const PATH_ORDER_ALGORITHMS = ['file', 'nn', '2opt']
export const DEFAULT_PATH_ORDER = 'nn'

function nearestNeighbourOrder(paths, startPos) {
  const pool = [...paths]
  const seq = []
  let pos = { ...startPos }
  while (pool.length) {
    let best = 0, minD = Infinity, reverse = false
    for (let i = 0; i < pool.length; i++) {
      const ds = dist(pos, pool[i].start)
      const de = dist(pos, pool[i].end)
      if (ds < minD) { minD = ds; best = i; reverse = false }
      if (de < minD) { minD = de; best = i; reverse = true }
    }
    let cur = pool.splice(best, 1)[0]
    if (reverse) cur = reversePath(cur)
    seq.push(cur)
    pos = cur.end
  }
  return seq
}

// 2-opt improvement pass: reversing seq[i..k] flips the direction of every path
// inside it, which is free here because a contour may be cut either way round.
function twoOptImprove(seq, startPos) {
  const n = seq.length
  for (let pass = 0; pass < TSP_MAX_PASSES; pass++) {
    let improved = false
    for (let i = 0; i < n - 1; i++) {
      const prev = i === 0 ? startPos : seq[i - 1].end
      for (let k = i + 1; k < n; k++) {
        const next = k + 1 < n ? seq[k + 1].start : null
        const before = dist(prev, seq[i].start) + (next ? dist(seq[k].end, next) : 0)
        const after  = dist(prev, seq[k].end)   + (next ? dist(seq[i].start, next) : 0)
        if (after < before - 1e-9) {
          const slice = seq.slice(i, k + 1).reverse()
          for (const p of slice) reversePath(p)
          seq.splice(i, slice.length, ...slice)
          improved = true
        }
      }
    }
    if (!improved) break
  }
  return seq
}

// MEASURED (see PATH_ORDER_ALGORITHMS docs above / CALIBRATION.md): the printer
// minimises travel, but only about as well as greedy nearest-neighbour - '2opt'
// finds a shorter tour than it does and estimates ~1,2 points too fast on the
// real production files. 'nn' is the default.
function optimizeOrder(paths, startPos, algo = DEFAULT_PATH_ORDER) {
  if (algo === 'file' || paths.length < 2) return paths
  const seq = nearestNeighbourOrder(paths, startPos)
  if (algo === 'nn' || seq.length < 4 || seq.length > TSP_MAX_PATHS) return seq
  return twoOptImprove(seq, startPos)
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
 * @param {string} [opts.optimize='file']  path-order algorithm within each vector
 *   phase - one of PATH_ORDER_ALGORITHMS ('file' | 'nn' | '2opt'); a falsy value
 *   is treated as 'file' for backwards compatibility with the old boolean flag.
 * @returns {{ moves: Array, stats: Object }}
 *   moves: ordered list of either
 *     { kind:'cut'|'engrave'|'other', color, category, prims }   (beam-on path)
 *     { kind:'travel', color, a, b }                             (rapid move)
 *   stats: { cutLen, engraveLen, otherLen, travelLen, totalTime } (mm / seconds)
 */
export function buildToolpath(data, { optimize = 'file', speeds = SPEED_MM_S, rasterPitch = RASTER_PITCH, accel = 0 } = {}) {
  // Accept the old boolean flag too: true -> default algorithm, false -> 'file'.
  const pathOrderAlgo = optimize === true ? DEFAULT_PATH_ORDER : (optimize || 'file')
  // Resolve the head speed (mm/s) for a move, with raster getting its own speed.
  const speedFor = (m) => {
    const s = m.category === 'raster' ? (speeds.raster ?? speeds.engrave) : speeds[m.kind]
    return s || speeds.other || SPEED_MM_S.other
  }
  const allPaths = reconstructPaths(data)
  const rasterPaths = allPaths.filter(p => p.category === 'green' || p.category === 'gray')
  const vectorPaths = allPaths.filter(p => p.category !== 'green' && p.category !== 'gray')

  // Raster content: ALL of it - green + grayscale vectors/fills AND grayscale
  // bitmaps, goes into ONE scanline pass. The machine sweeps each row from its
  // leftmost to its rightmost ink, so horizontally separated content in the same
  // rows shares a sweep (no proximity clustering) while a genuinely empty
  // vertical band produces no rows at all and thus splits the job by itself.
  // Each loop keeps its OWN colour tag so a shared band can still tell which
  // rows are actually green vs. grayscale (see rasterScanRows/rasterRegion).
  const rasterLoops = []
  for (const p of rasterPaths) {
    const pts = []
    for (const prim of p.prims) {
      const pp = flattenPrim(prim)
      if (pts.length) pts.push(...pp.slice(1)); else pts.push(...pp)
    }
    if (pts.length > 1) rasterLoops.push({ pts, color: p.category === 'green' ? 'green' : 'gray' })
  }
  for (const obj of data) {
    if (obj.type === 'fp' && isRasterColor(obj.fill)) {
      const color = isGreen(obj.fill) ? 'green' : 'gray'
      for (const loop of fpLoops(obj.path)) if (loop.length > 1) rasterLoops.push({ pts: loop, color })
    } else if (obj.type === 'img' && obj.colorspace === 1) {
      const b = bboxOfImage(obj)
      rasterLoops.push({
        pts: [{ x: b.minX, y: b.maxY }, { x: b.maxX, y: b.maxY },
              { x: b.maxX, y: b.minY }, { x: b.minX, y: b.minY }, { x: b.minX, y: b.maxY }],
        color: 'gray',
      })
    }
  }
  const scanRows = rasterScanRows(rasterLoops, rasterPitch || RASTER_PITCH)
  // Split into bands of CONTIGUOUS rows: an empty vertical gap ends a band.
  const bands = []
  for (const r of scanRows) {
    const last = bands[bands.length - 1]
    if (last && r.i === last[last.length - 1].i + 1) last.push(r)
    else bands.push([r])
  }

  const moves = []
  let lastPos = { x: 0, y: 0 } // print head starts at the top-left corner

  // ── Engrave phase 1: raster bands (green + grayscale) ──────────────────────
  //
  // NO travel into (or between) raster bands. There is no separate rapid to
  // charge: the head reaches the start of a scan row during the sweep, and the
  // step to the next band is the Y feed, which rasterYFeed already prices in.
  //
  // MEASURED, 54_rast_overscan: a 1 mm wide bar engraved at x = 500 mm
  // (200 dpi, 100 %). Charging the approach at 250 mm/s overshoots its 29 s
  // display by 5,9 %, charging approach and way back by 13,1 %; charging
  // neither lands at -0,7 %. And 52/53 (same two blocks, 5 mm vs 60 mm apart)
  // are both 379 s - crossing the gap costs nothing.
  for (const band of bands) {
    const r = rasterRegion(band, lastPos, rasterPitch || RASTER_PITCH,
                           speeds.raster ?? speeds.engrave)
    for (const m of r.moves) if (m.kind !== 'travel') moves.push(m)
    lastPos = r.end
  }

  // ── Vector phases: red engrave, blue cut, other ───────────────────────────
  let didVector = false
  for (const cat of ['red', 'blue', 'other']) {
    let group = vectorPaths.filter(p => p.category === cat)
    if (group.length === 0) continue

    if (pathOrderAlgo !== 'file') group = optimizeOrder(group, lastPos, pathOrderAlgo)
    // (unoptimised: keep file order)

    for (const p of group) {
      if (dist(lastPos, p.start) > 0.1) {
        moves.push({ kind: 'travel', color: '#888888', a: { ...lastPos }, b: { ...p.start } })
      }
      moves.push({ kind: kindOf(cat), color: p.color, category: cat, prims: p.prims })
      lastPos = p.end
      didVector = true
    }
  }

  // Return to home. The machine's estimate DOES include it: 42_home_near and
  // 43_home_far are the same 20 mm square, once in the start corner (5 s) and
  // once in the opposite corner (13 s). The 8 s difference is TWICE the ~1080 mm
  // approach at 250 mm/s (8,6 s), not once (4,3 s). Across all 134 runs the
  // return leg improves the fit from Ø 1,18 % to Ø 0,51 %.
  //
  // This reverses the earlier reading of the dashes files (17–19): under the old
  // parameter set the return leg overshot them, but that was the 69 ms per-vector
  // start penalty compensating for a missing term. With the penalty refitted to
  // 35 ms the dashes land within 1,8 % WITH the return leg.
  //
  // Only after a VECTOR phase - a raster-only job pays no travel at all, see the
  // raster loop above.
  if (CALIBRATION.returnToHome && didVector && (lastPos.x !== 0 || lastPos.y !== 0)) {
    // `home` marks it as NOT starting a vector, so it carries no start penalty.
    moves.push({ kind: 'travel', home: true, color: '#888888', a: { ...lastPos }, b: { x: 0, y: 0 } })
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
    const T = rampSegments(movePolyline(m), speedFor(m), accelFor(m, accel),
                           cornerPenaltyFor(m)).total + moveExtraTime(m)

    if      (m.kind === 'travel')     { stats.travelLen  += L; stats.travelTime  += T }
    else if (m.kind === 'cut')        { stats.cutLen     += L; stats.cutTime     += T }
    else if (m.category === 'raster') { stats.rasterLen  += L; stats.rasterTime  += T }
    else if (m.kind === 'engrave')    { stats.engraveLen += L; stats.engraveTime += T }
    else                              { stats.otherLen   += L; stats.otherTime   += T }
    stats.totalTime += T
  }
  stats.totalTime += CALIBRATION.jobOverhead
  return { moves, stats, tinyBoxes }
}
