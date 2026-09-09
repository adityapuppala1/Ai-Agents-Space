# AI Agent Workspace - Quick Reference & Visual Guide

## 🎯 Project Overview

```
┌────────────────────────────────────────────────────────────────┐
│  🚀 AI Agent Workspace Visualizer                              │
│  Cross-Platform 3D Real-Time Agent Visualization               │
└────────────────────────────────────────────────────────────────┘

YOUR CODING ASSISTANT (Any Platform)
        ↓ Auto-detects running assistant
┌───────────────────────────────────────┐
│  Platform Detection Engine            │
│  - Scans localhost ports              │
│  - Identifies platform type           │
│  - Establishes connection             │
└───────────────────────────────────────┘
        ↓ Fetches active tasks
┌───────────────────────────────────────┐
│  Task Detection & Parsing             │
│  - Console log monitoring             │
│  - DOM mutation tracking              │
│  - File system watching               │
│  - Message parsing (NLP)              │
└───────────────────────────────────────┘
        ↓ Creates/updates tasks
┌───────────────────────────────────────┐
│  Task Queue Manager                   │
│  - Priority sorting                   │
│  - Dependency tracking                │
│  - Agent matching                     │
└───────────────────────────────────────┘
        ↓ Broadcasts via WebSocket
┌───────────────────────────────────────┐
│  Node.js WebSocket Server             │
│  - Real-time event streaming          │
│  - Multi-client broadcasting          │
│  - Message compression                │
└───────────────────────────────────────┘
        ↓ Renders in 3D space
┌───────────────────────────────────────┐
│  React + Three.js Visualization       │
│  - Dynamic 3D office scene            │
│  - Agent animations                   │
│  - Particle effects                   │
│  - Interactive UI panels              │
└───────────────────────────────────────┘
```

---

## 📊 System Architecture Diagram

```
                    ┌─────────────────────────────────┐
                    │   Web Browser / Desktop App     │
                    │                                 │
        ┌───────────┴─────────────┬───────────────────┴──────────┐
        │                         │                              │
    ┌───▼──────┐          ┌──────▼────┐              ┌───────────▼────┐
    │  3D Scene │          │UI Panels  │              │ Control Center │
    │(Three.js)│          │(React)    │              │(Configuration) │
    │          │          │           │              │                │
    │-Agents   │          │-TaskQueue │              │-Theme selector │
    │-Office   │          │-AgentGrid │              │-Layout picker  │
    │-Effects  │          │-Feed      │              │-Settings       │
    └───┬──────┘          └──────┬────┘              └───────────┬────┘
        │                        │                             │
        └────────────┬───────────┴─────────────────────────────┘
                     │
            ┌────────▼────────────────┐
            │   Event Bus / Redux     │
            │   State Management      │
            └────────┬────────────────┘
                     │
            ┌────────▼───────────────────┐
            │  WebSocket Connection      │
            │  Bi-directional Sync      │
            └────────┬───────────────────┘
                     │
            ┌────────▼──────────────────────────┐
            │   Node.js Server (Express)       │
            │   http://localhost:5173          │
            │                                  │
            │  ┌─ REST API Endpoints          │
            │  ├─ WebSocket Router            │
            │  ├─ Static File Server          │
            │  └─ Health Check                │
            └────────┬──────────────────────────┘
                     │
    ┌────────────────┼─────────────────┐
    │                │                 │
┌───▼────────┐  ┌───▼────────┐   ┌───▼──────┐
│ Platform   │  │ Task       │   │ Agent    │
│ Detector   │  │ Parser     │   │ Manager  │
│            │  │            │   │          │
│-Port scan  │  │-NLP Model  │   │-Spawn    │
│-Auth check │  │-Regex      │   │-Animate  │
│-Version    │  │-Patterns   │   │-Update   │
│ detection  │  │            │   │ state    │
└───┬────────┘  └───┬────────┘   └───┬──────┘
    │               │                │
    └───────────────┼────────────────┘
                    │
    ┌───────────────┼────────────────┐
    │               │                │
┌───▼────────────┐  │  ┌────────────▼──┐
│ Supported      │  │  │  Configuration│
│ Platforms:    │  │  │  Files         │
│               │  │  │                │
│✓ Claude Code  │  │  │-Config JSON    │
│✓ VS Code      │  │  │-ENV vars       │
│✓ Copilot CLI  │  │  │-Themes         │
│✓ Cursor IDE   │  │  │-Layouts        │
│✓ GitHub Copilot   │  │-Integrations  │
│✓ Aider        │  │  └────────────────┘
│✓ Devin CLI    │  │
│✓ Gemini CLI   │  │
│+ 10 more...   │  │
└────────────────┘  │
                    │
         ┌──────────▼─────────────┐
         │   File System & Storage│
         │                        │
         │- .env file            │
         │- workspace.config.js  │
         │- LocalStorage (cache) │
         │- Temp files           │
         └────────────────────────┘
```

