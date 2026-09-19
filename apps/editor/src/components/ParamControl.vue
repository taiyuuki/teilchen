<script setup lang="ts">
import { computed } from 'vue'
import type { ParamSpec, ParamValue, Vec3 } from '@teilchen/core'
import { t } from '../i18n.ts'

const props = defineProps<{ spec: ParamSpec, modelValue: ParamValue | undefined, labelText?: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: ParamValue): void }>()

const label = computed(() => props.labelText ?? props.spec.label)

function asVec3(v: ParamValue | undefined): Vec3 {
    if (Array.isArray(v)) return v as Vec3
    const n = typeof v === 'number' ? v : Number(v) || 0

    return [n, n, n]
}

function num(): number {
    const v = props.modelValue
    const n = typeof v === 'number' ? v : Array.isArray(v) ? v[0] : Number(v)

    return Number.isFinite(n) ? n : 0
}

function setNum(e: Event): void {
    const raw = (e.target as HTMLInputElement).value
    const n = Number(raw)
    const val = props.spec.type === 'int' ? Math.trunc(n) : n
    emit('update:modelValue', Number.isFinite(val) ? val : 0)
}

function setSlider(e: Event): void {
    const n = Number((e.target as HTMLInputElement).value)
    emit('update:modelValue', props.spec.type === 'int' ? Math.trunc(n) : n)
}

function setAxis(i: number, e: Event): void {
    const v: Vec3 = [...asVec3(props.modelValue)]
    const n = Number((e.target as HTMLInputElement).value)
    v[i] = Number.isFinite(n) ? n : 0
    emit('update:modelValue', v)
}

const isColor = computed(() => props.spec.type === 'color255')

const colorHex = computed({
    get() {
        const v = asVec3(props.modelValue).map(c => Math.max(0, Math.min(255, Math.round(c))))

        return `#${v.map(c => c.toString(16).padStart(2, '0')).join('')}`
    },
    set(hex: string) {
        const m = /^#?([\da-f]{6})$/i.exec(hex)
        if (!m) return
        const s = m[1]
        emit('update:modelValue', [Number.parseInt(s.slice(0, 2), 16), Number.parseInt(s.slice(2, 4), 16), Number.parseInt(s.slice(4, 6), 16)])
    },
})

function onColor(e: Event): void {
    colorHex.value = (e.target as HTMLInputElement).value
}
</script>

<template>
  <div
    class="param"
    :data-type="spec.type"
  >
    <label :title="t('param.tip', { label, key: spec.key })">{{ label }}</label>
    <div
      v-if="spec.type === 'float' || spec.type === 'int'"
      class="scalar"
    >
      <input
        v-if="spec.min !== undefined && spec.max !== undefined"
        type="range"
        :min="spec.min"
        :max="spec.max"
        :step="spec.step ?? (spec.type === 'int' ? 1 : 0.01)"
        :value="num()"
        @input="setSlider"
      >
      <input
        type="number"
        class="num"
        :step="spec.step ?? (spec.type === 'int' ? 1 : 'any')"
        :value="num()"
        @input="setNum"
      >
    </div>
    <input
      v-else-if="spec.type === 'bool'"
      type="checkbox"
      :checked="!!modelValue"
      @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    >
    <div
      v-else-if="spec.type === 'vec3' || spec.type === 'color255'"
      class="vec3"
      :class="{ color: isColor }"
    >
      <span
        v-for="(axis, i) in (['X', 'Y', 'Z'] as const)"
        :key="axis"
        class="axis"
      >
        <em>{{ axis }}</em>
        <input
          type="number"
          step="any"
          :value="asVec3(modelValue)[i]"
          @input="setAxis(i, $event)"
        >
      </span>
      <input
        v-if="isColor"
        type="color"
        :value="colorHex"
        @input="onColor"
      >
    </div>
    <select
      v-else-if="spec.type === 'enum'"
      :value="String(modelValue ?? '')"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option
        v-for="o in spec.options ?? []"
        :key="String(o.value)"
        :value="String(o.value)"
      >
        {{ o.label }}
      </option>
    </select>
  </div>
</template>
