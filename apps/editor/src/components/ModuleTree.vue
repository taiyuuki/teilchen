<script setup lang="ts">
import { GPU_SUPPORTED, type ModuleKind, getModulesByKind } from '@teilchen/core'
import { addModule, editor, isCpActive, removeModule, selectModule } from '../store.ts'

const sections: { kind: ModuleKind, label: string }[] = [
    { kind: 'emitter', label: 'Emitters' },
    { kind: 'initializer', label: 'Initializers' },
    { kind: 'operator', label: 'Operators' },
    { kind: 'renderer', label: 'Renderers' },
]

function listFor(kind: ModuleKind): { name: string }[] {
    return kind === 'emitter'
        ? editor.def.emitters
        : kind === 'initializer'
            ? editor.def.initializers
            : kind === 'operator'
                ? editor.def.operators
                : editor.def.renderers
}

function isSupported(kind: ModuleKind, name: string): boolean {
    return GPU_SUPPORTED.has(`${kind}:${name}`)
}

function onSelectAdd(kind: ModuleKind, e: Event): void {
    const name = (e.target as HTMLSelectElement).value
    if (name) addModule(kind, name);
    (e.target as HTMLSelectElement).value = ''
}

function isActive(kind: ModuleKind | 'child' | 'cp', index: number): boolean {
    const sel = editor.selected

    return sel.kind === kind && sel.index === index
}

function selectCp(index: number): void {
    editor.selected = { kind: 'cp', index }
}
</script>

<template>
  <aside class="panel tree">
    <div
      class="sys-row"
      :class="{ active: editor.selected.kind === 'system' }"
      @click="editor.selected = { kind: 'system' }"
    >
      <span class="sys-icon">◈</span>{{ editor.def.name || 'untitled' }}
      <span class="sys-meta">{{ editor.def.maxCount.toLocaleString() }}</span>
    </div>

    <section
      v-for="sec in sections"
      :key="sec.kind"
    >
      <h3>{{ sec.label }} <em>{{ listFor(sec.kind).length }}</em></h3>
      <ul>
        <li
          v-for="(m, i) in listFor(sec.kind)"
          :key="i"
          :class="{ active: isActive(sec.kind, i) }"
          @click="selectModule(sec.kind, i)"
        >
          <span class="mod-name">{{ m.name }}</span>
          <span
            v-if="!isSupported(sec.kind, m.name)"
            class="badge"
            title="GPU 未实现，将跳过"
          >未实现</span>
          <button
            class="rm"
            title="删除"
            @click.stop="removeModule(sec.kind, i)"
          >
            ×
          </button>
        </li>
      </ul>
      <select
        class="add"
        :data-kind="sec.kind"
        @change="onSelectAdd(sec.kind, $event)"
      >
        <option value="">
          + 添加{{ sec.kind === 'emitter' ? '发射器' : sec.kind === 'initializer' ? '初始化器' : sec.kind === 'operator' ? '操作符' : '渲染器' }}…
        </option>
        <option
          v-for="s in getModulesByKind(sec.kind)"
          :key="s.name"
          :value="s.name"
        >
          {{ s.label }}{{ isSupported(sec.kind, s.name) ? '' : '（未实现）' }}
        </option>
      </select>
    </section>

    <section>
      <h3>控制点 <em>{{ editor.def.controlPoints.filter((_, i) => isCpActive(i)).length }}</em></h3>
      <ul>
        <li
          v-for="(cp, i) in editor.def.controlPoints"
          :key="i"
          :class="{ active: isActive('cp', i), dim: !isCpActive(i) }"
          @click="selectCp(i)"
        >
          <span class="mod-name">cp{{ i }}</span>
          <span
            v-if="cp.lockToPointer"
            class="badge"
          >lock</span>
          <span
            v-if="!isCpActive(i)"
            class="badge"
            title="未被引用且无偏移/角度"
          >空闲</span>
        </li>
      </ul>
    </section>

    <section v-if="editor.def.children.length">
      <h3>Children <em>{{ editor.def.children.length }}</em></h3>
      <ul>
        <li
          v-for="(c, i) in editor.def.children"
          :key="i"
          :class="{ active: isActive('child', i) }"
          @click="editor.selected = { kind: 'child', index: i }"
        >
          <span class="mod-name">{{ c.name || '(unnamed)' }}</span>
          <span
            v-if="c.type !== 'static'"
            class="badge"
          >{{ c.type }}</span>
          <span
            v-if="!c.def"
            class="badge"
            title="子定义未加载（本地 /we 资产缺失）"
          >未加载</span>
        </li>
      </ul>
    </section>
  </aside>
</template>
