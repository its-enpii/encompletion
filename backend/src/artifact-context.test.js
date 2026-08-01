import test from "node:test";
import assert from "node:assert/strict";
import { formatArtifactManifest } from "./artifact-context.js";

test("artifact manifest is bounded and includes readable IDs", () => {
  const out = formatArtifactManifest([
    { id: 7, title: "login.html", type: "html", language: null, content: "<main>ok</main>" },
  ]);
  assert.match(out, /#7 login\.html/);
  assert.match(out, /ReadArtifact/);
});
