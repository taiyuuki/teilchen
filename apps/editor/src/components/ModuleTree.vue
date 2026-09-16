<script setup lang="ts">
import { GPU_SUPPORTED, type ModuleKind, getModulesByKind } from '@teilchen/core'
import { addModule, editor, removeModule, selectModule } from '../store.ts'

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

function isActive(kind: ModuleKind, index: number): boolean {
    const sel = editor.selected

    return sel.kind === kind && sel.index === index
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
  </aside>
</template>
