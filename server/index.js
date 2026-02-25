require("dotenv").config();

const http = require("http");
const express = require("express");
const path = require("path");
const { WebSocketServer } = require("ws");
const sessionManager = require("./sessionManager");
const deepgramSTT = require("./deepgramSTT");

const app = express();
const server = http.createServer(app);

// Serve static files from client directory
app.use(express.static(path.join(__dirname, "..", "client")));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  console.log("New WebSocket connection");

  const session = sessionManager.createSession(ws);
  console.log(`[Session ${session.id}] Created`);

  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());

      switch (message.type) {
        case "audio":
          deepgramSTT.sendAudio(session, message.data);
          break;

        case "interrupt":
          sessionManager.interrupt(session);
          break;

        case "reset":
          sessionManager.interrupt(session);
          session.conversationHistory = [];
          console.log(`[Session ${session.id}] Conversation reset`);
          break;

        case "config":
          if (message.systemPrompt) session.config.systemPrompt = message.systemPrompt;
          if (message.voiceId) session.config.voiceId = message.voiceId;
          if (message.maxTokens) session.config.maxTokens = parseInt(message.maxTokens, 10);
          if (message.agentName) session.config.agentName = message.agentName;
          console.log(`[Session ${session.id}] Config updated`);
          break;

        default:
          console.log(`[Session ${session.id}] Unknown message type: ${message.type}`);
      }
    } catch (err) {
      console.error(`[Session ${session.id}] Message parse error:`, err.message);
    }
  });

  ws.on("close", () => {
    console.log(`[Session ${session.id}] Disconnected`);
    sessionManager.destroySession(session.id);
  });

  ws.on("error", (err) => {
    console.error(`[Session ${session.id}] WebSocket error:`, err.message);
    sessionManager.destroySession(session.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Voice Agent server running on http://localhost:${PORT}`);
});
