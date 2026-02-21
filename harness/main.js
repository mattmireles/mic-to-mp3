/**
 * Browser compatibility harness for mic-to-mp3.
 *
 * This page uses the framework-agnostic core controller to run real recording
 * flows and capture compatibility metrics across browsers/devices.
 */

const RUNS_STORAGE_KEY = "mic-to-mp3-harness-runs-v1";
const CHECKLIST_STORAGE_KEY = "mic-to-mp3-harness-checklist-v1";
const FALLBACK_DEFAULTS = {
  MAX_DURATION_SEC: 600,
  MAX_SIZE_BYTES: 25 * 1024 * 1024,
  TARGET_BITRATE: 64,
  SAMPLE_RATE: 44100,
};

const MANUAL_CHECKS = [
  "Microphone permission prompt appears and can be accepted",
  "Audio level bars react to voice input",
  "Stopping recording returns MP3 without page freeze",
  "Playback works and audio is intelligible",
  "Repeat record/stop cycles are stable",
];

/**
 * Return basic capability signals for this browser runtime.
 */
function detectCapabilities() {
  const hasNavigator = typeof navigator !== "undefined";
  const hasAudioContext =
    typeof window !== "undefined" &&
    ("AudioContext" in window || "webkitAudioContext" in window);

  let scriptProcessor = false;
  if (hasAudioContext) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const proto = AudioCtx?.prototype;
    scriptProcessor = Boolean(proto?.createScriptProcessor || proto?.createJavaScriptNode);
  }

  const mediaRecorderSupported = typeof window !== "undefined" && "MediaRecorder" in window;

  return {
    secureContext: typeof window !== "undefined" && window.isSecureContext,
    getUserMedia: Boolean(hasNavigator && navigator.mediaDevices?.getUserMedia),
    audioContext: hasAudioContext,
    mediaRecorder: mediaRecorderSupported,
    worker: typeof window !== "undefined" && "Worker" in window,
    scriptProcessor,
    mimeWebmOpus:
      mediaRecorderSupported &&
      typeof MediaRecorder.isTypeSupported === "function" &&
      MediaRecorder.isTypeSupported("audio/webm;codecs=opus"),
    mimeWebm:
      mediaRecorderSupported &&
      typeof MediaRecorder.isTypeSupported === "function" &&
      MediaRecorder.isTypeSupported("audio/webm"),
    mimeMp4:
      mediaRecorderSupported &&
      typeof MediaRecorder.isTypeSupported === "function" &&
      MediaRecorder.isTypeSupported("audio/mp4"),
    userAgent: hasNavigator ? navigator.userAgent : "Unavailable",
    platform: hasNavigator ? navigator.platform : "Unavailable",
  };
}

/**
 * Convert bytes to readable units.
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Convert milliseconds to readable text.
 */
function formatMs(ms) {
  if (ms === null || ms === undefined) return "-";
  return `${Math.round(ms)}ms`;
}

/**
 * Read JSON payload from localStorage with fallback.
 */
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Persist JSON payload to localStorage.
 */
function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Ignore quota/storage failures in harness mode */
  }
}

/**
 * Create and attach waveform bars.
 */
function createWaveformBars(container, count) {
  container.innerHTML = "";
  const bars = [];

  for (let i = 0; i < count; i += 1) {
    const bar = document.createElement("div");
    bar.className = "wave-bar";
    bar.style.height = "3px";
    container.appendChild(bar);
    bars.push(bar);
  }

  return bars;
}

/**
 * Return true when capability indicates likely incremental live path support.
 */
function estimateLivePathAvailable(capabilities) {
  return (
    capabilities.audioContext &&
    capabilities.worker &&
    capabilities.scriptProcessor &&
    capabilities.getUserMedia
  );
}

