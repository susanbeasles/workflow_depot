// Callers' Actions policy allows only actions owned by susanbeasles or created by GitHub,
// pinned to a full SHA. A workflow that references anything else fails at startup in every
// caller (startup_failure, no jobs run), so the depot must never ship one.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const ALLOWED_OWNERS = new Set(["actions", "github", "susanbeasles"]);

function* yamlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* yamlFiles(p);
    else if (/\.ya?ml$/.test(name)) yield p;
  }
}

test("live workflows and actions use only owner or GitHub actions, SHA-pinned", () => {
  const files = [...yamlFiles(path.join(root, ".github")), path.join(root, "pipeline/pipeline.yml")];
  const bad = [];
  for (const file of files) {
    for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
      const m = /^\s*-?\s*uses:\s*["']?([^"'\s#]+)/.exec(line);
      if (!m || m[1].startsWith("./")) continue;
      if (m[1].startsWith("docker://")) { bad.push(`${path.relative(root, file)}:${i + 1} ${m[1]} (container actions are not allowed)`); continue; }
      const ref = m[1];
      const owner = ref.split("/")[0];
      const pinned = /@[0-9a-f]{40}$/.test(ref);
      if (!ALLOWED_OWNERS.has(owner) || !pinned) bad.push(`${path.relative(root, file)}:${i + 1} ${ref}`);
    }
  }
  assert.deepEqual(bad, []);
});
