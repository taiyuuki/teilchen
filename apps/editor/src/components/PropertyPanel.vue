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
import { editor, openChildAsSystem } from '../store.ts'
import ParamControl from './ParamControl.vue'

const kindLabels: Record<ModuleKind, string> = {
    emitter:     'Emitter',
    initializer: 'Initializer',
    operator:    'Operator',
    renderer:    'Renderer',
}

const selectedModule = computed<{ kind: ModuleKind, mod: ParticleModule } | null>(() => {
    const sel = editor.selected
    if (sel.kind === 'system' || sel.kind === 'child' || sel.kind === 'cp') return null
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

const selectedChild = computed(() => {
    const sel = editor.selected

    return sel.kind === 'child' ? editor.def.children[sel.index] : null
})

/** 左侧树选中的控制点（带引用摘要）。 */
const selectedCp = computed(() => {
    const sel = editor.selected
    if (sel.kind !== 'cp') return null
    const cp = editor.def.controlPoints[sel.index]
    if (!cp) return null
    const refs: string[] = []
    const scan = (kind: string, list: Record<string, unknown>[]) => {
        for (const m of list) {
            for (const [k, v] of Object.entries(m)) {
                if (k.startsWith('controlpoint') && Number(v) === sel.index) refs.push(`${kind}·${m.name}`)
            }
        }
    }
    scan('emitter', editor.def.emitters)
    scan('initializer', editor.def.initializers)
    scan('operator', editor.def.operators)
    for (const c of editor.def.children) {
        if (c.controlPointStartIndex === sel.index) refs.push(`child·${c.name || '(unnamed)'}`)
    }

    return { index: sel.index, cp, usage: refs.join('、') }
})

/** 选中 child 的子定义概要（只读展示；子定义本体的模块编辑待后续）。 */
const childSummary = computed(() => {
    const d = selectedChild.value?.def
    if (!d) return null

    return {
        maxCount:     d.maxCount,
        emitters:     d.emitters.length,
        initializers: d.initializers.length,
        operators:    d.operators.length,
        renderers:    d.renderers.length,
        children:     d.children.length,
    }
})

const blendings: BlendMode[] = ['additive', 'translucent', 'normal', 'alphatocoverage', 'disabled']

const animationModes = [
    { value: 'sequence', label: 'sequence 序列' },
    { value: 'randomframe', label: 'randomframe 随机帧' },
] as const

const DEG = 180 / Math.PI
const deg = (rad: number): number => Number((rad * DEG).toFixed(1))

function setCpVec(cpIndex: number, key: 'angles' | 'offset' | 'spin', i: number, e: Event, inDeg = false): void {
    const cp = editor.def.controlPoints[cpIndex]
    const v = [...cp[key]] as Vec3
    let n = Number((e.target as HTMLInputElement).value) || 0
    if (inDeg) n = n / DEG
    v[i] = n
    cp[key] = v
}

function setChildVec(key: 'angles' | 'origin' | 'scale', i: number, e: Event): void {
    const c = selectedChild.value
    if (!c) return
    const v = [...c[key]] as Vec3
    v[i] = Number((e.target as HTMLInputElement).value) || 0
    c[key] = v
}

function openSelectedChild(): void {
    const sel = editor.selected
    if (sel.kind === 'child') void openChildAsSystem(sel.index)
}

function setOrigin(i: number, e: Event): void {
    const v = [...editor.def.origin] as Vec3
    v[i] = Number((e.target as HTMLInputElement).value) || 0
    editor.def.origin = v
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
          <label title="WE animationmode：序列播放或随机帧">动画模式</label>
          <select v-model="editor.def.animationMode">
            <option
              v-for="m in animationModes"
              :key="m.value"
              :value="m.value"
            >
              {{ m.label }}
            </option>
          </select>
        </div>
        <div class="param">
          <label title="WE sequencemultiplier：序列播放速率倍数">序列倍率</label><input
            v-model.number="editor.def.sequenceMultiplier"
            type="number"
            step="0.1"
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
        <p class="tip">
          控制点在左侧树「控制点」一栏选择编辑
        </p>
      </template>

      <!-- 单个控制点属性（左侧树选中） -->
      <template v-else-if="selectedCp">
        <h2>控制点 <code>cp{{ selectedCp.index }}</code></h2>
        <p class="tip">
          lock = 跟随鼠标（WE locktopointer）；角度 = WE「控制点角度」（°，ZYX），旋转 vortex 轴/attract 原点；自转 = 角度进动速度（°/s，预览扩展）
        </p>
        <p
          v-if="selectedCp.usage"
          class="tip"
        >
          引用：{{ selectedCp.usage }}
        </p>
        <p
          v-else
          class="tip"
        >
          未被任何模块引用
        </p>
        <div class="param">
          <label>锁定鼠标</label>
          <label class="cp-lock"><input
            v-model="selectedCp.cp.lockToPointer"
            type="checkbox"
          >跟随指针（locktopointer）</label>
        </div>
        <div class="param">
          <label>偏移 Offset</label>
          <div class="vec3">
            <span
              v-for="(axis, j) in (['X', 'Y', 'Z'] as const)"
              :key="axis"
              class="axis"
            >
              <em>{{ axis }}</em><input
                type="number"
                step="any"
                :value="selectedCp.cp.offset[j]"
                @input="setCpVec(selectedCp.index, 'offset', j, $event)"
              >
            </span>
          </div>
        </div>
        <div class="param">
          <label
            title="控制点角度（°，ZYX 欧拉）——旋转 vortex 轴/attract 原点"
          >角度 Angles</label>
          <div class="vec3">
            <span
              v-for="(axis, j) in (['X', 'Y', 'Z'] as const)"
              :key="axis"
              class="axis"
            >
              <em>{{ axis }}</em><input
                type="number"
                step="1"
                :value="deg(selectedCp.cp.angles[j])"
                @input="setCpVec(selectedCp.index, 'angles', j, $event, true)"
              >
            </span>
          </div>
        </div>
        <div class="param">
          <label
            title="角度自转速度（°/s）——线性进动，对应 WE controlpointangle 动画轨道"
          >自转 Spin</label>
          <div class="vec3">
            <span
              v-for="(axis, j) in (['X', 'Y', 'Z'] as const)"
              :key="axis"
              class="axis"
            >
              <em>{{ axis }}</em><input
                type="number"
                step="1"
                :value="deg(selectedCp.cp.spin[j])"
                @input="setCpVec(selectedCp.index, 'spin', j, $event, true)"
              >
            </span>
          </div>
        </div>
      </template>

      <!-- child 声明（子定义作为资产：独立打开编辑，不内嵌编辑） -->
      <template v-else-if="selectedChild">
        <h2>Child <code>{{ selectedChild.name || '(unnamed)' }}</code></h2>
        <p class="tip">
          子系统声明（WE children 项）；子定义作为独立资产，点下方按钮载入编辑器单独修改与导出。
        </p>
        <button
          v-if="selectedChild.def"
          class="open-child"
          @click="openSelectedChild()"
        >
          在编辑器中打开（独立编辑）
        </button>
        <div class="param">
          <label>Type</label><input
            :value="selectedChild.type"
            type="text"
            disabled
          >
        </div>
        <div class="param">
          <label title="event 类实例数上限">Max Count</label><input
            v-model.number="selectedChild.maxCount"
            type="number"
            min="1"
          >
        </div>
        <div class="param">
          <label>Probability</label><input
            v-model.number="selectedChild.probability"
            type="number"
            step="0.05"
            min="0"
            max="1"
          >
        </div>
        <div class="param">
          <label>CP Start</label><input
            v-model.number="selectedChild.controlPointStartIndex"
            type="number"
            min="0"
            max="7"
          >
        </div>
        <div class="param">
          <label>Origin</label>
          <div class="vec3">
            <span
              v-for="(axis, i) in (['X', 'Y', 'Z'] as const)"
              :key="axis"
              class="axis"
            >
              <em>{{ axis }}</em><input
                type="number"
                step="any"
                :value="selectedChild.origin[i]"
                @input="setChildVec('origin', i, $event)"
              >
            </span>
          </div>
        </div>
        <div class="param">
          <label>Scale</label>
          <div class="vec3">
            <span
              v-for="(axis, i) in (['X', 'Y', 'Z'] as const)"
              :key="axis"
              class="axis"
            >
              <em>{{ axis }}</em><input
                type="number"
                step="any"
                :value="selectedChild.scale[i]"
                @input="setChildVec('scale', i, $event)"
              >
            </span>
          </div>
        </div>
        <div class="param">
          <label>Angles</label>
          <div class="vec3">
            <span
              v-for="(axis, i) in (['X', 'Y', 'Z'] as const)"
              :key="axis"
              class="axis"
            >
              <em>{{ axis }}</em><input
                type="number"
                step="any"
                :value="selectedChild.angles[i]"
                @input="setChildVec('angles', i, $event)"
              >
            </span>
          </div>
        </div>
        <template v-if="childSummary">
          <h3 class="sub">
            子定义概要
          </h3>
          <p class="tip">
            max {{ childSummary.maxCount.toLocaleString() }} · emitter {{ childSummary.emitters }} · initializer {{ childSummary.initializers }} · operator {{ childSummary.operators }} · renderer {{ childSummary.renderers }}<template v-if="childSummary.children">
              · children {{ childSummary.children }}
            </template>
          </p>
        </template>
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
