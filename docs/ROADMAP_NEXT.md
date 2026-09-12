# What Agent Space builds next

Forward plan, written 12 September 2026. This document is the prioritised queue; [ROADMAP_STATUS.md](ROADMAP_STATUS.md) records what has actually shipped, and [Idea/PRODUCT_ROADMAP.md](../Idea/PRODUCT_ROADMAP.md) holds the original strategy. Nothing here is claimed as built. When an item ships it moves to ROADMAP_STATUS.md with its verification, and its row here is struck out.

Two inputs produced this list:

1. **A market study** of seventeen products in four categories — spatial agent offices (CLAW3D, AgentOffice, Emergence World, AI Town), orchestrators (Vibe Kanban, Conductor, Crystal, Claude Squad), local session readers (claude-code-trace, Agent Sessions, claude-session-dashboard, claude-trace, agent-traces, tracebase, Agent Island) and observability (LangGraph Studio, HumanLayer). Sources are listed in [§7](#7-sources).
2. **Product direction:** make it more robust, more intuitive, more interactive, more three-dimensional, more orchestrated — and specifically take the things CLAW3D gets right: talking back to an agent, giving it instructions, more agents appearing as the work needs them, watching what an agent is actually doing, and more visual depth.

## 1. The position this is all aimed at

> The only place you can watch, govern and trust what your own coding agents are really doing.

**Watch** is the office. **Govern** is policy, approvals and audit. **Trust** is provenance and the rule that we never invent progress. The 3D projects have the first. HumanLayer had the second. The trace viewers have the third. No product found in the study has all three, and all three only make sense together on the user's own machine.

One finding reshaped the queue: **reading the provider's own local session files is table stakes, not a moat.** Seven tools already do it. So the queue below spends nothing on being a better log reader and everything on being a place where you can act.

## 2. The rule that constrains every item here

Interaction must never manufacture agent behaviour.

- An agent speaks in the office only when the provider actually produced a message. A queued instruction is drawn as **queued** until the provider consumes it, never as "said".
- An agent looks at something only when the record says it is there — a speaker with a recorded message, a door someone actually walked through.
- Anything derived rather than reported stays labelled inferred, in the office exactly as in the panels.

Every item below is designed to be buildable without breaking that rule. Where an item could tempt us to fake something, the row says how it is prevented.

## 3. The queue

Priorities are dependency-ordered, not date-ordered. **P0** is being built now; **P1** needs P0's foundation; **P2** needs demand or a decision first. "Slice" means one focused pass: implementation, tests, documentation, and a look at the running app.

| # | Item | Priority | Slices | Depends on | Source |
| --- | --- | --- | --- | --- | --- |
| 1.1 | ~~Agents that can see the furniture~~ **Done 12 Sep** | — | 2 | — | Your screenshot |
| 1.2 | Run worker in its own process | P0 | 1 | — | Robustness |
| 1.3 | The workspace menu, decluttered | P0 | 1 | — | Your item 4 |
| 2.1 | Speak to an agent from its desk | P0 | 2 | 1.2 | CLAW3D |
| 2.2 | Give an instruction mid-run | P0 | 1 | 2.1 | CLAW3D |
| 2.3 | Address a room | P1 | 1 | 2.1, 1.1 | CLAW3D |
| 3.1 | Over the shoulder | P1 | 1 | 1.1 | Your "agents view" |
| 3.2 | The monitor becomes real | P1 | 2 | 3.1 | Your "agents view" |
| 3.3 | Read the diff at the table | P1 | 2 | 3.2 | CLAW3D |
| 4.1 | Subagents as visible helpers | P1 | 1 | 1.1 | Your "multiple agents" |
| 4.2 | Workflow fan-out on the floor | P1 | 2 | 4.1 | Your "orchestrated" |
| 4.3 | Which worktree is this desk on | P1 | 1 | — | Vibe Kanban, Conductor |
| 5.1 | The arranger in 3D | P1 | 2 | 1.1 | Your item 3 |
| 5.2 | The campus becomes a building | P2 | 2 | 5.1 | Your "3D layers" |
| 5.3 | Depth and light | P2 | 1 | — | Your "3D layers" |
| 6.1 | A one-line presence strip | P2 | 1 | — | Agent Island |
| 6.2 | Replay a day in the office | P2 | 3 | 1.1 | LangSmith |
| 6.3 | A runtime as a document | P2 | 2 | — | CLAW3D gateway |

## 4. Wave one — make the world physical and the runtime safe (P0)

Everything in waves two and three assumes an agent is credibly *somewhere*. That has to be true first.

### 1.1 Agents that can see the furniture — **done, 12 September 2026**

> Shipped. The evidence is in [ROADMAP_STATUS.md](ROADMAP_STATUS.md); all four layers below were built, and the desk-anchor bug described in the first paragraph turned out to be the larger half of the problem. The description is kept as written so the plan can be compared with what was actually delivered.


Today a walk is a straight line between two points, and the only obstacle any agent avoids is a conference-room wall, because those door waypoints were written by hand. Desks, chairs, placed furniture and other agents are all walked through.

Four layers, none of them per-agent, so every agent is covered by construction:

- **`office/obstacles.js`** — the office as padded rectangles, derived from the same `computeLayout()` output and prop list the renderer uses, so it cannot drift from what is drawn. Desks, chairs, room footprints, placed furniture, conference walls with a gap at the door, outer walls. Pure arithmetic, unit-testable without a browser.
- **`office/navmesh.js`** — a coarse grid (~0.35 units), A\* to the goal, then a string-pull that drops any waypoint whose segment is already clear, leaving two to five straight legs. Those legs feed the existing `followRoute()`, which already eases and times a multi-leg walk. Conference doors stay forced portals. Rebuilt on layout change, not per frame.
- **`office/steering.js`** — per-frame separation so agents do not pass through each other, clamped so nobody is ever pushed into an obstacle, with right-hand yielding and a wait pose when a seat approach is occupied.
- **Sitting and gaze** — every route to a seat ends at the chair's approach point facing the desk, so nobody arrives inside furniture; head rotation follows a gaze target with a ~70° limit before the body turns.

*Truthfulness guard:* gaze targets come only from recorded events. *Fallback:* an unreachable goal takes the old straight line rather than freezing. *Cost:* no new packages.

### 1.2 The run worker in its own process

A wedged provider CLI can currently take the interface down with it. The worker gets its own OS process with supervised restart and an unchanged contract above it. This is listed at P0 not for its own sake but because **wave two lets you talk to a live run**, and doing that safely means the thing holding the run cannot be the thing holding the UI.

### 1.3 The workspace menu, decluttered

Each row carries nine pieces of information and the panel does four jobs. Reduce to one line per workspace, the second line only for the current one, recency as ordering rather than a section, managing behind one item that opens the dialog that already exists, and a filter box only past nine workspaces.

## 5. Wave two — talk to your agents (P0 → P1)

The CLAW3D capability worth taking, and the one that turns the office from a display into a place you work.

### 2.1 Speak to an agent from its desk

Select an agent, and a conversation opens anchored to it: what it has actually said, and a box to say something back. The agent's recorded messages already exist as events; this gives them a face and a place.

- Messages render in-world as speech only when the provider produced them.
- The panel is the same conversation the run inspector shows — one record, two views, never two truths.
- Keyboard and screen-reader path from day one: the conversation is a normal focusable region with a live region, not a 3D-only affordance.

### 2.2 Give an instruction mid-run

This is smaller than it sounds, because the capability already exists: `POST /api/runs/:id/input` feeds a running session. What is missing is the place to type it and the honesty around it.

- An instruction is **queued** until the provider consumes it, and says so.
- It goes through policy and, where policy requires, an approval — steering a live agent is an action, and actions are governed here.
- It is recorded as an event with you as the author, so the run passport shows who said what.

### 2.3 Address a room

When a conference room is open, speak to everyone in it: the instruction fans out to each member's run under the same policy and approval rules, and the room's board shows what was asked.

## 6. Wave three — watch what an agent is doing (P1)

Your "more agents view — what he is doing, watching". Today you learn what an agent is doing by reading a panel beside the office. This puts it in the office.

### 3.1 Over the shoulder

Focus an agent and the camera drops behind it at desk height. Its monitor faces you. Leaving restores your previous view — the camera already distinguishes a view you chose from one it chose, so this does not fight you.

### 3.2 The monitor becomes real

The desk screen stops being a coloured panel and shows what the run record actually contains: the file being read or edited, the command running, the last tool call, elapsed time. Rendered to a canvas texture, throttled by graphics preset, and readable as text in the roster for anyone not looking at the 3D view.

*Truthfulness guard:* the screen shows recorded tool calls only. An idle agent's screen is idle — never filler code.

### 3.3 Read the diff at the table

The review room already gathers the agents; its board is blank where the diff should be. Put the changed-file list and the diff itself there, opened from the run, so a review happens where the review is depicted.

## 7. Wave four — more agents when the work needs them (P1)

Your "multiple agents as needed when work is happening", done truthfully: agents appear because work appeared, never to look busy.

- **4.1 Subagents as visible helpers.** Helper figures already exist in the scene. Wire them to real subagent transcripts, which the observer already reads, so a fan-out is visible as it happens and collapses when it ends.
- **4.2 Workflow fan-out on the floor.** A workflow step that dispatches several agents fills several desks, and the dependency edges are drawn between them. The workflow graph already exists; this is its spatial rendering.
- **4.3 Which worktree is this desk on.** Every orchestrator in the study isolates agents in git worktrees, and it is the first question their users ask. We already run sandboxed runs in `data/worktrees/<runId>` — we simply never show it. Show the branch at the desk, and put an agent on a worktree on visibly separate floor.

## 8. Wave five — more 3D layers (P1 → P2)

- **5.1 The arranger in 3D.** A live preview beside the plan, drag with snapping and a ghost that turns red on collision (reusing 1.1's obstacle map), and a walkthrough button that sends a test figure along the real routed path so you can tell whether an arrangement works before saving. The plan view stays as the keyboard and non-WebGL path.
- **5.2 The campus becomes a building.** The Campus view already shows several workspaces; give it vertical structure — workspaces as floors, with movement between them — so "more layers" is literal and navigational rather than decorative.
- **5.3 Depth and light.** Contact shadows, layered glass in the conference wing, and light falloff that separates the floor planes. Gated by graphics preset and disabled under reduced motion; this is the one item here that is purely presentational, which is why it sits last in its wave.

## 9. Wave six — reach (P2)

- **6.1 A one-line presence strip.** Agent Island's entire product is one question answered without opening anything: moving, your turn, or stuck. We have the vocabulary already; we lack the glanceable surface.
- **6.2 Replay a day in the office.** Scrub the timeline and watch the floor act it out. Everything required is already recorded, and Day in review is the seed.
- **6.3 A runtime as a document.** Adding a provider should be a config entry rather than an adapter, which is what makes CLAW3D's gateway model extensible.

## 10. Decisions taken

**Component libraries — no new packages.** MagicUI assumes Tailwind plus `motion`; Untitled UI React assumes Tailwind v4 plus `react-aria-components`. Their patterns get ported into our own tokens instead: animated borders, shimmer, number ticker, dock and bento layouts from MagicUI; field, menu and table anatomy and focus-ring discipline from Untitled UI.

This was already the project's answer once — Tailwind and `@tailwindcss/vite` were carried as devDependencies and removed on 12 September because nothing imported them. Re-adding them to obtain components we can write in tens of lines of CSS would split the design system in two and put the contrast gate at risk. Revisit only if a specific component proves genuinely impractical to port.

**Screenshots and demo data stay honest.** The repository is public. Captures committed to `artifacts/` show empty or loading states and carry no absolute paths.

## 11. Deliberately not planned

- **Hosted or multi-tenant anything.** CLAW3D is heading for $29/team/month hosted; that is a different product with a different threat model. Local-first is the position.
- **A better log viewer.** Seven tools already do it.
- **Simulated agents outside the demo workspace.** The whole differentiator is that the office shows real work.

## 12. Sources

CLAW3D: [github.com/iamlukethedev/Claw3D](https://github.com/iamlukethedev/Claw3D), [claw3d.ai](https://claw3d.ai) · AgentOffice: [github.com/harishkotra/agent-office](https://github.com/harishkotra/agent-office) · AI Town: [github.com/a16z-infra/ai-town](https://github.com/a16z-infra/ai-town) · claude-code-trace: [github.com/delexw/claude-code-trace](https://github.com/delexw/claude-code-trace) · Agent Sessions: [jazzyalex.github.io/agent-sessions](https://jazzyalex.github.io/agent-sessions/guides/claude-code-jsonl-history.html) · claude-session-dashboard: [github.com/dlupiak/claude-session-dashboard](https://github.com/dlupiak/claude-session-dashboard) · claude-trace: [github.com/nrigalle/claude-trace](https://github.com/nrigalle/claude-trace) · agent-traces: [github.com/edwarddgao/agent-traces](https://github.com/edwarddgao/agent-traces) · tracebase: [github.com/ssreeni1/tracebase](https://github.com/ssreeni1/tracebase) · Agent Island: [how it detects session state](https://dev.to/tristan666666/how-agent-island-detects-claude-code-and-codex-session-state-2p93) · Orchestrator surveys: [Augment Code](https://www.augmentcode.com/tools/open-source-agent-orchestrators), [Nimbalyst](https://nimbalyst.com/blog/best-multi-agent-coding-tools-2026/), [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators) · [claude-vibe-squad](https://github.com/mtarcure/claude-vibe-squad)

Emergence World, Conductor, Vibe Kanban, LangGraph Studio and HumanLayer are described from the surveys and product pages above; where no canonical URL was verified, no link is given rather than a guessed one.
