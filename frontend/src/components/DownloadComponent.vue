<template>
  <!-- Result group: the estimated job time (the app's headline output) plus the
       export action. Sits in the bottom dock beside the playback group, its
       own element, its own height; nothing here can stretch its neighbour. -->
  <div class="download-container" ref="root">
    <div class="dl-row">
      <!-- Estimate + disclosure as ONE control. The caption, the value and a
           separate caret button used to be three boxes sitting side by side,
           each with its own padding, the caret now rides inside the stat. -->
      <button
        class="est-toggle"
        :class="{ open: expanded }"
        :disabled="!hasStats"
        :aria-expanded="expanded"
        :title="t('estTime')"
        @click="expanded = !expanded"
      >
        <span class="est">
          <span class="est-label">{{ t('estTime') }}</span>
          <span class="est-value">{{ formattedTime }}</span>
        </span>
        <span class="est-caret" aria-hidden="true">▾</span>
      </button>

      <!-- Warning badge. Clicking it opens the breakdown, where the actual
           notes live (a tooltip alone is easy to miss and can't be acted on). -->
      <button
        v-if="showWarning || showTinyWarning"
        class="warn-badge"
        :title="warnTitle"
        @click="expanded = true"
      >⚠</button>

      <!-- Icon-only. The "Herunterladen" label was the single widest thing in
           the dock; the tooltip and aria-label carry the name, and the app
           already relies on icon-plus-tooltip for the view controls. -->
      <button
        class="download-btn"
        :title="t('download')"
        :aria-label="t('download')"
        @click="handleDownload"
      >
        <!-- Drawn, not a font glyph: same reasoning as the play/pause icons. -->
        <svg class="dl-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M12 3v10m0 0l-4-4m4 4l4-4" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <!-- Teleported to the app's portal root, same reason and pattern as
         ProfileDropdown's menu and PlayBack's speed-menu: .dock is now
         position:relative with its own z-index (so it can carry a box-shadow
         above the viewer, like the sidebar's), which makes it establish a
         stacking context of its own. Left in place, this panel - a
         DESCENDANT of .dock - would always paint above that context's own
         background no matter what number either of them carried; that's
         exactly the bug from the earlier box-shadow attempts. Teleporting it
         out makes it a genuine sibling of .dock instead, so a plain
         z-index comparison between the two actually means something, and
         .dock's own background can properly sit in front of this panel
         (and mask its shadow) where they'd otherwise overlap.
         Fixed-positioned + measured in JS instead of the old bottom:calc(...)
         relative to .dock-right. -->
    <Teleport to="#cc-portal-root" defer>
      <!-- <Transition>'s root MUST be this element, not a wrapper around it.
           Vue auto-detects how long to hold an element in the DOM during its
           leave transition by reading the CSS transition duration off THAT
           ROOT element only. An earlier version wrapped this in a clipping
           mask div that had no transition of its own; Vue found nothing to
           wait for and removed the element instantly, so the slide only ever
           showed on enter, leave looked like it "didn't animate" at all.

           :duration pins Vue to a fixed wait instead of auto-detecting it
           from the element's CSS. Auto-detection turned out to be unreliable
           even with the root fixed above: it would occasionally leave BOTH
           the enter and leave classes stuck on the element forever (verified
           by waiting several seconds, not a slow transition, a stall), so
           the element never actually left the DOM. An explicit duration
           removes that detection step entirely. -->
      <Transition name="grow" :duration="220">
        <div v-if="expanded && hasStats" class="breakdown" ref="menuRef" :style="menuStyle">
          <!-- A list, not a table: at this width (the section's) three columns
               would be cramped, so the distance sits under its operation name
               and only the time keeps a column of its own. -->
          <ul class="bd-list">
            <li v-for="row in rows" :key="row.key" class="bd-row">
              <span class="bd-dot" :style="{ background: row.color }"></span>
              <span class="bd-name">
                {{ row.label }}
                <span class="bd-dist">{{ row.dist }}</span>
              </span>
              <span class="bd-time">{{ row.time }}</span>
              <!-- View-only: hides this colour's strokes/fills in the viewer,
                   does not change the estimate (see ThreeViewer's kindGroupOf).
                   Always rendered (never v-if) so every row reserves the same
                   width for it - travel (not toggleable) just hides its own
                   copy, which is what keeps every row's time in one straight
                   column instead of the toggleable ones sitting short. -->
              <button
                class="bd-eye"
                :class="{ off: hiddenKinds[row.key], invisible: !row.toggleable }"
                :disabled="!row.toggleable"
                :tabindex="row.toggleable ? 0 : -1"
                :title="row.toggleable ? t(hiddenKinds[row.key] ? 'showColor' : 'hideColor') : null"
                @click="row.toggleable && toggleKindVisibility(row.key)"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                  <path v-if="!hiddenKinds[row.key]"
                        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z M12 9a3 3 0 100 6 3 3 0 000-6Z"
                        fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
                  <path v-else
                        d="M3 3l18 18 M9.9 5.5A10.6 10.6 0 0112 5c6.5 0 10 7 10 7a15.8 15.8 0 01-3.2 4.1 M6.6 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7c1.4 0 2.7-.3 3.8-.8 M9.5 14.5a3 3 0 004-4"
                        fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </li>
          </ul>

          <div class="bd-total">
            <span class="bd-name">
              {{ t('total') }}
              <span class="bd-dist">{{ totalDist }}</span>
            </span>
            <span class="bd-time">{{ formattedTime }}</span>
            <!-- Same reserved width as every row's .bd-eye (see above), so the
                 total's time lands in the same column as the rows above it. -->
            <span class="bd-eye-spacer" aria-hidden="true"></span>
          </div>

          <p v-if="showWarning" class="warn-note">{{ warningText }}</p>
          <button
            v-if="showTinyWarning"
            class="warn-note tiny"
            :class="{ active: tinyHighlight }"
            @click="toggleTinyHighlight"
          >
            <span>{{ tinyText }}</span>
            <span class="warn-action">{{ tinyHighlight ? t('hideParts') : t('showParts') }}</span>
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import eventBus from '../eventBus'
import { t } from '../translations'

// Full toolpath stats (lengths + per-operation times), from the viewer.
const stats = ref(null)
const expanded = ref(false)
const root = ref(null)
const menuRef = ref(null)

// The panel is teleported out of .dock-right (see the template comment), so
// it's fixed-positioned and measured in JS instead of CSS bottom:calc(...).
// Anchored by `bottom` (distance up from the viewport's own bottom edge) so
// it grows upward from .dock-right's top edge regardless of the panel's own
// height, no need to measure that height like PlayBack's speed-menu does for
// its up/down flip.
const menuStyle = ref({ position: 'fixed', top: '-9999px', left: '-9999px' })

const positionMenu = () => {
  const dockRight = root.value?.closest('.dock-right')
  const dock = root.value?.closest('.dock')
  if (!dockRight || !dock) return
  // Horizontal span (left/width) comes from .dock-right - it's the box that
  // actually runs from .dock-sep to the dock's right edge, .dock itself
  // spans the playback side too. But .dock-right's OWN top edge sits ~9px
  // BELOW .dock's true top border (align-self:stretch fills .dock's content
  // box, inside its own top padding, not its border box - dock-right's top
  // isn't dock's top). Anchoring the vertical `bottom` off .dock directly
  // sidesteps that gap entirely instead of hardcoding the padding value.
  const rightRect = dockRight.getBoundingClientRect()
  const dockRect = dock.getBoundingClientRect()
  menuStyle.value = {
    position: 'fixed',
    bottom: `${window.innerHeight - dockRect.top}px`,
    left: `${rightRect.left}px`,
    width: `${rightRect.width}px`,
  }
}
// .dock-right's own position shifts as the sidebar is dragged (it resizes
// .main-content, which the dock lives in) - keep the panel aligned with it
// live while open, the same way ThreeViewer re-fits the canvas during a drag.
let resizeObs = null
watch(expanded, (isOpen) => {
  if (!isOpen) return
  positionMenu()
  nextTick(positionMenu)   // re-measure once the panel itself is in the DOM
  if (window.ResizeObserver && !resizeObs) {
    const dock = root.value?.closest('.dock')
    if (dock) {
      resizeObs = new ResizeObserver(positionMenu)
      resizeObs.observe(dock)   // dock-right resizes in lockstep with dock, watching dock covers both
    }
  }
})

const hasStats = computed(() => !!stats.value && stats.value.totalTime > 0)

// M:SS, or H:MM:SS once a job runs past the hour (a big raster engrave easily
// does, "94:20" would be needlessly hard to read). --:-- when there's nothing.
const fmtTime = (sec) => {
  if (!sec || sec <= 0) return '--:--'
  const total = Math.floor(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
// mm, switching to metres once it gets long.
const fmtDist = (mm) => (mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Math.round(mm)} mm`)

const formattedTime = computed(() => fmtTime(stats.value?.totalTime))

// Handling-time warning: many cut-out parts cost real time the machine estimate
// ignores - each must be removed by hand. Driven by the COUNT, not the size.
const SMALL_PARTS_WARN = 10        // warn from this many parts on
const SECONDS_PER_SMALL_PART = 5   // ~ removal time per part

const smallParts = computed(() => stats.value?.smallParts || 0)
const showWarning = computed(() => smallParts.value >= SMALL_PARTS_WARN)
const warningText = computed(() =>
  t('smallPartsNote', { n: smallParts.value, time: fmtTime(smallParts.value * SECONDS_PER_SMALL_PART) }))

// Grid-fall warning: very small parts can drop through the bed grid; clicking the
// note highlights them in the viewer (off by default - only when the user checks).
const TINY_PARTS_WARN = 1          // warn once there is at least this many
const tinyParts = computed(() => stats.value?.tinyParts || 0)
const showTinyWarning = computed(() => tinyParts.value >= TINY_PARTS_WARN)
const tinyText = computed(() => t('tinyPartsNote', { n: tinyParts.value }))

const tinyHighlight = ref(false)
const toggleTinyHighlight = () => {
  tinyHighlight.value = !tinyHighlight.value
  eventBus.emit('tiny-highlight-changed', tinyHighlight.value)
}

// Combined tooltip for the warning badge (both warnings, if active).
const warnTitle = computed(() =>
  [showWarning.value ? warningText.value : null, showTinyWarning.value ? tinyText.value : null]
    .filter(Boolean).join('\n'))

// One row per operation type that has any length. Colours mirror the viewer.
// Travel isn't toggleable here - it already has its own dedicated show/hide
// button in the floating view toggles (top-right).
const rows = computed(() => {
  const s = stats.value
  if (!s) return []
  const defs = [
    { key: 'cut',     label: t('opCut'),           len: s.cutLen,     time: s.cutTime,     color: '#2f6df0', toggleable: true },
    { key: 'engrave', label: t('opVectorEngrave'), len: s.engraveLen, time: s.engraveTime, color: '#e0413a', toggleable: true },
    { key: 'raster',  label: t('opRasterEngrave'), len: s.rasterLen,  time: s.rasterTime,  color: '#00a000', toggleable: true },
    { key: 'other',   label: t('opOther'),         len: s.otherLen,   time: s.otherTime,   color: '#b07cff', toggleable: true },
    { key: 'travel',  label: t('opTravel'),        len: s.travelLen,  time: s.travelTime,  color: '#9aa0a6', toggleable: false },
  ]
  return defs
    .filter((d) => d.len > 0.05)
    .map((d) => ({ key: d.key, label: d.label, color: d.color, toggleable: d.toggleable, dist: fmtDist(d.len), time: fmtTime(d.time) }))
})

// View-only visibility per row (cut/engrave/raster/other) - purely cosmetic,
// does not touch the estimate. ThreeViewer owns the actual filtering; this is
// just the switch + its persisted-for-this-session state (see toggleTinyHighlight
// above for the same "own the flag here, emit an event" pattern).
const hiddenKinds = reactive({ cut: false, engrave: false, raster: false, other: false })
const toggleKindVisibility = (key) => {
  hiddenKinds[key] = !hiddenKinds[key]
  eventBus.emit('kind-visibility-changed', { kind: key, hidden: hiddenKinds[key] })
}

const totalDist = computed(() => {
  const s = stats.value
  if (!s) return fmtDist(0)
  return fmtDist((s.engraveLen || 0) + (s.rasterLen || 0) + (s.cutLen || 0) + (s.otherLen || 0) + (s.travelLen || 0))
})

const handleDownload = () => {
  // Handled in the ThreeViewer component.
  eventBus.emit('save_pdf_request')
}

const onStats = (s) => { stats.value = s || null }
// A fresh design drops any active highlight/hidden-colour state (the viewer
// resets its own copies of both on the same event - see ThreeViewer.vue).
const onLinesUpdated = () => {
  tinyHighlight.value = false
  for (const k of Object.keys(hiddenKinds)) hiddenKinds[k] = false
}

// The breakdown is a popover now, so it closes on an outside click like every
// other menu in the app (ProfileDropdown, LanguageSwitcher, the speed menu).
// Teleported content lives outside `root`, so the check needs to ALSO exempt
// the panel itself (same two-part check as ProfileDropdown/PlayBack).
const onDocClick = (e) => {
  if (root.value?.contains(e.target)) return
  if (menuRef.value?.contains(e.target)) return
  expanded.value = false
}
// Keep the panel aligned with .dock-right if the window resizes while open
// (the sidebar-drag case is covered by the ResizeObserver set up above).
const onWindowResize = () => { if (expanded.value) positionMenu() }

onMounted(() => {
  eventBus.on('toolpath-stats', onStats)
  eventBus.on('lines-updated', onLinesUpdated)
  document.addEventListener('pointerdown', onDocClick, true)
  window.addEventListener('resize', onWindowResize)
})
onBeforeUnmount(() => {
  eventBus.off('toolpath-stats', onStats)
  eventBus.off('lines-updated', onLinesUpdated)
  document.removeEventListener('pointerdown', onDocClick, true)
  window.removeEventListener('resize', onWindowResize)
  resizeObs?.disconnect()
  resizeObs = null
})
</script>

<style scoped>
/* A bare group sitting directly on the dock, no box of its own; the dock is
   already the container (see the matching note in PlayBack.vue).

   min-height, rather than stretching to the row, is what keeps it level with
   the playback group without the two being coupled: both simply state the
   same height, so neither can ever drag the other taller. */
/* No position:relative here, .breakdown positions itself against App.vue's
   .dock-right instead (see the CSS note on .breakdown for why), so this stays
   a plain flex item and doesn't shadow that ancestor lookup. */
.download-container {
  flex: 0 0 auto;
  box-sizing: border-box;
  min-height: 42px;
  display: flex;
  align-items: center;
  padding: 0 4px;
  background: transparent;
}

.dl-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* ── The hero stat ─────────────────────────────────────────────────────────
   Caption over value. Inter with tabular figures rather than Courier New: the
   monospace face was doing nothing the tabular numerals don't already do
   (stable digit width) and clashed with the rest of the UI. */
/* The stat and its caret are one button, a disclosure that happens to be
   showing the figure it discloses. */
.est-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 6px 4px 8px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: inherit;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.2s ease;
}
.est-toggle:hover:not(:disabled) { background: var(--hover-bg); }
.est-toggle:disabled { cursor: default; }
.est-toggle:disabled .est-caret { opacity: 0.35; }

.est-caret {
  font-size: 15px;
  line-height: 1;
  color: var(--text-strong);
  opacity: 0.7;
  transition: transform 0.2s ease;
}
.est-toggle.open .est-caret { transform: rotate(180deg); }

.est {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 1px;
}
/* --text-muted only reaches ~3:1 on the panel, which is fine for the sidebar's
   12-13px labels but too weak for a 10px uppercase caption. Dimmed
   --text-strong instead: ~4.5:1 in both themes, still clearly subordinate to
   the value beneath it. */
.est-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-strong);
  opacity: 0.72;
  white-space: nowrap;
  line-height: 1;
}
.est-value {
  font-size: 25px;
  font-weight: 700;
  line-height: 1.05;
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ── Warnings ──────────────────────────────────────────────────────────── */
.warn-badge {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: rgba(224, 168, 0, 0.14);
  color: #d99500;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.2s ease;
}
.warn-badge:hover { background: rgba(224, 168, 0, 0.28); }

.warn-note {
  margin: 8px 0 0;
  padding: 7px 9px;
  border-radius: 7px;
  background: rgba(224, 168, 0, 0.12);
  border: 1px solid rgba(224, 168, 0, 0.45);
  color: var(--text-strong);
  font-size: 11.5px;
  line-height: 1.35;
}
/* The grid-fall note is a button: click to highlight the parts in the viewer. */
.warn-note.tiny {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  text-align: left;
  cursor: pointer;
  font-family: inherit;
}
.warn-note.tiny:hover { background: rgba(224, 168, 0, 0.2); }
.warn-note.tiny.active {
  background: rgba(255, 140, 0, 0.18);
  border-color: #ff8c00;
}
.warn-action {
  align-self: flex-start;
  font-weight: 600;
  color: #d99500;
  text-decoration: underline;
}
.warn-note.tiny.active .warn-action { color: #ff8c00; }

/* ── Breakdown panel ───────────────────────────────────────────────────
   Flush against the TOP OF THE DOCK, not floating above it with a gap, and
   not flush against just this section's own (lower, narrower) top edge.
   That's why it positions against App.vue's .dock-right rather than
   .download-container: .dock-right's box is deliberately stretched to the
   dock's full height and spans exactly from the separator to the dock's true
   right edge (see its CSS note in App.vue), so `bottom: 100%; left: 0;
   right: 0;` land exactly where each of those three words asked for it,
   using the real geometry rather than an approximated pixel offset.

   Reads as connected to the dock's own chrome, not a separate floating card:
   painted in --panel-bg (matching the dock), no bottom border (the dock's
   own top border is the seam), and only the top-left corner rounded, the
   top-right sits flush against the true right edge, both bottom corners
   flush against the dock itself. */
.breakdown {
  /* position/bottom/left/width come from the inline :style (menuStyle,
     computed in JS by positionMenu) now that this is teleported and
     fixed-positioned - see the template comment for why. Anchored by
     `bottom` rather than `top`, so it grows upward from .dock-right's top
     edge regardless of its own height (the old bottom:calc(100% + 9px) had
     the same self-adjusting property; this is the fixed-position
     equivalent). */
  z-index: 60;   /* below .dock's 65 (App.vue) - see the template comment */
  padding: 12px 14px 10px;
  /* Teleported to #cc-portal-root, a SIBLING of .app-container rather than a
     descendant, so it no longer inherits .app-container's font-family and
     falls back to :root's (style.css) instead - a different stack. Same fix
     as ProfileDropdown's .dropdown-menu and PlayBack's .speed-menu. */
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-right: none;
  border-bottom: none;
  border-radius: 12px 0 0 0;
  /* Box-shadow is back: now that this panel is a genuine SIBLING of .dock
     (teleported out, see the template comment) rather than a descendant of
     it, .dock's own higher z-index actually means something here - its
     opaque background paints in front of this panel wherever they overlap,
     masking the ~10px the blur reaches past this panel's own edge instead of
     it bleeding onto the toolbar. */
  box-shadow: -2px -2px 16px rgba(0, 0, 0, 0.12);
}

/* Grows open from the dock's top edge: scaleY from a compressed sliver up to
   full height, transform-origin pinned to the BOTTOM (not top, like
   ProfileDropdown's menu - this panel opens upward, anchored at its own
   bottom edge where it touches the dock) so the expansion reads as coming
   FROM the dock rather than from the panel's own centre. Same treatment as
   ProfileDropdown's .dropdown-menu and PlayBack's .speed-menu, just flipped
   to match this panel's own anchor side.

   <Transition>'s root is .breakdown itself (see the template comment), Vue
   reads this transition-duration straight off it and correctly delays
   removal until the leave animation finishes. */
.grow-enter-active,
.grow-leave-active {
  transform-origin: bottom center;
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.15s ease;
}
.grow-enter-from,
.grow-leave-to {
  transform: scaleY(0.45);
  opacity: 0;
}

/* ── Breakdown rows ────────────────────────────────────────────────────
   A list rather than a table: three columns do not fit the section's width,
   so the distance sits under its operation name and the time keeps the only
   real column. */
.bd-list { list-style: none; margin: 0; padding: 0; }

.bd-row,
.bd-total {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  color: var(--text-strong);
}

.bd-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.bd-name {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.bd-dist {
  font-size: 10.5px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.bd-time {
  flex-shrink: 0;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* Per-row visibility toggle (view-only, see toggleKindVisibility). */
.bd-eye {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.bd-eye:hover { background: var(--hover-bg); color: var(--text-strong); }
.bd-eye.off { color: var(--text-muted); opacity: 0.55; }
/* Travel's row (not toggleable): keep the same reserved width so every
   row's time lands in one straight column, just don't show or hit-test it. */
.bd-eye.invisible { visibility: hidden; pointer-events: none; }

/* Total row has no button of its own, but needs the same reserved width as
   every .bd-eye above it, for the same reason. */
.bd-eye-spacer { flex-shrink: 0; width: 22px; }

.bd-total {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--ctrl-border);
  font-weight: 700;
}
/* No dot on the total row, indent so its label lines up with the ones above. */
.bd-total .bd-name { padding-left: 16px; }
/* ── Download button, the one filled accent on this side of the dock ────
   Icon-only: its label was ~100px of the group's width. */
.download-btn {
  flex-shrink: 0;
  width: 46px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: #00ADC6;
  color: #fff;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.2s ease, transform 0.15s ease;
}
.download-btn:hover { background: #0093A8; transform: translateY(-1px); }
.download-btn:active { transform: translateY(0); }

.dl-icon { display: block; flex-shrink: 0; }
</style>
