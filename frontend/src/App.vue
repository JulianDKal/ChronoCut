<template>
  <div class="app-container" :class="{ dark: isDark }">
    <!-- Sidebar - Left -->
    <aside class="sidebar">
      <Sidebar />
    </aside>

    <!-- Main Content Area -->
    <div class="main-content">
      <!-- Three.js Viewer fills the whole area -->
      <div class="viewer-container">
        <ThreeViewer />

        <!-- Debug overlay (top-left) -->
        <div class="debug-overlay">Segments: {{ segmentCount.toLocaleString() }}</div>

        <!-- Dark-mode toggle (floating, top-right) -->
        <button
          class="theme-toggle"
          @click="toggleTheme"
          :title="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
        >
          {{ isDark ? '☀' : '☾' }}
        </button>

        <!-- Floating control islands over the preview -->
        <div class="floating-dock" :class="{ 'is-disabled': !hasContent }">
          <div class="island island--timeline">
            <PlayBack />
          </div>
          <div class="island island--download">
            <DownloadComponent />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import ThreeViewer from './components/ThreeViewer.vue'
import Sidebar from './components/Sidebar.vue'
import PlayBack from './components/PlayBack.vue'
import DownloadComponent from './components/DownloadComponent.vue'
import eventBus from './eventBus'

// Controls are greyed out / disabled until a file has been uploaded.
const hasContent = ref(false)
const onLinesUpdated = () => { hasContent.value = true }

// Debug: number of line segments in the current toolpath.
const segmentCount = ref(0)
const onStats = (stats) => { segmentCount.value = stats?.segments ?? 0 }

// Dark mode (the viewer reacts via the 'theme-changed' event).
const isDark = ref(false)
const toggleTheme = () => {
  isDark.value = !isDark.value
  eventBus.emit('theme-changed', isDark.value)
}

onMounted(() => {
  eventBus.on('lines-updated', onLinesUpdated)
  eventBus.on('toolpath-stats', onStats)
})
onBeforeUnmount(() => {
  eventBus.off('lines-updated', onLinesUpdated)
  eventBus.off('toolpath-stats', onStats)
})
</script>

<style scoped>
.app-container {
  display: flex;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;

  /* Theme tokens (consumed by the sidebar, floating islands + child components) */
  --panel-bg: #ffffff;
  --panel-border: rgba(0, 0, 0, 0.06);
  --panel-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  --text-strong: #2c3e50;
  --text-muted: #7f8c8d;
  --track-bg: #ecf0f1;
  --ctrl-border: #353535;
  --dropdown-bg: #ffffff;
  --dropdown-border: #cccccc;
  --hover-bg: rgba(0, 0, 0, 0.05);
  --active-bg: #fff3e0;
}

.app-container.dark {
  --panel-bg: #2a2c30;
  --panel-border: rgba(255, 255, 255, 0.08);
  --panel-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
  --text-strong: #e8eaed;
  --text-muted: #9aa0a6;
  --track-bg: #3a3d42;
  --ctrl-border: #4a4d52;
  --dropdown-bg: #2a2c30;
  --dropdown-border: #3a3d42;
  --hover-bg: rgba(255, 255, 255, 0.06);
  --active-bg: #3a2f1e;
}

/* Sidebar Styles */
.sidebar {
  width: 250px;
  background-color: var(--panel-bg);
  display: flex;
  flex-direction: column;
  box-shadow: 2px 0 5px rgba(0, 0, 0, 0.1);
  z-index: 10;
  transition: background-color 0.25s ease;
}

/* Main Content Area (right of sidebar) */
.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Three.js Viewer Container — fills the area; controls float on top */
.viewer-container {
  flex: 1;
  position: relative;
  overflow: hidden;
}

/* ── Debug overlay ──────────────────────────────────────────────────────── */
.debug-overlay {
  position: absolute;
  top: 14px;
  left: 14px;
  z-index: 20;
  padding: 4px 8px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.55);
  color: #d6f5c8;
  font-family: 'Courier New', monospace;
  font-size: 12px;
  pointer-events: none;
  user-select: none;
}

/* ── Dark-mode toggle ───────────────────────────────────────────────────── */
.theme-toggle {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  border: 1px solid var(--panel-border);
  background: var(--panel-bg);
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

/* ── Floating control dock ──────────────────────────────────────────────── */
.floating-dock {
  position: absolute;
  left: 24px;
  right: 24px;
  bottom: 24px;
  display: flex;
  align-items: flex-end;   /* each island keeps its own height */
  gap: 16px;
  z-index: 10;
  /* Let clicks pass through to the canvas everywhere except on the islands. */
  pointer-events: none;
  transition: opacity 0.25s ease, filter 0.25s ease;
}

.island {
  pointer-events: auto;
  background: var(--panel-bg);
  border-radius: 14px;
  border: 1px solid var(--panel-border);
  box-shadow: var(--panel-shadow);
  overflow: hidden;
}

.island--timeline { flex: 1 1 auto; min-width: 0; }
.island--download { flex: 0 0 auto; }

/* Greyed out until something is uploaded */
.floating-dock.is-disabled {
  opacity: 0.5;
  filter: grayscale(0.75);
}
.floating-dock.is-disabled .island {
  pointer-events: none;
}

/* Responsive */
@media (max-width: 768px) {
  .sidebar { width: 200px; }
  .floating-dock {
    left: 12px;
    right: 12px;
    bottom: 12px;
    flex-direction: column;
  }
}
</style>
