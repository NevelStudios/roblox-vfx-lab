import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VFX_TOOLS, seedLibrary } from "../src/lab.js";
import { VIEWER_TOOLS } from "../src/server.js";
import { textOf } from "./fake-gpu.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("seedLibrary copies examples into an empty library only, and never over a file", () => {
  const examples = fs.mkdtempSync(path.join(os.tmpdir(), "vfx-examples-"));
  fs.mkdirSync(path.join(examples, "impact"));
  for (const ext of ["wgsl", "png", "json"]) fs.writeFileSync(path.join(examples, "impact", `a.${ext}`), ext);
  fs.writeFileSync(path.join(examples, "index.json"), "[]");
  const library = fs.mkdtempSync(path.join(os.tmpdir(), "vfx lab ü-"));
  assert.deepEqual(seedLibrary(library, examples), { copied: 3 });
  assert.equal(fs.readFileSync(path.join(library, "shaders", "impact", "a.wgsl"), "utf8"), "wgsl");
  assert.equal(fs.readFileSync(path.join(library, "bakes", "impact", "a.png"), "utf8"), "png");
  assert.ok(!fs.existsSync(path.join(library, "bakes", "index.json")));
  fs.writeFileSync(path.join(library, "shaders", "impact", "a.wgsl"), "mine");
  assert.deepEqual(seedLibrary(library, examples), { copied: 0 });
  assert.equal(fs.readFileSync(path.join(library, "shaders", "impact", "a.wgsl"), "utf8"), "mine");
  assert.deepEqual(seedLibrary(fs.mkdtempSync(path.join(os.tmpdir(), "vfx-")), path.join(examples, "missing")), { copied: 0 });
});

test("the server lists every tool over stdio and answers vfx_guide", async () => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), "vfx-stdio-"));
  const client = new Client({ name: "index-test", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "src", "index.js")], env: { ...getDefaultEnvironment(), VFX_LAB_LIBRARY: library }, stderr: "pipe" }),
  );
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...VFX_TOOLS, ...VIEWER_TOOLS].map((t) => t.name).sort());
    assert.match(textOf(await client.callTool({ name: "vfx_guide", arguments: {} })), /^Sections:/);
    const bad = await client.callTool({ name: "vfx_shader_read", arguments: { name: "../x" } });
    assert.ok(bad.isError);
  } finally {
    await client.close();
  }
});
