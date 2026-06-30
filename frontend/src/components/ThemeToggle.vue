<template>
  <button
    class="theme-toggle"
    @click="$emit('toggle')"
    :title="isDark ? t('toLight') : t('toDark')"
  >
    {{ isDark ? '☀' : '☾' }}
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
.theme-toggle {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  border: 1px solid var(--panel-border);
  background: var(--card-bg);
  color: var(--text-strong);
  box-shadow: var(--panel-shadow);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
  transition: transform 0.15s ease, background 0.2s ease;
}
.theme-toggle:hover { transform: scale(1.08); }
</style>
