import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function frontendSources(directory) {
  const sources = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) sources.push(...(await frontendSources(filename)));
    else if (/\.(?:html|[cm]?js)$/.test(entry.name)) sources.push(filename);
  }
  return sources;
}

test("all app-owned pages use in-app modals instead of native browser questions", async () => {
  const root = fileURLToPath(new URL("../public/", import.meta.url));
  const nativeQuestion = /\b(?:alert|confirm|prompt)\s*(?:\?\.)?\s*\(/;
  for (const filename of await frontendSources(root)) {
    assert.doesNotMatch(
      await readFile(filename, "utf8"),
      nativeQuestion,
      `${path.relative(root, filename)} must not call native browser alert/confirm/prompt`,
    );
  }
});
