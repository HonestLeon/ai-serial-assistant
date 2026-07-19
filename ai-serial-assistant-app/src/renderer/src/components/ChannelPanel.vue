<script setup>
const props = defineProps({
  values: {
    type: Array,
    default: () => Array(8).fill(0)
  }
})

const channelColors = [
  'var(--color-channel-0)',
  'var(--color-channel-1)',
  'var(--color-channel-2)',
  'var(--color-channel-3)',
  'var(--color-channel-4)',
  'var(--color-channel-5)',
  'var(--color-channel-6)',
  'var(--color-channel-7)'
]

const visible = [true, true, true, true, false, false, false, false]
</script>

<template>
  <div class="channel-panel">
    <div class="panel-header">
      <span>数据通道</span>
    </div>

    <div class="channel-list">
      <div
        v-for="(value, i) in values"
        :key="i"
        class="channel-row"
        :class="{ hidden: !visible[i] }"
      >
        <el-icon size="12" class="eye-icon"><View v-if="visible[i]" /><Hide v-else /></el-icon>
        <div class="channel-dot" :style="{ background: channelColors[i], opacity: visible[i] ? 1 : 0.35 }"></div>
        <span class="channel-name">I{{ i }}</span>
        <span class="channel-value" :style="{ color: visible[i] ? channelColors[i] : 'var(--color-text-tertiary)' }">
          {{ Number(value).toFixed(3) }}
        </span>
      </div>
    </div>

    <div class="panel-footer">
      <div class="color-dots">
        <div v-for="(color, i) in channelColors" :key="i" class="dot" :style="{ background: color }"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.channel-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  color: var(--color-text-primary);
}

.panel-header {
  padding: var(--space-3);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-text-primary);
}

.channel-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-1) 0;
}

.channel-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px var(--space-3);
  height: 28px;
}

.channel-row.hidden {
  opacity: 0.7;
}

.eye-icon {
  color: var(--color-text-secondary);
  cursor: pointer;
  flex-shrink: 0;
}

.channel-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.channel-name {
  font-family: var(--font-family-mono);
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  width: 22px;
  flex-shrink: 0;
}

.channel-value {
  font-family: var(--font-family-mono);
  font-size: var(--text-xs);
  flex: 1;
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.panel-footer {
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--color-border-subtle);
  display: flex;
  justify-content: flex-end;
}

.color-dots {
  display: flex;
  gap: 3px;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
</style>
