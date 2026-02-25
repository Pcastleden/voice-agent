# Voice Agent MVP — Technical Specification

## Project Overview

Build a browser-based real-time voice agent that rivals commercial platforms (Voiceflow, Bland AI, Vapi) in speed and quality. The user speaks into their browser mic, speech is transcribed in real-time, an AI agent responds conversationally, and the response is spoken back with natural-sounding TTS — all with sub-1.5-second time-to-first-audio.

This is a client-demo-ready MVP. Prioritise speed, accuracy, and quality over cost.

## Architecture

```
Browser (Client)
  ├── Captures mic audio via MediaRecorder API (raw PCM/webm)
  ├── Streams audio to server via WebSocket
  ├── Receives TTS audio chunks via same WebSocket
  ├── Plays audio using AudioContext for gapless playback
  └── Handles barge-in (interrupt detection)

Server (Node.js)
  ├── WebSocket server (ws library)
  ├── Deepgram STT — streaming WebSocket connection per session
  ├── Anthropic Claude API — streaming chat completions (Sonnet)
  └── ElevenLabs TTS — streaming WebSocket API per session
```

### Data Flow (Pipelined for Speed)

```
User speaks → mic audio streams to server
  → Server pipes audio to Deepgram WebSocket
    → Deepgram returns real-time transcript + endpointing signal
      → On endpoint (user stopped speaking):
        → Full utterance sent to Claude API (streaming)
          → As Claude streams, buffer text until sentence boundary detected
            → Each complete sentence sent to ElevenLabs WebSocket
              → ElevenLabs streams audio chunks back
                → Server forwards audio chunks to browser via WebSocket
                  → Browser plays audio immediately using AudioContext
```

This pipeline means TTS audio generation starts while Claude is still generating text. Target: ~1.0-1.3s from end-of-speech to first audio playback.

## Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Runtime | Node.js 20+ | WebSocket-native, good streaming support |
| Server framework | Express (HTTP) + ws (WebSocket) | Lightweight, no overhead |
| STT | Deepgram Nova-2 Streaming API | Best accuracy + lowest latency for streaming STT |
| LLM | Claude Sonnet (claude-sonnet-4-5-20250514) | Fast, excellent for conversation, streaming support |
| TTS | ElevenLabs Streaming WebSocket API | Lowest latency TTS, natural voices |
| Client | Vanilla HTML/JS/CSS | No framework overhead, direct Web API access |

## Project Structure

```
voice-agent/
├── server/
│   ├── index.js              # Express + WebSocket server setup
│   ├── sessionManager.js     # Manages per-client session state
│   ├── deepgramSTT.js        # Deepgram streaming STT handler
│   ├── claudeAgent.js        # Claude API conversation handler
│   ├── elevenLabsTTS.js      # ElevenLabs streaming TTS handler
│   └── sentenceBuffer.js     # Buffers Claude stream, emits complete sentences
├── client/
│   ├── index.html            # Single page — mic button, status indicators, transcript display
│   ├── app.js                # WebSocket client, mic capture, audio playback
│   └── style.css             # Clean, minimal, professional UI
├── .env.example              # Template for required API keys
├── package.json
└── README.md
```

## Detailed Component Specifications

### 1. Server Entry Point (`server/index.js`)

- Express server on port 3000 (configurable via env)
- Serve static files from `client/` directory
- Create WebSocket server on the same HTTP server using `ws`
- On new WebSocket connection:
  - Create a new session via `sessionManager`
  - Set up message routing based on message type
  - Handle disconnection cleanup

WebSocket message protocol (JSON):
```javascript
// Client → Server
{ type: "audio", data: "<base64 encoded audio chunk>" }
{ type: "interrupt" }   // User started speaking during agent response
{ type: "config", systemPrompt: "...", voiceId: "..." }  // Optional session config

// Server → Client
{ type: "transcript", text: "...", isFinal: false }           // Real-time STT
{ type: "transcript", text: "...", isFinal: true }            // Final transcript
{ type: "agentText", text: "..." }                            // Claude's text (for display)
{ type: "audio", data: "<base64 encoded audio chunk>" }       // TTS audio
{ type: "agentSpeakingDone" }                                 // Agent finished speaking
{ type: "state", state: "listening|thinking|speaking" }       // UI state updates
{ type: "error", message: "..." }                             // Error messages
```

