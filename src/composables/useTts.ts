import { computed, readonly, ref } from "vue";
import { eventListen } from "./useEventBus";
import {
  useFrontendPlugins,
  type FrontendTtsEngineRecord,
  type TtsSpeakContext,
  type TtsVoiceDefinition,
} from "./useFrontendPlugins";
import { invokeWithTimeout } from "./useInvoke";

const SYSTEM_ENGINE_ID = "system";
const PRELOAD_AHEAD = 6;
const MAX_SEGMENT_CHARS = 200;
const COMMAND_TIMEOUT_MS = 12_000;
const POLL_INTERVAL_MS = 180;
const SETTINGS_KEY = "legado.tts.settings";

export interface TtsOptions {
  engineId?: string;
  voiceId?: string;
  voice?: string;
  language?: string;
  rate?: number;
  volume?: number;
  pitch?: number;
}

export interface TtsStartOptions extends TtsOptions {
  initialSegments: string[];
  onNeedMore?: () => Promise<string[] | null>;
  onSegmentStart?: (globalIdx: number) => void;
  onAllDone?: () => void;
}

export interface TtsVoice {
  id: string;
  name: string;
  language?: string;
}

export interface TtsEngineRecord {
  id: string;
  name: string;
  description: string;
  category: string;
  source: "system" | "plugin";
  pluginId?: string;
  fileName?: string;
}

interface QueueItem {
  text: string;
  globalIdx: number;
}

interface PersistedTtsSettings {
  engineId?: string;
  voiceId?: string;
  playbackRate?: number;
  volume?: number;
  pitch?: number;
}

interface SystemTtsSpeakingState {
  speaking: boolean;
}

interface SystemTtsSpeakPayload {
  text: string;
  language?: string;
  voiceId?: string;
  rate: number;
  pitch: number;
  volume: number;
  queueMode: "flush" | "add";
}

const frontendPlugins = useFrontendPlugins();

const systemEngine: TtsEngineRecord = {
  id: SYSTEM_ENGINE_ID,
  name: "系统 TTS",
  description: "使用操作系统原生朗读引擎",
  category: "内置",
  source: "system",
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function readPersistedSettings(): PersistedTtsSettings {
  try {
    const raw = window.localStorage?.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as PersistedTtsSettings) : {};
  } catch {
    return {};
  }
}

function writePersistedSettings(values: PersistedTtsSettings): void {
  try {
    window.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(values));
  } catch {
    // ignore storage failures
  }
}

function normalizePluginEngine(
  record: FrontendTtsEngineRecord,
): TtsEngineRecord {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    category: record.category,
    source: "plugin",
    pluginId: record.pluginId,
    fileName: record.fileName,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

export function splitIntoSegments(text: string): string[] {
  if (!text.trim()) {
    return [];
  }
  const lines = text.split(/\n+/).filter((line) => line.trim());
  const segments: string[] = [];

  for (const line of lines) {
    const parts = line.split(/(?<=[。！？…；!?])/u);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed.length <= MAX_SEGMENT_CHARS) {
        segments.push(trimmed);
        continue;
      }

      let remaining = trimmed;
      while (remaining.length > MAX_SEGMENT_CHARS) {
        let cutAt = MAX_SEGMENT_CHARS;
        for (
          let index = MAX_SEGMENT_CHARS - 1;
          index > MAX_SEGMENT_CHARS / 2;
          index--
        ) {
          if (/[。！？…；!?,，、]/.test(remaining[index])) {
            cutAt = index + 1;
            break;
          }
        }
        segments.push(remaining.slice(0, cutAt).trim());
        remaining = remaining.slice(cutAt).trim();
      }
      if (remaining) {
        segments.push(remaining);
      }
    }
  }

  return segments.filter(Boolean);
}

function getBrowserSpeechVoices(): TtsVoice[] {
  if (!("speechSynthesis" in window)) {
    return [];
  }
  return window.speechSynthesis.getVoices().map((voice) => ({
    id: voice.voiceURI || voice.name,
    name: voice.name,
    language: voice.lang,
  }));
}

