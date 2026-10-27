// The hosted lab's storage: two IndexedDB stores, "nodes" and "bakes". A window where IndexedDB is blocked (some
// private windows) gets a kv in memory: the lab still works there, it only forgets on reload (persistent: false).
const STORES = ["nodes", "bakes"];

export function memoryKv(persistent = false) {
  const stores = Object.fromEntries(STORES.map((name) => [name, new Map()]));
  return {
    persistent,
    get: async (store, key) => stores[store].get(key),
    put: async (store, key, value) => void stores[store].set(key, value),
    keys: async (store) => [...stores[store].keys()],
    delete: async (store, key) => void stores[store].delete(key),
  };
}

const done = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export async function openKv(name = "roblox-vfx-lab") {
  let db;
  try {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => STORES.forEach((store) => request.result.createObjectStore(store));
    db = await done(request);
  } catch (error) {
    console.error("[roblox-vfx-lab] IndexedDB is blocked in this window; nodes and bakes stay in memory until reload:", error);
    return memoryKv(false);
  }
  const run = (store, mode, act) => done(act(db.transaction(store, mode).objectStore(store)));
  return {
    persistent: true,
    get: (store, key) => run(store, "readonly", (s) => s.get(key)),
    put: (store, key, value) => run(store, "readwrite", (s) => s.put(value, key)).then(() => undefined),
    keys: (store) => run(store, "readonly", (s) => s.getAllKeys()),
    delete: (store, key) => run(store, "readwrite", (s) => s.delete(key)).then(() => undefined),
  };
}
