import { fileURLToPath } from "node:url";
import { createWorkspaceServer } from "./server.js";

const port = Number(process.env.PORT ?? 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be between 1 and 65535");

// AGENT_SPACE_DB: path to the SQLite file, or ":memory:" for a throwaway
// database. Defaults to data/agent-space.sqlite in the project root.
const dbPath =
  process.env.AGENT_SPACE_DB ||
  fileURLToPath(new URL("../../../data/agent-space.sqlite", import.meta.url));

const server = createWorkspaceServer({
  dbPath,
  demo: process.env.DEMO !== "false",
});
server.on("error", (error) => {
  console.error(`Unable to start workspace: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, process.env.HOST ?? "127.0.0.1", () =>
  console.log(
    `Agent workspace: http://127.0.0.1:${port} (database: ${dbPath})`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close());
