<script setup lang="ts">
import ToolBar from './components/ToolBar.vue'
import ModuleTree from './components/ModuleTree.vue'
import PreviewCanvas from './components/PreviewCanvas.vue'
import PropertyPanel from './components/PropertyPanel.vue'
import TimelineBar from './components/TimelineBar.vue'
</script>

<template>
  <div class="app">
    <ToolBar />
    <div class="main">
      <ModuleTree />
      <div class="center">
        <PreviewCanvas />
        <TimelineBar />
      </div>
      <PropertyPanel />
    </div>
  </div>
</template>