const els = {
  toggleRecording: document.getElementById("toggle-recording"),
  clearError: document.getElementById("clear-error"),
  exportJson: document.getElementById("export-json"),
  clearRuns: document.getElementById("clear-runs"),
  statusRecording: document.getElementById("status-recording"),
  statusProcessing: document.getElementById("status-processing"),
  statusElapsed: document.getElementById("status-elapsed"),
  statusTargetRate: document.getElementById("status-target-rate"),
  statusError: document.getElementById("status-error"),
  resultSummary: document.getElementById("result-summary"),
  playback: document.getElementById("playback"),
  downloadLink: document.getElementById("download-link"),
  runRows: document.getElementById("run-rows"),
  capabilityRows: document.getElementById("capability-rows"),
  notes: document.getElementById("notes"),
  waveform: document.getElementById("waveform"),
  manualChecklist: document.getElementById("manual-checklist"),
};

/**
 * Validate required DOM nodes so harness fails clearly if markup changes.
 */
function assertElementsPresent() {
  for (const [key, element] of Object.entries(els)) {
    if (!element) {
      throw new Error(`Missing required element: ${key}`);
    }
  }
}

assertElementsPresent();

const runs = loadJson(RUNS_STORAGE_KEY, []);
const checklistState = loadJson(CHECKLIST_STORAGE_KEY, {});

const capabilities = detectCapabilities();
const waveformBars = createWaveformBars(els.waveform, 40);

let recorder = null;
let currentState = {
  isRecording: false,
  isProcessing: false,
  elapsed: 0,
  error: null,
  audioLevels: [],
};
let currentRun = null;
let playbackObjectUrl = null;
let runtimeDefaults = { ...FALLBACK_DEFAULTS };

/**
 * Render capability table.
 */
function renderCapabilities() {
  const rows = [
    ["Secure context", capabilities.secureContext, "HTTPS or localhost required for mic"],
    ["getUserMedia", capabilities.getUserMedia, "navigator.mediaDevices.getUserMedia"],
    ["AudioContext", capabilities.audioContext, "Required for decode/live PCM path"],
    ["MediaRecorder", capabilities.mediaRecorder, "Used by robust blob fallback path"],
    ["Web Worker", capabilities.worker, "Used for non-blocking MP3 encoding"],
    ["ScriptProcessorNode", capabilities.scriptProcessor, "Used for live incremental PCM capture"],
    ["MIME: webm+opus", capabilities.mimeWebmOpus, "Preferred MediaRecorder codec"],
    ["MIME: webm", capabilities.mimeWebm, "Fallback MediaRecorder codec"],
    ["MIME: mp4", capabilities.mimeMp4, "Common Safari fallback codec"],
    [
      "Estimated live path",
      estimateLivePathAvailable(capabilities),
      "Heuristic: AudioContext + ScriptProcessor + Worker + getUserMedia",
    ],
  ];

  els.capabilityRows.innerHTML = "";
  for (const [name, value, detail] of rows) {
    const row = document.createElement("tr");
    const badgeClass = value ? "ok" : "no";
    const badgeText = value ? "Yes" : "No";

    row.innerHTML = `
      <td>${name}</td>
      <td><span class="badge ${badgeClass}">${badgeText}</span></td>
      <td>${detail}</td>
    `;

    els.capabilityRows.appendChild(row);
  }

  const agentRow = document.createElement("tr");
  agentRow.innerHTML = `
    <td>User agent</td>
    <td><span class="badge ok">Info</span></td>
    <td>${capabilities.userAgent}</td>
  `;
  els.capabilityRows.appendChild(agentRow);
}

/**
 * Render manual checklist controls and sync to localStorage.
 */
function renderManualChecklist() {
  els.manualChecklist.innerHTML = "";

  MANUAL_CHECKS.forEach((labelText, index) => {
    const id = `check-${index}`;
    const row = document.createElement("div");
    row.className = "check-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = id;
    checkbox.checked = Boolean(checklistState[id]);
    checkbox.addEventListener("change", () => {
      checklistState[id] = checkbox.checked;
      saveJson(CHECKLIST_STORAGE_KEY, checklistState);
    });

    const label = document.createElement("label");
    label.setAttribute("for", id);
    label.textContent = labelText;

    row.appendChild(checkbox);
    row.appendChild(label);
    els.manualChecklist.appendChild(row);
  });
}

