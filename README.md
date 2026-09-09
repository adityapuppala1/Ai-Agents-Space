# Agent Space

A local-first command center for AI agents. Today it is a runnable workspace visualizer: a procedural 3D office, a task board, live WebSocket updates across browser tabs, and a small HTTP API that scripts or assistant hooks can call. The long-term direction, documented in [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md), is a workspace where real provider runs (Codex, Claude Agent SDK, Copilot, Cursor, Gemini CLI) drive the office.

![Desktop workspace](artifacts/workspace-desktop.png)

## Status

| Area                                             | State                                                        |
| ------------------------------------------------ | ------------------------------------------------------------ |
| React dashboard, task board, activity feed       | Working                                                      |
| Three.js office with six demo agents             | Working, all assets generated locally                        |
| Task lifecycle, assignment, progress, demo mode  | Working, in memory                                           |
| WebSocket snapshots and reconnect                | Working                                                      |
| Unit, integration, and Chrome browser tests      | Working                                                      |
| Persistent agents, workspaces, and runs (R1)     | In progress, see roadmap                                     |
| Real provider execution (R2 and later)           | Planned, no provider is connected                            |

The six visual agents represent workspace roles. They do not execute AI inference or coding tasks, and no assistant account is connected automatically. The planning documents in this repository are design references, not proof of implementation.

## Run

Requires Node.js **22.12+ or 24+** and a browser with WebGL2 for the 3D view.

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:5173**. The server starts with clearly labeled demo tasks. Set `DEMO=false` for an empty queue, or use the pause button to stop simulated progress. `PORT` changes the port and `HOST` the bind address (loopback by default).

```powershell
# Windows example
$env:DEMO = 'false'
npm start
```

For development run `npm run dev` (server with restart on change) and `npm run dev:web` (Vite with hot reload on http://127.0.0.1:3000) in two terminals.

## Verify

```sh
npm test          # Node unit and integration tests
npm run build     # Vite production build
npm run test:ui   # Playwright browser suite
```

The browser suite uses an installed Google Chrome, starts an isolated server on port 5174, and covers desktop and mobile rendering, two-tab synchronization, the manual task lifecycle, dialog focus, and theme persistence. To use another browser, change `channel` in `playwright.config.js`. On Linux CI run `npx playwright install chrome` first. Preview captures are written to `artifacts/`.

## API

All write endpoints require `Content-Type: application/json`. Requests are limited to 16 KB. Errors return `{ "error": "description" }` with a 4xx status. The server accepts local hosts and same-origin browser requests only.

| Endpoint                     | Purpose                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /api/health`            | Health, mode, and task count                                                                             |
| `GET /api/workspace`         | Complete task, agent, activity, and demo snapshot                                                        |
| `GET /api/tasks`             | Tasks ordered by priority and creation time                                                              |
| `POST /api/tasks`            | Create `{ "title", "description", "priority", "agentId" }`; omit `agentId` to queue                      |
| `POST /api/tasks/:id/assign` | Assign `{ "agentId": "nova" }` to an available agent                                                     |
| `PATCH /api/tasks/:id`       | Update `{ "status": "IN_PROGRESS", "progress": 25 }`                                                     |
| `POST /api/demo`             | `{ "running": false }` pauses, `{ "running": true }` resumes, `{ "action": "reset" }` reloads samples    |
| `WS /ws`                     | Read-only `workspace:snapshot` events with a complete `payload`                                          |

Agent IDs: `atlas`, `nova`, `echo`, `pixel`, `orbit`, `sage`. Priorities: `low`, `medium`, `high`, `critical`.

Lifecycle: `QUEUE → IN_PROGRESS → COMPLETED`, with `IN_PROGRESS ↔ BLOCKED`. Completion sets progress to 100 and releases the agent. Progress cannot decrease and completed tasks are immutable.

```powershell
$task = Invoke-RestMethod http://127.0.0.1:5173/api/tasks -Method Post -ContentType 'application/json' -Body '{"title":"Review project","priority":"high"}'
Invoke-RestMethod "http://127.0.0.1:5173/api/tasks/$($task.id)/assign" -Method Post -ContentType 'application/json' -Body '{"agentId":"sage"}'
Invoke-RestMethod "http://127.0.0.1:5173/api/tasks/$($task.id)" -Method Patch -ContentType 'application/json' -Body '{"status":"COMPLETED"}'
```

## Project layout

```text
apps/web/src/          React interface, WebSocket hook, Three.js scene
packages/core/src/     Task lifecycle, agent assignments, demo simulation
packages/server/src/   Local HTTP API, static frontend, WebSocket broadcast
tests/                 Node unit and integration tests
e2e/                   Chrome browser acceptance tests
artifacts/             Desktop and mobile captures
```

## Documents

| File                                                                 | Purpose                                                        |
| -------------------------------------------------------------------- | -------------------------------------------------------------- |
| [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md)                             | Product strategy, release gates R1–R6, and the next step       |
| [AGENT_WORKSPACE_SYSTEM_PROMPT.md](AGENT_WORKSPACE_SYSTEM_PROMPT.md) | Original visualizer specification                              |
| [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md)                         | Proposed monorepo layout                                       |
| [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md)                   | Original phased implementation notes                           |
| [QUICK_REFERENCE.md](QUICK_REFERENCE.md)                             | Architecture and UI quick reference                            |
| [STARTER_FILES.md](STARTER_FILES.md)                                 | Starter configuration samples                                  |

## Container option

```sh
docker build -t agent-space .
docker run --rm -p 127.0.0.1:5173:5173 agent-space
```

The container recipe has not been exercised in this environment. This MVP has no authentication and is intended for local use.
