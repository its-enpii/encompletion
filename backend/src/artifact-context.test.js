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

test("artifact manifest displays version numbers for revised files", () => {
  const out = formatArtifactManifest([
    { id: 9, title: "src/app.js", type: "code", language: "javascript", version: 2, content: "export default 2;" },
  ]);
  assert.match(out, /src\/app\.js v2/);
});
