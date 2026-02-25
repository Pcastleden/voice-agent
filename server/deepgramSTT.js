const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

function createConnection(session, onUtteranceComplete) {
  const connection = deepgram.listen.live({
    model: "nova-2",
    language: "en",
    smart_format: true,
    endpointing: 300,
    interim_results: true,
    utterance_end_ms: 1000,
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
  });

  session.deepgramConnection = connection;

  connection.on(LiveTranscriptionEvents.Open, () => {
    console.log(`[Session ${session.id}] Deepgram connected`);
  });

  connection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (!transcript || transcript.trim() === "") return;

    if (!data.is_final) {
      // Interim result — send for real-time display
      send(session, { type: "transcript", text: transcript, isFinal: false });
    } else {
      // Final result — accumulate as part of current utterance
      send(session, { type: "transcript", text: transcript, isFinal: true });
      session.currentUtterance = (session.currentUtterance || "") + " " + transcript;

      // speech_final means the user finished a complete thought
      if (data.speech_final) {
        const utterance = session.currentUtterance.trim();
        session.currentUtterance = "";
        if (utterance) {
          onUtteranceComplete(utterance);
        }
      }
    }
  });

  connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
    // Backup endpoint detection — fires after utterance_end_ms of silence
    const utterance = (session.currentUtterance || "").trim();
    session.currentUtterance = "";
    if (utterance) {
      onUtteranceComplete(utterance);
    }
  });

  connection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error(`[Session ${session.id}] Deepgram error:`, err);
    send(session, { type: "error", message: "Speech recognition error" });
  });

  connection.on(LiveTranscriptionEvents.Close, () => {
    console.log(`[Session ${session.id}] Deepgram connection closed`);

    // Auto-reconnect if session is still active (not intentionally closed)
    if (session.deepgramConnection === connection && session.ws.readyState === 1) {
      console.log(`[Session ${session.id}] Reconnecting to Deepgram...`);
      setTimeout(() => {
        if (session.ws.readyState === 1) {
          createConnection(session, onUtteranceComplete);
        }
      }, 1000);
    }
  });

  return connection;
}

function sendAudio(session, base64Data) {
  if (!session.deepgramConnection) return;
  try {
    const buffer = Buffer.from(base64Data, "base64");
    session.deepgramConnection.send(buffer);
  } catch (err) {
    console.error(`[Session ${session.id}] Error sending audio to Deepgram:`, err.message);
  }
}

function closeConnection(session) {
  if (session.deepgramConnection) {
    try {
      session.deepgramConnection.requestClose();
    } catch (err) {
      // Ignore close errors
    }
    session.deepgramConnection = null;
  }
}

function send(session, message) {
  if (session.ws.readyState === 1) {
    session.ws.send(JSON.stringify(message));
  }
}

module.exports = { createConnection, sendAudio, closeConnection };