---

## 🏃 Quick Start Flow

```
┌─────────────┐
│ User Types: │
│ npx ai-... │
└──────┬──────┘
       │
┌──────▼────────────────────────────┐
│ 1. CLI Launcher (packages/cli)    │
│    - Detect OS & architecture      │
│    - Download binary if needed     │
│    - Check Node.js version         │
└──────┬────────────────────────────┘
       │
┌──────▼────────────────────────────┐
│ 2. Start Server (packages/server) │
│    - Find available port           │
│    - Initialize modules            │
│    - Start WebSocket server        │
└──────┬────────────────────────────┘
       │
┌──────▼────────────────────────────┐
│ 3. Launch Browser                │
│    - Open http://localhost:PORT   │
│    - Load React app (apps/web)   │
│    - Connect WebSocket            │
└──────┬────────────────────────────┘
       │
┌──────▼────────────────────────────┐
│ 4. Initialize Scene              │
│    - Load 3D models               │
│    - Setup lighting & environment │
│    - Initialize particle systems  │
└──────┬────────────────────────────┘
       │
┌──────▼────────────────────────────┐
│ 5. Detect Platforms              │
│    - Scan localhost ports         │
│    - Connect to running assistants│
│    - Subscribe to task events     │
└──────┬────────────────────────────┘
       │
┌──────▼────────────────────────────┐
│ 6. Ready for Visualization       │
│    ✅ Waiting for task assignments│
└──────────────────────────────────┘
```

---

## 🎬 Agent State Transitions

```
                    ┌──────────┐
                    │   IDLE   │ zzz (sleeping)
                    └────┬─────┘
                         │ Task assigned
                    ┌────▼──────────┐
                    │  ASSIGNED ✓   │ (acknowledging)
                    └────┬──────────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
        ┌─────▼───┐ ┌───▼────┐ ┌──▼──────────┐
        │RESEARCH │ │ CODING │ │  DEBUGGING  │
        │  🔍     │ │  ⌨️    │ │   🐛        │
        └─────┬───┘ └───┬────┘ └──┬──────────┘
              │         │         │
              └────┬────┴─────────┘
                   │
            ┌──────▼────────┐
            │  TESTING ✓    │
            │      ✓        │
            └──────┬────────┘
                   │
         ┌─────────▼────────┐
         │   COMPLETED 🎉   │
         │   (celebrating)  │
         └──────────────────┘

Alternative flows:
- CODING → BLOCKED ⚠️ → RESEARCHING → DEBUGGING → TESTING
- ANY_STATE → COLLABORATING 💬 → back to previous
- ANY_STATE → RELAXING ☕ → IDLE
- ANY_STATE → THINKING 💭 → same state
```

---

## 🎨 UI Layout Breakdown

