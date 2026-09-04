<template>
  <!-- Same button + hover-hint treatment as every other control in the
       top-right column (.vt-btn / .vt-tip live in src/theme.css). It used to
       carry a native `title` tooltip instead, which looked and timed
       completely differently from its neighbours. -->
  <button class="vt-btn" @click="$emit('toggle')">
    <span class="theme-glyph">{{ isDark ? '☀' : '☾' }}</span>
    <span class="vt-tip">{{ isDark ? t('toLight') : t('toDark') }}</span>
  </button>
</template>

<script setup>
// Floating dark-mode toggle (top-right). Shared by the desktop viewer and the
// mobile page; the parent owns the `isDark` state and persistence.
import { t } from '../translations'
defineProps({ isDark: { type: Boolean, default: false } })
defineEmits(['toggle'])
</script>

<style scoped>
/* The glyph is a text character, not an SVG icon like the neighbours' - it
   needs its own sizing, everything else comes from .vt-btn. */
.theme-glyph {
  display: block;
  font-size: 18px;
  line-height: 1;
}
</style>
