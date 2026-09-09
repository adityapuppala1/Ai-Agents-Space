# AI Agent Workspace - Project Structure & Implementation Guide

## Directory Structure

```
ai-agent-workspace/
│
├── packages/
│   ├── core/                          # Core visualization engine
│   │   ├── src/
│   │   │   ├── agents/
│   │   │   │   ├── AgentManager.ts
│   │   │   │   ├── AgentTypes.ts
│   │   │   │   ├── StateManager.ts
│   │   │   │   └── AgentAnimations.ts
│   │   │   ├── tasks/
│   │   │   │   ├── TaskQueue.ts
│   │   │   │   ├── TaskParser.ts
│   │   │   │   ├── TaskDetection.ts
│   │   │   │   └── TaskSchema.ts
│   │   │   ├── scene/
│   │   │   │   ├── SceneManager.ts
│   │   │   │   ├── LightingSetup.ts
│   │   │   │   ├── EnvironmentSetup.ts
│   │   │   │   └── LODSystem.ts
│   │   │   ├── communication/
│   │   │   │   ├── WebSocketManager.ts
│   │   │   │   ├── EventBus.ts
│   │   │   │   └── MessageProtocol.ts
│   │   │   └── utils/
│   │   │       ├── Logger.ts
│   │   │       ├── Performance.ts
│   │   │       └── Config.ts
│   │   └── package.json
│   │
│   ├── ui/                           # React UI components
│   │   ├── src/
│   │   │   ├── components/
│   │   │   │   ├── Dashboard.tsx
│   │   │   │   ├── ThreeViewport.tsx
│   │   │   │   ├── RightPanel.tsx
│   │   │   │   ├── TaskQueue.tsx
│   │   │   │   ├── AgentGrid.tsx
│   │   │   │   ├── CollaborationFeed.tsx
│   │   │   │   ├── HoverInfoCard.tsx
│   │   │   │   └── TopBar.tsx
│   │   │   ├── hooks/
│   │   │   │   ├── useScene.ts
│   │   │   │   ├── useTasks.ts
│   │   │   │   ├── useWebSocket.ts
│   │   │   │   ├── useAgents.ts
│   │   │   │   └── useTheme.ts
│   │   │   ├── contexts/
│   │   │   │   ├── AgentContext.tsx
│   │   │   │   ├── TaskContext.tsx
│   │   │   │   └── ThemeContext.tsx
│   │   │   ├── styles/
│   │   │   │   ├── globals.css
│   │   │   │   ├── theme.css
│   │   │   │   └── animations.css
│   │   │   ├── App.tsx
│   │   │   └── main.tsx
│   │   └── package.json
│   │
│   ├── platforms/                    # Platform integrations
│   │   ├── src/
│   │   │   ├── claude-code/
│   │   │   │   ├── Detector.ts
│   │   │   │   ├── TaskExtractor.ts
│   │   │   │   └── EventListener.ts
│   │   │   ├── github-copilot/
│   │   │   ├── cursor/
│   │   │   ├── vscode-copilot/
│   │   │   ├── generic-rest/
│   │   │   ├── generic-websocket/
│   │   │   ├── PlatformRegistry.ts
│   │   │   ├── PlatformDetector.ts
│   │   │   └── PlatformInterface.ts
│   │   └── package.json
│   │
│   ├── server/                      # Node.js backend
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── api/
│   │   │   │   ├── routes.ts
│   │   │   │   ├── middleware.ts
│   │   │   │   └── controllers.ts
│   │   │   ├── websocket/
│   │   │   │   ├── WSManager.ts
│   │   │   │   ├── handlers/
│   │   │   │   └── events.ts
│   │   │   ├── platform-bridge/
│   │   │   │   ├── PlatformBridge.ts
│   │   │   │   └── adapters/
│   │   │   ├── services/
│   │   │   │   ├── TaskService.ts
│   │   │   │   ├── AgentService.ts
│   │   │   │   └── ConfigService.ts
│   │   │   └── utils/
│   │   │       └── portFinder.ts
│   │   └── package.json
│   │
│   └── cli/                         # CLI launcher
│       ├── src/
│       │   ├── index.ts
│       │   ├── launcher.ts
│       │   ├── os-detector.ts
│       │   ├── port-manager.ts
│       │   └── browser-launcher.ts
│       ├── bin/
│       │   └── cli.js
│       └── package.json
│
├── apps/
│   ├── web/                         # Main web app (Vite)
│   │   ├── src/
│   │   │   └── (react files)
│   │   ├── vite.config.ts
│   │   ├── index.html
│   │   └── package.json
│   │
│   ├── electron/                    # Electron wrapper
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── preload.ts
│   │   │   └── updater.ts
│   │   └── package.json
│   │
│   └── docker/
│       ├── Dockerfile
│       └── docker-compose.yml
│
├── assets/
│   ├── models/
│   │   ├── agents/
│   │   │   ├── dev-female-1.glb
│   │   │   ├── dev-male-1.glb
│   │   │   ├── devops-1.glb
│   │   │   └── ... (more models)
│   │   ├── environment/
│   │   │   ├── desk.glb
│   │   │   ├── chair.glb
│   │   │   ├── floor.glb
│   │   │   └── walls.glb
│   │   └── effects/
│   │       ├── particles.json
│   │       └── shaders/
│   ├── icons/
│   ├── fonts/
│   └── audio/
│       ├── ambient.mp3
│       ├── typing.mp3
│       └── notification.mp3
│
├── docs/
│   ├── QUICKSTART.md
│   ├── PLATFORM_INTEGRATION.md
│   ├── CUSTOMIZATION.md
│   ├── API.md
│   └── ARCHITECTURE.md
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
├── scripts/
│   ├── build-all.sh
│   ├── build-executables.sh
│   ├── generate-models.sh
│   ├── dev-setup.sh
│   └── release.sh
│
├── config/
│   ├── workspace.config.example.js
│   ├── webpack.common.js
│   ├── webpack.dev.js
│   ├── webpack.prod.js
│   └── tsconfig.json
│
├── .github/
│   └── workflows/
│       ├── build.yml
│       ├── test.yml
│       └── release.yml
│
├── package.json                    # Monorepo root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── turbo.json
└── README.md
```

