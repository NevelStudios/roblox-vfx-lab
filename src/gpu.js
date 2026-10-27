// GPU side of the VFX lab: Dawn (the webgpu package) in a child process. Dawn prints validation errors on fd 1,
// which would corrupt the MCP stream, and a runaway shader can hang or crash the device: the child keeps both away
// from the server. The server talks to it over IPC (advanced serialization, so typed arrays cross whole).
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolError } from "./core.js";

const WORKER_FLAG = "--vfx-gpu-worker";
const CALL_TIMEOUT_MS = 60_000;
const SELF = fileURLToPath(import.meta.url);

// ---------- server side ----------

let child;
let nextId = 0;
const pending = new Map();

function failAll(message) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(new ToolError(message));
  }
  pending.clear();
}

function worker() {
  if (child) return child;
  // execArgv: []: flags meant for the parent (--input-type, --test) break a plain module child.
  child = fork(SELF, [WORKER_FLAG], { stdio: ["ignore", "pipe", "inherit", "ipc"], serialization: "advanced", execArgv: [] });
  child.stdout.pipe(process.stderr);
  child.on("message", ({ id, ok, value, error }) => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    clearTimeout(call.timer);
    if (ok) call.resolve(value);
    else call.reject(new ToolError(error));
  });
  child.on("exit", (code, signal) => {
    child = undefined;
    failAll(`GPU worker exited (${signal ?? code}); the next call starts a new one`);
  });
  child.unref();
  child.channel?.unref();
  return child;
}

function call(op, args) {
  const proc = worker();
  const id = (nextId += 1);
  return new Promise((resolve, reject) => {
    // A shader that never finishes would hold the device: kill the worker so the next call starts clean.
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new ToolError(`GPU ${op} took over ${CALL_TIMEOUT_MS / 1000}s; the worker was stopped`));
      proc.kill();
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    proc.send({ id, op, args });
  });
}

// compile(code) -> [{ type, line, column, message }] (empty when the module and the pipeline are valid).
// render({ code, width, height, cells: [{ rect: [x, y, w, h], uniforms: Float32Array }] })
//   -> Uint8Array of straight RGBA (RGB 0 where alpha is 0), row-major, top row first.
export const gpu = {
  compile: (code) => call("compile", { code }),
  render: (job) => call("render", job),
};

// ---------- worker side ----------

const SLOT_BYTES = 512; // per cell: VfxFrame at +0, VfxParams at +256 (uniform offsets align to 256)

async function startWorker() {
  const { create, globals } = await import("webgpu");
  const { GPUBufferUsage, GPUTextureUsage, GPUMapMode } = globals;
  // The instance must outlive every adapter and device: once it is collected, Dawn frees them under us (a 0xC0000005).
  const instance = create([]);
  let devicePromise;

  function device() {
    devicePromise ??= (async () => {
      const adapter = await instance.requestAdapter();
      if (!adapter) throw new Error("no GPU adapter: Dawn found no D3D12, Vulkan or Metal device");
      const dev = await adapter.requestDevice();
      dev.lost.then(() => {
        devicePromise = undefined;
      });
      return dev;
    })();
    return devicePromise;
  }

  // Error scopes keep Dawn from printing; every create call goes through one.
  async function scoped(dev, build) {
    dev.pushErrorScope("validation");
    const value = build();
    const error = await dev.popErrorScope();
    return { value, error };
  }

  const pipelines = new Map();

  async function pipelineFor(dev, code) {
    if (pipelines.has(code)) return { pipeline: pipelines.get(code), messages: [] };
    const { value: module } = await scoped(dev, () => dev.createShaderModule({ code }));
    const info = await module.getCompilationInfo();
    const messages = info.messages.map((m) => ({ type: m.type, line: m.lineNum, column: m.linePos, message: m.message }));
    if (messages.some((m) => m.type === "error")) return { pipeline: null, messages };
    const { value: pipeline, error } = await scoped(dev, () =>
      dev.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vfx_vs" },
        // Straight 8-bit RGBA straight from the GPU: no float readback, no un-premultiply pass on the CPU.
        fragment: { module, entryPoint: "vfx_fs_straight", targets: [{ format: "rgba8unorm" }] },
        primitive: { topology: "triangle-list" },
      }),
    );
    if (error) return { pipeline: null, messages: [...messages, { type: "error", line: 0, column: 0, message: error.message }] };
    if (pipelines.size > 32) pipelines.clear();
    pipelines.set(code, pipeline);
    return { pipeline, messages };
  }

  async function compile({ code }) {
    return (await pipelineFor(await device(), code)).messages;
  }

  async function render({ code, width, height, cells }) {
    const dev = await device();
    const { pipeline, messages } = await pipelineFor(dev, code);
    if (!pipeline) throw new Error(`shader does not compile: ${messages.map((m) => `${m.line}:${m.column} ${m.message}`).join("; ")}`);
    const uniforms = new Uint8Array(cells.length * SLOT_BYTES);
    cells.forEach((cell, index) => uniforms.set(new Uint8Array(cell.uniforms.buffer, cell.uniforms.byteOffset, cell.uniforms.byteLength), index * SLOT_BYTES));
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const { value: resources, error } = await scoped(dev, () => {
      const buffer = dev.createBuffer({ size: uniforms.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(buffer, 0, uniforms);
      const texture = dev.createTexture({ size: [width, height], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const readback = dev.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const layout = pipeline.getBindGroupLayout(0);
      const groups = cells.map((_, index) =>
        dev.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { buffer, offset: index * SLOT_BYTES, size: 48 } },
            { binding: 1, resource: { buffer, offset: index * SLOT_BYTES + 256, size: 256 } },
          ],
        }),
      );
      const encoder = dev.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }] });
      pass.setPipeline(pipeline);
      cells.forEach((cell, index) => {
        const [x, y, w, h] = cell.rect;
        pass.setViewport(x, y, w, h, 0, 1);
        pass.setScissorRect(x, y, w, h);
        pass.setBindGroup(0, groups[index]);
        pass.draw(3);
      });
      pass.end();
      encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow }, [width, height]);
      dev.queue.submit([encoder.finish()]);
      return { buffer, texture, readback };
    });
    if (error) throw new Error(`render failed: ${error.message}`);
    await resources.readback.mapAsync(GPUMapMode.READ);
    const raw = new Uint8Array(resources.readback.getMappedRange());
    const out = new Uint8Array(width * height * 4);
    if (bytesPerRow === width * 4) out.set(raw);
    else for (let y = 0; y < height; y += 1) out.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    resources.readback.unmap();
    for (const resource of Object.values(resources)) resource.destroy();
    return out;
  }

  const OPS = { compile, render };
  process.on("message", async ({ id, op, args }) => {
    try {
      process.send({ id, ok: true, value: await OPS[op](args) });
    } catch (error) {
      process.send({ id, ok: false, error: error.message });
    }
  });
}

if (process.argv.includes(WORKER_FLAG) && path.resolve(process.argv[1] ?? "") === SELF) {
  startWorker().catch((error) => {
    console.error("[vfx-gpu] worker failed to start:", error);
    process.exit(1);
  });
}