```
┌──────────────────────────────────────────────────────────────────────┐
│ Top Bar (60px)                                                       │
│ ┌─┐ App Title | Platform Badge | Connection ⚫ | Stats | Theme | ⚙️ │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ┌─────────────────────────────────┐  ┌───────────────────────────┐ │
│  │                                 │  │  Right Panel (30%)        │ │
│  │                                 │  │                           │ │
│  │     3D Viewport (70%)           │  │  ┌─────────────────────┐  │ │
│  │                                 │  │  │ Active Tasks Queue  │  │ │
│  │   ┌─────────────────────────┐   │  │  │                     │  │ │
│  │   │                         │   │  │  │ [Task 1] ████ 75%   │  │ │
│  │   │       [Agent]           │   │  │  │ [Task 2] ██░░ 40%   │  │ │
│  │   │        on task          │   │  │  │ [Task 3] ░░░░ 0%    │  │ │
│  │   │                         │   │  │  └─────────────────────┘  │ │
│  │   │    [Particles]          │   │  │                           │ │
│  │   │                         │   │  │  ┌─────────────────────┐  │ │
│  │   │  Hover for info! ↑      │   │  │  │ Agent Status Board  │  │ │
│  │   │                         │   │  │  │                     │  │ │
│  │   └─────────────────────────┘   │  │  │ 👤 Agent 1: CODING  │  │ │
│  │                                 │  │  │ 👤 Agent 2: TESTING │  │ │
│  │                                 │  │  │ 👤 Agent 3: IDLE    │  │ │
│  │   Click & Drag: Rotate          │  │  └─────────────────────┘  │ │
│  │   Scroll: Zoom                  │  │                           │ │
│  │   Double-click: Focus           │  │  ┌─────────────────────┐  │ │
│  │                                 │  │  │ Collaboration Feed  │  │ │
│  │                                 │  │  │                     │  │ │
│  │                                 │  │  │ 💬 Agent 1 → Agent2 │  │ │
│  │                                 │  │  │    "Need help?"     │  │ │
│  │                                 │  │  │                     │  │ │
│  │                                 │  │  │ 💬 Agent 2 → Agent1 │  │ │
│  │                                 │  │  │    "On my way!"     │  │ │
│  │                                 │  │  └─────────────────────┘  │ │
│  └─────────────────────────────────┘  └───────────────────────────┘ │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ Bottom Bar (50px)                                                    │
│ ┌──────────────┬──────────────┬──────────────┬──────────────────────┐│
│ │ CPU: 25%     │ RAM: 180MB   │ Tasks: 8/10  │ Agents: 3/8 Active   ││
│ └──────────────┴──────────────┴──────────────┴──────────────────────┘│
└──────────────────────────────────────────────────────────────────────┘
```

---

## 📱 Responsive Breakpoints

```
Mobile (< 768px)
┌──────────────┐
│ Top Bar      │  60px
├──────────────┤
│              │
│   3D Scene   │  (Full width, 90%)
│              │
├──────────────┤
│ Right Panel  │  (Drawer/Bottom)
│ (Collapsible)│
├──────────────┤
│ Bottom Bar   │  50px
└──────────────┘
Max Agents: 3


Tablet (768px - 1200px)
┌────────────────────────┐
│ Top Bar                │
├──────────┬─────────────┤
│  Scene   │  Right Panel│
│  75%     │   25%       │
├──────────┴─────────────┤
│ Bottom Bar             │
└────────────────────────┘
Max Agents: 5


Desktop (> 1200px)
┌────────────────────────────────────┐
│ Top Bar                            │
├──────────────────┬─────────────────┤
│  Scene 70%       │  Right Panel 30%│
├──────────────────┴─────────────────┤
│ Bottom Bar                         │
└────────────────────────────────────┘
Max Agents: 8
```

---

## 🔄 Real-Time Data Flow

```
Coding Assistant Task Assigned:
"Create a React component for user dashboard"
        │
        ▼
┌─────────────────────────────────┐
│ Task Detection Engine           │
│ - Parse task description        │
│ - Classify task type: FRONTEND  │
│ - Estimate duration: 45 mins    │
│ - Priority: MEDIUM             │
└────────┬────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ Agent Matching Algorithm         │
│ - Find available Frontend Dev    │
│ - Check skill match              │
│ - Load balance across agents     │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ WebSocket Event: task:assigned   │
│ payload: {                       │
│   taskId: "uuid",               │
│   agentId: "agent-2",           │
│   title: "React component",     │
│   status: "ASSIGNED"            │
│ }                               │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ Browser Receives Event           │
│ - Redux dispatch action          │
│ - Update agent state             │
│ - Add to task queue              │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ React Re-renders                 │
│ - Update task card               │
│ - Highlight agent               │
│ - Trigger animation             │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ Three.js Scene Updates           │
│ - Play ASSIGNED animation       │
│ - Spawn particle effects        │
│ - Update progress bar           │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ ✅ Agent Spawned in 3D Space     │
│ - Avatar shows at desk           │
│ - Name tag displays             │
│ - Task name shown above         │
└──────────────────────────────────┘
```

---

## 🚀 Deployment Matrix

