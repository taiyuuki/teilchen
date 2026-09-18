<script setup lang="ts">
import { computed, ref } from 'vue'
import {
    type BlendMode,
    COLOR_BLEND_MODES,
    type ModuleKind,
    type ParticleModule,
    type Vec3,
    getModuleSpec,
} from '@teilchen/core'
import { editor } from '../store.ts'
import ParamControl from './ParamControl.vue'

const kindLabels: Record<ModuleKind, string> = {
    emitter:     'Emitter',
    initializer: 'Initializer',
    operator:    'Operator',
    renderer:    'Renderer',
}

const selectedModule = computed<{ kind: ModuleKind, mod: ParticleModule } | null>(() => {
    const sel = editor.selected
    if (sel.kind === 'system') return null
    const list = sel.kind === 'emitter'
        ? editor.def.emitters
        : sel.kind === 'initializer'
            ? editor.def.initializers
            : sel.kind === 'operator'
                ? editor.def.operators
                : editor.def.renderers
    const mod = list[sel.index]

    return mod ? { kind: sel.kind, mod } : null
})

const spec = computed(() => {
    const m = selectedModule.value

    return m ? getModuleSpec(m.kind, m.mod.name) : undefined
})

const blendings: BlendMode[] = ['additive', 'translucent', 'normal', 'alphatocoverage', 'disabled']

function setOrigin(i: number, e: Event): void {
    const v = [...editor.def.origin] as Vec3
    v[i] = Number((e.target as HTMLInputElement).value) || 0
    editor.def.origin = v
}

function setCpOffset(cpIndex: number, i: number, e: Event): void {
    const v = [...editor.def.controlPoints[cpIndex].offset] as Vec3
    v[i] = Number((e.target as HTMLInputElement).value) || 0
    editor.def.controlPoints[cpIndex].offset = v
}

const PANEL_MIN = 300
const PANEL_MAX = 620

const panelWidth = ref(Math.min(PANEL_MAX, Math.max(PANEL_MIN, Number(localStorage.getItem('teilchen.propsWidth')) || 360)))
const resizing = ref(false)

function startResize(e: PointerEvent): void {
    const handle = e.currentTarget as HTMLElement
    const startX = e.clientX
    const startW = panelWidth.value
    resizing.value = true
    handle.setPointerCapture(e.pointerId)
    document.body.style.cursor = 'col-resize'
    const move = (ev: PointerEvent): void => {
        panelWidth.value = Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW + (startX - ev.clientX))))
    }
    const up = (): void => {
        handle.removeEventListener('pointermove', move)
        document.body.style.cursor = ''
        resizing.value = false
        localStorage.setItem('teilchen.propsWidth', String(panelWidth.value))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up, { once: true })
    handle.addEventListener('pointercancel', up, { once: true })
}
</script>

<template>
  <div class="props-wrap">
    <div
      class="resize-handle"
      :class="{ dragging: resizing }"
      @pointerdown="startResize"
    />
    <aside
      class="panel props"
      :style="{ width: `${panelWidth}px` }"
    >
    <!-- 系统级属性 -->
    <template v-if="editor.selected.kind === 'system'">
      <h2>系统 System</h2>
      <div class="param">
        <label>名称</label><input
          v-model="editor.def.name"
          type="text"
          spellcheck="false"
        >
      </div>
      <div class="param">
        <label>Max Count</label><input
          v-model.number="editor.def.maxCount"
          type="number"
        >
      </div>
      <div class="param">
        <label>Start Time（预热）</label><input
          v-model.number="editor.def.startTime"
          type="number"
          step="0.5"
          min="0"
        >
      </div>
      <div class="param">
        <label>混合 Blending</label>
        <select v-model="editor.def.material.blending">
          <option
            v-for="b in blendings"
            :key="b"
            :value="b"
          >
            {{ b }}
          </option>
        </select>
      </div>
      <div class="param">
        <label title="颜色混合 BlendMode（colorBlendMode）">颜色混合</label>
        <select v-model="editor.def.material.colorBlendMode">
          <option
            v-for="m in COLOR_BLEND_MODES"
            :key="m.value"
            :value="m.value"
          >
            {{ m.value }} · {{ m.label }}
          </option>
        </select>
      </div>
      <div class="param">
        <label>原点 Origin</label>
        <div class="vec3">
          <span
            v-for="(axis, i) in (['X', 'Y', 'Z'] as const)"
            :key="axis"
            class="axis"
          >
            <em>{{ axis }}</em><input
              type="number"
              step="any"
              :value="editor.def.origin[i]"
              @input="setOrigin(i, $event)"
            >
          </span>
        </div>
      </div>

      <h2>控制点 Control Points</h2>
      <p class="tip">
        lock = 跟随鼠标（WE locktopointer）
      </p>
      <div
        v-for="(cp, i) in editor.def.controlPoints"
        :key="i"
        class="cp-row"
      >
        <span class="cp-id">cp{{ i }}</span>
        <label class="cp-lock"><input
          v-model="cp.lockToPointer"
          type="checkbox"
        >lock</label>
        <div class="vec3">
          <span
            v-for="(axis, j) in (['X', 'Y', 'Z'] as const)"
            :key="axis"
            class="axis"
          >
            <em>{{ axis }}</em><input
              type="number"
              step="any"
              :value="cp.offset[j]"
              @input="setCpOffset(i, j, $event)"
            >
          </span>
        </div>
      </div>
    </template>

    <!-- 模块属性（注册表驱动） -->
    <template v-else-if="selectedModule && spec">
      <h2>{{ kindLabels[selectedModule.kind] }} <code>{{ selectedModule.mod.name }}</code></h2>
      <p
        v-if="spec.description"
        class="tip"
      >
        {{ spec.description }}
      </p>
      <ParamControl
        v-for="p in spec.params"
        :key="p.key"
        v-model="selectedModule.mod[p.key]"
        :spec="p"
      />
    </template>

    <template v-else>
      <h2>{{ selectedModule ? kindLabels[selectedModule.kind] : '属性' }}</h2>
      <p class="tip">
        未注册的模块 "{{ selectedModule?.mod.name }}"：字段保留（兼容 WE round-trip），但无参数面板。
      </p>
    </template>
  </aside>
  </div>
</template>
