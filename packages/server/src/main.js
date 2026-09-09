import { createWorkspaceServer } from "./server.js";

const port = Number(process.env.PORT ?? 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be between 1 and 65535");
const server = createWorkspaceServer(undefined, {
  demo: process.env.DEMO !== "false",
});
server.on("error", (error) => {
  console.error(`Unable to start workspace: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, process.env.HOST ?? "127.0.0.1", () =>
  console.log(`Agent workspace: http://127.0.0.1:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close());
