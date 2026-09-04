<template>
  <div class="dropdown-wrapper" ref="root">
    <button
      class="dropdown-toggle"
      :class="{ open }"
      :disabled="disabled"
      @click="!disabled && toggleOpen()"
    >
      <span class="btn-text">{{ selectedLabel }}</span>
      <span class="arrow" :class="{ rotated: open }">▾</span>
    </button>

    <!-- Teleported to the app's portal root, same reason and same pattern as
         PlayBack's speed-menu: the sidebar clips overflow AND (the part that
         actually matters here) establishes its own stacking context, since
         it's position:relative with its own z-index. Anything positioned
         *inside* the sidebar is trapped at that context's rank no matter how
         high its own z-index climbs, so the menu could end up rendering
         BEHIND the top-right controls or the download breakdown panel
         whenever they overlap. Teleporting it out from under the sidebar's
         context is what actually fixes that, not a bigger z-index number.
         Fixed-positioned + measured in JS instead of top:100%, for the same
         reason. -->
    <Teleport to="#cc-portal-root" defer>
      <!-- Grows open from the toggle's own bottom edge (transform-origin:
           top, scaleY from a compressed sliver up to full height) rather
           than sliding a flat few pixels, the button reads as the anchor
           it's expanding out of. :duration is explicit: left to Vue's own
           detection, this turned out unreliable for the breakdown panel
           earlier and could leave a menu stuck mid-transition. -->
      <Transition name="grow-menu" :duration="220">
        <div class="dropdown-menu" ref="menuRef" v-show="open" :style="menuStyle">
          <input
            v-if="searchable"
            ref="searchEl"
            v-model="search"
            class="dropdown-search"
            type="text"
            :placeholder="searchPlaceholder"
            @click.stop
          />
          <div v-if="searchable && filtered.length === 0" class="dropdown-empty">{{ emptyText }}</div>
          <div class="dropdown-list">
            <div
              v-for="(it, i) in filtered"
              :key="itemKey ? it[itemKey] : i"
              class="dropdown-item"
              :class="{ active: isActive(it) }"
              @click="choose(it)"
            >
              <span class="item-name">{{ it[labelKey] }}</span>
              <span v-if="detail" class="item-detail">{{ detail(it) }}</span>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
// Generic, styled profile dropdown - the connected/scrollable menu used for the
// cutter / material / thickness selectors (extracted from the sidebar so the
// desktop sidebar AND the mobile page share one look & behaviour).
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  modelValue: { type: Object, default: null },     // selected item (or null)
  items: { type: Array, default: () => [] },
  placeholder: { type: String, default: '–' },
  disabled: { type: Boolean, default: false },
  labelKey: { type: String, default: 'name' },      // field shown for an item
  itemKey: { type: String, default: '' },           // field used for :key + active match
  detail: { type: Function, default: null },        // (item) => secondary line, optional
  searchable: { type: Boolean, default: false },
  searchPlaceholder: { type: String, default: '' },
  emptyText: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

const open = ref(false)
const search = ref('')
const root = ref(null)
const searchEl = ref(null)
const menuRef = ref(null)

// The menu is teleported out of the sidebar (see template), so it can no
// longer rely on `top: 100%` inside a position:relative wrapper to attach
// itself under the toggle - it's fixed-positioned and measured in JS instead,
// same approach as PlayBack's speed-menu. Zero gap, same width as the toggle,
// so the two still read as one connected control.
const menuStyle = ref({ position: 'fixed', top: '-9999px', left: '-9999px' })

const positionMenu = () => {
  if (!root.value) return
  const btn = root.value.querySelector('.dropdown-toggle')
  if (!btn) return
  const b = btn.getBoundingClientRect()
  menuStyle.value = { position: 'fixed', top: `${b.bottom}px`, left: `${b.left}px`, width: `${b.width}px` }
}

const selectedLabel = computed(() =>
  props.modelValue ? props.modelValue[props.labelKey] : props.placeholder)

const filtered = computed(() => {
  if (!props.searchable) return props.items
  const q = search.value.trim().toLowerCase()
  return q ? props.items.filter((it) => String(it[props.labelKey]).toLowerCase().includes(q)) : props.items
})

const isActive = (it) =>
  props.modelValue && (props.itemKey
    ? it[props.itemKey] === props.modelValue[props.itemKey]
    : it === props.modelValue)

const toggleOpen = () => {
  open.value = !open.value
  if (open.value) {
    positionMenu()
    nextTick(() => {
      positionMenu()   // re-measure once the menu itself exists (offsetHeight etc.)
      if (props.searchable) searchEl.value?.focus()
    })
  }
}

