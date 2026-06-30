<template>
  <div class="lang-switcher" ref="root">
    <button class="lang-btn" :title="t('language')" @click="open = !open">
      <span class="flag" v-html="currentLang.flag"></span>
    </button>

    <div v-if="open" class="lang-menu">
      <button
        v-for="l in LANGS"
        :key="l.code"
        class="lang-item"
        :class="{ active: l.code === locale }"
        @click="choose(l.code)"
      >
        <span class="flag" v-html="l.flag"></span>
        <span class="lang-name">{{ l.label }}</span>
      </button>
    </div>
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
.lang-switcher {
  position: absolute;
  top: 66px;            /* directly beneath the dark-mode toggle (top:16 + 42 + 8) */
  right: 16px;
  z-index: 30;          /* above the view toggles so the open dropdown covers them */
}

.lang-btn {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  border: 1px solid var(--panel-border);
  background: var(--card-bg);
  box-shadow: var(--panel-shadow);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: transform 0.15s ease;
}
.lang-btn:hover { transform: scale(1.08); }

/* Flag clipped to a circle for the button, rounded rect in the menu. */
.flag {
  display: block;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  overflow: hidden;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.15);
}
.flag :deep(svg) { width: 100%; height: 100%; display: block; }

.lang-menu {
  position: absolute;
  top: 50px;
  right: 0;
  min-width: 150px;
  background: var(--dropdown-bg);
  border: 1px solid var(--dropdown-border);
  border-radius: 10px;
  box-shadow: var(--panel-shadow);
  overflow: hidden;
  padding: 4px;
}

.lang-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-radius: 7px;
  cursor: pointer;
  color: var(--text-strong);
  font-size: 14px;
  text-align: left;
}
.lang-item:hover { background: var(--hover-bg); }
.lang-item.active { background: var(--active-bg); }

/* In the menu the flag is a small rounded rectangle (not a circle). */
.lang-item .flag {
  width: 26px;
  height: 18px;
  border-radius: 3px;
  flex-shrink: 0;
}

.lang-name { flex: 1; }
</style>
