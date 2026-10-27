// The example gallery: one card per example, its baked sheet playing as Roblox plays it, with Open and the files to
// download. It plays PNGs on a 2D canvas, so it works in a browser without WebGPU too.
const h = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== false) node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};

export async function loadExamples(base = "./") {
  const response = await fetch(`${base}examples/index.json`);
  if (!response.ok) throw new Error(`examples/index.json answered ${response.status}`);
  return response.json();
}

// The cell Roblox shows t seconds in: a Loop at frames / duration fps (30 at most), a OneShot over its lifetime plus a
// short hold before it starts again.
export function galleryFrame(entry, t) {
  if (entry.grid <= 1) return 0;
  if (entry.mode === "loop") return Math.floor(t * Math.min(30, entry.frames / entry.duration)) % entry.frames;
  return Math.min(entry.frames - 1, Math.floor(((t % (entry.duration + 0.35)) / entry.duration) * entry.frames));
}

let running = 0;

export function renderGallery(container, examples, { onOpen, baseUrl = "./" }) {
  cancelAnimationFrame(running);
  const cards = examples.map((entry) => {
    const canvas = h("canvas", { width: 256, height: 256 });
    const image = new Image();
    image.src = `${baseUrl}${entry.png}`;
    const settings = Object.entries(entry.settings ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ");
    const card = h(
      "article",
      { class: "card" },
      h("div", { class: "card-stage bd-checker" }, canvas),
      h("h2", {}, entry.title),
      h("div", { class: "card-name mono" }, entry.name),
      h("p", {}, entry.description),
      h("div", { class: "card-tags" }, entry.grid > 1 ? `${entry.grid}x${entry.grid} · ${entry.mode} · ${entry.duration}s` : "still", ` · ${entry.target}`, settings ? ` · ${settings}` : ""),
      h(
        "div",
        { class: "actions" },
        h("button", { class: "btn primary", onclick: () => onOpen(entry.name) }, "Open"),
        h("a", { class: "btn", href: `${baseUrl}${entry.png}`, download: `${entry.name.replaceAll("/", "-")}.png` }, "PNG"),
        h("a", { class: "btn", href: `${baseUrl}${entry.wgsl}`, download: `${entry.node.replaceAll("/", "-")}.wgsl` }, "WGSL"),
      ),
    );
    return { entry, canvas, ctx: canvas.getContext("2d"), image, card, last: -1 };
  });
  container.replaceChildren(h("div", { class: "cards" }, cards.map((c) => c.card)));

  const started = performance.now();
  const tick = (now) => {
    if (container.hidden || !container.isConnected) return;
    const t = (now - started) / 1000;
    for (const card of cards) {
      const { entry, image, ctx, canvas } = card;
      if (!image.complete || image.naturalWidth === 0) continue;
      const frame = galleryFrame(entry, t);
      if (frame === card.last) continue;
      card.last = frame;
      const cell = image.naturalWidth / entry.grid;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, (frame % entry.grid) * cell, Math.floor(frame / entry.grid) * cell, cell, cell, 0, 0, canvas.width, canvas.height);
    }
    running = requestAnimationFrame(tick);
  };
  running = requestAnimationFrame(tick);
}
