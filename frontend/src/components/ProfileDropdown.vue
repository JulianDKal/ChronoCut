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

    <div class="dropdown-menu" v-show="open">
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
  </div>
</template>

<script setup>
// Generic, styled profile dropdown — the connected/scrollable menu used for the
// cutter / material / thickness selectors (extracted from the sidebar so the
// desktop sidebar AND the mobile page share one look & behaviour).
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  modelValue: { type: Object, default: null },     // selected item (or null)
  items: { type: Array, default: () => [] },
  placeholder: { type: String, default: '—' },
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
  if (open.value && props.searchable) nextTick(() => searchEl.value?.focus())
}

const choose = (it) => {
  emit('update:modelValue', it)
  open.value = false
  search.value = ''
}

const onDocClick = (e) => { if (root.value && !root.value.contains(e.target)) open.value = false }
onMounted(() => document.addEventListener('pointerdown', onDocClick, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocClick, true))
</script>

<style scoped>
.dropdown-wrapper { position: relative; }

.dropdown-toggle {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 12px 16px;
  background: var(--ctrl-bg);
  border: 1px solid var(--ctrl-border);
  border-radius: 8px;
  font-size: 14px;
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

.dropdown-menu {
  position: absolute;
  top: 100%;                    /* attached directly to the toggle (no gap) */
  left: 0;
  right: 0;
  background: var(--dropdown-bg);
  border: 1px solid var(--dropdown-border);
  border-top: none;             /* the toggle's bottom border is the seam → connected */
  border-radius: 0 0 8px 8px;   /* only the bottom corners are rounded */
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
  z-index: 100;
  overflow: hidden;             /* clip the rounded corners; the list scrolls itself */
}

.dropdown-list {
  max-height: 260px;
  overflow-y: auto;
}

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
