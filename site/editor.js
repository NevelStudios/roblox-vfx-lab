// The node editor: a textarea over a highlighted copy of its text (lib/wgsl.js), a line gutter, completions as you
// type (Ctrl+Space opens them), the compiler's problems under it, Ctrl+S to save. It holds no lab logic: onSave,
// onNew and onDuplicate are the page's, and the page sends back the verdict with setProblems.
import { completions, highlightWgsl } from "./lib/wgsl.js";

const h = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== false) node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};

const LINE_PX = 18; // .code-text line-height
const PAD_PX = 8; // .code-text padding
const KIND_MARK = { helper: "ƒ", builtin: "ƒ", type: "T", keyword: "k", local: "x", param: "p", uniform: "u" };

// onDuplicate: shown on a read-only node (a hosted example) in place of Save.
export function mountEditor(container, { source, problems = [], readOnly = false, onSave, onNew, onDuplicate }) {
  let saved = source;
  const area = h("textarea", { class: "code-text", spellcheck: "false", autocomplete: "off", autocapitalize: "off", wrap: "off", readonly: readOnly });
  area.value = source;
  const layer = h("pre", { class: "code-hl", "aria-hidden": "true" });
  const popup = h("ul", { class: "code-ac", role: "listbox", hidden: true });
  const gutter = h("pre", { class: "code-gutter", "aria-hidden": "true" });
  const status = h("span", { class: "code-state" });
  const list = h("ul", { class: "msgs code-msgs" });
  const saveButton = h("button", { class: "btn primary", title: "Save (Ctrl+S)", disabled: readOnly, onclick: () => save() }, "Save");
  const newButton = h("button", {
    class: "btn",
    title: "A new node from the starter template",
    onclick: () => {
      const name = prompt("Name of the new node (folder/name, letters, digits, - and _):", "my/effect");
      if (name) onNew(name.trim());
    },
  }, "New node");
  let current = problems;
  let menu = null; // { from, items, index } while the completion list is open

  const lines = () => area.value.split("\n").length;
  function paintGutter() {
    const bad = new Set(current.filter((p) => p.type === "error" && p.line).map((p) => p.line));
    gutter.replaceChildren(...Array.from({ length: lines() }, (_, i) => h("span", { class: bad.has(i + 1) ? "bad" : "" }, `${i + 1}\n`)));
    gutter.scrollTop = area.scrollTop;
  }
  // The trailing newline keeps the layer one line taller than its text, as the textarea is.
  function paintLayer() {
    layer.innerHTML = `${highlightWgsl(area.value)}\n`;
    syncScroll();
  }
  function syncScroll() {
    layer.scrollTop = gutter.scrollTop = area.scrollTop;
    layer.scrollLeft = area.scrollLeft;
  }
  function paintStatus() {
    const [label, cls] = readOnly ? ["Read-only", ""] : area.value !== saved ? ["Unsaved", "warn-line"] : ["Saved", "ok-line"];
    status.textContent = label;
    status.className = `code-state ${cls}`;
  }
  const changed = () => (paintLayer(), paintGutter(), paintStatus());

  // ---------- completions ----------
  let charPx = 0;
  const charWidth = () => {
    if (!charPx) {
      const probe = h("span", { class: "code-probe" }, "0".repeat(40));
      area.parentElement.append(probe);
      charPx = probe.getBoundingClientRect().width / 40 || 7.2;
      probe.remove();
    }
    return charPx;
  };
  function closeMenu() {
    menu = null;
    popup.hidden = true;
  }
  function openMenu(force = false) {
    if (readOnly) return closeMenu();
    const found = completions(area.value, area.selectionStart, { force });
    if (!found) return closeMenu();
    menu = { ...found, index: 0 };
    const before = area.value.slice(0, found.from);
    const row = before.split("\n").length - 1;
    const col = found.from - (before.lastIndexOf("\n") + 1);
    popup.style.top = `${PAD_PX + (row + 1) * LINE_PX - area.scrollTop}px`;
    popup.style.left = `${Math.max(0, PAD_PX + col * charWidth() - area.scrollLeft)}px`;
    paintMenu();
    popup.hidden = false;
  }
  function paintMenu() {
    popup.replaceChildren(
      ...menu.items.slice(0, 50).map((item, i) =>
        h(
          "li",
          {
            class: i === menu.index ? "on" : "",
            role: "option",
            // mousedown, not click: a click would blur the textarea first and close the list.
            onmousedown: (event) => (event.preventDefault(), accept(i)),
          },
          h("i", { class: `ac-${item.kind}` }, KIND_MARK[item.kind] ?? "·"),
          h("b", {}, item.label),
          h("span", {}, item.detail),
        ),
      ),
    );
    popup.children[menu.index]?.scrollIntoView({ block: "nearest" });
  }
  // A function goes in with its parentheses and the caret between them.
  function accept(index) {
    const item = menu.items[index];
    const call = item.kind === "helper" || item.kind === "builtin" ? item.detail.startsWith("(") : false;
    const end = area.selectionStart;
    area.setRangeText(call ? `${item.label}()` : item.label, menu.from, end, "end");
    if (call) area.setSelectionRange(area.selectionStart - 1, area.selectionStart - 1);
    closeMenu();
    changed();
  }

  // ---------- problems and save ----------
  // The caret goes to a problem's line and column (both 1-based; line 0 is a problem of the whole node).
  function jump(problem) {
    if (!problem.line) return;
    const rows = area.value.split("\n");
    const at = rows.slice(0, problem.line - 1).reduce((n, row) => n + row.length + 1, 0) + Math.max(0, (problem.column || 1) - 1);
    area.focus();
    area.setSelectionRange(at, at);
    area.scrollTop = Math.max(0, (problem.line - 4) * LINE_PX);
    syncScroll();
  }
  function paintProblems() {
    list.replaceChildren(
      ...current.map((p) =>
        h("li", { class: p.type, title: p.line ? "Go to the line" : "", onclick: () => jump(p) }, h("span", {}, p.line ? `${p.line}:${p.column} ` : ""), p.message),
      ),
    );
    paintGutter();
  }
  async function save() {
    if (readOnly) return;
    const text = area.value;
    saveButton.disabled = true;
    // onSave answers false when the save was refused (it shows why with setProblems); the text then stays unsaved.
    try {
      if ((await onSave(text)) !== false) saved = text;
    } finally {
      saveButton.disabled = false;
      paintStatus();
    }
  }

  area.addEventListener("input", (event) => {
    changed();
    // Typing a word or a "." opens or narrows the list; anything else closes it.
    if (event.inputType?.startsWith("insert") && /[\w.]$/.test(event.data ?? "")) openMenu();
    else if (menu) openMenu();
  });
  area.addEventListener("scroll", () => (syncScroll(), closeMenu()));
  area.addEventListener("blur", closeMenu);
  area.addEventListener("click", closeMenu);
  area.addEventListener("keydown", (event) => {
    if (menu) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const count = Math.min(menu.items.length, 50);
        menu.index = (menu.index + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
        return paintMenu();
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        return accept(menu.index);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        return closeMenu();
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key === " ") {
      event.preventDefault();
      openMenu(true);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    } else if (event.key === "Tab" && !event.shiftKey && !readOnly) {
      event.preventDefault();
      area.setRangeText("  ", area.selectionStart, area.selectionEnd, "end");
      changed();
    }
  });

  container.replaceChildren(
    h(
      "div",
      { class: "code-bar" },
      status,
      h("div", { class: "actions" }, newButton, readOnly && onDuplicate ? h("button", { class: "btn primary", title: "An editable copy of this example", onclick: () => onDuplicate() }, "Duplicate") : saveButton),
    ),
    h("div", { class: "code-body" }, gutter, h("div", { class: "code-edit" }, layer, area, popup)),
    list,
  );
  paintLayer();
  paintProblems();
  paintStatus();

  return {
    // A change from elsewhere (the AI, another page) replaces the text only while the developer has no unsaved edit.
    // Answers whether it did: with an unsaved edit, the page keeps the old hash, so a save of it is refused as stale.
    setSource(next) {
      if (area.value !== saved) return false;
      area.value = saved = next;
      changed();
      return true;
    },
    setProblems(next) {
      current = next;
      paintProblems();
    },
  };
}
