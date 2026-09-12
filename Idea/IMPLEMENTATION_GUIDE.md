# AI Agent Workspace - Implementation Guide

## 🎯 How to Use These Files

You now have 5 comprehensive documents:

### 1. **AGENT_WORKSPACE_SYSTEM_PROMPT.md** ⭐
The **complete specification** for the entire application. Use this when:
- Building individual features
- Onboarding new developers
- Making architectural decisions
- Explaining the vision to stakeholders

### 2. **PROJECT_STRUCTURE.md**
The **detailed directory layout** and core implementation patterns. Use this when:
- Setting up the monorepo
- Understanding module organization
- Creating new packages
- Implementing AgentManager, TaskDetection, etc.

### 3. **STARTER_FILES.md**
**Production-ready boilerplate code**. Use this when:
- Starting implementation
- Copy-pasting config files
- Setting up build pipelines
- Creating initial components

### 4. **QUICK_REFERENCE.md**
**Visual guides and flowcharts**. Use this when:
- Need a quick overview
- Explaining architecture to others
- Understanding data flows
- Checking responsive design specs

### 5. **IMPLEMENTATION_GUIDE.md** (this file)
**Practical tips and common pitfalls**. Use this when:
- About to start coding
- Troubleshooting issues
- Optimizing performance
- Making design decisions

---

## 🚀 Step-by-Step Implementation Roadmap

### Week 1: Foundation Setup

**Day 1-2: Project Initialization**
```bash
# 1. Create monorepo structure
mkdir ai-agent-workspace && cd ai-agent-workspace
pnpm init

# 2. Create workspace directories
mkdir -p packages/{core,ui,platforms,server,cli}
mkdir -p apps/{web,electron,docker}
mkdir -p {assets,docs,tests,scripts,config}

# 3. Copy starter files
# From STARTER_FILES.md:
# - Copy package.json (root)
# - Copy tsconfig.json
# - Copy .env.example
# - Copy Dockerfile

# 4. Initialize each package
cd packages/core && pnpm init
cd ../ui && pnpm init
# ... repeat for all packages
```

**Day 3: Install Dependencies**
```bash
# Install core dependencies in each package
pnpm add typescript @types/node

# Frontend deps (apps/web)
pnpm --filter web add react react-dom @react-three/fiber three tailwindcss framer-motion

# Server deps (packages/server)
pnpm --filter server add express cors ws

# CLI deps (packages/cli)
pnpm --filter cli add chalk commander

# Development deps (root)
pnpm add -D vite webpack turbo eslint prettier
```

**Day 4-5: Core Architecture**
```bash
# 1. Implement packages/core/src/agents/AgentManager.ts
#    (Copy from PROJECT_STRUCTURE.md)

# 2. Implement packages/core/src/tasks/TaskDetection.ts
#    (Copy from PROJECT_STRUCTURE.md)

# 3. Implement packages/platforms/src/PlatformDetector.ts
#    (Copy from PROJECT_STRUCTURE.md)

# 4. Create communication layer
#    - EventBus.ts
#    - WebSocketManager.ts

# 5. Run tests
pnpm test
```

### Week 2: Backend Server

**Day 1: Express Setup**
```typescript
// packages/server/src/main.ts
// Copy from STARTER_FILES.md

// Key points:
// - Create HTTP server
// - Setup WebSocket
// - Add REST endpoints
// - Error handling
```

**Day 2: Platform Detection**
```typescript
// packages/server/src/platform-bridge/
// - Implement port scanning
// - Create platform adapters
// - Test with real assistants
```

**Day 3: Task Management**
```typescript
// packages/server/src/services/TaskService.ts
// - Queue management
// - Priority sorting
// - Agent assignment logic
```

**Day 4-5: Testing & Debugging**
```bash
# Create test data
# Test with mock platforms
# Debug WebSocket events
# Profile memory usage
```

### Week 3: Frontend React

