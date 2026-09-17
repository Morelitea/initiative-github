import type { AddressInfo } from "node:net";

import { server } from "../../src/server.js";

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as AddressInfo;
  process.stdout.write(`${JSON.stringify({ port })}\n`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
