#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createRuntimeContext } from "./runtime/context.js";
import { createMcpServer } from "./server.js";

async function main(): Promise<void> {
  const context = createRuntimeContext();
  const server = createMcpServer(context);
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