### 2. Session Manager (`server/sessionManager.js`)

Each WebSocket connection gets a session object:

```javascript
{
  id: "uuid",
  ws: WebSocket,                    // Client WebSocket
  conversationHistory: [],          // Claude messages array
  deepgramConnection: null,         // Live Deepgram WebSocket
  elevenLabsConnection: null,       // Live ElevenLabs WebSocket
  currentClaudeStream: null,        // AbortController for cancellation
  config: {
    systemPrompt: "You are a helpful voice assistant. Keep responses concise and conversational — typically 1-3 sentences unless the user asks for detail. Never use markdown, bullet points, or formatting in your responses since they will be spoken aloud.",
    voiceId: "21m00Tcm4TlvDq8ikWAM",  // ElevenLabs Rachel voice (default)
    model: "claude-sonnet-4-5-20250514"
  },
  state: "idle"  // idle | listening | thinking | speaking
}
```

Key methods:
- `createSession(ws)` — initialise session, set up Deepgram connection
- `destroySession(id)` — close all connections, clean up
- `interrupt(id)` — cancel Claude stream, close ElevenLabs stream, stop audio
- `setState(id, state)` — update state and notify client

### 3. Deepgram STT (`server/deepgramSTT.js`)

Use Deepgram's **streaming WebSocket API** (not REST).

Connection setup:
```javascript
// Use Deepgram JS SDK: @deepgram/sdk
// Connection params:
{
  model: "nova-2",           // Best accuracy model
  language: "en",
  smart_format: true,        // Punctuation, capitalisation
  endpointing: 300,          // Milliseconds of silence to trigger endpoint (300ms is responsive)
  interim_results: true,     // Send partial results for real-time display
  utterance_end_ms: 1000,    // Backup endpoint detection
  encoding: "linear16",      // PCM audio format
  sample_rate: 16000,
  channels: 1
}
```

Handle these Deepgram events:
- `Transcript` with `is_final: false` → send interim transcript to client for real-time display
- `Transcript` with `is_final: true` → accumulate as part of current utterance
- `UtteranceEnd` or `SpeechFinal` → user has stopped speaking, trigger Claude with full utterance
- `Error` → log and notify client

**Important**: Keep the Deepgram connection alive for the duration of the session. Don't reconnect per utterance.

Audio format from browser: The browser should capture audio as **Linear16 PCM, 16kHz, mono**. Use AudioWorklet to resample from the browser's native sample rate (usually 48kHz) to 16kHz.

### 4. Claude Agent (`server/claudeAgent.js`)

Use the Anthropic SDK with streaming:

```javascript
const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic();

async function* streamResponse(session, userMessage) {
  // Add user message to history
  session.conversationHistory.push({ role: "user", content: userMessage });

  // Create AbortController for interruption support
  const controller = new AbortController();
  session.currentClaudeStream = controller;

  const stream = client.messages.stream({
    model: session.config.model,
    max_tokens: 300,          // Keep responses concise for voice
    system: session.config.systemPrompt,
    messages: session.conversationHistory,
  }, { signal: controller.signal });

  let fullResponse = "";

  for await (const event of stream) {
    if (event.type === "content_block_delta") {
      const text = event.delta.text;
      fullResponse += text;
      yield text;  // Yield each chunk for sentence buffering
    }
  }

  // Add assistant response to history
  session.conversationHistory.push({ role: "assistant", content: fullResponse });
  session.currentClaudeStream = null;
}
```

**Conversation history management**:
- Keep the full conversation history for context
- If history exceeds ~20 exchanges, summarise older messages to keep token count manageable
- On interruption, add the partial response to history with a note: `"[interrupted] partial response text..."`

### 5. Sentence Buffer (`server/sentenceBuffer.js`)

This is critical for pipelining. As Claude streams text, we need to detect complete sentences and dispatch them to TTS immediately.

```javascript
class SentenceBuffer {
  constructor(onSentence) {
    this.buffer = "";
    this.onSentence = onSentence;  // Callback with complete sentence
  }

  add(text) {
    this.buffer += text;
    // Check for sentence boundaries: . ! ? followed by space or end
    // Also handle: "..." and other patterns
    // Be careful not to split on "Dr." "Mr." "e.g." etc.
    const sentenceEnders = /([.!?]+[\s]|[.!?]+$)/;
    // Extract and emit complete sentences
    // Keep remainder in buffer
  }

  flush() {
    // Emit whatever is left in buffer (end of response)
    if (this.buffer.trim()) {
      this.onSentence(this.buffer.trim());
      this.buffer = "";
    }
  }
}
```

