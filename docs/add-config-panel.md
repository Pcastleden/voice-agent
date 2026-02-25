# Instruction: Add Agent Configuration Panel

Add a collapsible settings panel to the client UI that lets the user configure the agent without touching code. This panel should be accessible via a gear icon in the top-right corner of the page.

## Panel Fields

1. **Agent Name** — text input, default "Voice Assistant"
2. **System Prompt** — large textarea (at least 8 rows), default to the current system prompt from sessionManager. This is where the user defines who the agent is, how it behaves, what it knows, etc.
3. **Voice** — dropdown selector populated with a few preset ElevenLabs voice options:
   - Rachel (21m00Tcm4TlvDq8ikWAM) — default
   - Josh (TxGEqnHWrfWFTfGW9XjX)
   - Bella (EXAVITQu4vr4xnSDxMaL)
   - Antoni (ErXwobaYiN019PkySvjV)
   - Elli (MF3mGyEYCl7XYWbV9V6O)
   - Also allow a custom voice ID text input for any ElevenLabs voice
4. **Max Response Length** — slider or number input, range 50-1000 tokens, default 300
5. **Save / Apply** button — sends the config to the server via the existing WebSocket as a `{ type: "config", ... }` message, which updates the session config
6. **Preset Selector** — dropdown at the top of the panel with options: "Default", "Custom". When the user saves a config, store it in localStorage so it persists across page reloads. Later we can add more presets.

## Behaviour

- Panel slides in/out from the right side, overlaying the main UI
- Config can be changed mid-session — it takes effect on the next agent turn (not mid-response)
- When the page loads, check localStorage for a saved config and apply it automatically
- The server's `sessionManager` must accept and apply the `config` message type (this should already be in the WebSocket protocol from the main spec)
- Show a brief toast/notification "Settings applied" when saved

## Design

- Match the existing dark theme
- Keep it clean — no clutter
- The textarea for the system prompt should use a monospace font for readability
- Panel should be responsive and work on mobile (full-width on small screens)
