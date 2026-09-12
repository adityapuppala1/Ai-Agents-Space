# AI Agent Workspace Visualizer - System Prompt

## Project Overview
**AI Agent Workspace Visualizer** is a cross-platform, AI-assistant-agnostic visualization engine that transforms abstract task assignments into a dynamic, interactive 3D office environment where AI agents work collaboratively in real-time.

### Core Vision
Visualize AI agents as professional domain experts working in a shared office space, where:
- Tasks are assigned and tracked in real-time
- Agent states (working, researching, debugging, relaxing, etc.) are visually represented
- 3D workspace adapts to any screen size, OS, and coding platform
- Interactive tooltips show granular task details on hover
- Multi-agent collaboration is visible and intuitive

---

## Technical Architecture

### Tech Stack
```
Frontend: React + Three.js + Babel (for cross-platform compatibility)
Backend: Node.js/Express (standalone or embedded)
State: Redux + WebSocket for real-time sync
Styling: Tailwind CSS + Framer Motion (animations)
Build: Vite (with universal preset) + esbuild
Platform Support: Windows, macOS, Linux, Ubuntu
Deployment: NPX executable, Docker, Electron wrapper
```

### Universal CLI Entry Point
```bash
# Global installation
npx ai-agent-workspace

# Local development
npm start

# Docker
docker run -p 3000:3000 ai-agent-workspace

# Executable
./ai-agent-workspace (Windows/macOS/Linux binary)
```

---

## Supported AI Assistants Integration

### Automatic Detection & Integration
The app detects and integrates with:

```javascript
SUPPORTED_PLATFORMS = {
  // IDE-Embedded Agents
  'vscode-copilot': { port: 63342, protocol: 'CDP' },
  'github-copilot-cli': { port: 6969, protocol: 'REST' },
  'cursor': { port: 3001, protocol: 'WebSocket' },
  'jetbrains-copilot': { port: 63343, protocol: 'CDP' },
  
  // Terminal/CLI Agents
  'claude-code': { port: 3000, protocol: 'WebSocket' },
  'aider': { port: 5000, protocol: 'REST' },
  'devin-cli': { port: 8000, protocol: 'REST' },
  'openai-codex': { port: 5001, protocol: 'WebSocket' },
  
  // Browser-Based
  'claude-ai': { url: 'claude.ai', protocol: 'IFrame' },
  'gemini-cli': { port: 4242, protocol: 'WebSocket' },
  'kimi-code': { port: 6000, protocol: 'REST' },
  
  // Advanced Agents
  'devin': { port: 8080, protocol: 'gRPC' },
  'factory-droid': { port: 7000, protocol: 'WebSocket' },
  'trae': { port: 9000, protocol: 'REST' },
  'openclaw': { port: 5555, protocol: 'WebSocket' },
  'hermes': { port: 8888, protocol: 'REST' },
  'kiro-ide': { port: 9001, protocol: 'WebSocket' },
};
```

### Task Fetching Strategy
```javascript
TASK_SOURCES = [
  'window.localStorage (chat history)',
  'Browser DevTools (CDP)',
  'File system (watching .agent files)',
  'WebSocket events (real-time)',
  'REST API polling (fallback)',
  'Clipboard monitoring (advanced)',
];
```

---

## Agent Visualization System

### Agent Archetypes & Appearances
Each agent has a unique 3D avatar representing their domain:

```javascript
AGENT_TYPES = {
  'Frontend Developer': {
    avatar: 'dev_female_1.glb',
    color: '#FF6B6B',
    tools: ['React', 'CSS', 'JavaScript'],
    desk: 'standing',
    specialty: 'UI/UX implementation'
  },
  'Backend Developer': {
    avatar: 'dev_male_1.glb',
    color: '#4ECDC4',
    tools: ['Node.js', 'PostgreSQL', 'REST'],
    desk: 'sitting',
    specialty: 'API & database'
  },
  'DevOps Engineer': {
    avatar: 'devops_1.glb',
    color: '#FFE66D',
    tools: ['Docker', 'Kubernetes', 'AWS'],
    desk: 'monitor_wall',
    specialty: 'Deployment & infrastructure'
  },
  'QA/Tester': {
    avatar: 'qa_1.glb',
    color: '#95E1D3',
    tools: ['Jest', 'Cypress', 'Selenium'],
    desk: 'testing_station',
    specialty: 'Testing & validation'
  },
  'Data Scientist': {
    avatar: 'data_1.glb',
    color: '#C7CEEA',
    tools: ['Python', 'TensorFlow', 'Pandas'],
    desk: 'lab_station',
    specialty: 'ML & analytics'
  },
  'Security Specialist': {
    avatar: 'security_1.glb',
    color: '#FF8B94',
    tools: ['Penetration', 'SAST', 'Audit'],
    desk: 'secure_room',
    specialty: 'Security & compliance'
  },
  'Architect': {
    avatar: 'architect_1.glb',
    color: '#A8D8EA',
    tools: ['Design Patterns', 'System Design'],
    desk: 'whiteboard_station',
    specialty: 'System design'
  },
  'Project Manager': {
    avatar: 'pm_1.glb',
    color: '#FFDAC1',
    tools: ['Agile', 'Scrum'],
    desk: 'meeting_room',
    specialty: 'Coordination'
  }
};
```