const choose = (it) => {
  emit('update:modelValue', it)
  open.value = false
  search.value = ''
}

// Teleported content lives outside `root`, so the outside-click check needs
// to ALSO exempt the menu itself (same two-part check as PlayBack's speed-menu).
const onDocClick = (e) => {
  if (root.value?.contains(e.target)) return
  if (menuRef.value?.contains(e.target)) return
  open.value = false
}
// Keep the menu aligned with its toggle if the window resizes while open.
const onWindowResize = () => { if (open.value) positionMenu() }

onMounted(() => {
  document.addEventListener('pointerdown', onDocClick, true)
  window.addEventListener('resize', onWindowResize)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocClick, true)
  window.removeEventListener('resize', onWindowResize)
})
</script>

<style scoped>
.dropdown-wrapper { position: relative; }

.dropdown-toggle {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 9px 14px;
  background: var(--ctrl-bg);
  border: 1px solid var(--ctrl-border);
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-strong);
  cursor: pointer;
  transition: background 0.2s;
}
.dropdown-toggle:hover:not(:disabled) { background: var(--ctrl-hover); }
.dropdown-toggle:disabled { opacity: 0.5; cursor: not-allowed; }
/* When open, square off the bottom so the menu continues the button as one box. */
.dropdown-toggle.open {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}

.dropdown-search {
  width: calc(100% - 16px);
  margin: 8px;
  padding: 8px 10px;
  border: 1px solid var(--dropdown-border);
  border-radius: 6px;
  background: var(--panel-bg);
  color: var(--text-strong);
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}
.dropdown-empty {
  padding: 10px 16px;
  font-size: 13px;
  color: var(--text-muted);
}

.arrow {
  margin-left: auto;
  color: var(--text-strong);
  font-size: 17px;
  line-height: 1;
  transition: transform 0.2s;
  display: inline-block;
}
.arrow.rotated { transform: rotate(180deg); }

/* position/top/left/width come from the inline :style (menuStyle, computed
   in JS by positionMenu) now that this is teleported and fixed-positioned -
   see the template comment for why. border-top:none + squared top corners
   keep it reading as continuous with the toggle even though nothing in the
   DOM connects them anymore. */
.dropdown-menu {
  /* Teleported to #cc-portal-root, a SIBLING of .app-container, not a
     descendant of it - so it no longer inherits .app-container's own
     font-family and falls back all the way to :root's (style.css), a
     different stack (system-ui/Roboto vs Segoe UI/Tahoma/Geneva/Verdana).
     Restating it here is what makes the teleported menu match the rest of
     the app again. */
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  background: var(--dropdown-bg);
  border: 1px solid var(--dropdown-border);
  border-top: none;
  border-radius: 0 0 8px 8px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
  z-index: 100;
  overflow: hidden;             /* clip the rounded corners; the list scrolls itself */
}

/* Grows open from the toggle's bottom edge: scaleY from a compressed sliver
   up to full height, transform-origin pinned to the top so the expansion
   reads as coming FROM the toggle rather than from the menu's own centre.
   ease-out-ish curve (a fast start that settles, not linear) so it feels like
   it's unfurling rather than just resizing. */
.grow-menu-enter-active,
.grow-menu-leave-active {
  transform-origin: top center;
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.15s ease;
}
.grow-menu-enter-from,
.grow-menu-leave-to {
  transform: scaleY(0.45);
  opacity: 0;
}

.dropdown-list {
  max-height: 260px;
  overflow-y: auto;
  /* The browser's default scrollbar ignores the app's own theme entirely
     (stays light-grey even in dark mode, reported in Edge) and stands out
     hard against a dark dropdown. scrollbar-color covers Firefox; the
     ::-webkit-scrollbar rules below cover Chromium/Edge/Safari. */
  scrollbar-width: thin;
  scrollbar-color: var(--ctrl-border) transparent;
}
.dropdown-list::-webkit-scrollbar { width: 8px; }
.dropdown-list::-webkit-scrollbar-track { background: transparent; }
.dropdown-list::-webkit-scrollbar-thumb {
  background: var(--ctrl-border);
  border-radius: 4px;
}
.dropdown-list::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

.dropdown-item {
  display: flex;
  flex-direction: column;
  padding: 10px 16px;
  cursor: pointer;
  transition: background 0.15s;
}
.dropdown-item:hover  { background: var(--hover-bg); }
.dropdown-item.active { background: var(--active-bg); }

.item-name   { font-size: 14px; font-weight: 500; color: var(--text-strong); }
.item-detail { font-size: 11px; color: var(--text-muted); margin-top: 1px; }
</style>
