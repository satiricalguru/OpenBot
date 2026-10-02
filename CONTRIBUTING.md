# Contributing to OpenBot

Thanks for helping make free AI teammates better!

## Dev setup

```bash
git clone https://github.com/satiricalguru/OpenBot.git
cd OpenBot
npm install
npm run app        # desktop app (Electron)
# or
npm start          # server only → http://localhost:4321
```

You'll need Node 22.13+, `ffmpeg`, and a free model (for example `ollama pull qwen3:8b`).

## Project layout

| Path | What lives there |
|---|---|
| `electron/` | Desktop shell: window, menu-bar icon, theme sync |
| `server/agents/` | Agent loop, tools, rules & approvals, routines |
| `server/video/` | ffmpeg pipeline, Whisper/CLIP, multimodal search |
| `server/llm.js` | Ollama + OpenAI-compatible providers |
| `public/js/` | Dependency-free UI (ES modules): `bot.js` draws the animated bots |
| `scripts/capture.cjs` | Regenerates README screenshots and GIFs |

## Guidelines

- Keep it **free**. No feature may require a paid service.
- Keep it **dependency-light**. The UI is plain ES modules with no build step.
- New agent tools go in `server/agents/tools.js` with a `risk` level (`read`, `write` or `dangerous`) so the rules engine can gate them.
- Run `npm run check` before opening a PR.
- For UI changes, include a screenshot in both **dark** and **light** themes.

## Updating README media

```bash
npm start                         # in one terminal
npx electron scripts/capture.cjs  # in another; writes docs/assets/*
```