**Day 1: Component Structure**
```typescript
// apps/web/src/components/
// - Dashboard.tsx (main container)
// - ThreeViewport.tsx (3D scene)
// - RightPanel.tsx (side panels)
// - TopBar.tsx (header)
// - TaskQueue.tsx (task list)
// - AgentGrid.tsx (agent cards)
```

**Day 2: State Management**
```typescript
// apps/web/src/contexts/
// - AgentContext.tsx (agent state)
// - TaskContext.tsx (task state)
// - ThemeContext.tsx (theme state)

// apps/web/src/hooks/
// - useWebSocket.ts
// - useScene.ts
// - useTasks.ts
// - useAgents.ts
```

**Day 3: Styling & Theme**
```css
/* apps/web/src/styles/globals.css */
/* - CSS custom properties (vars) */
/* - Color schemes */
/* - Responsive utilities */
/* - Animation keyframes */

/* apps/web/src/styles/theme.css */
/* - Dark/light/high-contrast themes */
/* - Agent-specific colors */
/* - Gradient definitions */
```

**Day 4-5: UI Polish**
```typescript
// Animations using Framer Motion
// Responsive design testing
// Accessibility audit
// Performance optimization
```

### Week 4: 3D Visualization

**Day 1: Scene Setup**
```typescript
// packages/core/src/scene/SceneManager.ts
// - Three.js scene initialization
// - Camera setup
// - Lighting configuration
// - Grid/environment setup
```

**Day 2: Agent Models**
```typescript
// - Find/create 3D models (Sketchfab, TurboSquid)
// - Convert to GLTF/GLB format
// - Setup in assets/models/agents/
// - Test loading & rendering
```

**Day 3: Animations**
```typescript
// packages/core/src/agents/AgentAnimations.ts
// - Idle animation
// - Working animations
// - Transition blending
// - State-specific effects
```

**Day 4-5: Particle Effects**
```typescript
// packages/core/src/particles/
// - Particle system implementation
// - Effect templates
// - Performance optimization
// - LOD levels
```

---

## ⚡ Performance Optimization Checklist

### Before Launch
- [ ] Initial load < 2.5s (measure with Lighthouse)
- [ ] 60 FPS at 1080p (use Chrome DevTools)
- [ ] Memory usage < 300MB (heap snapshot)
- [ ] Bundle size < 2MB (webpack-bundle-analyzer)
- [ ] First Contentful Paint (FCP) < 1.5s

### Code Optimization
```typescript
// ✅ DO: Lazy load 3D models
const model = await loader.loadAsync(modelPath);

// ❌ DON'T: Load all models at startup
// for (const model of allModels) { loader.load(model); }

// ✅ DO: Use object pooling for particles
const particlePool = new PoolAllocator(10000);

// ❌ DON'T: Create new particles every frame
// new Particle() on each update

// ✅ DO: Debounce resize events
const onResize = debounce(() => updateLayout(), 300);

// ❌ DON'T: Update on every resize event
// window.addEventListener('resize', updateLayout);

// ✅ DO: Use LOD for distant agents
if (distance > 15) { useSimplifiedModel(); }

// ❌ DON'T: Render full detail for all agents
// Always use highPolyModel;
```

### Network Optimization
```typescript
// ✅ DO: Compress WebSocket messages
ws.send(compress(JSON.stringify(data)));

// ✅ DO: Batch updates
batchUpdates([update1, update2, update3]);

// ✅ DO: Throttle real-time events
const throttledUpdate = throttle(updateAgent, 100);

// ❌ DON'T: Send every single state change
agent.setState(newState); // Sends immediately
```

---

## 🐛 Common Pitfalls to Avoid

### 1. **Platform Detection Timeout**
```typescript
// ❌ WRONG: Long timeout blocks startup
const response = await fetch(url, { timeout: 10000 });

// ✅ CORRECT: Short timeout, continue on failure
const response = await fetch(url, { timeout: 1000 });
if (!response) {
  console.warn('Platform detection timeout, continuing...');
  // Use default behavior
}
```

