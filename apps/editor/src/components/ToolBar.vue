<script setup lang="ts">
import { ref } from 'vue'
import { PRESET_DEFS, type TextureChoice, editor, exportWeJson, importWeJson, loadDef, setTexture } from '../store.ts'

const fileInput = ref<HTMLInputElement | null>(null)
const textureFile = ref<HTMLInputElement | null>(null)
const texFile = ref<HTMLInputElement | null>(null)

function onPreset(e: Event): void {
    const id = (e.target as HTMLSelectElement).value
    const p = PRESET_DEFS.find(x => x.id === id)
    if (p) loadDef(p.load());
    (e.target as HTMLSelectElement).value = ''
}

async function onImportFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) importWeJson(await file.text())
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
    const file = input.files?.[0]
    if (file) await setTexture('tex', file)
    input.value = ''
}
</script>

<template>
  <header class="toolbar">
    <h1>teilchen <span>editor</span></h1>
    <select @change="onPreset">
      <option value="">
        预设 Presets…
      </option>
      <option
        v-for="p in PRESET_DEFS"
        :key="p.id"
        :value="p.id"
      >
        {{ p.label }}
      </option>
    </select>
    <button @click="fileInput?.click()">
      导入 WE JSON
    </button>
    <input
      ref="fileInput"
      type="file"
      accept=".json,application/json"
      hidden
      @change="onImportFile"
    >
    <button @click="exportWeJson()">
      导出
    </button>
    <select @change="onTextureSelect">
      <option
        value="halo"
        :selected="editor.textureName === 'halo'"
      >
        贴图：halo
      </option>
      <option
        value="white"
        :selected="editor.textureName === 'white'"
      >
        贴图：white
      </option>
      <option value="upload">
        贴图：上传图片…
      </option>
      <option
        value="tex"
        :selected="editor.textureName === 'tex' || editor.textureName === 'tex-sprite'"
      >
        贴图：导入 .tex（WE）…
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
      accept=".tex"
      hidden
      @change="onTexFile"
    >
  </header>
</template>
