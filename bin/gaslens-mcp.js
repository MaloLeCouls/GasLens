#!/usr/bin/env node
import('../dist/mcp-server.js').then((m) => m.runGaslensMcpServer()).catch((err) => {
  process.stderr.write(`gaslens-mcp: ${err?.message ?? err}\n`);
  process.exit(1);
});
