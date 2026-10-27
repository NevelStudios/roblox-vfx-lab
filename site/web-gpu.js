// The bake's GPU interface (see lib/bake.js) on the browser's own WebGPU device: the same two calls as the MCP's Dawn
// worker (src/gpu.js), so a sheet baked here comes from the same shader, format and uniform layout.
const SLOT_BYTES = 512; // per cell: VfxFrame at +0, VfxParams at +256 (uniform offsets align to 256)

export function createWebGpu(device) {
  const pipelines = new Map();

  async function scoped(build) {
    device.pushErrorScope("validation");
    const value = build();
    const error = await device.popErrorScope();
    return { value, error };
  }

  async function pipelineFor(code) {
    if (pipelines.has(code)) return { pipeline: pipelines.get(code), messages: [] };
    const { value: module } = await scoped(() => device.createShaderModule({ code }));
    const info = await module.getCompilationInfo();
    const messages = info.messages.map((m) => ({ type: m.type, line: m.lineNum, column: m.linePos, message: m.message }));
    if (messages.some((m) => m.type === "error")) return { pipeline: null, messages };
    const { value: pipeline, error } = await scoped(() =>
      device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vfx_vs" },
        fragment: { module, entryPoint: "vfx_fs_straight", targets: [{ format: "rgba8unorm" }] },
        primitive: { topology: "triangle-list" },
      }),
    );
    if (error) return { pipeline: null, messages: [...messages, { type: "error", line: 0, column: 0, message: error.message }] };
    if (pipelines.size > 32) pipelines.clear();
    pipelines.set(code, pipeline);
    return { pipeline, messages };
  }

  async function render({ code, width, height, cells }) {
    const { pipeline, messages } = await pipelineFor(code);
    if (!pipeline) throw new Error(`shader does not compile: ${messages.map((m) => `${m.line}:${m.column} ${m.message}`).join("; ")}`);
    const uniforms = new Uint8Array(cells.length * SLOT_BYTES);
    cells.forEach((cell, index) => uniforms.set(new Uint8Array(cell.uniforms.buffer, cell.uniforms.byteOffset, cell.uniforms.byteLength), index * SLOT_BYTES));
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const { value: resources, error } = await scoped(() => {
      const buffer = device.createBuffer({ size: uniforms.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, uniforms);
      const texture = device.createTexture({ size: [width, height], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const readback = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const layout = pipeline.getBindGroupLayout(0);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }] });
      pass.setPipeline(pipeline);
      cells.forEach((cell, index) => {
        const [x, y, w, h] = cell.rect;
        pass.setViewport(x, y, w, h, 0, 1);
        pass.setScissorRect(x, y, w, h);
        pass.setBindGroup(
          0,
          device.createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: { buffer, offset: index * SLOT_BYTES, size: 48 } },
              { binding: 1, resource: { buffer, offset: index * SLOT_BYTES + 256, size: 256 } },
            ],
          }),
        );
        pass.draw(3);
      });
      pass.end();
      encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow }, [width, height]);
      device.queue.submit([encoder.finish()]);
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

  return { compile: async (code) => (await pipelineFor(code)).messages, render };
}
