<template>
  <!-- Same shape as the raster / curve-fidelity / debug controls above: a round
       button in the top-right column whose flyout slides out to the LEFT with
       radio items, plus the same hover hint. It used to drop a differently
       styled menu DOWNWARDS and carry a native `title` tooltip, which read as a
       foreign control sitting in the middle of that column.
       .vt-* classes live in src/theme.css, shared with ViewToggles. -->
  <div class="vt-popover" ref="root">
    <button
      class="vt-btn"
      aria-haspopup="true"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="flag" v-html="currentLang.flag"></span>
      <span class="vt-tip" v-show="!open">{{ t('language') }}</span>
    </button>

    <Transition name="slide-fade" :duration="220">
      <div v-if="open" class="vt-menu">
        <button
          v-for="l in LANGS"
          :key="l.code"
          class="vt-item"
          :class="{ active: l.code === locale }"
          @click="choose(l.code)"
        >
          <span class="vt-radio"></span>
          <span class="flag flag-menu" v-html="l.flag"></span>
          <span class="lang-name">{{ l.label }}</span>
        </button>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { LANGS, locale, currentLang, setLocale, t } from '../translations'

const open = ref(false)
const root = ref(null)

const choose = (code) => { setLocale(code); open.value = false }

const onDocClick = (e) => { if (root.value && !root.value.contains(e.target)) open.value = false }
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<style scoped>
/* Flag clipped to a circle for the button, small rounded rect in the menu -
   the only thing this control needs beyond the shared .vt-* styles. */
.flag {
  display: block;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  overflow: hidden;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.15);
}
.flag :deep(svg) { width: 100%; height: 100%; display: block; }

.flag-menu {
  width: 24px;
  height: 16px;
  border-radius: 3px;
  flex-shrink: 0;
}

.lang-name { flex: 1; }
</style>