async function waitForBrowserVoices(): Promise<TtsVoice[]> {
  const voices = getBrowserSpeechVoices();
  if (voices.length > 0 || !("speechSynthesis" in window)) {
    return voices;
  }
  return new Promise((resolve) => {
    const timer = window.setTimeout(
      () => resolve(getBrowserSpeechVoices()),
      800,
    );
    window.speechSynthesis.onvoiceschanged = () => {
      window.clearTimeout(timer);
      resolve(getBrowserSpeechVoices());
    };
  });
}

async function stopSystemSpeech(): Promise<void> {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  try {
    await invokeWithTimeout<void>("tts_stop", undefined, COMMAND_TIMEOUT_MS);
  } catch {
    // Browser/Web fallback may not have the native command available.
  }
}

function waitForSystemSpeechDone(
  signal: AbortSignal,
  text: string,
): Promise<void> {
  const startedAt = Date.now();
  const estimatedMs = clamp(text.length * 180, 1_000, 45_000);

  return new Promise((resolve) => {
    let resolved = false;
    let sawSpeaking = false;
    let pollTimer: number | null = null;
    const unlisteners: Array<() => void> = [];

    const cleanup = () => {
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
        pollTimer = null;
      }
      signal.removeEventListener("abort", finish);
      for (const unlisten of unlisteners.splice(0)) {
        unlisten();
      }
    };

    function finish() {
      if (resolved) {
        return;
      }
      resolved = true;
      cleanup();
      resolve();
    }

    async function registerFinishEvent(eventName: string) {
      try {
        const unlisten = await eventListen(eventName, finish);
        if (resolved) {
          unlisten();
        } else {
          unlisteners.push(unlisten);
        }
      } catch {
        // Some browser/Web fallback modes do not provide native TTS events.
      }
    }

    async function pollSpeakingState() {
      if (resolved || signal.aborted) {
        finish();
        return;
      }

      try {
        const state = await invokeWithTimeout<SystemTtsSpeakingState>(
          "tts_is_speaking",
          undefined,
          COMMAND_TIMEOUT_MS,
        );
        if (state.speaking) {
          sawSpeaking = true;
        }
        if (sawSpeaking && !state.speaking) {
          finish();
          return;
        }
      } catch {
        // Keep the estimated timer path alive when polling is unavailable.
      }

      if (!sawSpeaking && Date.now() - startedAt > estimatedMs) {
        finish();
        return;
      }
      pollTimer = window.setTimeout(pollSpeakingState, POLL_INTERVAL_MS);
    }

    signal.addEventListener("abort", finish, { once: true });
    void registerFinishEvent("tts://speech:finish");
    void registerFinishEvent("tts://speech:cancel");
    pollTimer = window.setTimeout(pollSpeakingState, POLL_INTERVAL_MS);
  });
}

async function speakWithBrowserSpeech(
  text: string,
  options: Required<Pick<TtsOptions, "rate" | "volume" | "pitch">> & {
    voiceId?: string;
    language?: string;
  },
  signal: AbortSignal,
): Promise<void> {
  if (!("speechSynthesis" in window)) {
    throw new Error("当前环境没有可用的系统朗读引擎");
  }

  await waitForBrowserVoices();
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find(
      (item) =>
        item.voiceURI === options.voiceId || item.name === options.voiceId,
    );
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else if (options.language) {
      utterance.lang = options.language;
    }
    utterance.rate = clamp(options.rate, 0.1, 4);
    utterance.volume = clamp(options.volume, 0, 1);
    utterance.pitch = clamp(options.pitch, 0.5, 2);

    const cleanup = () => {
      utterance.onend = null;
      utterance.onerror = null;
    };
    utterance.onend = () => {
      cleanup();
      resolve();
    };
    utterance.onerror = (event) => {
      cleanup();
      reject(new Error(`浏览器朗读失败: ${event.error}`));
    };
    signal.addEventListener(
      "abort",
      () => {
        cleanup();
        window.speechSynthesis.cancel();
        resolve();
      },
      { once: true },
    );
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  });
}

