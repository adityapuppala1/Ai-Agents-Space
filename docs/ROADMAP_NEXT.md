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
| 1.2 | ~~Run worker in its own process~~ **Withdrawn 12 Sep — premise unproven** | — | — | — | Robustness |
| 1.2a | Bound and cache binary resolution | P0 | — | — | What 1.2 actually found |
| 1.3 | ~~The workspace menu, decluttered~~ **Done 12 Sep** | — | 1 | — | Your item 4 |
| 2.1 | ~~Speak to an agent from its desk~~ **Done 12 Sep** | — | 2 | — | CLAW3D |
| 2.2 | ~~Give an instruction mid-run~~ **Not possible — headless CLIs are one shot** | — | — | — | CLAW3D |
| 2.3 | Address a room | P1 | 1 | 2.1, 1.1 | CLAW3D |
| 3.1 | ~~Over the shoulder~~ **Done 12 Sep** | — | 1 | 1.1 | Your "agents view" |
| 3.2 | ~~The monitor becomes real~~ **Already was — see below** | — | — | — | Your "agents view" |
| 3.3 | ~~Read the diff at the table~~ **Done 12 Sep** (board names the files) | — | 1 | — | CLAW3D |
| 4.1 | ~~Subagents as visible helpers~~ **Already was — see below** | — | — | — | Your "multiple agents" |
| 4.2 | ~~Workflow fan-out on the floor~~ **Done 12 Sep** | — | 1 | — | Your "orchestrated" |
| 4.3 | ~~Which worktree is this desk on~~ **Done 12 Sep** | — | 1 | — | Vibe Kanban, Conductor |
| 5.1 | ~~The arranger in 3D~~ **Preview done 12 Sep; drag-in-3D not** | P2 | 2 | 1.1 | Your item 3 |
| 5.2 | ~~The campus becomes a building~~ **Already has floors — see below** | — | — | — | Your "3D layers" |
| 5.3 | Depth and light | P2 | 1 | — | Your "3D layers" |
| 6.1 | ~~A one-line presence strip~~ **Done 12 Sep** (attention elsewhere) | — | 1 | — | Agent Island |
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

### 1.2 The run worker in its own process — **withdrawn as stated, 12 September 2026**

> **The premise did not survive measurement.** This item said "a wedged provider CLI can currently take the interface down with it." That is not true, and it should not have been written without checking.
>
> A provider CLI is spawned with `spawn()` and piped stdio (`runs/process.js`). It is a separate OS process whose output arrives through async streams, so a CLI that wedges, floods or dies cannot block the server's event loop. It holds a queue slot and some memory; it does not hold the thread.
>
> Three candidate blockers were measured rather than assumed:
>
> | Suspect | Measured | Verdict |
> | --- | --- | --- |
> | Artifact capture reading untracked files with `readFileSync` | Worst event-loop pause **16–44 ms** across 2 000–20 000 untracked files | Bounded by the `DIFF_LIMIT` check; not a freeze |
> | A wedged CLI holding the main thread | Not reproducible by construction — async pipes | Not a real failure mode |
> | Synchronous binary resolution (`execFileSync` for `where`/`which`) | Up to its **5 000 ms** timeout, on every launch attempt, whenever PATH holds something unresponsive | **Real.** Fixed — see below |
>
> So the 2 400-line extraction of `RunWorker` across a process boundary — which would also have forced either multi-process SQLite or a large IPC surface — had no demonstrated problem behind it. Building it would have been a lot of risk bought with an assumption.
>
> **What was actually wrong, and is now fixed:** binary resolution is synchronous, so whatever it waited for, every open page and WebSocket waited for. Its `where` / `which` fallback was capped at five seconds and re-ran on every launch attempt. The cap is now 800 ms — close to what a working lookup costs — and results are cached for 30 seconds, keyed by name and PATH, so a provider that is simply not installed no longer pays the full cost on each attempt. A short TTL means installing a CLI is still picked up without a restart. `tests/binary-lookup.test.js` pins the bound, the caching, and that the cache never answers for a different environment.
>
> **What is left of the original idea.** Nothing urgent. If a future change makes the run path genuinely CPU-bound — parsing a very high-volume stream, say — the honest fix would be a worker thread for that parsing, not a second process holding the database. Revisit only with a measurement in hand.
>
> **Consequence for wave 2.** Talking to a live run does *not* depend on this, which removes the only dependency that made 2.1 a P0-after-1.2. It moves up.