```
┌──────────────────┬──────────────────┬────────────────────┐
│  Distribution    │  Command         │  Time to Deploy    │
├──────────────────┼──────────────────┼────────────────────┤
│ NPX (Global)     │ npx ai-agent...  │ ~2-3 minutes       │
├──────────────────┼──────────────────┼────────────────────┤
│ Local Dev        │ npm run dev      │ ~1 minute          │
├──────────────────┼──────────────────┼────────────────────┤
│ Docker Container │ docker run ...   │ ~30 seconds        │
├──────────────────┼──────────────────┼────────────────────┤
│ Windows .exe     │ .\ai-agent.exe   │ ~1 second (instant)│
├──────────────────┼──────────────────┼────────────────────┤
│ macOS .app       │ open app         │ ~1 second          │
├──────────────────┼──────────────────┼────────────────────┤
│ Linux AppImage   │ ./ai-agent.appimage │ ~1 second       │
├──────────────────┼──────────────────┼────────────────────┤
│ Browser Deploy   │ Vercel/Netlify   │ ~2 minutes setup   │
└──────────────────┴──────────────────┴────────────────────┘
```

---

## 📦 Performance Metrics

```
Metric              Target    Adaptive
─────────────────────────────────────
Initial Load Time   < 2.5s   ✓ Lazy loading
Frame Rate          60 FPS    ✓ Reduces to 30 FPS on low-end
Memory Usage        < 300MB  ✓ Cull unused agents
Network Bandwidth   < 1MB/s  ✓ Message compression
Agent Spawn Time    < 500ms  ✓ Async loading
3D Model Size       ~2MB     ✓ LOD system reduces size
Particle Limits     50k      ✓ Pools & culling
GPU Requirement     WebGL2   ✓ Falls back to CPU rendering
```

---

## 🎯 Key Features by Phase

```
┌─────────────────────────────────────────────────────────────┐
│ PHASE 1: MVP (Months 1-2)                                 │
├─────────────────────────────────────────────────────────────┤
│ ✅ 3D office with 5 agent types                            │
│ ✅ Task assignment from Claude Code                        │
│ ✅ Basic state visualization                               │
│ ✅ Hover info cards                                        │
│ ✅ Task queue panel                                        │
│ ✅ Responsive design                                       │
│ ✅ NPX launcher                                            │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ PHASE 2: Integration (Months 3-4)                          │
├─────────────────────────────────────────────────────────────┤
│ ⏳ VS Code Copilot integration                            │
│ ⏳ GitHub Copilot CLI support                            │
│ ⏳ Cursor IDE integration                                 │
│ ⏳ Multi-platform auto-detection                          │
│ ⏳ Advanced particle effects                              │
│ ⏳ Sound effects & ambient audio                          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ PHASE 3: Advanced Features (Months 5-6)                    │
├─────────────────────────────────────────────────────────────┤
│ ⏳ Agent-to-agent collaboration                           │
│ ⏳ Virtual whiteboard & diagrams                          │
│ ⏳ Performance analytics                                  │
│ ⏳ Custom agent appearance editor                         │
│ ⏳ Timeline scrubbing & replay                            │
│ ⏳ Session recording & export                             │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ PHASE 4: Enterprise (Months 7+)                            │
├─────────────────────────────────────────────────────────────┤
│ ⏳ Multi-team workspaces                                  │
│ ⏳ Role-based permissions                                 │
│ ⏳ Audit logs & compliance                                │
│ ⏳ CI/CD pipeline integration                             │
│ ⏳ Custom integration SDK                                 │
│ ⏳ Self-hosted deployment                                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔗 File Navigation Guide

```
Key Entry Points:

1. CLI User?
   └─ packages/cli/bin/cli.js → Start here

2. Browser User?
   └─ apps/web/src/App.tsx → React app

3. Backend Developer?
   └─ packages/server/src/main.ts → Server logic

4. Platform Integration?
   └─ packages/platforms/src/ → Platform connectors

5. 3D Scene Development?
   └─ packages/core/src/scene/ → Three.js setup

6. Task Parsing?
   └─ packages/core/src/tasks/ → Task logic

7. Configuration?
   └─ workspace.config.js → Settings

8. Styling?
   └─ apps/web/src/styles/ → CSS
```

---

This quick reference should help navigate the entire project! 🚀
