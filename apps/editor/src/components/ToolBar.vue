<script setup lang="ts">
import { ref } from 'vue'
import { PRESET_DEFS, type TextureChoice, WE_PRESET_DEFS, editor, exportWeJson, importWeJson, loadDef, loadWePreset, setTexture } from '../store.ts'
import { exportStandaloneHtml } from '../exportHtml.ts'
import { i18n, setLocale, t } from '../i18n.ts'

const fileInput = ref<HTMLInputElement | null>(null)
const textureFile = ref<HTMLInputElement | null>(null)
const texFile = ref<HTMLInputElement | null>(null)

async function onPreset(e: Event): Promise<void> {
    const v = (e.target as HTMLSelectElement).value
    if (v.startsWith('p:')) {
        const p = PRESET_DEFS.find(x => x.id === v.slice(2))
        if (p) loadDef(p.load())
    }
    else if (v.startsWith('w:')) {
        await loadWePreset(v.slice(2))
    }
    (e.target as HTMLSelectElement).value = ''
}

async function onImportFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) await importWeJson(await file.text())
    input.value = ''
}

function onTextureSelect(e: Event): void {
    const name = (e.target as HTMLSelectElement).value as TextureChoice
    if (name === 'upload') {
        textureFile.value?.click()
    }
    else if (name === 'tex') {
        texFile.value?.click()
    }
    else {
        void setTexture(name)
    }
    (e.target as HTMLSelectElement).value = editor.textureName === 'upload' ? 'upload' : editor.textureName
}

async function onTextureFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) await setTexture('upload', file)
    input.value = ''
}

async function onTexFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement
    const files = Array.from(input.files ?? [])
    const isDesc = (f: File) => f.name.toLowerCase().endsWith('.json') || f.name.toLowerCase().endsWith('.tex-json')
    const tex = files.find(f => !isDesc(f))
    const desc = files.find(f => isDesc(f))
    if (tex) await setTexture('tex', tex, desc)
    input.value = ''
}
</script>

<template>
  <header class="toolbar">
    <h1>teilchen <span>editor</span></h1>
    <select @change="onPreset">
      <option value="">
        {{ t('toolbar.presets') }}
      </option>
      <optgroup :label="t('toolbar.groupProgram')">
        <option
          v-for="p in PRESET_DEFS"
          :key="p.id"
          :value="`p:${p.id}`"
        >
          {{ t(p.labelKey) }}
        </option>
      </optgroup>
      <optgroup :label="t('toolbar.groupWe')">
        <option
          v-for="p in WE_PRESET_DEFS"
          :key="p.file"
          :value="`w:${p.file}`"
        >
          {{ t(p.labelKey) }}
        </option>
      </optgroup>
    </select>
    <button @click="fileInput?.click()">
      {{ t('toolbar.import') }}
    </button>
    <input
      ref="fileInput"
      type="file"
      accept=".json,application/json"
      hidden
      @change="onImportFile"
    >
    <button @click="exportWeJson()">
      {{ t('toolbar.export') }}
    </button>
    <button @click="exportStandaloneHtml()">
      {{ t('toolbar.exportHtml') }}
    </button>
    <select @change="onTextureSelect">
      <option
        value="halo"
        :selected="editor.textureName === 'halo'"
      >
        {{ t('toolbar.texHalo') }}
      </option>
      <option
        value="white"
        :selected="editor.textureName === 'white'"
      >
        {{ t('toolbar.texWhite') }}
      </option>
      <option value="upload">
        {{ t('toolbar.texUpload') }}
      </option>
      <option
        value="tex"
        :selected="editor.textureName === 'tex' || editor.textureName === 'tex-sprite'"
      >
        {{ t('toolbar.texImport') }}
      </option>
    </select>
    <input
      ref="textureFile"
      type="file"
      accept="image/*"
      hidden
      @change="onTextureFile"
    >
    <input
      ref="texFile"
      type="file"
      accept=".tex,.tex-json,.json"
      multiple
      hidden
      @change="onTexFile"
    >
    <div class="lang">
      <button
        :class="{ active: i18n.locale === 'zh' }"
        title="中文"
        @click="setLocale('zh')"
      >
        中
      </button>
      <button
        :class="{ active: i18n.locale === 'en' }"
        title="English"
        @click="setLocale('en')"
      >
        EN
      </button>
    </div>
  </header>
</template>