### 1.3 The workspace menu, decluttered — **done, 12 September 2026**

> Shipped, as described. See [ROADMAP_STATUS.md](ROADMAP_STATUS.md) for the evidence.


Each row carries nine pieces of information and the panel does four jobs. Reduce to one line per workspace, the second line only for the current one, recency as ordering rather than a section, managing behind one item that opens the dialog that already exists, and a filter box only past nine workspaces.

## 5. Wave two — talk to your agents (P0 → P1)

The CLAW3D capability worth taking, and the one that turns the office from a display into a place you work.

### 2.1 Speak to an agent from its desk — **done, 12 September 2026**

> Shipped whole: the exchange, replying, and reaching it from an agent's desk. See [ROADMAP_STATUS.md](ROADMAP_STATUS.md) for the evidence.


Select an agent, and a conversation opens anchored to it: what it has actually said, and a box to say something back. The agent's recorded messages already exist as events; this gives them a face and a place.

- Messages render in-world as speech only when the provider produced them.
- The panel is the same conversation the run inspector shows — one record, two views, never two truths.
- Keyboard and screen-reader path from day one: the conversation is a normal focusable region with a live region, not a 3D-only affordance.

### 2.2 Give an instruction mid-run — **not possible, 12 September 2026**

> **Corrected.** This item claimed "`POST /api/runs/:id/input` feeds a running session". It does not. `RunWorker.input()` refuses outright while the run is executing — *"headless providers accept input only between attempts"* — and what it actually does is resume the provider's session as a **new run**, linked to the previous one by `parentRunId`.
>
> That is not a gap to close; it is what a headless provider CLI is. `claude -p "…"` is one shot: it takes a prompt, works, answers and exits. There is no stdin to steer it through. Nothing in the interface can change that, and pretending otherwise would have been exactly the kind of invented capability the truthfulness rules exist to stop.
>
> So "mid-run" is dropped, and what *is* possible was built instead as part of 2.1: replying between attempts, with the interface saying plainly that a reply starts a new attempt. A run that is still working says so, and offers the two real options — wait, or cancel.
>
> The queueing and approval ideas in the original text are still worth having, but they belong to a reply that starts an attempt, not to steering a live process. They are not built.

### 2.3 Address a room

When a conference room is open, speak to everyone in it: the instruction fans out to each member's run under the same policy and approval rules, and the room's board shows what was asked.

## 6. Wave three — watch what an agent is doing (P1)

Your "more agents view — what he is doing, watching". Today you learn what an agent is doing by reading a panel beside the office. This puts it in the office.

### 3.1 Over the shoulder — **done, 12 September 2026**

> Shipped. See [ROADMAP_STATUS.md](ROADMAP_STATUS.md) for the evidence and the one design constraint worth knowing: the office camera is orthographic, so the vantage point sets the *angle*, and closeness is zoom.


### 3.2 The monitor becomes real — **it already was, 12 September 2026**

> **Written from a wrong belief about the code.** This item said "the desk screen stops being a coloured panel". It was never a coloured panel. `updateMonitor()` in `office/zones.js` has been drawing the agent's current file, its activity label and its current action to a canvas texture, with an optional three-line preview fed from the run's own sanitized artifacts — masked in presentation mode, and keyed so it only redraws when the content changes.
>
> It is visible in `artifacts/office-seated-desks.png`, taken before this item was looked at: the desk screens read "Atlas / Planning", "Echo / Coding", "Pixel / testing", "Sage / waiting for echo". The QA station board likewise reads "tests running / Pixel / no test output yet" — an honest empty state, not filler.
>
> Nothing was built. The truthfulness guard the item asked for was already the behaviour.

### 3.3 Read the diff at the table — **done in part, 12 September 2026**

