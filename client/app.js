// ─── State ───────────────────────────────────────────────────────────────────
let ws = null;
let audioContext = null;
let micStream = null;
let workletNode = null;
let micSource = null;
let micInitialized = false;
let isMicActive = false;

// Playback state
let playbackContext = null;
let nextPlaybackTime = 0;
let isPlaying = false;
const PLAYBACK_SAMPLE_RATE = 16000;

// Agent text accumulation
let currentAgentText = "";

// ─── DOM References ──────────────────────────────────────────────────────────
const micBtn = document.getElementById("mic-button");
const conversationEl = document.getElementById("conversation");
const transcriptEl = document.getElementById("current-transcript");
const statusIndicator = document.getElementById("status-indicator");
const statusText = document.getElementById("status-text");
const waveformEl = statusIndicator.querySelector(".waveform");
const connectionBadge = document.getElementById("connection-status");

// ─── WebSocket ───────────────────────────────────────────────────────────────
function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    updateConnectionStatus("connected");
    console.log("WebSocket connected");
  };

  ws.onclose = () => {
    updateConnectionStatus("disconnected");
    console.log("WebSocket disconnected");
    scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.error("WebSocket error:", e);
  };

  ws.onmessage = handleServerMessage;
}

function scheduleReconnect() {
  setTimeout(() => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      console.log("Attempting reconnect...");
      connectWebSocket();
    }
  }, 2000);
}

function updateConnectionStatus(status) {
  connectionBadge.textContent = status === "connected" ? "Connected" : "Disconnected";
  connectionBadge.className = `status-badge ${status}`;
}

// ─── Server Message Handler ──────────────────────────────────────────────────
function handleServerMessage(event) {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case "transcript":
      updateTranscriptDisplay(msg.text, msg.isFinal);
      break;
    case "agentText":
      appendAgentText(msg.text);
      break;
    case "audio":
      queueAudioForPlayback(msg.data);
      break;
    case "agentSpeakingDone":
      onAgentDone();
      break;
    case "state":
      updateUIState(msg.state);
      break;
    case "error":
      showError(msg.message);
      break;
  }
}

// ─── Transcript Display ─────────────────────────────────────────────────────
function updateTranscriptDisplay(text, isFinal) {
  transcriptEl.textContent = text;
}

// ─── Conversation Display ───────────────────────────────────────────────────
function addConversationMessage(role, text) {
  const div = document.createElement("div");
  div.className = `message message-${role}`;
  div.textContent = text;
  conversationEl.appendChild(div);
  conversationEl.scrollTop = conversationEl.scrollHeight;
}

function appendAgentText(text) {
  currentAgentText += text;
  let bubble = document.querySelector(".message-agent.streaming");
  if (!bubble) {
    bubble = document.createElement("div");
    bubble.className = "message message-agent streaming";
    conversationEl.appendChild(bubble);
  }
  bubble.textContent = currentAgentText;
  conversationEl.scrollTop = conversationEl.scrollHeight;
}

function finalizeAgentMessage() {
  const bubble = document.querySelector(".message-agent.streaming");
  if (bubble) bubble.classList.remove("streaming");
  currentAgentText = "";
}

