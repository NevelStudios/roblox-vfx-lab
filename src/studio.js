// Roblox's own Studio MCP as a child process: the lab reaches Studio only through it (upload_image, execute_luau,
// screen_capture, list_roblox_studios). The child starts at the first call that needs Studio, so writing, rendering
// and baking work on a machine with no Studio. Luau ops run from studio-ops.luau; their arguments cross as a
// long-bracket string, never as code.
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolError } from "./core.js";

const OPS_SOURCE = fs.readFileSync(new URL("./studio-ops.luau", import.meta.url), "utf8");
// Mesh and texture jobs in Studio take minutes; an upload of a 1024 sheet takes seconds.
const CALL_TIMEOUT_MS = 300_000;
const MAC_STUDIO_MCP = "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP";
const HELP = "install Roblox Studio and open it once, or set ROBLOX_STUDIO_MCP to the command that starts its MCP server";

// "a b" "c d" -> ["a b", "c", "d"]: double quotes group, nothing else is special.
const splitCommand = (line) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);

// The command that starts Roblox's Studio MCP (https://create.roblox.com/docs/studio/mcp).
export function studioLaunch({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (env.ROBLOX_STUDIO_MCP) {
    const [command, ...args] = splitCommand(env.ROBLOX_STUDIO_MCP);
    return { command, args };
  }
  if (platform === "win32") {
    const bat = path.win32.join(env.LOCALAPPDATA ?? "", "Roblox", "mcp.bat");
    if (!exists(bat)) throw new ToolError(`no Roblox Studio MCP found at ${bat}: ${HELP}`);
    return { command: "cmd.exe", args: ["/c", bat] };
  }
  if (platform === "darwin") {
    if (!exists(MAC_STUDIO_MCP)) throw new ToolError(`no Roblox Studio MCP found at ${MAC_STUDIO_MCP}: ${HELP}`);
    return { command: MAC_STUDIO_MCP, args: [] };
  }
  throw new ToolError(`Roblox Studio runs on Windows and macOS; on ${platform}, ${HELP}`);
}

async function connectStdio({ command, args }) {
  const client = new Client({ name: "roblox-vfx-lab", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command, args, stderr: "inherit" }));
  return client;
}

// { call(name, args), close() }. A child that exits fails its pending calls; the next call starts a new one.
export function createStudio({ launch = studioLaunch, connect = connectStdio } = {}) {
  let session = null; // Promise of { client, closed, alive }

  function open() {
    const current = { alive: true };
    current.closed = new Promise((_, reject) => {
      current.fail = reject;
    });
    current.closed.catch(() => {});
    return (async () => {
      const { command, args } = launch();
      try {
        current.client = await connect({ command, args });
      } catch (error) {
        throw new ToolError(`Roblox's Studio MCP did not start (${[command, ...args].join(" ")}: ${error.message}); ${HELP}, and turn on its MCP server (Assistant settings)`);
      }
      current.client.onclose = (code) => {
        if (!current.alive) return;
        current.alive = false;
        if (session === current.promise) session = null;
        current.fail(new ToolError(`Roblox's Studio MCP exited (${code ?? "closed"}); the next call starts it again. If it keeps exiting, open Studio and turn on its MCP server (Assistant settings), or set ROBLOX_STUDIO_MCP`));
      };
      return current;
    })();
  }

  return {
    async call(name, args) {
      if (!session) {
        session = open();
        session.catch(() => {
          session = null;
        });
      }
      const promise = session;
      const current = await promise;
      current.promise = promise;
      try {
        return await Promise.race([current.client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS }), current.closed]);
      } catch (error) {
        if (!current.alive && !(error instanceof ToolError)) return current.closed;
        throw error;
      }
    },
    async close() {
      const pending = session;
      session = null;
      if (pending) await pending.then((current) => ((current.alive = false), current.client.close())).catch(() => {});
    },
  };
}

export const resultText = (result) => result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");

// [{ id, name }] of the open Studio windows.
export async function listStudios(studio) {
  const result = await studio.call("list_roblox_studios", {});
  const answer = resultText(result);
  if (result.isError) throw new ToolError(`list_roblox_studios failed: ${answer}`);
  let parsed;
  try {
    parsed = JSON.parse(answer);
  } catch {
    throw new ToolError(`list_roblox_studios answered in a format the lab does not read: ${answer.slice(0, 300)}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed.studios;
  if (!Array.isArray(list)) throw new ToolError(`list_roblox_studios answered in a format the lab does not read: ${answer.slice(0, 300)}`);
  return list.map(({ id, name }) => ({ id: String(id), name: String(name ?? id) }));
}

// The Studio to act on: the one asked for, else the only one open. Several open: an error that lists them (and
// carries them as .studios, so the page can ask which).
export async function pickStudio(args, studio) {
  if (typeof args?.studio_id === "string" && args.studio_id !== "") return args.studio_id;
  const studios = await listStudios(studio);
  if (studios.length === 1) return studios[0].id;
  if (studios.length === 0) throw new ToolError("no Studio is connected: open a place in Roblox Studio (its MCP server must be on)");
  const error = new ToolError(`studio_id is required. Open studios: ${studios.map((s) => `${s.name} (${s.id})`).join(", ")}`);
  error.studios = studios;
  throw error;
}

// Long-bracket literal whose level cannot be closed by anything inside `text`, including a trailing "]".
export function longString(text) {
  let level = 0;
  const closes = (closer) => `${text}${closer}`.indexOf(closer) < text.length;
  while (closes(`]${"=".repeat(level)}]`)) level += 1;
  const eq = "=".repeat(level);
  // A newline right after [==[ is dropped by Luau, so pad one when the text starts with a newline.
  return `[${eq}[${text.startsWith("\n") || text.startsWith("\r") ? "\n" : ""}${text}]${eq}]`;
}

export const opCode = (op, args) => `${OPS_SOURCE}\nreturn run(${longString(op)}, ${longString(JSON.stringify(args))})`;

// Runs one op in the Edit DataModel and answers its JSON.
export async function runOp(studio, studioId, op, args) {
  const result = await studio.call("execute_luau", { studio_id: studioId, datamodel_type: "Edit", code: opCode(op, args) });
  const output = resultText(result);
  // Studio prefixes every Luau error with its Assistant plugin's internal call stack; keep only the message.
  if (result.isError) throw new ToolError(`execute_luau failed: ${output.replace(/^.*CommandExecution:\d+: /s, "")}`);
  return JSON.parse(output);
}
