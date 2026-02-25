const { v4: uuidv4 } = require("uuid");
const deepgramSTT = require("./deepgramSTT");
const claudeAgent = require("./claudeAgent");
const elevenLabsTTS = require("./elevenLabsTTS");
const { SentenceBuffer } = require("./sentenceBuffer");

const sessions = new Map();

function createSession(ws) {
  const session = {
    id: uuidv4(),
    ws,
    conversationHistory: [],
    deepgramConnection: null,
    elevenLabsConnection: null,
    currentClaudeStream: null,
    currentTTSStream: null,
    currentUtterance: "",
    config: {
      systemPrompt:
        "You are a helpful voice assistant. Keep responses concise and conversational — typically 1-3 sentences unless the user asks for detail. Never use markdown, bullet points, or formatting in your responses since they will be spoken aloud.",
      voiceId: process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM",
      model: "claude-sonnet-4-6",
      maxTokens: 300,
      agentName: "Voice Assistant",
    },
    state: "idle",
  };

  sessions.set(session.id, session);

  // Initialize Deepgram STT connection
  deepgramSTT.createConnection(session, async (utterance) => {
    if (!utterance || utterance.trim().length === 0) return;

    console.log(`[Session ${session.id}] User said: "${utterance}"`);
    setState(session, "thinking");

    // Create TTS stream for this turn
    let ttsStream = null;
    try {
      ttsStream = await elevenLabsTTS.createTTSStream(session, setState);
      session.currentTTSStream = ttsStream;
    } catch (err) {
      console.error(`[Session ${session.id}] TTS init failed, text-only fallback:`, err.message);
    }

    const sentenceBuffer = new SentenceBuffer((sentence) => {
      console.log(`[Session ${session.id}] -> TTS: "${sentence}"`);
      if (ttsStream) {
        ttsStream.sendText(sentence);
      }
    });

    await claudeAgent.streamResponse(
      session,
      utterance,
      (textChunk) => sentenceBuffer.add(textChunk),
      () => {
        sentenceBuffer.flush();
        if (ttsStream) {
          ttsStream.close(); // Send EOS, wait for remaining audio
        } else {
          // No TTS — go straight to listening
          setState(session, "listening");
        }
      }
    );
  });

  setState(session, "idle");

  return session;
}

function destroySession(id) {
  const session = sessions.get(id);
  if (!session) return;

  // Close Deepgram
  deepgramSTT.closeConnection(session);

  // Abort Claude stream if active
  if (session.currentClaudeStream) {
    session.currentClaudeStream.abort();
    session.currentClaudeStream = null;
  }

  // Close ElevenLabs if active
  if (session.currentTTSStream) {
    try {
      session.currentTTSStream.forceClose();
    } catch (err) {
      // Ignore
    }
    session.currentTTSStream = null;
  }

  sessions.delete(id);
}

function getSession(id) {
  return sessions.get(id);
}

function setState(session, state) {
  session.state = state;
  if (session.ws.readyState === 1) {
    session.ws.send(JSON.stringify({ type: "state", state }));
  }
}

function interrupt(session) {
  console.log(`[Session ${session.id}] Interrupt — cancelling agent response`);

  // Cancel Claude stream
  claudeAgent.cancelStream(session);

  // Force-close ElevenLabs TTS
  if (session.currentTTSStream) {
    session.currentTTSStream.forceClose();
    session.currentTTSStream = null;
  }

  // Notify client to stop playback
  if (session.ws.readyState === 1) {
    session.ws.send(JSON.stringify({ type: "agentSpeakingDone" }));
  }

  setState(session, "listening");
}

module.exports = { createSession, destroySession, getSession, setState, interrupt };
