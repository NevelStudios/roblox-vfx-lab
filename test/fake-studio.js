// A stand-in for Roblox's Studio MCP: the four tools the lab calls, with every call recorded.
//   studios: [{ id, name }] that list_roblox_studios answers
//   luau(op, payload): the answer object for one studio-ops.luau op
export const opOf = (code) => /return run\(\[=*\[(\w+)\]/.exec(code)[1];
export const payloadOf = (code) => JSON.parse(/, \[(=*)\[([\s\S]*)\]\1\]\)$/.exec(code)[2]);

const textResult = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

export function fakeStudio({ studios = [{ id: "s1", name: "Place1" }], luau = () => ({}) } = {}) {
  const studio = {
    calls: [],
    uploads: [],
    ops: [],
    async call(name, args) {
      studio.calls.push([name, args]);
      if (name === "list_roblox_studios") return textResult(studios);
      if (name === "upload_image") {
        const response = await fetch(args.imagePaths[0]);
        studio.uploads.push(Buffer.from(await response.arrayBuffer()));
        return textResult({ [args.imagePaths[0]]: "rbxassetid://987" });
      }
      if (name === "screen_capture") return { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "ok" }] };
      if (name === "execute_luau") {
        const op = opOf(args.code);
        const payload = payloadOf(args.code);
        studio.ops.push([op, payload]);
        return textResult(luau(op, payload));
      }
      throw new Error(`fake studio has no tool ${name}`);
    },
    close() {},
  };
  return studio;
}