The sentence buffer should err on the side of sending slightly shorter chunks to keep latency low. A sentence or clause of 5+ words is worth sending.

### 6. ElevenLabs TTS (`server/elevenLabsTTS.js`)

Use the **WebSocket streaming API** for lowest latency.

```javascript
// WebSocket URL:
// wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input?model_id=eleven_turbo_v2_5&output_format=pcm_16000&optimize_streaming_latency=4

// Send text chunks as JSON:
{
  "text": "Hello, how can I help you today? ",  // Note trailing space
  "voice_settings": {
    "stability": 0.5,
    "similarity_boost": 0.75
  },
  "xi_api_key": "YOUR_API_KEY"   // Send in first message only
}

// Signal end of input:
{ "text": "" }   // Empty string flushes remaining audio

// Receive: binary audio data (PCM 16-bit, 16kHz)
// Forward these chunks directly to the client WebSocket
```

**Important settings**:
- `model_id`: `eleven_turbo_v2_5` — fastest model
- `output_format`: `pcm_16000` — raw PCM for direct playback, 16kHz sample rate
- `optimize_streaming_latency`: `4` — maximum latency optimisation
- Send the `xi_api_key` only in the **first** message of each connection (called the BOS — Beginning of Stream message)
- After all text is sent, send `{ "text": "" }` to flush remaining audio (EOS — End of Stream)

**Connection lifecycle**: Open a new ElevenLabs WebSocket for each agent turn (not per session). Close it after receiving all audio for that turn.

### 7. Client — HTML (`client/index.html`)

Single page, clean professional UI:

```
┌─────────────────────────────────────┐
│          Voice Agent Demo           │
│                                     │
│     ┌───────────────────────┐       │
│     │                       │       │
│     │   Conversation area   │       │
│     │   (scrolling)         │       │
│     │                       │       │
│     │  User: "What can..."  │       │
│     │  Agent: "I can help.."│       │
│     │                       │       │
│     └───────────────────────┘       │
│                                     │
│     [  Current transcript...  ]     │  ← Real-time STT display
│                                     │
│          ● Listening...             │  ← Status indicator with animation
│                                     │
│         [ 🎤 Hold to Talk ]         │  ← Large, prominent button
│                                     │
│    or  [ Toggle Continuous Mode ]   │
│                                     │
└─────────────────────────────────────┘
```

Two interaction modes:
1. **Push-to-talk**: Hold button to speak, release to send (simpler, avoids false triggers)
2. **Continuous mode**: Always listening, uses Deepgram endpointing to detect turns (more natural but needs barge-in handling)

Start with push-to-talk as default. Continuous mode is a stretch goal.

### 8. Client — JavaScript (`client/app.js`)

Key responsibilities:

**Audio Capture**:
- Use `navigator.mediaDevices.getUserMedia({ audio: true })`
- Create AudioContext and AudioWorklet processor to:
  - Resample from native rate (usually 48kHz) to 16kHz
  - Convert to Linear16 PCM
  - Output as raw byte buffers
- Stream audio chunks to server WebSocket as base64-encoded messages

**AudioWorklet processor** (must be a separate file or inline blob):
```javascript
// Resamples input audio to 16kHz Linear16 PCM
class AudioProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0][0]; // First channel
    if (!input) return true;
    // Downsample from sampleRate to 16000
    // Convert float32 to int16
    // Post to main thread
    this.port.postMessage(/* int16 buffer */);
    return true;
  }
}
```

**Audio Playback**:
- Use AudioContext with a queue of audio buffers
- On receiving audio chunks from server:
  - Decode base64 → ArrayBuffer → Int16Array
  - Convert to Float32Array
  - Create AudioBuffer and queue for playback
  - Use `AudioBufferSourceNode` chained with precise scheduling for gapless playback
- Track playback position to know when agent is done speaking