---

## Key Files to Implement

### 1. **Core Package: AgentManager.ts**
```typescript
// packages/core/src/agents/AgentManager.ts

import * as THREE from 'three';
import { EventBus } from '../communication/EventBus';
import { AGENT_TYPES, AGENT_STATES } from './AgentTypes';

export class AgentManager {
  private agents: Map<string, Agent> = new Map();
  private scene: THREE.Scene;
  private eventBus: EventBus;

  constructor(scene: THREE.Scene, eventBus: EventBus) {
    this.scene = scene;
    this.eventBus = eventBus;
  }

  async spawnAgent(
    agentId: string,
    agentType: keyof typeof AGENT_TYPES,
    position: { x: number; y: number; z: number }
  ): Promise<Agent> {
    const agentConfig = AGENT_TYPES[agentType];
    const agent = new Agent(agentId, agentType, agentConfig, this.eventBus);
    
    await agent.initialize(position, this.scene);
    this.agents.set(agentId, agent);
    
    this.eventBus.emit('agent:spawned', { agentId, agentType });
    return agent;
  }

  updateAgentState(agentId: string, newState: keyof typeof AGENT_STATES) {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.setState(newState);
      this.eventBus.emit('agent:state_changed', { agentId, newState });
    }
  }

  assignTaskToAgent(agentId: string, taskId: string) {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.assignTask(taskId);
    }
  }

  getAgent(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  getAllAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  removeAgent(agentId: string) {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.dispose();
      this.agents.delete(agentId);
      this.eventBus.emit('agent:removed', { agentId });
    }
  }

  update(deltaTime: number) {
    this.agents.forEach(agent => agent.update(deltaTime));
  }
}

class Agent {
  private id: string;
  private type: string;
  private config: any;
  private state: string = 'IDLE';
  private model: THREE.Group;
  private currentTask: string | null = null;
  private animations: Map<string, THREE.AnimationAction> = new Map();
  private particleSystem: ParticleSystem;

  constructor(id: string, type: string, config: any, eventBus: EventBus) {
    this.id = id;
    this.type = type;
    this.config = config;
  }

  async initialize(position: any, scene: THREE.Scene) {
    // Load 3D model
    this.model = await this.loadModel(this.config.avatar);
    this.model.position.set(position.x, position.y, position.z);
    scene.add(this.model);

    // Setup animations
    await this.setupAnimations();

    // Setup particle system
    this.particleSystem = new ParticleSystem(scene);
  }

  private async loadModel(modelPath: string): Promise<THREE.Group> {
    // Load from GLTF/GLB
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(`/models/${modelPath}`);
    return gltf.scene;
  }

  setState(newState: string) {
    if (this.state === newState) return;

    this.state = newState;
    this.playAnimation(newState);

    if (AGENT_STATES[newState as keyof typeof AGENT_STATES]?.particles) {
      this.particleSystem.spawn(
        AGENT_STATES[newState as keyof typeof AGENT_STATES].particles
      );
    }
  }

  assignTask(taskId: string) {
    this.currentTask = taskId;
    this.setState('ASSIGNED');
  }

  private async setupAnimations() {
    // Extract and store animations from loaded model
  }

  private playAnimation(stateName: string) {
    // Blend and play appropriate animation
  }

  update(deltaTime: number) {
    this.particleSystem.update(deltaTime);
    // Update animations, rotate view based on state
  }

  dispose() {
    // Cleanup model and resources
  }
}
```