### Agent State Machine
```javascript
AGENT_STATES = {
  IDLE: {
    animation: 'standing_idle',
    icon: 'zzz',
    color: '#CCCCCC',
    duration: 'indefinite'
  },
  ASSIGNED: {
    animation: 'head_nod',
    icon: '📋',
    color: '#FFE66D',
    duration: '2s'
  },
  RESEARCHING: {
    animation: 'thinking',
    icon: '🔍',
    color: '#C7CEEA',
    duration: '3s',
    particles: 'blue_motes'
  },
  CODING: {
    animation: 'typing_fast',
    icon: '⌨️',
    color: '#FF6B6B',
    duration: '1.5s',
    particles: 'code_blocks'
  },
  DEBUGGING: {
    animation: 'scratching_head',
    icon: '🐛',
    color: '#FF8B94',
    duration: '2.5s',
    particles: 'error_pulses'
  },
  ANALYZING: {
    animation: 'studying',
    icon: '📊',
    color: '#A8D8EA',
    duration: '2s',
    particles: 'data_streams'
  },
  TESTING: {
    animation: 'clicking_mouse',
    icon: '✓',
    color: '#95E1D3',
    duration: '2s',
    particles: 'checkmarks'
  },
  ASSESSING: {
    animation: 'reviewing',
    icon: '👁️',
    color: '#FFE66D',
    duration: '2s',
    particles: 'evaluation_marks'
  },
  COLLABORATING: {
    animation: 'talking',
    icon: '💬',
    color: '#FFDAC1',
    duration: '2s',
    particles: 'chat_bubbles'
  },
  EXPLAINING: {
    animation: 'gesturing',
    icon: '📝',
    color: '#4ECDC4',
    duration: '3s',
    particles: 'visual_elements'
  },
  THINKING: {
    animation: 'pondering',
    icon: '💭',
    color: '#C7CEEA',
    duration: '2.5s',
    particles: 'idea_bulbs'
  },
  RELAXING: {
    animation: 'stretching',
    icon: '☕',
    color: '#FFDAC1',
    duration: 'indefinite'
  },
  BLOCKED: {
    animation: 'confused',
    icon: '⚠️',
    color: '#FF6B6B',
    duration: '2s',
    particles: 'warning_signs'
  },
  COMPLETED: {
    animation: 'celebrating',
    icon: '🎉',
    color: '#95E1D3',
    duration: '3s',
    particles: 'confetti'
  }
};
```

---

## 3D Environment Architecture

### Office Layout (Adaptive)

```javascript
OFFICE_LAYOUTS = {
  'compact': {
    scale: 0.7,
    agents_per_row: 3,
    desk_height: 0.8,
    target: 'mobile/tablet'
  },
  'standard': {
    scale: 1.0,
    agents_per_row: 4,
    desk_height: 1.0,
    target: 'desktop'
  },
  'spacious': {
    scale: 1.3,
    agents_per_row: 5,
    desk_height: 1.2,
    target: 'ultrawide/4k'
  },
  'meeting_room': {
    scale: 0.9,
    agents_per_row: 6,
    desk_height: 0.95,
    target: 'large_display'
  }
};

ENVIRONMENT_FEATURES = {
  floors: ['polished_concrete', 'wooden', 'modern_tile'],
  walls: ['glass_panels', 'painted', 'industrial'],
  lighting: ['daylight', 'fluorescent', 'ambient_led'],
  decorations: ['plants', 'art', 'whiteboards'],
  ambient_sounds: ['typing', 'subtle_music', 'office_hum'],
};
```

