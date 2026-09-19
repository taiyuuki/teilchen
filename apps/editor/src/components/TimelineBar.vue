<script setup lang="ts">
import { editor, resetSystem, stepFrame, togglePaused } from '../store.ts'
import { t } from '../i18n.ts'
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
      ⏯ {{ t('timeline.step') }}
    </button>
    <button @click="resetSystem()">
      ↺ {{ t('timeline.reset') }}
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
      :title="t('timeline.showAllCpsTip')"
    ><input
      v-model="editor.showAllCps"
      type="checkbox"
    >{{ t('timeline.showAllCps') }}</label>
    <label class="gizmo-toggle"><input
      v-model="editor.gizmos"
      type="checkbox"
    >gizmos</label>
  </footer>
</template>