### 2. **Task Detection: TaskDetection.ts**
```typescript
// packages/core/src/tasks/TaskDetection.ts

import { EventBus } from '../communication/EventBus';

export class TaskDetectionEngine {
  private eventBus: EventBus;
  private detectionMethods: DetectionMethod[] = [];
  private taskCache: Map<string, Task> = new Map();

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
    this.initializeDetectionMethods();
  }

  private initializeDetectionMethods() {
    this.detectionMethods = [
      new ConsoleLogDetector(this.eventBus),
      new DOMObserverDetector(this.eventBus),
      new FileSystemDetector(this.eventBus),
      new WebSocketDetector(this.eventBus),
      new LocalStorageDetector(this.eventBus),
    ];
  }

  async startDetection() {
    for (const method of this.detectionMethods) {
      method.start();
    }
  }

  parseTask(rawInput: any): Task {
    const nlpResult = this.classifyTaskIntent(rawInput);
    
    if (nlpResult.confidence < 0.75) {
      return null; // Ignore low-confidence detections
    }

    const task: Task = {
      id: generateUUID(),
      title: nlpResult.title,
      description: rawInput,
      priority: nlpResult.priority,
      estimatedDuration: nlpResult.estimatedDuration,
      suggestedAgentType: nlpResult.agentType,
      timestamp: Date.now(),
    };

    this.taskCache.set(task.id, task);
    this.eventBus.emit('task:detected', task);
    
    return task;
  }

  private classifyTaskIntent(input: any): ClassificationResult {
    // Use ML model or regex patterns to classify
    // Returns: { title, priority, agentType, estimatedDuration, confidence }
    
    const patterns = {
      frontend: /react|vue|angular|css|html|ui|component|button|form/i,
      backend: /api|endpoint|database|server|node|express|auth|permission/i,
      devops: /docker|kubernetes|aws|deploy|ci\/cd|build|release/i,
      testing: /test|unit test|e2e|cypress|jest|mocha/i,
      debugging: /debug|bug|error|fix|issue|trace/i,
    };

    // Determine type and other metadata
    // Return classification result
  }
}

interface Task {
  id: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  estimatedDuration: number;
  suggestedAgentType: string;
  timestamp: number;
}

interface ClassificationResult {
  title: string;
  priority: string;
  agentType: string;
  estimatedDuration: number;
  confidence: number;
}
```

### 3. **Platform Detector: PlatformDetector.ts**
```typescript
// packages/platforms/src/PlatformDetector.ts

export class PlatformDetector {
  static async detectAvailablePlatforms(): Promise<DetectedPlatform[]> {
    const detected: DetectedPlatform[] = [];

    // Check VS Code Copilot
    if (await this.checkVSCodeCopilot()) {
      detected.push({
        name: 'vscode-copilot',
        port: 63342,
        protocol: 'CDP',
        available: true,
      });
    }

    // Check Claude Code
    if (await this.checkClaudeCode()) {
      detected.push({
        name: 'claude-code',
        port: 3000,
        protocol: 'WebSocket',
        available: true,
      });
    }

    // Check Cursor
    if (await this.checkCursor()) {
      detected.push({
        name: 'cursor',
        port: 3001,
        protocol: 'WebSocket',
        available: true,
      });
    }

    // Check local ports for generic agents
    const genericPorts = await this.scanForGenericAgents();
    detected.push(...genericPorts);

    return detected;
  }

  private static async checkVSCodeCopilot(): Promise<boolean> {
    try {
      const response = await fetch('http://localhost:63342/health', {
        timeout: 1000,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private static async checkClaudeCode(): Promise<boolean> {
    try {
      // Check if Claude Code is running
      const response = await fetch('http://localhost:3000/api/status', {
        timeout: 1000,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private static async checkCursor(): Promise<boolean> {
    // Similar detection logic
  }

  private static async scanForGenericAgents(): Promise<DetectedPlatform[]> {
    const detected: DetectedPlatform[] = [];
    const ports = [3000, 3001, 5000, 5001, 5555, 6000, 6969, 7000, 8000, 8080, 8888, 9000, 9001];

    for (const port of ports) {
      try {
        const response = await fetch(`http://localhost:${port}/api/status`, {
          timeout: 500,
        });
        if (response.ok) {
          const data = await response.json();
          detected.push({
            name: data.name || `agent-${port}`,
            port,
            protocol: 'REST',
            available: true,
          });
        }
      } catch {
        // Port not responding
      }
    }

    return detected;
  }
}