### Interactive Elements

```javascript
INTERACTIVE_ZONES = {
  agent_desk: {
    hover_distance: 2.0,
    info_panel: 'detailed_task_card',
    actions: ['pause', 'reassign', 'help', 'escalate']
  },
  meeting_room: {
    capacity: 3,
    states: ['empty', 'discussion', 'presenting'],
    features: ['whiteboard', 'screen_share', 'recording']
  },
  break_room: {
    states: ['empty', 'casual', 'lunch'],
    animations: ['sitting', 'chatting', 'eating']
  },
  tech_wall: {
    displays: ['metrics', 'logs', 'real_time_updates'],
    refresh_rate: 1000
  }
};
```

---

## Real-Time Task Management System

### Task Detection Pipeline
```javascript
TASK_DETECTION = {
  1_CAPTURE: {
    methods: [
      'intercept_console_logs()',
      'monitor_dom_mutations()',
      'track_function_calls()',
      'parse_chat_messages()',
      'read_file_system_events()',
    ],
    debounce: 300
  },
  
  2_PARSE: {
    nlp: 'task_classifier_ml_model',
    patterns: [
      'assignTaskRegex',
      'progressRegex',
      'completionRegex',
      'errorRegex',
      'collaborationRegex',
    ],
    confidence_threshold: 0.75
  },
  
  3_ENRICH: {
    add_metadata: [
      'task_priority',
      'estimated_duration',
      'dependencies',
      'assigned_agent_type',
      'related_tasks',
    ],
    source_tracking: true
  },
  
  4_VISUALIZE: {
    queue_task: 'task_queue',
    assign_agent: 'intelligent_matching',
    animate_transition: 'smooth_2s'
  }
};
```

### Task Data Structure
```javascript
TASK_SCHEMA = {
  id: 'uuid',
  title: 'string',
  description: 'string',
  priority: 'enum[low, medium, high, critical]',
  source: 'string (platform)',
  assigned_agent: {
    id: 'uuid',
    type: 'agent_archetype',
    status: 'agent_state'
  },
  timeline: {
    created_at: 'timestamp',
    started_at: 'timestamp',
    estimated_completion: 'timestamp',
    completed_at: 'timestamp'
  },
  progress: {
    percentage: 'number[0-100]',
    subtasks: 'array',
    blockers: 'array',
    notes: 'string'
  },
  collaboration: {
    related_agents: 'array',
    chat_history: 'array',
    attachments: 'array'
  },
  visualization: {
    animation_state: 'agent_state_enum',
    particle_effects: 'array',
    color_code: 'hex'
  }
};
```

---

## UI/UX Architecture

### Main Dashboard Zones

```javascript
DASHBOARD_LAYOUT = {
  3d_viewport: {
    flex: '70%',
    content: '3D_office_scene',
    controls: 'orbit_click_zoom',
    responsive: 'scales_with_container'
  },
  
  right_panel: {
    flex: '30%',
    sections: [
      {
        title: 'Active Tasks Queue',
        component: 'TaskQueue',
        height: '30%',
        sortBy: 'priority|time_assigned|deadline'
      },
      {
        title: 'Agent Status Board',
        component: 'AgentGrid',
        height: '35%',
        filter: 'all|busy|idle|blocked'
      },
      {
        title: 'Collaboration Feed',
        component: 'CollaborationFeed',
        height: '35%',
        realtime: true
      }
    ]
  },
  
  top_bar: {
    height: '60px',
    sections: [
      'app_logo_title',
      'connected_platform_badge',
      'real_time_connection_indicator',
      'stats_overview',
      'theme_toggle',
      'settings_menu'
    ]
  },
  
  bottom_bar: {
    height: '50px',
    sections: [
      'global_metrics',
      'task_completion_rate',
      'performance_indicator',
      'notification_center'
    ]
  }
};
```

### Hover Information Card

```javascript
HOVER_INFO_CARD = {
  trigger: 'on_agent_hover',
  fade_in: '200ms',
  position: 'smart_placement',
  content: [
    {
      label: 'Current Task',
      value: 'dynamic_from_agent.current_task.title'
    },
    {
      label: 'Status',
      value: 'dynamic_from_agent.state',
      icon: true
    },
    {
      label: 'Progress',
      value: 'progress_bar_component'
    },
    {
      label: 'Time Spent',
      value: 'elapsed_time_tracker'
    },
    {
      label: 'Efficiency',
      value: 'score_with_gauge'
    },
    {
      label: 'Subtasks',
      value: 'expandable_list'
    },
    {
      label: 'Actions',
      value: 'quick_action_buttons'
    }
  ],
  animations: 'smooth_slide_bounce'
};
```

