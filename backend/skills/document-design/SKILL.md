---
description: Design and build visually rich PDF, PowerPoint, Word, Excel, HTML, SVG, PNG, or JPEG deliverables with BuildDocument. Use when the user asks for a polished document, deck, report, workbook, dashboard, brochure, proposal, or branded visual output.
---

# Document Design

Use `BuildDocument` when visual quality, custom layout, editability, branding, charts, or illustrations matter. Use the simpler `CreateDocument` only for quick plain reports, tables, or bullet decks.

## Workflow

1. Inspect the request and choose the format:
   - PDF: `pdfkit`, or create HTML/SVG and embed/render it when suitable.
   - PPTX: `pptxgenjs`; keep important text and charts native when editability matters.
   - DOCX: `docx`.
   - XLSX: `xlsx`.
   - SVG/HTML: author directly. Prefer SVG when a scalable visual asset is sufficient.
2. Use `Read`/`Glob` to inspect any previous generator source before revising.
3. Write a reusable generator such as `documents/<name>/build.mjs` plus local assets/data.
4. Create a deliberate visual system: palette, typography, spacing, grid, hierarchy, and repeated components.
5. Vary layout according to content. Do not force every page or slide into the same title-and-bullets pattern.
6. Run `BuildDocument` with every final output. If it returns an error, fix the source and run again.
7. Keep the same output path/title when revising so the application records a new artifact version.

## Design Rules

- Prefer visual hierarchy and whitespace over dense text.
- Convert important numbers into charts, comparison blocks, timelines, or KPI cards.
- Keep slides focused on one idea; split overloaded slides.
- Use shapes, SVG, and generated diagrams instead of decorative clutter.
- Ensure readable contrast and safe margins.
- Do not fetch remote assets during the build. Create SVG locally or use user-provided workspace assets.
- Do not write outside the session workspace or spawn commands.

## BuildDocument Example

```json
{
  "entrypoint": "documents/strategy/build.mjs",
  "outputs": [
    { "path": "documents/strategy/strategy.pptx", "title": "strategy.pptx" },
    { "path": "documents/strategy/strategy.pdf", "title": "strategy.pdf" }
  ]
}
```

Publish only final outputs. Generator source stays in the workspace so later revisions can edit and rebuild it.
