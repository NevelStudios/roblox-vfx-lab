import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("../site", import.meta.url));
const read = (file) => fs.readFileSync(path.join(SITE, file), "utf8");
const scripts = () => fs.readdirSync(SITE).filter((f) => f.endsWith(".js"));

test("site files use relative URLs only, so the page works under any path", () => {
  for (const file of [...scripts(), "index.html"]) {
    const text = read(file);
    assert.doesNotMatch(text, /fetch\(\s*["'`]\//, `${file}: fetch of an absolute path`);
    assert.doesNotMatch(text, /from\s+["']\//, `${file}: absolute import`);
    assert.doesNotMatch(text, /src=["']\//, `${file}: absolute src`);
    assert.doesNotMatch(text, /href=["']\/[^/]/, `${file}: absolute href`);
  }
});

test("app.js reaches the library only through the backend", () => {
  const app = read("app.js");
  assert.doesNotMatch(app, /\bfetch\(/);
  assert.doesNotMatch(app, /EventSource/);
  assert.match(app, /createLocalBackend/);
});

test("site modules import the lab only from ./lib/", () => {
  for (const file of scripts()) {
    for (const [, spec] of read(file).matchAll(/from\s+["']([^"']+)["']/g)) {
      assert.ok(spec.startsWith("./"), `${file} imports ${spec}`);
      if (/core|pixels|bake\.js|wgsl\.js/.test(spec) && !spec.startsWith("./backend")) assert.match(spec, /^\.\/lib\/(core|pixels|bake|wgsl)\.js$/, `${file} imports ${spec}`);
    }
  }
});
