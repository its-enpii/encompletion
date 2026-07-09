import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "test-skill-src");
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(root, "examples"), { recursive: true });
fs.writeFileSync(path.join(root, "SKILL.md"),
  `---\ndescription: Demo skill with supporting files\n---\n\n# Demo\n\nSee \\`examples/sample.md\\` and \\`scripts/hello.sh\\`.\n`);
fs.writeFileSync(path.join(root, "examples", "sample.md"),
  `# Sample output\n\nThis is an example markdown file.\n`);
fs.writeFileSync(path.join(root, "scripts", "hello.sh"),
  `#!/bin/sh\necho "hello from skill"\n`);

// Build a zip manually with zlib (STORED method) since alpine has no `zip` binary.
// We use a tiny pure-JS writer. To keep this simple we shell out to a small
// Python helper bundled with the alpine image.
console.log("src:", root);
