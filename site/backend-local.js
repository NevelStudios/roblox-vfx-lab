// The library on disk, through the lab server the MCP starts (src/server.js). Every write is a POST that only this
// page's own origin may send. null when no lab server answers: the page then runs in the browser (backend-hosted.js).
const asJson = async (response) => {
  const answer = await response.json().catch(() => ({ error: `the lab server answered ${response.status}` }));
  if (!response.ok) {
    const error = new Error(answer.error ?? `the lab server answered ${response.status}`);
    if (answer.studios) error.studios = answer.studios;
    throw error;
  }
  return answer;
};

const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(asJson);

// The lab server listens on loopback only, so a page from anywhere else (GitHub Pages) skips the probe and its 404.
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

export async function createLocalBackend(base = "./") {
  if (!LOOPBACK.includes(location.hostname)) return null;
  let first;
  try {
    const response = await fetch(`${base}api/library`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json")) return null;
    first = await response.json();
  } catch {
    return null;
  }
  if (!Array.isArray(first?.nodes)) return null;
  let cached = first;
  const q = (name) => `name=${encodeURIComponent(name)}`;
  return {
    mode: "local",
    persistent: true,
    location: first.library,
    async listing() {
      if (cached) {
        const listing = cached;
        cached = null;
        return listing;
      }
      return asJson(await fetch(`${base}api/library`));
    },
    async node(name) {
      const response = await fetch(`${base}api/node?${q(name)}`);
      return response.ok ? response.json() : null;
    },
    saveNode: ({ name, source, replaces }) => post(`${base}api/node`, { name, source, replaces }),
    async recipe(name) {
      const response = await fetch(`${base}api/bake?${q(name)}`);
      return response.ok ? response.json() : null;
    },
    sheetUrl: async (name, recipe) => `${base}api/bake.png?${q(name)}&v=${recipe?.pngSha ?? ""}`,
    bake: (call) => post(`${base}api/bake`, call),
    remove: ({ kind, name }) => post(`${base}api/delete`, { kind, name }),
    exportToRoblox: (bake, studioId) => post(`${base}api/export`, { bake, ...(studioId ? { studio_id: studioId } : {}) }),
    // Changes from fs.watch (the AI's writes, other pages), and the connection state for the header.
    subscribe(onChange, onStatus) {
      const events = new EventSource(`${base}api/events`);
      events.onopen = () => onStatus(true);
      events.onerror = () => onStatus(false);
      events.addEventListener("change", (event) => onChange(JSON.parse(event.data)));
    },
  };
}