/**
 * Render run history table.
 */
function renderRuns() {
  els.runRows.innerHTML = "";

  if (runs.length === 0) {
    const emptyRow = document.createElement("tr");
    emptyRow.innerHTML = '<td colspan="7">No runs yet.</td>';
    els.runRows.appendChild(emptyRow);
    return;
  }

  for (const run of runs) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${new Date(run.timestamp).toLocaleString()}</td>
      <td>${run.durationSec}s</td>
      <td>${formatBytes(run.sizeBytes)}</td>
      <td>${formatMs(run.stopToDoneMs)}</td>
      <td>${formatMs(run.processingMs)}</td>
      <td>${run.path}</td>
      <td>${run.error || "-"}</td>
    `;
    els.runRows.appendChild(row);
  }
}

/**
 * Update UI with current recorder state.
 */
function updateStatus(state) {
  els.statusRecording.textContent = state.isRecording ? "Yes" : "No";
  els.statusProcessing.textContent = state.isProcessing ? "Yes" : "No";
  els.statusElapsed.textContent = `${state.elapsed}s`;
  els.statusError.textContent = state.error || "";
  els.toggleRecording.textContent = state.isRecording ? "Stop recording" : "Start recording";
  els.toggleRecording.disabled = state.isProcessing;

  const levels = state.audioLevels || [];
  for (let i = 0; i < waveformBars.length; i += 1) {
    const level = levels[i] || 0;
    const height = Math.max(2, Math.round((level / 255) * 52));
    waveformBars[i].style.height = `${height}px`;
  }

  if (!state.isRecording && levels.length === 0) {
    waveformBars.forEach((bar) => {
      bar.style.height = "3px";
    });
  }
}

/**
 * Build a stable run log record from recording callback and timing state.
 */
function finalizeRun(mp3Data, metadata) {
  const nowMs = performance.now();
  if (!currentRun) {
    currentRun = {
      startedAtMs: nowMs,
      stopRequestedAtMs: null,
      processingStartedAtMs: null,
      processingEndedAtMs: null,
      path: estimateLivePathAvailable(capabilities) ? "incremental-live" : "fallback-batch",
    };
  }

  const stopToDoneMs =
    currentRun.stopRequestedAtMs === null ? null : nowMs - currentRun.stopRequestedAtMs;

  const processingStart = currentRun.processingStartedAtMs;
  const processingEnd = currentRun.processingEndedAtMs;
  const processingMs =
    processingStart === null
      ? null
      : (processingEnd ?? nowMs) - processingStart;

  const run = {
    timestamp: new Date().toISOString(),
    durationSec: metadata.durationSec,
    sizeBytes: metadata.sizeBytes,
    stopToDoneMs,
    processingMs,
    path: currentRun.path,
    error: null,
    defaultSampleRate: runtimeDefaults.SAMPLE_RATE,
    targetBitrate: runtimeDefaults.TARGET_BITRATE,
    notes: els.notes.value.trim(),
    userAgent: capabilities.userAgent,
    platform: capabilities.platform,
  };

  runs.unshift(run);
  if (runs.length > 50) {
    runs.length = 50;
  }

  saveJson(RUNS_STORAGE_KEY, runs);
  renderRuns();

  els.resultSummary.textContent =
    `Duration ${metadata.durationSec}s, ${formatBytes(metadata.sizeBytes)}, stop->done ${formatMs(stopToDoneMs)}.`;

  if (playbackObjectUrl) {
    URL.revokeObjectURL(playbackObjectUrl);
  }

  playbackObjectUrl = URL.createObjectURL(new Blob([mp3Data], { type: "audio/mpeg" }));
  els.playback.src = playbackObjectUrl;
  els.playback.hidden = false;

  els.downloadLink.href = playbackObjectUrl;
  els.downloadLink.download = `mic-to-mp3-${Date.now()}.mp3`;
  els.downloadLink.hidden = false;

  currentRun = null;
}

/**
 * Append a run entry for fatal errors that occur before MP3 completion.
 */
function recordFailure(errorMessage) {
  if (!currentRun) {
    return;
  }

  runs.unshift({
    timestamp: new Date().toISOString(),
    durationSec: currentState.elapsed,
    sizeBytes: 0,
    stopToDoneMs:
      currentRun.stopRequestedAtMs === null
        ? null
        : performance.now() - currentRun.stopRequestedAtMs,
    processingMs:
      currentRun.processingStartedAtMs === null
        ? null
        : performance.now() - currentRun.processingStartedAtMs,
    path: currentRun.path,
    error: errorMessage,
    defaultSampleRate: runtimeDefaults.SAMPLE_RATE,
    targetBitrate: runtimeDefaults.TARGET_BITRATE,
    notes: els.notes.value.trim(),
    userAgent: capabilities.userAgent,
    platform: capabilities.platform,
  });

  if (runs.length > 50) {
    runs.length = 50;
  }

  saveJson(RUNS_STORAGE_KEY, runs);
  renderRuns();
  currentRun = null;
}

/**
 * Initialize harness using built core output from /dist.
 */
async function initHarness() {
  try {
    const core = await import("../dist/core.js");
    const { createVoiceRecorder: createRecorder, DEFAULTS } = core;
    runtimeDefaults = { ...FALLBACK_DEFAULTS, ...DEFAULTS };

    els.statusTargetRate.textContent = `${runtimeDefaults.SAMPLE_RATE}Hz`;

    recorder = createRecorder({
      onRecordingComplete: (mp3Data, metadata) => {
        finalizeRun(mp3Data, metadata);
      },
      sampleRate: runtimeDefaults.SAMPLE_RATE,
      bitrate: runtimeDefaults.TARGET_BITRATE,
      maxDuration: runtimeDefaults.MAX_DURATION_SEC,
      maxSizeBytes: runtimeDefaults.MAX_SIZE_BYTES,
    });

    currentState = recorder.getState();
    updateStatus(currentState);

    recorder.subscribe((state) => {
      const prev = currentState;
      currentState = state;
      updateStatus(state);

      if (!prev.isProcessing && state.isProcessing && currentRun) {
        currentRun.processingStartedAtMs = performance.now();
      }

      if (prev.isProcessing && !state.isProcessing && currentRun) {
        currentRun.processingEndedAtMs = performance.now();
      }

      if (state.error && state.error !== prev.error) {
        recordFailure(state.error);
      }
    });

    els.toggleRecording.addEventListener("click", async () => {
      if (currentState.isRecording) {
        if (currentRun) {
          currentRun.stopRequestedAtMs = performance.now();
        }
      } else {
        currentRun = {
          startedAtMs: performance.now(),
          stopRequestedAtMs: null,
          processingStartedAtMs: null,
          processingEndedAtMs: null,
          path: estimateLivePathAvailable(capabilities)
            ? "incremental-live"
            : "fallback-batch",
        };
      }

      await recorder.toggleRecording();
    });

    els.clearError.addEventListener("click", () => {
      recorder.clearError();
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown harness bootstrap failure";

    els.statusError.textContent =
      `Failed to load dist/core.js. Run "npm run build" before opening this page. (${message})`;

    els.toggleRecording.disabled = true;
    els.clearError.disabled = true;
  }
}

renderCapabilities();
renderManualChecklist();
renderRuns();

els.exportJson.addEventListener("click", () => {
  const payload = {
    generatedAt: new Date().toISOString(),
    capabilities,
    checklist: checklistState,
    notes: els.notes.value.trim(),
    runs,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `mic-to-mp3-harness-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});

els.clearRuns.addEventListener("click", () => {
  runs.length = 0;
  saveJson(RUNS_STORAGE_KEY, runs);
  renderRuns();
});

window.addEventListener("beforeunload", () => {
  if (recorder) {
    recorder.destroy();
  }

  if (playbackObjectUrl) {
    URL.revokeObjectURL(playbackObjectUrl);
  }
});

await initHarness();