### 2. **WebSocket Reconnection Logic**
```typescript
// ❌ WRONG: Infinite reconnection attempts
ws.onclose = () => {
  ws = new WebSocket(url);
};

// ✅ CORRECT: Exponential backoff
let reconnectAttempts = 0;
const maxAttempts = 5;
const baseDelay = 1000;

ws.onclose = () => {
  if (reconnectAttempts < maxAttempts) {
    const delay = baseDelay * Math.pow(2, reconnectAttempts);
    setTimeout(() => reconnect(), delay);
    reconnectAttempts++;
  }
};
```

### 3. **Memory Leaks with Three.js**
```typescript
// ❌ WRONG: Not disposing geometry/materials
scene.removeChild(mesh);
// mesh.geometry and mesh.material still in memory!

// ✅ CORRECT: Proper cleanup
mesh.geometry.dispose();
mesh.material.dispose();
scene.removeChild(mesh);
```

### 4. **State Update Racing**
```typescript
// ❌ WRONG: Async update race condition
agent.state = 'CODING';
agent.state = 'DEBUGGING'; // May override before first renders

// ✅ CORRECT: Use state machine
agent.setState('CODING');
// ... animation plays
agent.setState('DEBUGGING');
// waits for previous animation to complete
```

### 5. **Cross-Platform Path Issues**
```typescript
// ❌ WRONG: Hard-coded Unix paths
const path = '/usr/local/bin/app';

// ✅ CORRECT: Use path module
import path from 'path';
const appPath = path.join(process.cwd(), 'bin', 'app');
```

### 6. **Responsive Design Breaks**
```typescript
// ❌ WRONG: Hard-coded dimensions
const cameraX = 10;

// ✅ CORRECT: Scale with window size
const cameraX = window.innerWidth / 100;

// Use window resize listener with debounce
const handleResize = debounce(() => {
  updateCameraPosition();
  renderer.setSize(window.innerWidth, window.innerHeight);
}, 300);

window.addEventListener('resize', handleResize);
```

---

## 🔧 Debugging Tips

### Enable Debug Logging
```typescript
// In workspace.config.js
{
  debugMode: true,
  logLevel: 'debug'
}

// In code
if (config.debugMode) {
  console.log('[DEBUG]', message);
  console.table(data);
}
```

### Performance Profiling
```typescript
// Chrome DevTools Performance tab
performance.mark('task-assignment-start');
// ... your code
performance.mark('task-assignment-end');
performance.measure('task-assignment', 'task-assignment-start', 'task-assignment-end');
```

### Platform Detection Debugging
```bash
# Check what platforms are detected
curl http://localhost:5173/api/platforms

# Should return:
# [
#   { name: 'claude-code', port: 3000, available: true },
#   { name: 'cursor', port: 3001, available: true }
# ]
```

### WebSocket Event Logging
```typescript
// In browser console
window.addEventListener('beforeunload', () => {
  ws.addEventListener('message', (event) => {
    console.log('[WS]', event.data);
  });
});

// Or use Redux DevTools to trace state changes
```

---

## 📊 Testing Strategy

### Unit Tests
```bash
# Test individual functions
# packages/core/src/agents/AgentManager.test.ts
# packages/core/src/tasks/TaskDetection.test.ts

npm run test:unit
```

### Integration Tests
```bash
# Test module interactions
# test/integration/platform-detection.test.ts
# test/integration/task-assignment.test.ts

npm run test:integration
```

### E2E Tests
```bash
# Test full user flows
# test/e2e/task-assignment-flow.test.ts
# test/e2e/multi-agent-collaboration.test.ts

npm run test:e2e
```

---

## 📦 Build & Distribution

### Local Build
```bash
pnpm build
# Creates dist/ folder with all built assets
```

