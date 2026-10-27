// The Export panel of a bake: its files, the Roblox properties to set by hand, and (on the lab server) Export to
// Roblox, which uploads the sheet through Roblox's Studio MCP and puts it on what is selected in Studio.
import { propertiesLuau, textureProperties } from "./lib/core.js";

const h = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== false) node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};

const fileName = (name, ext) => `${name.replaceAll("/", "-")}.${ext}`;

function save(href, download) {
  const link = h("a", { href, download });
  document.body.append(link);
  link.click();
  link.remove();
}

const flash = (button, label) => {
  const before = button.textContent;
  button.textContent = label;
  button.classList.add("done");
  setTimeout(() => {
    button.textContent = before;
    button.classList.remove("done");
  }, 1100);
};

export const UPLOAD_WARNING =
  "Upload this sheet to Roblox?\n\nThe image becomes a public asset on the account that is signed in to Studio. Roblox moderates it, and an upload cannot be undone.";

// bake: the recipe plus its name. uri: the texture's asset id when one is known (an earlier upload).
export function exportPanel({ backend, bake, uri }) {
  const known = uri ?? bake.uploads?.find((u) => u.pngSha === bake.pngSha && u.assetId)?.assetId;
  const texture = known ? (String(known).startsWith("rbx") ? known : `rbxassetid://${known}`) : "rbxassetid://<id after upload>";
  const code = propertiesLuau(textureProperties("ParticleEmitter", bake, texture));
  const result = h("div", { class: "export-result" });

  const exportButton = backend.exportToRoblox
    ? h("button", { class: "btn primary", title: "Upload through Roblox's Studio MCP and apply it to the selection", onclick: () => run() }, "Export to Roblox")
    : null;

  async function run(studioId) {
    if (!studioId && !confirm(UPLOAD_WARNING)) return;
    exportButton.disabled = true;
    result.className = "export-result";
    result.textContent = "Uploading…";
    try {
      const answer = await backend.exportToRoblox(bake.name, studioId);
      const where = answer.created?.length
        ? `Made ${answer.created.join(", ")}.`
        : `Applied to ${answer.applied?.reduce((n, a) => n + a.paths.length, 0) ?? 0} selected instance(s).`;
      result.className = "export-result ok-line";
      result.replaceChildren(`rbxassetid://${answer.assetId}${answer.reused ? " (already uploaded)" : ""}. ${where}`);
    } catch (error) {
      result.className = "export-result bad-line";
      result.replaceChildren(error.message);
      // Several Studios are open: the developer picks one, and the export runs again on it.
      if (error.studios?.length) {
        const pick = h("select", {}, error.studios.map((s) => h("option", { value: s.id }, s.name ?? s.id)));
        result.append(h("div", { class: "actions" }, pick, h("button", { class: "btn", onclick: () => run(pick.value) }, "Export there")));
      }
    } finally {
      exportButton.disabled = false;
    }
  }

  const copy = h("button", { class: "btn", onclick: (event) => navigator.clipboard.writeText(code).then(() => flash(event.target, "Copied")) }, "Copy");
  return h(
    "div",
    {},
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn", onclick: async () => save(await backend.sheetUrl(bake.name, bake), fileName(bake.name, "png")) }, "Download PNG"),
      h("button", {
        class: "btn",
        onclick: () => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(bake, null, 2)], { type: "application/json" }));
          save(url, fileName(bake.name, "json"));
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        },
      }, "Download recipe"),
    ),
    h("pre", { class: "luau" }, code),
    h("div", { class: "actions" }, copy, exportButton),
    backend.exportToRoblox ? null : h("p", { class: "empty" }, "Export to Roblox runs from the MCP's own page (npx roblox-vfx-lab). Here, download the PNG and upload it in Studio."),
    result,
  );
}
