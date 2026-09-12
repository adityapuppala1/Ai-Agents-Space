export const ROADMAP_BOARD = [
  {
    slice: "Adaptive product shell",
    status: "completed",
    detail:
      "Task-grouped navigation, labelled phone bar with More, one Task board, honest provider pulse",
  },
  {
    slice: "Visual system overhaul",
    status: "working",
    detail:
      "One token file, AA status colours, 12 px type floor; 16 routes × 8 viewports pass the audit",
  },
  {
    slice: "Living 3D office",
    status: "working",
    detail:
      "Live presence, office-first Workspace, working minimap and WebGL fallback, Campus drill-down",
  },
  {
    slice: "Provider adapters",
    status: "working",
    detail:
      "Claude/Copilot and bounded artifacts work; Codex/Gemini/Cursor need runtime proof",
  },
  {
    slice: "Cross-platform runtime",
    status: "not-started",
    detail: "Native packaging and clean-machine OS matrix are not built yet",
  },
  {
    slice: "Orchestration and remote hosts",
    status: "working",
    detail: "Local workflow graph exists; remote runner lifecycle remains",
  },
  {
    slice: "Administration",
    status: "working",
    detail: "Local policies, budgets, audit and stop controls exist",
  },
  {
    slice: "Production hardening",
    status: "working",
    detail:
      "Build and browser checks, recovery and backup tests exist; formal audits and hardware profiling remain",
  },
  {
    slice: "Marketing and validation",
    status: "not-started",
    detail:
      "Needs user sessions, design partners, public site and pricing proof",
  },
];

export function roadmapBoardTotals(board = ROADMAP_BOARD) {
  return board.reduce(
    (acc, row) => {
      if (row?.status in acc) acc[row.status] += 1;
      return acc;
    },
    { completed: 0, working: 0, "not-started": 0 },
  );
}