async function speakWithSystemEngine(
  text: string,
  context: TtsSpeakContext,
): Promise<void> {
  const payload: SystemTtsSpeakPayload = {
    text,
    language: context.language,
    voiceId: context.voiceId,
    rate: context.rate,
    pitch: context.pitch,
    volume: context.volume,
    queueMode: "flush",
  };

  const waitController = new AbortController();
  const abortWait = () => waitController.abort();
  context.signal.addEventListener("abort", abortWait, { once: true });
  const done = waitForSystemSpeechDone(waitController.signal, text);

  try {
    await invokeWithTimeout("tts_speak", { payload }, COMMAND_TIMEOUT_MS);
    await done;
  } catch (error) {
    waitController.abort();
    if (context.signal.aborted) {
      return;
    }
    await speakWithBrowserSpeech(text, context, context.signal).catch(() => {
      throw error;
    });
  } finally {
    context.signal.removeEventListener("abort", abortWait);
  }
}

function normalizePluginVoices(value: TtsVoiceDefinition[]): TtsVoice[] {
  return value.map((voice) => ({
    id: voice.id,
    name: voice.name,
    language: voice.language,
  }));
}

const persisted = readPersistedSettings();

const isPlaying = ref(false);
const isLoading = ref(false);
const hasSession = ref(false);
const playbackRate = ref(clamp(persisted.playbackRate ?? 1, 0.5, 2));
const volume = ref(clamp(persisted.volume ?? 1, 0, 1));
const pitch = ref(clamp(persisted.pitch ?? 1, 0.5, 2));
const error = ref<string | null>(null);
const currentGlobalIdx = ref(-1);
const currentSegmentIndex = ref(0);
const totalSegmentsKnown = ref(0);
const totalFinalized = ref(false);
const currentSegmentText = ref("");
const selectedEngineId = ref(nonEmpty(persisted.engineId) ?? SYSTEM_ENGINE_ID);
const selectedVoiceId = ref(nonEmpty(persisted.voiceId) ?? "");
const availableVoices = ref<TtsVoice[]>([]);
const voicesLoading = ref(false);

const availableEngines = computed<TtsEngineRecord[]>(() => [
  systemEngine,
  ...frontendPlugins.ttsEngines.value.map(normalizePluginEngine),
]);
const selectedEngine = computed(
  () =>
    availableEngines.value.find(
      (engine) => engine.id === selectedEngineId.value,
    ) ?? systemEngine,
);
const currentSegmentOrdinal = computed(() =>
  totalSegmentsKnown.value > 0
    ? Math.min(currentSegmentIndex.value + 1, totalSegmentsKnown.value)
    : 0,
);
const progressRatio = computed(() => {
  if (totalSegmentsKnown.value <= 0) {
    return 0;
  }
  return currentSegmentOrdinal.value / totalSegmentsKnown.value;
});

const items: QueueItem[] = [];
let nextGlobalIdx = 0;
let playIndex = 0;
let activeOptions: TtsStartOptions | null = null;
let loadingMore = false;
let endReached = false;
let loadMorePromise: Promise<void> | null = null;
let currentAbort: AbortController | null = null;
let playGeneration = 0;

function saveCurrentSettings(): void {
  writePersistedSettings({
    engineId: selectedEngineId.value,
    voiceId: selectedVoiceId.value,
    playbackRate: playbackRate.value,
    volume: volume.value,
    pitch: pitch.value,
  });
}

function syncProgressRefs(): void {
  currentSegmentIndex.value = Math.max(0, playIndex);
  totalSegmentsKnown.value = items.length;
  totalFinalized.value = endReached;
}

function appendSegments(segments: string[]): void {
  for (const text of segments) {
    const trimmed = text.trim();
    if (trimmed) {
      items.push({ text: trimmed, globalIdx: nextGlobalIdx++ });
    }
  }
  syncProgressRefs();
}

async function loadMore(): Promise<void> {
  if (loadingMore || endReached || !activeOptions?.onNeedMore) {
    return loadMorePromise ?? Promise.resolve();
  }

  loadingMore = true;
  isLoading.value = true;
  loadMorePromise = (async () => {
    try {
      const more = await activeOptions?.onNeedMore?.();
      if (more && more.length > 0) {
        appendSegments(more);
      } else {
        endReached = true;
        syncProgressRefs();
      }
    } finally {
      loadingMore = false;
      isLoading.value = false;
      loadMorePromise = null;
    }
  })();
  return loadMorePromise;
}

