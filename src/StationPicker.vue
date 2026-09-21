<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = withDefaults(defineProps<{
  modelValue: string;
  options: string[];
  placeholder?: string;
  required?: boolean;
  ariaLabel?: string;
}>(), { placeholder: "请选择车站", required: false, ariaLabel: "车站" });
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const query = ref(props.modelValue);
const open = ref(false);
const highlighted = ref(0);
const root = ref<HTMLElement | null>(null);
const filteredOptions = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase();
  const values = [...new Set(props.options)].filter(Boolean);
  return (keyword ? values.filter((station) => station.toLocaleLowerCase().includes(keyword)) : values).slice(0, 80);
});
watch(() => props.modelValue, (value) => { if (value !== query.value) query.value = value; });
function update(value: string) { query.value = value; emit("update:modelValue", props.options.includes(value) ? value : ""); open.value = true; highlighted.value = 0; }
function choose(value: string) { query.value = value; emit("update:modelValue", value); open.value = false; }
function handleKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown") { event.preventDefault(); open.value = true; highlighted.value = Math.min(highlighted.value + 1, Math.max(filteredOptions.value.length - 1, 0)); }
  else if (event.key === "ArrowUp") { event.preventDefault(); highlighted.value = Math.max(highlighted.value - 1, 0); }
  else if (event.key === "Enter" && open.value && filteredOptions.value[highlighted.value]) { event.preventDefault(); choose(filteredOptions.value[highlighted.value]); }
  else if (event.key === "Escape") open.value = false;
}
function closeOnOutside(event: MouseEvent) { if (root.value && !root.value.contains(event.target as Node)) open.value = false; }
function deferClose() { window.setTimeout(() => { open.value = false; }, 120); }
nextTick(() => document.addEventListener("mousedown", closeOnOutside));
onBeforeUnmount(() => document.removeEventListener("mousedown", closeOnOutside));
</script>

<template>
  <div ref="root" class="station-picker">
    <input :value="query" :placeholder="placeholder" :required="required" :aria-label="ariaLabel" aria-autocomplete="list" :aria-expanded="open" @input="update(($event.target as HTMLInputElement).value)" @focus="open = true" @keydown="handleKeydown" @blur="deferClose" />
    <div v-if="open" class="station-picker-menu" role="listbox">
      <button v-for="(station, index) in filteredOptions" :key="station" type="button" role="option" :aria-selected="station === modelValue" :class="{ highlighted: index === highlighted }" @mousedown.prevent="choose(station)">{{ station }}</button>
      <span v-if="!filteredOptions.length" class="station-picker-empty">没有匹配的车站</span>
    </div>
  </div>
</template>