**Barge-In (Interruption)**:
- When in continuous mode and user starts speaking while agent is playing audio:
  - Stop all queued audio playback
  - Send `{ type: "interrupt" }` to server
  - Server cancels Claude stream and ElevenLabs stream
  - Resume listening for new user input

### 9. Client — Styling (`client/style.css`)

Professional, minimal design:
- Dark theme (dark charcoal background, not pure black)
- Large, centered microphone button with pulsing animation when listening
- Smooth state transitions (listening → thinking → speaking)
- Status indicator with subtle animated dots or waveform
- Conversation history with clear visual distinction between user/agent
- Use a clean sans-serif font (Inter or system font stack)
- Mobile-responsive

Visual states:
- **Idle**: Mic button static, neutral colour
- **Listening**: Mic button pulsing green, audio waveform animation
- **Thinking**: Pulsing blue/purple dots or spinner
- **Speaking**: Animated waveform or speaker icon, mic button dimmed

## Environment Variables

```env
ANTHROPIC_API_KEY=sk-ant-...
DEEPGRAM_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
PORT=3000
```

## Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "latest",
    "@deepgram/sdk": "latest",
    "ws": "^8.0.0",
    "express": "^4.18.0",
    "dotenv": "^16.0.0",
    "uuid": "^9.0.0"
  }
}
```

## Build Order (Follow This Sequence)

### Phase 1: Audio Pipeline
1. Set up Express server with WebSocket support
2. Build the client HTML/CSS with mic button
3. Implement AudioWorklet for mic capture (resample to 16kHz PCM)
4. Stream audio from browser to server via WebSocket
5. Connect server to Deepgram streaming API
6. Display real-time transcripts in browser
7. **Test**: Speak and see your words appear in real-time

### Phase 2: AI Response
8. Integrate Claude streaming API
9. Build sentence buffer
10. On Deepgram endpoint event, send transcript to Claude
11. Stream Claude's text response back to client for display
12. **Test**: Speak, see transcript, see AI text response

### Phase 3: Voice Output
13. Connect sentence buffer output to ElevenLabs WebSocket streaming API
14. Stream TTS audio chunks back to client
15. Implement AudioContext-based gapless audio playback
16. Wire up the full loop: speak → transcript → AI → TTS → playback
17. **Test**: Full voice conversation loop working

### Phase 4: Polish
18. Implement barge-in / interruption handling
19. Add visual state indicators and animations
20. Add conversation history display
21. Error handling and recovery (reconnection, API failures)
22. Add push-to-talk and continuous mode toggle
23. **Test**: Demo-ready quality, smooth experience

## Important Implementation Notes

1. **Sentence boundary detection matters a lot**. Too aggressive = choppy TTS. Too conservative = high latency. Start with splitting on `. `, `! `, `? ` and tune from there. Abbreviations (Dr., Mr., etc.) should not trigger splits.

2. **Audio format consistency**: Browser captures at native rate (48kHz typically) → resample to 16kHz for Deepgram. ElevenLabs outputs PCM at 16kHz → convert back for AudioContext playback (which uses the browser's native rate).

3. **Error recovery**: If Deepgram disconnects, reconnect immediately. If ElevenLabs fails, fall back to displaying text only. Never let one component failure kill the whole session.

4. **Memory management**: Audio buffers accumulate. Clean up played AudioBufferSourceNodes. Don't hold references to old audio data.

5. **Conversation history pruning**: Voice conversations generate lots of short turns. After ~20 exchanges, consider summarising older context to avoid hitting token limits.

6. **Claude's system prompt should explicitly say**: responses are being spoken aloud, so avoid markdown, lists, URLs, special characters, or anything that sounds unnatural when read by TTS.

7. **Test with headphones** during development to avoid the mic picking up the agent's audio output (echo/feedback loop).

## Testing Checklist

- [ ] Microphone permissions work on first visit
- [ ] Real-time transcript appears with <500ms latency
- [ ] Agent responds within 1.5s of user finishing speaking
- [ ] Audio playback is smooth with no gaps or pops
- [ ] Interrupting the agent works cleanly
- [ ] Conversation context is maintained across multiple turns
- [ ] Works in Chrome (primary target) and Edge
- [ ] Mobile browser works (iOS Safari, Android Chrome)
- [ ] Graceful error handling for API failures
- [ ] No audio feedback loop when not using headphones (stretch goal)
