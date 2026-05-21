<script setup lang="ts">
import { computed } from 'vue';
import type { PaginationMeasurementData } from './composables/usePagination';

const props = defineProps<{
  /** 测量数据，null 时不显示 */
  measurement: PaginationMeasurementData | null;
  /** 是否显示调试指示器 */
  show: boolean;
}>();

const displayData = computed(() => {
  if (!props.measurement) {return null;}
  const m = props.measurement;
  const widthDiff = m.containerWidth - m.availableWidth;
  const heightDiff = m.containerHeight - m.availableHeight;
  const widthDiffPct =
    m.containerWidth > 0 ? ((widthDiff / m.containerWidth) * 100).toFixed(1) : '0';
  const heightDiffPct =
    m.containerHeight > 0 ? ((heightDiff / m.containerHeight) * 100).toFixed(1) : '0';

  return {
    containerWidth: m.containerWidth.toFixed(1),
    containerHeight: m.containerHeight.toFixed(1),
    availableWidth: m.availableWidth.toFixed(1),
    availableHeight: m.availableHeight.toFixed(1),
    widthDiff: widthDiff.toFixed(1),
    heightDiff: heightDiff.toFixed(1),
    widthDiffPct,
    heightDiffPct,
    paddingLeft: m.padding.left.toFixed(1),
    paddingRight: m.padding.right.toFixed(1),
    paddingTop: m.padding.top.toFixed(1),
    paddingBottom: m.padding.bottom.toFixed(1),
    lineHeightPx: m.lineHeightPx.toFixed(1),
    fontSize: m.fontSize.toFixed(1),
    engine: m.engine,
  };
});

const lineCount = computed(() => {
  if (!props.measurement) {return 0;}
  const availH = props.measurement.availableHeight;
  const lineH = props.measurement.lineHeightPx;
  return lineH > 0 ? Math.floor(availH / lineH) : 0;
});
</script>

<template>
  <div v-if="show && displayData" class="layout-debug-indicator">
    <!-- 标题栏 -->
    <div class="layout-debug-indicator__header">
      <span class="layout-debug-indicator__title">排版测量诊断</span>
      <span class="layout-debug-indicator__engine">引擎: {{ displayData.engine }}</span>
    </div>

    <!-- 容器尺寸信息 -->
    <div class="layout-debug-indicator__section">
      <div class="layout-debug-indicator__label">容器尺寸</div>
      <div class="layout-debug-indicator__row">
        <span>实际宽: {{ displayData.containerWidth }}px</span>
        <span class="layout-debug-indicator__muted"
          >(可用: {{ displayData.availableWidth }}px)</span
        >
        <span class="layout-debug-indicator__diff"
          >差异: {{ displayData.widthDiff }}px ({{ displayData.widthDiffPct }}%)</span
        >
      </div>
      <div class="layout-debug-indicator__row">
        <span>实际高: {{ displayData.containerHeight }}px</span>
        <span class="layout-debug-indicator__muted"
          >(可用: {{ displayData.availableHeight }}px)</span
        >
        <span class="layout-debug-indicator__diff"
          >差异: {{ displayData.heightDiff }}px ({{ displayData.heightDiffPct }}%)</span
        >
      </div>
    </div>

    <!-- 边距信息 -->
    <div class="layout-debug-indicator__section">
      <div class="layout-debug-indicator__label">页边距</div>
      <div class="layout-debug-indicator__padding-grid">
        <div class="layout-debug-indicator__padding-item" style="grid-column: 2">
          L: {{ displayData.paddingLeft }}px
        </div>
        <div class="layout-debug-indicator__padding-item" style="grid-column: 2">
          R: {{ displayData.paddingRight }}px
        </div>
        <div class="layout-debug-indicator__padding-item" style="grid-column: 2">
          T: {{ displayData.paddingTop }}px
        </div>
        <div class="layout-debug-indicator__padding-item" style="grid-column: 2">
          B: {{ displayData.paddingBottom }}px
        </div>
      </div>
    </div>

    <!-- 行高信息 -->
    <div class="layout-debug-indicator__section">
      <div class="layout-debug-indicator__label">行高设置</div>
      <div class="layout-debug-indicator__row">
        <span>字号: {{ displayData.fontSize }}px</span>
        <span>行高: {{ displayData.lineHeightPx }}px</span>
        <span class="layout-debug-indicator__muted">(预计 {{ lineCount }} 行)</span>
      </div>
    </div>

    <!-- 诊断提示 -->
    <div v-if="parseFloat(displayData.widthDiffPct) > 5" class="layout-debug-indicator__warning">
      ⚠️ 宽度边距占比 >5%，检查是否有 Canvas 测量精度问题
    </div>
  </div>
</template>

<style scoped>
.layout-debug-indicator {
  position: fixed;
  bottom: 60px;
  left: 10px;
  right: 10px;
  background: rgba(0, 0, 0, 0.85);
  color: #e0e0e0;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  padding: 10px;
  font-size: 12px;
  font-family: 'Courier New', monospace;
  z-index: 9998;
  max-height: 300px;
  overflow-y: auto;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.layout-debug-indicator__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  margin-bottom: 8px;
}

.layout-debug-indicator__title {
  font-weight: bold;
  color: #4fc3f7;
}

.layout-debug-indicator__engine {
  color: #81c784;
  font-size: 11px;
}

.layout-debug-indicator__section {
  margin-bottom: 8px;
  padding: 6px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 4px;
}

.layout-debug-indicator__label {
  font-weight: bold;
  color: #ffb74d;
  margin-bottom: 4px;
  font-size: 11px;
}

.layout-debug-indicator__row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 2px;
  font-size: 11px;
}

.layout-debug-indicator__row > span {
  flex: 1;
}

.layout-debug-indicator__muted {
  color: #888;
  font-size: 10px;
}

.layout-debug-indicator__diff {
  color: #ef5350;
  font-weight: bold;
}

.layout-debug-indicator__padding-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}

.layout-debug-indicator__padding-item {
  background: rgba(79, 195, 247, 0.1);
  padding: 3px 6px;
  border-radius: 3px;
  border-left: 2px solid #4fc3f7;
  font-size: 11px;
}

.layout-debug-indicator__warning {
  background: rgba(239, 83, 80, 0.2);
  border: 1px solid rgba(239, 83, 80, 0.5);
  color: #ffab91;
  padding: 6px;
  border-radius: 4px;
  font-size: 11px;
  margin-top: 6px;
}
</style>