function maybeLoadMore(): void {
  if (!activeOptions?.onNeedMore || endReached || loadingMore) {
    return;
  }
  if (items.length - playIndex <= PRELOAD_AHEAD) {
    void loadMore();
  }
}

async function ensurePlayableItem(
  generation: number,
): Promise<QueueItem | null> {
  for (;;) {
    if (generation !== playGeneration || !hasSession.value) {
      return null;
    }
    if (playIndex < items.length) {
      break;
    }
    if (endReached || !activeOptions?.onNeedMore) {
      return null;
    }
    await loadMore();
  }
  return items[playIndex] ?? null;
}

function interruptCurrentSpeech(): void {
  currentAbort?.abort();
  currentAbort = null;
  const engineId = selectedEngine.value.id;
  if (engineId === SYSTEM_ENGINE_ID) {
    void stopSystemSpeech();
  } else {
    void frontendPlugins.stopTtsEngine(engineId).catch(() => {});
  }
}

function buildSpeakContext(signal: AbortSignal): TtsSpeakContext {
  const voice = availableVoices.value.find(
    (item) => item.id === selectedVoiceId.value,
  );
  return {
    text: currentSegmentText.value,
    voiceId:
      nonEmpty(selectedVoiceId.value) ??
      nonEmpty(activeOptions?.voiceId) ??
      nonEmpty(activeOptions?.voice),
    language:
      nonEmpty(activeOptions?.language) ?? nonEmpty(voice?.language) ?? "zh-CN",
    rate: playbackRate.value,
    pitch: pitch.value,
    volume: volume.value,
    signal,
  };
}

async function speakCurrentItem(
  item: QueueItem,
  signal: AbortSignal,
): Promise<void> {
  currentSegmentText.value = item.text;
  const context = buildSpeakContext(signal);
  context.text = item.text;

  if (selectedEngine.value.id === SYSTEM_ENGINE_ID) {
    await speakWithSystemEngine(item.text, context);
    return;
  }
  await frontendPlugins.speakWithTtsEngine(selectedEngine.value.id, context);
}

function finishAll(): void {
  isPlaying.value = false;
  hasSession.value = false;
  currentGlobalIdx.value = -1;
  currentSegmentText.value = "";
  activeOptions?.onAllDone?.();
}

async function playLoop(generation: number): Promise<void> {
  for (;;) {
    if (
      generation !== playGeneration ||
      !hasSession.value ||
      !isPlaying.value
    ) {
      return;
    }
    const item = await ensurePlayableItem(generation);
    if (!item) {
      if (generation === playGeneration && hasSession.value) {
        finishAll();
      }
      return;
    }

    currentGlobalIdx.value = item.globalIdx;
    playIndex = items.findIndex(
      (candidate) => candidate.globalIdx === item.globalIdx,
    );
    if (playIndex < 0) {
      playIndex = item.globalIdx;
    }
    syncProgressRefs();
    activeOptions?.onSegmentStart?.(item.globalIdx);
    maybeLoadMore();

    const controller = new AbortController();
    currentAbort = controller;
    const loadingTimer = window.setTimeout(() => {
      if (generation === playGeneration && currentAbort === controller) {
        isLoading.value = false;
      }
    }, 450);

    try {
      isLoading.value = true;
      error.value = null;
      await speakCurrentItem(item, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted && generation === playGeneration) {
        error.value = err instanceof Error ? err.message : String(err);
        isPlaying.value = false;
        return;
      }
    } finally {
      window.clearTimeout(loadingTimer);
      if (currentAbort === controller) {
        currentAbort = null;
      }
      isLoading.value = false;
    }

    if (
      controller.signal.aborted ||
      generation !== playGeneration ||
      !isPlaying.value
    ) {
      return;
    }
    playIndex += 1;
    syncProgressRefs();
  }
}