### NPX Publishing
```bash
# 1. Update version in package.json
# 2. Build
pnpm build

# 3. Publish to NPM
npm publish --access public

# 4. Test locally
npx ai-agent-workspace@latest
```

### Desktop App Build
```bash
# Windows
pnpm build:win

# macOS
pnpm build:mac

# Linux
pnpm build:linux

# All platforms
pnpm build:executables
```

### Docker Image
```bash
docker build -t ai-agent-workspace:latest .
docker run -p 5173:5173 ai-agent-workspace:latest

# Push to Docker Hub
docker tag ai-agent-workspace:latest yourusername/ai-agent-workspace:latest
docker push yourusername/ai-agent-workspace:latest
```

---

## 🌍 Cross-Platform Specific Notes

### Windows
- Use `path.win32` for path operations
- Handle `EADDRINUSE` error for port conflicts
- Set environment variables with `setx` for persistence
- Binary might need .exe suffix explicitly

### macOS
- Handle .DS_Store files in git
- Code signing may be required for distribution
- Use `launchd` for running as background service
- M1/M2 Apple Silicon support (arm64)

### Linux/Ubuntu
- Test on multiple distributions (Ubuntu, Fedora, Debian)
- Create AppImage and snap packages
- Handle glibc version compatibility
- Use systemd for service management

---

## 📝 Documentation Best Practices

### Code Comments
```typescript
/**
 * Spawns a new agent in the scene
 * 
 * @param agentId - Unique identifier for the agent
 * @param agentType - Type determines appearance and behavior
 * @param position - Initial 3D position in world space
 * @returns Promise resolving to the created Agent instance
 * 
 * @example
 * const agent = await agentManager.spawnAgent(
 *   'agent-1',
 *   'Frontend Developer',
 *   { x: 0, y: 0, z: 5 }
 * );
 */
async spawnAgent(
  agentId: string,
  agentType: AgentType,
  position: Vector3
): Promise<Agent>
```

### README Structure
- What it does (2-3 sentences)
- Quick start (one command)
- Screenshots/demo
- Key features (bullet list)
- Architecture diagram
- Installation options
- Configuration examples
- Troubleshooting
- Contributing guidelines
- License

---

## 🎯 Success Metrics

Track these metrics during development:

```typescript
interface SuccessMetrics {
  // Performance
  initialLoadTime: number; // < 2.5s
  frameRate: number; // 60 FPS
  memoryUsage: number; // < 300MB
  
  // User Experience
  taskDetectionAccuracy: number; // > 90%
  agentSpawnTime: number; // < 500ms
  
  // Reliability
  websocketUptime: number; // > 99.5%
  platformDetectionSuccess: number; // > 95%
  
  // Code Quality
  testCoverage: number; // > 80%
  typeScriptStrict: boolean; // true
  lintErrors: number; // 0
}
```

---

## 🚀 Launch Checklist

Before releasing to public:

- [ ] All unit tests passing
- [ ] All integration tests passing
- [ ] Performance benchmarks met
- [ ] Security audit completed
- [ ] Cross-platform testing done
- [ ] Documentation complete
- [ ] CHANGELOG.md updated
- [ ] GitHub release created
- [ ] NPM package published
- [ ] Docker image published
- [ ] Executables built for all platforms
- [ ] Website/landing page ready
- [ ] Demo video recorded
- [ ] Social media posts scheduled

---

## 📞 Getting Help

When stuck, check in this order:

1. **QUICK_REFERENCE.md** - Visual diagrams
2. **SYSTEM_PROMPT.md** - Full specification
3. **PROJECT_STRUCTURE.md** - Code organization
4. **STARTER_FILES.md** - Copy-paste solutions
5. **Browser DevTools** - Console errors
6. **GitHub Issues** - Search for similar problems
7. **Stack Overflow** - Platform-specific issues
8. **Documentation** - Official docs for dependencies

---

This implementation guide should get you from zero to a working visualization! 

**Ready to build?** Start with Week 1 Day 1 and follow the roadmap! 🚀