---

## Color & Theming System

### Dynamic Theme Engine
```javascript
THEME_SYSTEM = {
  modes: ['light', 'dark', 'high_contrast', 'colorblind'],
  
  palettes: {
    primary: '#6366F1',
    secondary: '#EC4899',
    success: '#10B981',
    warning: '#F59E0B',
    error: '#EF4444',
    info: '#3B82F6'
  },
  
  agent_colors: [
    '#FF6B6B', '#4ECDC4', '#FFE66D', '#95E1D3',
    '#C7CEEA', '#FF8B94', '#A8D8EA', '#FFDAC1'
  ],
  
  gradients: {
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    card: 'linear-gradient(to bottom, rgba(255,255,255,0.1), rgba(255,255,255,0))',
    hover: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)'
  },
  
  accessibility: {
    contrast_ratio_minimum: 4.5,
    color_blindness_modes: ['protanopia', 'deuteranopia', 'tritanopia']
  }
};
```

---

## Cross-Platform Compatibility

### Build Targets
```json
{
  "targets": {
    "web": "React SPA (any browser)",
    "electron": "Desktop app (Windows/macOS/Linux)",
    "cli": "Terminal UI (Rich + Python)",
    "native": "Platform-specific (Tauri)",
    "docker": "Containerized deployment"
  },
  
  "platforms": {
    "windows": ["x86_64", "arm64", ".exe installer"],
    "macos": ["x86_64", "arm64 (Apple Silicon)", ".dmg"],
    "linux": ["x86_64", "arm64", "AppImage", "snap"]
  },
  
  "os_detection": {
    "runtime": "process.platform || navigator.platform",
    "architecture": "os.arch()",
    "available_memory": "os.totalmem()",
    "gpu_available": "WebGL2 detection"
  },
  
  "auto_optimization": {
    "low_memory": "reduce_agents_count * 0.5",
    "no_gpu": "reduce_particle_effects * 0.3",
    "low_bandwidth": "compress_3d_assets * 0.7"
  }
}
```

### NPX Universal Execution
```bash
# Cross-platform runner
npx ai-agent-workspace

# What happens:
# 1. Detect OS & architecture
# 2. Download appropriate binary
# 3. Check for Node.js installation
# 4. Launch server on available port
# 5. Auto-open browser at http://localhost:3000
# 6. Connect to detected AI assistant
```

---

## Real-Time Communication Protocol

### WebSocket Event Schema
```javascript
WEBSOCKET_EVENTS = {
  // Agent lifecycle
  'agent:spawn': { agent_id, agent_type, appearance },
  'agent:status_changed': { agent_id, new_state, timestamp },
  'agent:animation_triggered': { agent_id, animation_name, duration },
  
  // Task events
  'task:assigned': { task_id, agent_id, priority },
  'task:progress_updated': { task_id, percentage, current_subtask },
  'task:completed': { task_id, agent_id, metrics },
  'task:blocked': { task_id, blocker_reason },
  
  // Collaboration
  'agents:collaboration_started': { agent_ids, location },
  'agents:message_exchange': { from_agent, to_agent, message, timestamp },
  'agents:presentation_started': { presenter_agent, audience_agents },
  
  // System
  'system:metrics_update': { cpu, memory, active_tasks, active_agents },
  'system:connection_status': { platform, status, latency }
};

MESSAGE_FORMAT = {
  event: 'string',
  payload: 'object',
  timestamp: 'iso8601',
  source: 'string',
  sequence: 'number'
};
```

---

## Performance Optimization

### Resource Management
```javascript
PERFORMANCE_TARGETS = {
  initial_load: '< 2.5s',
  frame_rate: '60 FPS (adaptive down to 30)',
  memory_usage: '< 300MB',
  network_bandwidth: '< 1MB/s',
  
  optimization_strategies: [
    'lazy_load_3d_models',
    'gpu_particle_batching',
    'memory_pool_allocation',
    'websocket_message_compression',
    'request_debouncing',
    'animation_frame_skipping_when_occluded'
  ]
};

RENDERING_OPTIMIZATION = {
  LOD_levels: [
    { distance: '0-5m', detail: 'high', poly_count: 50000 },
    { distance: '5-15m', detail: 'medium', poly_count: 15000 },
    { distance: '15m+', detail: 'low', poly_count: 3000 }
  ],
  
  culling: ['frustum', 'occlusion', 'distance_based'],
  
  particle_system: {
    max_particles: 50000,
    pool_size: 100000,
    death_rate: 'per_frame_cleanup'
  }
};
```