> **The premise was half wrong again.** The board was never blank: it already said "reviewing", named the reviewers, and carried up to three clickable artifact chips that open the artifact. What it never said was *what the review is about* — "2 artifacts linked" tells you a review exists, not which files changed.
>
> The changed files were recorded all along, on the diff artifact's own `metadata.files` (`captureGitDiff` stores `{ path, status }` per file); nothing surfaced them. The board now reads **"3 files changed: app.js, routes.js"**, and says **"no diff recorded"** when none was — a different fact from nothing having changed, and never shown as "0 files changed".
>
> **Not done:** the patch text itself on the wall. The chips already open the artifact, which is where a diff is readable; painting a patch onto a canvas texture at wall distance would be less legible than the panel that already exists. Revisit only if reading it in place turns out to matter more than reaching it in one click.

## 7. Wave four — more agents when the work needs them (P1)

Your "multiple agents as needed when work is happening", done truthfully: agents appear because work appeared, never to look busy.

- **4.1 Subagents as visible helpers — already built (checked 12 September 2026).** The item said "wire them to real subagent transcripts". They were already wired. `Office.jsx` builds a helper per open delegation in the snapshot's `agent.subagents`, steps it out of its parent, gives it a chip naming the delegation, and folds it back when the subagent reports. Nothing to do.
- **4.2 Workflow fan-out on the floor — done, 12 September 2026, but not as written.** The spatial half already existed: agents in a live workflow stand on the floor (`relayPresence`), and the dependency edges between them are drawn as dashed wait lines (`waitingLinks`). What was wrong was the **relay strip**, which laid every step out in a row with an arrow between each pair — so two steps that depend on none of each other, and run at the same time, were drawn as though one followed the other. That is a claim the workflow does not make. The strip now groups steps into the stages they form (`relayLayers`): arrows only between stages, and steps within one stage braced together, announced to a screen reader as "one of 2 running at the same time".
- **4.3 Which worktree is this desk on — done, 12 September 2026.** The snapshot's agents now carry `branch` and `isolated`; the run passport names the branch and says whether it is an isolated worktree or your own working tree, and an agent's tooltip in the office says "on &lt;branch&gt; (isolated worktree)". A run that recorded no branch says so rather than being shown as `main`. **Not done:** putting an isolated agent on visibly separate floor — the data is there for it, but a second floor plane is a large scene change for a distinction a label already makes.

## 8. Wave five — more 3D layers (P1 → P2)

- **5.1 The arranger in 3D — the preview is done, 12 September 2026; dragging in 3D is not.** A live preview now stands above the plan, built by `office/arrangeStage.js` from the same `computeLayout()` the office runs, so it cannot drift from what saving produces. It draws the floor, the rooms as named slabs, the desks as guides and the furniture with the office's own catalogue, highlights whatever the plan has selected, and rings anything standing in something else (`propClashes`). Without WebGL it simply does not appear — the plan is the editor and always was.
  **Still not done:** dragging *in* the 3D view, snapping, and the walkthrough. The plan already drags with snapping and is the keyboard path, so 3D dragging is a second way to do something that works; it drops to P2 rather than being called finished.
- **5.2 The campus becomes a building — not done, and deliberately so (12 September 2026).** The premise was that the Campus lacked vertical structure. It does not: it is already a three.js scene where each workspace is a building whose **height scales with its team**, whose **window bands are floors lit when work is running**, and which glows when something needs attention (`artifacts/campus-buildings.png`).
  Stacking independent workspaces into one building was also considered and rejected on the project's own terms: workspaces are independent — separate agents, tasks, policy and history — and drawing them as floors of a single building would say they are parts of one thing. The existing metaphor is the truer one, so this item is closed rather than built.
- **5.3 Depth and light.** Contact shadows, layered glass in the conference wing, and light falloff that separates the floor planes. Gated by graphics preset and disabled under reduced motion; this is the one item here that is purely presentational, which is why it sits last in its wave.

## 9. Wave six — reach (P2)

- **6.1 A one-line presence strip — done, 12 September 2026, narrowed to the part that was missing.** The glanceable surface mostly existed: the top bar already says what is running and what needs attention **here**, and the provider pulse already says which assistants are alive. The one question nothing answered was the one Agent Island exists for — *does something need me somewhere I am not looking?* A workspace could sit blocked indefinitely and say nothing until the switcher was opened. The bar now carries "Payments needs you" / "2 workspaces need you", and clicking it goes there. Silent when nothing is waiting: "0 elsewhere" is not information.
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
