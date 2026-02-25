const WebSocket = require("ws");

function createTTSStream(session, setState) {
  return new Promise((resolve, reject) => {
    const model = session.config.voiceId || "aura-2-luna-en";
    const url = `wss://api.deepgram.com/v1/speak?model=${model}&encoding=linear16&sample_rate=16000`;

    const ttsWs = new WebSocket(url, {
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      },
    });

    let isOpen = false;
    let isClosed = false;
    let audioChunkCount = 0;
    let closeTimeout = null;

    ttsWs.on("open", () => {
      isOpen = true;
      console.log(`[Session ${session.id}] Deepgram TTS connected (model: ${model})`);

      resolve({
        sendText(text) {
          if (isOpen && !isClosed) {
            ttsWs.send(JSON.stringify({ type: "Speak", text: text + " " }));
            ttsWs.send(JSON.stringify({ type: "Flush" }));
          }
        },

        close() {
          if (isOpen && !isClosed) {
            ttsWs.send(JSON.stringify({ type: "Flush" }));
            ttsWs.send(JSON.stringify({ type: "Close" }));

            // Safety timeout
            closeTimeout = setTimeout(() => {
              if (!isClosed) {
                console.log(`[Session ${session.id}] TTS timeout, forcing close`);
                isClosed = true;
                ttsWs.close();
                notifyDone();
              }
            }, 10000);
          }
        },

        forceClose() {
          isClosed = true;
          if (closeTimeout) clearTimeout(closeTimeout);
          if (ttsWs.readyState === WebSocket.OPEN || ttsWs.readyState === WebSocket.CONNECTING) {
            ttsWs.close();
          }
        },
      });
    });

    ttsWs.on("message", (data, isBinary) => {
      if (isClosed) return;

      if (isBinary) {
        // Binary frame = raw PCM audio
        audioChunkCount++;
        if (audioChunkCount === 1) {
          console.log(`[Session ${session.id}] First TTS audio chunk received`);
        }

        // Convert to base64 and forward to client
        const base64Audio = Buffer.from(data).toString("base64");
        if (session.ws.readyState === 1) {
          session.ws.send(
            JSON.stringify({
              type: "audio",
              data: base64Audio,
            })
          );
        }

        // Set speaking state on first audio chunk
        if (audioChunkCount === 1 && setState) {
          setState(session, "speaking");
        }
      } else {
        // Text frame = JSON metadata/control message
        try {
          const message = JSON.parse(data.toString());
          console.log(`[Session ${session.id}] Deepgram TTS msg:`, message.type);

          if (message.type === "Flushed") {
            // Flush confirmed — audio for that segment is done
          }

          if (message.type === "Warning" || message.type === "Error") {
            console.error(`[Session ${session.id}] Deepgram TTS ${message.type}:`, message.description);
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    });

    ttsWs.on("error", (error) => {
      console.error(`[Session ${session.id}] Deepgram TTS error:`, error.message);
      isClosed = true;
      if (closeTimeout) clearTimeout(closeTimeout);
      if (!isOpen) reject(error);
    });

    ttsWs.on("close", () => {
      if (!isClosed) {
        isClosed = true;
        if (closeTimeout) clearTimeout(closeTimeout);
        notifyDone();
      }
    });

    function notifyDone() {
      if (session.ws.readyState === 1) {
        session.ws.send(JSON.stringify({ type: "agentSpeakingDone" }));
      }
      if (setState) {
        setState(session, "listening");
      }
    }
  });
}

module.exports = { createTTSStream };