interface DetectedPlatform {
  name: string;
  port: number;
  protocol: 'REST' | 'WebSocket' | 'CDP' | 'gRPC';
  available: boolean;
}
```

### 4. **CLI Launcher: bin/cli.js**
```javascript
#!/usr/bin/env node

// packages/cli/bin/cli.js

const { exec } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

async function main() {
  console.log('🚀 Starting AI Agent Workspace...\n');

  // Detect OS
  const platform = os.platform();
  const arch = os.arch();
  console.log(`📱 Detected: ${platform} (${arch})`);

  // Find available port
  const port = await findAvailablePort(3000);
  console.log(`🔌 Using port ${port}\n`);

  // Start server
  const serverProcess = exec(`node ${path.join(__dirname, '../dist/server/main.js')} --port ${port}`);

  serverProcess.stdout.on('data', (data) => {
    console.log(`[Server] ${data}`);
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`[Server Error] ${data}`);
  });

  // Wait for server to start
  await waitForServer(port);

  // Open browser
  const url = `http://localhost:${port}`;
  console.log(`\n✅ Opening ${url}\n`);

  openBrowser(url);

  console.log('Press Ctrl+C to stop the server\n');
}

async function findAvailablePort(startPort) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(startPort, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      resolve(findAvailablePort(startPort + 1));
    });
  });
}

async function waitForServer(port, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Server failed to start');
}

function openBrowser(url) {
  const platform = os.platform();
  let cmd;

  switch (platform) {
    case 'darwin':
      cmd = `open "${url}"`;
      break;
    case 'win32':
      cmd = `start "${url}"`;
      break;
    default:
      cmd = `xdg-open "${url}"`;
  }

  exec(cmd);
}

main().catch(console.error);
```

### 5. **React Dashboard Component**
```typescript
// apps/web/src/App.tsx

import React, { useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import ThreeViewport from './components/ThreeViewport';
import RightPanel from './components/RightPanel';
import TopBar from './components/TopBar';
import { useWebSocket } from './hooks/useWebSocket';
import { useScene } from './hooks/useScene';

export default function App() {
  const { connect } = useWebSocket();
  const { scene, initialized } = useScene();

  useEffect(() => {
    connect();
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* Top Bar */}
      <TopBar />

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden gap-4 p-4">
        {/* 3D Viewport */}
        <div className="flex-1 rounded-lg overflow-hidden shadow-2xl bg-black">
          {initialized && (
            <Canvas
              camera={{ position: [0, 5, 10], fov: 50 }}
              shadows
              dpr={[1, 2]}
            >
              <ThreeViewport scene={scene} />
            </Canvas>
          )}
        </div>

        {/* Right Panel */}
        <RightPanel />
      </div>
    </div>
  );
}
```

---

## Build & Distribution

### Package.json (Root)
```json
{
  "name": "ai-agent-workspace",
  "version": "1.0.0",
  "description": "Cross-platform AI agent visualization engine",
  "private": true,
  "workspaces": [
    "packages/*",
    "apps/*"
  ],
  "scripts": {
    "dev": "turbo run dev --parallel",
    "build": "turbo run build",
    "build:all": "./scripts/build-all.sh",
    "build:executables": "./scripts/build-executables.sh",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "type-check": "turbo run typecheck",
    "clean": "turbo run clean && rm -rf node_modules"
  },
  "devDependencies": {
    "turbo": "^1.10.0",
    "typescript": "^5.0.0",
    "vite": "^4.4.0",
    "electron": "^25.0.0",
    "electron-builder": "^24.0.0"
  }
}
```

### Build Script for Executables
```bash
#!/bin/bash
# scripts/build-executables.sh

set -e

echo "🔨 Building AI Agent Workspace executables..."

# Build web app
npm run build

# Build for different platforms
echo "📦 Building Windows (.exe)..."
npm run build:win

echo "📦 Building macOS (.dmg)..."
npm run build:mac

echo "📦 Building Linux (AppImage)..."
npm run build:linux

echo "✅ Build complete!"
echo ""
echo "Executables located in: dist/"
```

---

## Getting Started

### Installation & Quickstart
```bash
# Global NPX (recommended)
npx ai-agent-workspace

# Or local development
git clone https://github.com/yourusername/ai-agent-workspace
cd ai-agent-workspace
pnpm install
pnpm dev

# Connect to your AI assistant
# The app will auto-detect running Claude Code, VS Code Copilot, etc.
```

---

This structure provides everything needed to build, deploy, and maintain the AI Agent Workspace across all platforms!