function restartPlaybackIfNeeded(wasPlaying: boolean): void {
  if (!hasSession.value) {
    return;
  }
  if (!wasPlaying) {
    syncProgressRefs();
    const item = items[playIndex];
    if (item) {
      currentGlobalIdx.value = item.globalIdx;
      activeOptions?.onSegmentStart?.(item.globalIdx);
    }
    return;
  }
  isPlaying.value = true;
  const generation = ++playGeneration;
  void playLoop(generation);
}

async function refreshEngines(): Promise<void> {
  await frontendPlugins.ensureInitialized();
  if (
    !availableEngines.value.some(
      (engine) => engine.id === selectedEngineId.value,
    )
  ) {
    selectedEngineId.value = SYSTEM_ENGINE_ID;
    selectedVoiceId.value = "";
    saveCurrentSettings();
  }
}

async function loadVoices(): Promise<void> {
  voicesLoading.value = true;
  try {
    await refreshEngines();
    if (selectedEngine.value.id === SYSTEM_ENGINE_ID) {
      try {
        const voices = await invokeWithTimeout<TtsVoice[]>(
          "tts_get_voices",
          { language: undefined },
          COMMAND_TIMEOUT_MS,
        );
        availableVoices.value = voices;
      } catch {
        availableVoices.value = await waitForBrowserVoices();
      }
    } else {
      availableVoices.value = normalizePluginVoices(
        await frontendPlugins.getTtsEngineVoices(selectedEngine.value.id),
      );
    }

    if (
      selectedVoiceId.value &&
      !availableVoices.value.some((voice) => voice.id === selectedVoiceId.value)
    ) {
      selectedVoiceId.value = "";
      saveCurrentSettings();
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    availableVoices.value = [];
  } finally {
    voicesLoading.value = false;
  }
}

function startReading(options: TtsStartOptions): void {
  stop();
  activeOptions = options;
  if (options.engineId) {
    selectedEngineId.value = options.engineId;
  }
  const nextVoiceId = nonEmpty(options.voiceId) ?? nonEmpty(options.voice);
  if (nextVoiceId) {
    selectedVoiceId.value = nextVoiceId;
  }
  if (typeof options.rate === "number") {
    playbackRate.value = clamp(options.rate, 0.5, 2);
  }
  if (typeof options.volume === "number") {
    volume.value = clamp(options.volume, 0, 1);
  }
  if (typeof options.pitch === "number") {
    pitch.value = clamp(options.pitch, 0.5, 2);
  }
  saveCurrentSettings();

  nextGlobalIdx = 0;
  playIndex = 0;
  endReached = false;
  items.length = 0;
  appendSegments(options.initialSegments);
  hasSession.value = true;
  isPlaying.value = true;
  error.value = null;
  void loadVoices();
  const generation = ++playGeneration;
  void playLoop(generation);
}

function play(): void {
  if (!hasSession.value || isPlaying.value) {
    return;
  }
  isPlaying.value = true;
  const generation = ++playGeneration;
  void playLoop(generation);
}

function pause(): void {
  if (!isPlaying.value) {
    return;
  }
  isPlaying.value = false;
  playGeneration += 1;
  interruptCurrentSpeech();
}

function stop(): void {
  playGeneration += 1;
  interruptCurrentSpeech();
  isPlaying.value = false;
  isLoading.value = false;
  hasSession.value = false;
  error.value = null;
  currentGlobalIdx.value = -1;
  currentSegmentIndex.value = 0;
  totalSegmentsKnown.value = 0;
  totalFinalized.value = false;
  currentSegmentText.value = "";
  activeOptions = null;
  loadingMore = false;
  endReached = false;
  loadMorePromise = null;
  nextGlobalIdx = 0;
  playIndex = 0;
  items.length = 0;
}

function nextSegment(): void {
  if (!hasSession.value) {
    return;
  }
  const wasPlaying = isPlaying.value;
  isPlaying.value = false;
  playGeneration += 1;
  interruptCurrentSpeech();
  playIndex = endReached
    ? Math.min(playIndex + 1, Math.max(items.length - 1, 0))
    : playIndex + 1;
  restartPlaybackIfNeeded(wasPlaying);
}

function prevSegment(): void {
  if (!hasSession.value) {
    return;
  }
  const wasPlaying = isPlaying.value;
  isPlaying.value = false;
  playGeneration += 1;
  interruptCurrentSpeech();
  playIndex = Math.max(0, playIndex - 1);
  restartPlaybackIfNeeded(wasPlaying);
}

function seekToIndex(index: number): void {
  if (!hasSession.value || items.length === 0) {
    return;
  }
  const wasPlaying = isPlaying.value;
  isPlaying.value = false;
  playGeneration += 1;
  interruptCurrentSpeech();
  playIndex = Math.max(0, Math.min(Math.round(index), items.length - 1));
  restartPlaybackIfNeeded(wasPlaying);
}

function setPlaybackRate(rate: number): void {
  playbackRate.value = clamp(rate, 0.5, 2);
  saveCurrentSettings();
  if (isPlaying.value) {
    const index = playIndex;
    pause();
    playIndex = index;
    play();
  }
}

function setVolume(nextVolume: number): void {
  volume.value = clamp(nextVolume, 0, 1);
  saveCurrentSettings();
}

function setPitch(nextPitch: number): void {
  pitch.value = clamp(nextPitch, 0.5, 2);
  saveCurrentSettings();
}

async function setEngineId(engineId: string): Promise<void> {
  await refreshEngines();
  const nextEngineId = availableEngines.value.some(
    (engine) => engine.id === engineId,
  )
    ? engineId
    : SYSTEM_ENGINE_ID;
  if (selectedEngineId.value === nextEngineId) {
    return;
  }

  const wasPlaying = isPlaying.value;
  isPlaying.value = false;
  playGeneration += 1;
  interruptCurrentSpeech();
  selectedEngineId.value = nextEngineId;
  selectedVoiceId.value = "";
  saveCurrentSettings();
  await loadVoices();
  restartPlaybackIfNeeded(wasPlaying);
}

function setVoiceId(voiceId: string): void {
  selectedVoiceId.value = voiceId;
  saveCurrentSettings();
}

async function previewVoice(voiceId = selectedVoiceId.value): Promise<void> {
  if (!voiceId) {
    return;
  }
  if (selectedEngine.value.id === SYSTEM_ENGINE_ID) {
    try {
      await invokeWithTimeout(
        "tts_preview_voice",
        { voiceId, text: "这是一段系统朗读试听。" },
        COMMAND_TIMEOUT_MS,
      );
    } catch {
      await speakWithBrowserSpeech(
        "这是一段系统朗读试听。",
        {
          voiceId,
          language: availableVoices.value.find((voice) => voice.id === voiceId)
            ?.language,
          rate: playbackRate.value,
          volume: volume.value,
          pitch: pitch.value,
        },
        new AbortController().signal,
      );
    }
    return;
  }
  await frontendPlugins.previewTtsEngineVoice(selectedEngine.value.id, voiceId);
}

export function useTts() {
  return {
    isPlaying: readonly(isPlaying),
    isLoading: readonly(isLoading),
    hasSession: readonly(hasSession),
    playbackRate: readonly(playbackRate),
    volume: readonly(volume),
    pitch: readonly(pitch),
    currentGlobalIdx: readonly(currentGlobalIdx),
    currentSegmentIndex: readonly(currentSegmentIndex),
    currentSegmentOrdinal,
    currentSegmentText: readonly(currentSegmentText),
    totalSegmentsKnown: readonly(totalSegmentsKnown),
    totalFinalized: readonly(totalFinalized),
    progressRatio,
    error: readonly(error),
    availableEngines,
    selectedEngine,
    selectedEngineId: readonly(selectedEngineId),
    availableVoices: readonly(availableVoices),
    selectedVoiceId: readonly(selectedVoiceId),
    voicesLoading: readonly(voicesLoading),

    startReading,
    play,
    pause,
    stop,
    nextSegment,
    prevSegment,
    seekToIndex,
    setPlaybackRate,
    setVolume,
    setPitch,
    setEngineId,
    setVoiceId,
    refreshEngines,
    loadVoices,
    previewVoice,
  };
}
