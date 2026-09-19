<script setup lang="ts">
import { GPU_SUPPORTED, type ModuleKind, getModulesByKind } from '@teilchen/core'
import { addModule, addSystemToScene, duplicateSystem, editor, isCpActive, removeModule, removeSystem, selectModule, selectSystem } from '../store.ts'
import { moduleLabel, t } from '../i18n.ts'

const sections: { kind: ModuleKind }[] = [
    { kind: 'emitter' },
    { kind: 'initializer' },
    { kind: 'operator' },
    { kind: 'renderer' },
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
    <section class="scene">
      <h3>
        {{ t('sec.scene') }} <em>{{ editor.systems.length }}</em>
        <button
          class="scene-add"
          :title="t('scene.add')"
          @click="addSystemToScene()"
        >＋</button>
      </h3>
      <ul>
        <li
          v-for="s in editor.systems"
          :key="s.id"
          :class="{ active: s.id === editor.activeId }"
          @click="selectSystem(s.id)"
        >
          <span
            class="mod-name"
            :title="s.def.name"
          >{{ s.def.name || 'untitled' }}</span>
          <span class="sys-meta">{{ s.def.maxCount.toLocaleString() }}</span>
          <button
            class="rm"
            :title="t('scene.duplicate')"
            @click.stop="duplicateSystem(s.id)"
          >⧉</button>
          <button
            v-if="editor.systems.length > 1"
            class="rm"
            :title="t('action.delete')"
            @click.stop="removeSystem(s.id)"
          >×</button>
        </li>
      </ul>
    </section>

    <section
      v-for="sec in sections"
      :key="sec.kind"
    >
      <h3>{{ t(`sec.${sec.kind}`) }} <em>{{ listFor(sec.kind).length }}</em></h3>
      <ul>
        <li
          v-for="(m, i) in listFor(sec.kind)"
          :key="i"
          :class="{ active: isActive(sec.kind, i) }"
          @click="selectModule(sec.kind, i)"
        >
          <span
            class="mod-name"
            :title="m.name"
          >{{ moduleLabel(sec.kind, m.name, m.name) }}</span>
          <span
            v-if="!isSupported(sec.kind, m.name)"
            class="badge"
            :title="t('badge.unimplementedTip')"
          >{{ t('badge.unimplemented') }}</span>
          <button
            class="rm"
            :title="t('action.delete')"
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
          {{ t(`add.${sec.kind}`) }}
        </option>
        <option
          v-for="s in getModulesByKind(sec.kind)"
          :key="s.name"
          :value="s.name"
        >
          {{ moduleLabel(sec.kind, s.name, s.label) }}{{ isSupported(sec.kind, s.name) ? '' : t('tree.unimplementedSuffix') }}
        </option>
      </select>
    </section>

    <section>
      <h3>{{ t('tree.controlPoints') }} <em>{{ editor.def.controlPoints.filter((_, i) => isCpActive(i)).length }}</em></h3>
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
            :title="t('badge.idleTip')"
          >{{ t('badge.idle') }}</span>
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
            :title="t('badge.notLoadedTip')"
          >{{ t('badge.notLoaded') }}</span>
        </li>
      </ul>
    </section>
  </aside>
</template>