// ─── Audio Capture (AudioWorklet) ────────────────────────────────────────────
const PROCESSOR_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs) {
    const input = inputs[0][0];
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      this.buffer[this.bufferIndex++] = input[i];

      if (this.bufferIndex >= this.bufferSize) {
        const ratio = sampleRate / 16000;
        const outputLength = Math.floor(this.bufferSize / ratio);
        const output = new Int16Array(outputLength);

        for (let j = 0; j < outputLength; j++) {
          const srcIndex = Math.floor(j * ratio);
          const sample = Math.max(-1, Math.min(1, this.buffer[srcIndex]));
          output[j] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        }

        this.port.postMessage(output.buffer, [output.buffer]);
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-processor", PCMProcessor);
`;

async function initMicrophone() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  audioContext = new AudioContext();

  const blob = new Blob([PROCESSOR_CODE], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  await audioContext.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  micSource = audioContext.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(audioContext, "pcm-processor");

  workletNode.port.onmessage = (event) => {
    if (isMicActive && ws && ws.readyState === WebSocket.OPEN) {
      const base64 = arrayBufferToBase64(event.data);
      ws.send(JSON.stringify({ type: "audio", data: base64 }));
    }
  };

  micSource.connect(workletNode);
  // Connect to destination to keep processor alive (silent output)
  workletNode.connect(audioContext.destination);

  micInitialized = true;
}

function startStreaming() {
  isMicActive = true;
  if (audioContext && audioContext.state === "suspended") {
    audioContext.resume();
  }
}

function stopStreaming() {
  isMicActive = false;
}

// ─── Audio Playback ──────────────────────────────────────────────────────────
function initPlaybackContext() {
  if (!playbackContext || playbackContext.state === "closed") {
    playbackContext = new AudioContext();
  }
  if (playbackContext.state === "suspended") {
    playbackContext.resume();
  }
}

function queueAudioForPlayback(base64Audio) {
  initPlaybackContext();

  // Decode base64 to bytes
  const binaryString = atob(base64Audio);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Interpret as Int16 PCM
  const int16 = new Int16Array(bytes.buffer);

  // Convert Int16 to Float32
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }

  // Resample from 16kHz to playback context sample rate if needed
  let samples = float32;
  const contextRate = playbackContext.sampleRate;
  if (contextRate !== PLAYBACK_SAMPLE_RATE) {
    const ratio = contextRate / PLAYBACK_SAMPLE_RATE;
    const resampledLength = Math.round(float32.length * ratio);
    const resampled = new Float32Array(resampledLength);
    for (let i = 0; i < resampledLength; i++) {
      const srcIdx = i / ratio;
      const lo = Math.floor(srcIdx);
      const hi = Math.min(lo + 1, float32.length - 1);
      const frac = srcIdx - lo;
      resampled[i] = float32[lo] * (1 - frac) + float32[hi] * frac;
    }
    samples = resampled;
  }

  // Create AudioBuffer and schedule
  const audioBuffer = playbackContext.createBuffer(1, samples.length, contextRate);
  audioBuffer.getChannelData(0).set(samples);

  const source = playbackContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(playbackContext.destination);

  const currentTime = playbackContext.currentTime;
  const startTime = Math.max(currentTime + 0.01, nextPlaybackTime);
  source.start(startTime);
  nextPlaybackTime = startTime + audioBuffer.duration;
  isPlaying = true;
}

function stopPlayback() {
  if (playbackContext && playbackContext.state !== "closed") {
    playbackContext.close();
    playbackContext = null;
  }
  nextPlaybackTime = 0;
  isPlaying = false;
}

function onAgentDone() {
  finalizeAgentMessage();

  if (playbackContext) {
    const remaining = Math.max(0, nextPlaybackTime - playbackContext.currentTime);
    setTimeout(() => {
      isPlaying = false;
      nextPlaybackTime = 0;
    }, remaining * 1000);
  } else {
    isPlaying = false;
  }
}

// ─── UI State ────────────────────────────────────────────────────────────────
function updateUIState(state) {
  statusIndicator.className = `status ${state}`;
  micBtn.classList.remove("listening", "thinking", "speaking");

  switch (state) {
    case "listening":
      statusText.textContent = "Listening";
      waveformEl.hidden = true;
      micBtn.classList.add("listening");
      break;
    case "thinking":
      statusText.textContent = "Thinking";
      waveformEl.hidden = true;
      micBtn.classList.add("thinking");
      // Add user message to conversation from transcript
      if (transcriptEl.textContent.trim()) {
        addConversationMessage("user", transcriptEl.textContent.trim());
        transcriptEl.textContent = "";
      }
      break;
    case "speaking":
      statusText.textContent = "Speaking";
      waveformEl.hidden = false;
      micBtn.classList.add("speaking");
      break;
    default:
      statusText.textContent = "Ready";
      waveformEl.hidden = true;
      break;
  }
}

// ─── Error Display ───────────────────────────────────────────────────────────
function showError(message) {
  const toast = document.createElement("div");
  toast.className = "error-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ─── Mic Toggle (Click to Start / Click to Stop) ────────────────────────────
async function toggleMic(e) {
  e.preventDefault();

  if (isMicActive) {
    // Stop listening
    stopStreaming();
    micBtn.querySelector("span").textContent = "Click to Start";
    micBtn.classList.remove("listening");
    return;
  }

  // Barge-in: if agent is playing, stop it
  if (isPlaying) {
    stopPlayback();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "interrupt" }));
    }
    finalizeAgentMessage();
  }

  if (!micInitialized) {
    try {
      await initMicrophone();
    } catch (err) {
      showError("Microphone access denied. Please allow microphone access.");
      console.error("Mic init error:", err);
      return;
    }
  }

  // Pre-warm playback context during user gesture so autoplay policy allows it
  initPlaybackContext();

  startStreaming();
  micBtn.querySelector("span").textContent = "Listening...";
}

micBtn.addEventListener("click", toggleMic);

// ─── Utilities ───────────────────────────────────────────────────────────────
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ─── Config Panel ────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  agentName: "Voice Assistant",
  systemPrompt:
    "You are a helpful voice assistant. Keep responses concise and conversational — typically 1-3 sentences unless the user asks for detail. Never use markdown, bullet points, or formatting in your responses since they will be spoken aloud.",
  voiceId: "aura-2-luna-en",
  maxTokens: 300,
};

const configPanel = document.getElementById("config-panel");
const configOverlay = document.getElementById("config-overlay");
const settingsBtn = document.getElementById("settings-btn");
const configCloseBtn = document.getElementById("config-close");
const configSaveBtn = document.getElementById("config-save");
const configPreset = document.getElementById("config-preset");
const configName = document.getElementById("config-name");
const configPrompt = document.getElementById("config-prompt");
const configVoice = document.getElementById("config-voice");
const configVoiceCustom = document.getElementById("config-voice-custom");
const configMaxTokens = document.getElementById("config-max-tokens");
const configMaxTokensVal = document.getElementById("config-max-tokens-val");
const agentTitle = document.getElementById("agent-title");

function openConfigPanel() {
  configPanel.classList.add("open");
  configOverlay.hidden = false;
}

function closeConfigPanel() {
  configPanel.classList.remove("open");
  configOverlay.hidden = true;
}

settingsBtn.addEventListener("click", openConfigPanel);
configCloseBtn.addEventListener("click", closeConfigPanel);
configOverlay.addEventListener("click", closeConfigPanel);

// Voice dropdown — show custom input when "custom" selected
configVoice.addEventListener("change", () => {
  configVoiceCustom.hidden = configVoice.value !== "custom";
  if (configVoice.value !== "custom") {
    configVoiceCustom.value = "";
  }
});

// Max tokens slider label
configMaxTokens.addEventListener("input", () => {
  configMaxTokensVal.textContent = configMaxTokens.value;
});

// Preset selector
configPreset.addEventListener("change", () => {
  if (configPreset.value === "default") {
    populateConfigForm(DEFAULT_CONFIG);
  }
});

function getConfigFromForm() {
  let voiceId = configVoice.value;
  if (voiceId === "custom") {
    voiceId = configVoiceCustom.value.trim() || DEFAULT_CONFIG.voiceId;
  }
  return {
    agentName: configName.value.trim() || DEFAULT_CONFIG.agentName,
    systemPrompt: configPrompt.value.trim() || DEFAULT_CONFIG.systemPrompt,
    voiceId,
    maxTokens: parseInt(configMaxTokens.value, 10),
  };
}

function populateConfigForm(config) {
  configName.value = config.agentName;
  configPrompt.value = config.systemPrompt;
  configMaxTokens.value = config.maxTokens;
  configMaxTokensVal.textContent = config.maxTokens;
  agentTitle.textContent = config.agentName;

  // Set voice dropdown
  const voiceOptions = Array.from(configVoice.options).map((o) => o.value);
  if (voiceOptions.includes(config.voiceId)) {
    configVoice.value = config.voiceId;
    configVoiceCustom.hidden = true;
  } else {
    configVoice.value = "custom";
    configVoiceCustom.hidden = false;
    configVoiceCustom.value = config.voiceId;
  }
}

function sendConfigToServer(config) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "config",
        systemPrompt: config.systemPrompt,
        voiceId: config.voiceId,
        maxTokens: config.maxTokens,
        agentName: config.agentName,
      })
    );
  }
}

function showToast(message, type) {
  const toast = document.createElement("div");
  toast.className = type === "error" ? "error-toast" : "success-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// Save button
configSaveBtn.addEventListener("click", () => {
  const config = getConfigFromForm();

  // Save to localStorage
  localStorage.setItem("voiceAgentConfig", JSON.stringify(config));
  configPreset.value = "custom";

  // Send to server
  sendConfigToServer(config);

  // Update title
  agentTitle.textContent = config.agentName;

  showToast("Settings applied", "success");
  closeConfigPanel();
});

// Load saved config on startup
function loadSavedConfig() {
  const saved = localStorage.getItem("voiceAgentConfig");
  if (saved) {
    try {
      const config = JSON.parse(saved);
      populateConfigForm(config);
      configPreset.value = "custom";
      return config;
    } catch (e) {
      // Ignore invalid JSON
    }
  }
  populateConfigForm(DEFAULT_CONFIG);
  return null;
}

const savedConfig = loadSavedConfig();

// ─── Init ────────────────────────────────────────────────────────────────────
connectWebSocket();

// Send saved config to server once connected
if (savedConfig) {
  const origOnOpen = ws.onopen;
  ws.onopen = () => {
    origOnOpen();
    sendConfigToServer(savedConfig);
  };
}
