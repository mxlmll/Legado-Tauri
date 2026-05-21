<!-- FullModeUnlockDialog — 完全体模式 挑战码解锁对话框 -->
<script setup lang="ts">
import { ref, watch } from "vue";
import { useMessage } from "naive-ui";
import { storeToRefs } from "pinia";
import { useOverlayBackstack } from "@/composables/useOverlayBackstack";
import { usePreferencesStore } from "@/stores/preferences";

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{
  (e: "update:show", value: boolean): void;
}>();

const message = useMessage();
const prefStore = usePreferencesStore();
const { devTools } = storeToRefs(prefStore);

const challenge = ref("");
const inputResponse = ref("");
const inputError = ref("");

function generateChallenge() {
  challenge.value = String(Math.floor(100000 + Math.random() * 900000));
  inputResponse.value = "";
  inputError.value = "";
}

/**
 * 挑战码计算算法（djb2 变体 + 固定 salt）
 *
 * 提供给开发者的计算程序：
 * ```js
 * function computeResponse(c) {
 *   const salt = "legado_full_v1";
 *   let h = 5381;
 *   for (const ch of c + salt)
 *     h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
 *   return String(h % 1000000).padStart(6, '0');
 * }
 * ```
 */
function computeResponse(ch: string): string {
  const salt = "legado_full_v1";
  let h = 5381;
  for (const c of ch + salt) {
    h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
  }
  return String(h % 1000000).padStart(6, "0");
}

function close() {
  emit("update:show", false);
}

function handleVerify() {
  const expected = computeResponse(challenge.value);
  if (inputResponse.value.trim() === expected) {
    prefStore.patchDevTools({ fullModeEnabled: true });
    message.success("完全体模式已激活");
    close();
  } else {
    inputError.value = "验证码错误，请重新计算";
    generateChallenge();
  }
}

function handleRevoke() {
  prefStore.patchDevTools({ fullModeEnabled: false });
  message.info("完全体模式已关闭");
  close();
}

useOverlayBackstack(() => props.show, close);

watch(
  () => props.show,
  (v) => {
    if (v) generateChallenge();
  },
);
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="解除限制"
    :style="{ width: '400px', maxWidth: '92vw' }"
    :bordered="false"
    :segmented="{ content: true, footer: true }"
    @update:show="(v) => emit('update:show', v)"
  >
    <template v-if="!devTools.fullModeEnabled">
      <div class="fmu-body">
        <p class="fmu-desc">请使用以下挑战码计算验证码后输入：</p>

        <div class="fmu-challenge-box">
          <span class="fmu-challenge-box__label">挑战码</span>
          <strong class="fmu-challenge-box__value">{{ challenge }}</strong>
        </div>

        <n-input
          v-model:value="inputResponse"
          placeholder="输入 6 位验证码"
          maxlength="6"
          :status="inputError ? 'error' : undefined"
          class="fmu-input"
          @keydown.enter="handleVerify"
        />
        <p v-if="inputError" class="fmu-error">{{ inputError }}</p>
      </div>
    </template>

    <template v-else>
      <div class="fmu-body">
        <p class="fmu-active">完全体模式已激活，限制已解除。</p>
      </div>
    </template>

    <template #footer>
      <div class="fmu-footer">
        <n-button @click="close">取消</n-button>
        <template v-if="!devTools.fullModeEnabled">
          <n-button type="primary" @click="handleVerify">验证</n-button>
        </template>
        <template v-else>
          <n-button type="warning" @click="handleRevoke"
            >撤销完全体模式</n-button
          >
        </template>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.fmu-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.fmu-desc {
  margin: 0;
  font-size: 0.88rem;
  color: var(--color-text-soft);
}

.fmu-challenge-box {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 16px;
  background: var(--color-fill);
  border-radius: var(--radius-md, 8px);
}

.fmu-challenge-box__label {
  font-size: 0.8rem;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.fmu-challenge-box__value {
  font-family: monospace;
  font-size: 1.5rem;
  letter-spacing: 0.25em;
  color: var(--color-accent, var(--color-primary));
}

.fmu-hint {
  margin: 0;
  font-size: 0.8rem;
  color: var(--color-text-muted);
}

.fmu-formula {
  margin: 0;
  padding: 10px 12px;
  font-size: 0.73rem;
  line-height: 1.6;
  background: var(--color-fill);
  border-radius: 6px;
  overflow-x: auto;
  color: var(--color-text-soft);
  white-space: pre;
}

.fmu-error {
  margin: 0;
  font-size: 0.82rem;
  color: var(--color-error, #e74c3c);
}

.fmu-active {
  margin: 0;
  font-size: 0.9rem;
  color: var(--color-text-soft);
}

.fmu-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
