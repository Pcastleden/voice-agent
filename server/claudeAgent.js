const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic();

async function streamResponse(session, userMessage, onTextChunk, onComplete) {
  session.conversationHistory.push({ role: "user", content: userMessage });

  const controller = new AbortController();
  session.currentClaudeStream = controller;

  let fullResponse = "";

  try {
    const stream = client.messages.stream(
      {
        model: session.config.model,
        max_tokens: session.config.maxTokens || 300,
        system: session.config.systemPrompt,
        messages: session.conversationHistory,
      },
      { signal: controller.signal }
    );

    stream.on("text", (text) => {
      fullResponse += text;
      onTextChunk(text);

      // Send to client for display
      if (session.ws.readyState === 1) {
        session.ws.send(JSON.stringify({ type: "agentText", text }));
      }
    });

    await stream.finalMessage();

    session.conversationHistory.push({ role: "assistant", content: fullResponse });
    session.currentClaudeStream = null;

    pruneHistory(session);
    onComplete();
  } catch (error) {
    if (error.name === "AbortError" || controller.signal.aborted) {
      // Interrupted by user — save partial response
      if (fullResponse) {
        session.conversationHistory.push({
          role: "assistant",
          content: `[interrupted] ${fullResponse}`,
        });
      }
      console.log(`[Session ${session.id}] Claude stream interrupted`);
    } else {
      console.error(`[Session ${session.id}] Claude error:`, error.message);
      if (session.ws.readyState === 1) {
        session.ws.send(
          JSON.stringify({
            type: "error",
            message: "AI response failed. Please try again.",
          })
        );
      }
    }
    session.currentClaudeStream = null;
  }
}

function pruneHistory(session) {
  const maxMessages = 40;
  if (session.conversationHistory.length > maxMessages) {
    session.conversationHistory = session.conversationHistory.slice(-maxMessages);
  }
}

function cancelStream(session) {
  if (session.currentClaudeStream) {
    session.currentClaudeStream.abort();
    session.currentClaudeStream = null;
  }
}

module.exports = { streamResponse, cancelStream };
