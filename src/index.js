#!/usr/bin/env node
// roblox-vfx-lab: the MCP server over stdio. Write WGSL effect nodes, render and bake them on this machine's GPU,
// and put them in Studio through Roblox's own Studio MCP. Nothing but the MCP transport writes to stdout: the GPU
// worker's output goes to stderr.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { gpu } from "./gpu.js";
import { VFX_TOOLS, callTool, seedLibrary, vfxLibrary } from "./lab.js";
import { VIEWER_TOOLS } from "./server.js";
import { createStudio } from "./studio.js";

const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const TOOLS = [...VFX_TOOLS, ...VIEWER_TOOLS];
const EXAMPLES = fileURLToPath(new URL("../examples", import.meta.url));

async function main() {
  const seeded = seedLibrary(vfxLibrary(), EXAMPLES);
  if (seeded.copied > 0) console.error(`[roblox-vfx-lab] copied ${seeded.copied} example files into ${vfxLibrary()}`);
  const ctx = { gpu, studio: createStudio() };
  const server = new Server({ name: "roblox-vfx-lab", version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) throw new Error(`unknown tool ${request.params.name}`);
    return callTool(tool, request.params.arguments, ctx);
  });
  server.onclose = () => ctx.studio.close();
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error("[roblox-vfx-lab] failed to start:", error);
  process.exit(1);
});
