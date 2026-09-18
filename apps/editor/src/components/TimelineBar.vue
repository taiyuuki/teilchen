<script setup lang="ts">
import { editor, resetSystem, stepFrame, togglePaused } from '../store.ts'
</script>

<template>
  <footer class="timeline">
    <button
      :class="{ active: editor.paused }"
      @click="togglePaused()"
    >
      {{ editor.paused ? '▶' : '⏸' }}
    </button>
    <button @click="stepFrame()">
      ⏯ 单步
    </button>
    <button @click="resetSystem()">
      ↺ 重置
    </button>
    <div class="readout">
      <span>fps <b>{{ editor.stats.fps || '—' }}</b></span>
      <span>alive <b>{{ editor.stats.alive.toLocaleString() }}</b></span>
      <span>drawn <b>{{ editor.stats.drawn.toLocaleString() }}</b></span>
      <span>t <b>{{ editor.stats.time.toFixed(1) }}s</b></span>
    </div>
    <div class="spacer" />
    <label
      class="gizmo-toggle"
      title="关闭时只显示被引用/有偏移/锁定的控制点"
    ><input
      v-model="editor.showAllCps"
      type="checkbox"
    >全部控制点</label>
    <label class="gizmo-toggle"><input
      v-model="editor.gizmos"
      type="checkbox"
    >gizmos</label>
  </footer>
</template>
