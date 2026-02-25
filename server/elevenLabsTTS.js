const WebSocket = require("ws");

function createTTSStream(session, setState) {
  return new Promise((resolve, reject) => {
    const voiceId = session.config.voiceId;
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_turbo_v2_5&output_format=pcm_16000&optimize_streaming_latency=4`;

    const ttsWs = new WebSocket(url);
    let isOpen = false;
    let isClosed = false;
    let audioChunkCount = 0;
    let closeTimeout = null;

    ttsWs.on("open", () => {
      isOpen = true;

      // Send BOS (Beginning of Stream) message with API key
      ttsWs.send(
        JSON.stringify({
          text: " ",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0,
            use_speaker_boost: true,
          },
          generation_config: {
            chunk_length_schedule: [120, 160, 250, 290],
          },
          xi_api_key: process.env.ELEVENLABS_API_KEY,
        })
      );

      resolve({
        sendText(text) {
          if (isOpen && !isClosed) {
            ttsWs.send(
              JSON.stringify({
                text: text + " ",
                try_trigger_generation: true,
              })
            );
          }
        },

        close() {
          if (isOpen && !isClosed) {
            // Send EOS — empty string flushes remaining audio
            ttsWs.send(JSON.stringify({ text: "" }));

            // Safety timeout: if no isFinal after 10s, force close
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

    ttsWs.on("message", (data) => {
      if (isClosed) return;

      try {
        const message = JSON.parse(data.toString());

        if (message.audio) {
          audioChunkCount++;
          // Forward audio to client
          if (session.ws.readyState === 1) {
            session.ws.send(
              JSON.stringify({
                type: "audio",
                data: message.audio, // Already base64 from ElevenLabs
              })
            );
          }

          // Set speaking state on first audio chunk
          if (audioChunkCount === 1 && setState) {
            setState(session, "speaking");
          }
        }

        if (message.isFinal) {
          isClosed = true;
          if (closeTimeout) clearTimeout(closeTimeout);
          ttsWs.close();
          notifyDone();
        }
      } catch (e) {
        // Could be raw binary data in some edge cases
        console.error(`[Session ${session.id}] TTS message parse error:`, e.message);
      }
    });

    ttsWs.on("error", (error) => {
      console.error(`[Session ${session.id}] ElevenLabs error:`, error.message);
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
