<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{ modelValue: string; label: string; withTime?: boolean; withSeconds?: boolean; optional?: boolean; minDate?: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const open = ref(false);
const month = ref(new Date().getMonth());
const year = ref(new Date().getFullYear());
const selected = ref('');
const hour = ref('00');
const minute = ref('00');
const second = ref('00');
const pad = (value: number) => String(value).padStart(2, '0');
const years = computed(() => Array.from({ length: 11 }, (_, index) => year.value - 5 + index));
const days = computed(() => {
  const offset = (new Date(year.value, month.value, 1).getDay() + 6) % 7;
  const count = new Date(year.value, month.value + 1, 0).getDate();
  return Array.from({ length: Math.ceil((offset + count) / 7) * 7 }, (_, index) => {
    const day = index - offset + 1;
    return day > 0 && day <= count ? `${year.value}-${pad(month.value + 1)}-${pad(day)}` : '';
  });
});
function show() {
  const value = props.modelValue;
  const date = value ? new Date(`${value.slice(0, 10)}T12:00:00`) : new Date();
  year.value = date.getFullYear(); month.value = date.getMonth();
  selected.value = value.slice(0, 10); hour.value = value.slice(11, 13) || '00'; minute.value = value.slice(14, 16) || '00'; second.value = value.slice(17, 19) || '00';
  open.value = !open.value;
}
function moveMonth(offset: number) {
  const next = new Date(year.value, month.value + offset, 1);
  year.value = next.getFullYear(); month.value = next.getMonth();
}
function choose(value: string) {
  if (props.minDate && value < props.minDate) return;
  selected.value = value;
  if (!props.withTime) commit();
}
function commit() {
  if (!selected.value) return;
  emit('update:modelValue', selected.value + (props.withTime ? `T${hour.value}:${minute.value}${props.withSeconds ? `:${second.value}` : ''}` : ''));
  open.value = false;
}
</script>

<template>
  <div class="date-picker" @keydown.esc="open = false" @focusout="!($event.currentTarget as HTMLElement).contains($event.relatedTarget as Node) && (open = false)">
    <button type="button" class="date-trigger" :aria-label="label" :aria-expanded="open" @click="show">
      <span>{{ modelValue ? modelValue.replace('T', ' ') : `选择${label}` }}</span><span aria-hidden="true">▦</span>
    </button>
    <div v-if="open" class="calendar-panel" role="group" :aria-label="`${label}选择器`">
      <div class="calendar-navigation">
        <button type="button" aria-label="上个月" @click="moveMonth(-1)">‹</button>
        <select v-model.number="year" aria-label="年份"><option v-for="item in years" :key="item" :value="item">{{ item }}年</option></select>
        <select v-model.number="month" aria-label="月份"><option v-for="item in 12" :key="item" :value="item - 1">{{ item }}月</option></select>
        <button type="button" aria-label="下个月" @click="moveMonth(1)">›</button>
      </div>
      <div class="calendar-days">
        <span v-for="day in ['一','二','三','四','五','六','日']" :key="day">{{ day }}</span>
        <template v-for="(day, index) in days" :key="index">
          <button v-if="day" type="button" :aria-label="day" :aria-current="selected === day ? 'date' : undefined" :disabled="Boolean(minDate && day < minDate)" :class="{ selected: selected === day }" @click="choose(day)">{{ Number(day.slice(-2)) }}</button>
          <span v-else />
        </template>
      </div>
      <div v-if="withTime" class="calendar-time">
        <span>时间</span><select v-model="hour" aria-label="小时"><option v-for="item in 24" :key="item" :value="pad(item - 1)">{{ pad(item - 1) }} 时</option></select>
        <select v-model="minute" aria-label="分钟"><option v-for="item in 60" :key="item" :value="pad(item - 1)">{{ pad(item - 1) }} 分</option></select>
        <select v-if="withSeconds" v-model="second" aria-label="秒"><option v-for="item in 60" :key="item" :value="pad(item - 1)">{{ pad(item - 1) }} 秒</option></select>
        <button type="button" :disabled="!selected" @click="commit">确定</button>
      </div>
      <button v-if="optional" type="button" class="quiet-action" @click="emit('update:modelValue', ''); open = false">不设置截止时间</button>
    </div>
  </div>
</template>

<style scoped>
.date-picker { position: relative; min-width: 0; }
.date-trigger { width: 100%; display: flex; justify-content: space-between; gap: 12px; border: 1px solid #2b3d53; background: #08131f; color: #e8edf5; font-weight: 500; }
.calendar-panel { position: absolute; z-index: 30; top: calc(100% + 6px); left: 0; width: min(330px, calc(100vw - 90px)); padding: 12px; border: 1px solid #426078; border-radius: 6px; background: #102033; box-shadow: 0 12px 30px #0008; }
.calendar-navigation { display: grid; grid-template-columns: 28px 1fr 1fr 28px; gap: 5px; }
.calendar-navigation button,.calendar-days button { padding: 6px; background: transparent; color: #e8edf5; }
.calendar-panel select { padding: 7px 3px; font: inherit; }
.calendar-days { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; margin: 10px 0; text-align: center; }
.calendar-days > span { min-height: 26px; padding: 5px; color: #91a5bd; }
.calendar-days button:hover,.calendar-days button.selected { background: #5ce1c2; color: #07101c; }
.calendar-days button:disabled { color: #52667d; cursor: not-allowed; opacity: .55; }
.calendar-days button:disabled:hover { background: transparent; color: #52667d; }
.calendar-time { display: flex; align-items: center; gap: 6px; padding-top: 10px; border-top: 1px solid #2b3d53; }
.calendar-time select { min-width: 0; flex: 1; }.calendar-time button { padding: 8px; }
</style>