---

## Features & Roadmap

### Phase 1: MVP
- [x] 3D office scene with 5 agent types
- [x] Real-time task assignment from Claude Code
- [x] Agent state visualization
- [x] Hover info cards
- [x] Task queue panel
- [x] Responsive design
- [x] NPX launcher

### Phase 2: Platform Integration
- [ ] GitHub Copilot CLI integration
- [ ] VS Code Copilot Chat sync
- [ ] Cursor IDE integration
- [ ] Multi-platform task fetch
- [ ] Advanced animations

### Phase 3: Advanced Features
- [ ] Agent-to-agent collaboration visualization
- [ ] Whiteboard & diagram generation
- [ ] Performance metrics & analytics
- [ ] Custom agent appearance editor
- [ ] Timeline scrubbing
- [ ] Export/share session recordings

### Phase 4: Enterprise
- [ ] Multi-team workspaces
- [ ] Permission & role management
- [ ] Audit logs
- [ ] Integration with CI/CD pipelines
- [ ] Custom integrations API
- [ ] Self-hosted deployment

---

## Security Considerations

```javascript
SECURITY_MEASURES = {
  data_handling: [
    'LocalStorage only for preferences',
    'No task content stored persistently',
    'End-to-end encryption for WebSocket',
    'CORS restrictions configured',
    'CSP headers strict'
  ],
  
  platform_communication: [
    'OAuth2 for sensitive integrations',
    'API key rotation recommended',
    'No credentials in localStorage',
    'Secure channel validation',
    'TLS 1.3 minimum'
  ],
  
  user_privacy: [
    'No analytics tracking',
    'No external CDN for core assets',
    'Self-hosted deployment option',
    'GDPR compliant',
    'No telemetry'
  ]
};
```

---

## Development Environment Setup

```bash
# Clone & install
git clone https://github.com/yourusername/ai-agent-workspace.git
cd ai-agent-workspace
npm install

# Development server
npm run dev

# Build for production
npm run build

# Build cross-platform executables
npm run build:executables

# Run tests
npm run test

# Type checking
npm run typecheck
```

---

## Configuration File (`workspace.config.js`)

```javascript
module.exports = {
  // Platform detection
  auto_detect_platforms: true,
  platforms: ['claude-code', 'cursor', 'github-copilot'],
  
  // Visualization
  default_layout: 'standard',
  theme: 'dark',
  fps_target: 60,
  particle_quality: 'high',
  
  // Agent customization
  max_agents: 8,
  agent_types: ['all'],
  
  // Performance
  memory_limit: '300MB',
  reduce_quality_below_memory: '200MB',
  
  // Advanced
  debug_mode: false,
  log_level: 'info',
  websocket_compress: true
};
```

---

## Summary

This system creates a **professional, beautiful, and intuitive visualization engine** for AI agents that:

✅ **Works everywhere**: Windows, macOS, Linux via single `npx` command  
✅ **Integrates anywhere**: Detects and connects to 15+ AI assistant platforms  
✅ **Looks amazing**: Dynamic 3D scenes with particle effects and smooth animations  
✅ **Highly responsive**: Adaptive UI for any screen size  
✅ **Real-time sync**: Live task updates from any platform  
✅ **Professional UX**: Clean, intuitive interface with rich interactions  
✅ **Extensible**: Custom agent types, themes, and integrations  
✅ **Production-ready**: Security, performance, and accessibility considered  

---

## Next Steps

1. **Generate starter React + Three.js boilerplate**
2. **Create platform detection middleware**
3. **Build 3D agent models (or find free alternatives)**
4. **Implement task parsing NLP model**
5. **Set up WebSocket event broadcasting**
6. **Design and implement UI components**
7. **Build cross-platform bundling pipeline**
8. **Create comprehensive documentation**
9. **Set up GitHub Actions for CI/CD**
10. **Launch as open-source project**

---

This prompt provides everything needed to build a professional, cross-platform AI agent visualization system!
