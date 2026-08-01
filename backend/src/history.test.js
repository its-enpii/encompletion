import test from "node:test";
import assert from "node:assert/strict";
import { selectHistoryRows } from "./history.js";

test("history keeps first user turn and newest rows within budget", () => {
  const rows = [
    { role: "user", content: "opening constraint" },
    { role: "assistant", content: "reply one" },
    { role: "user", content: "middle" },
    { role: "assistant", content: "latest reply" },
  ];
  const selected = selectHistoryRows(rows, 32);
  assert.equal(selected[0].content, "opening constraint");
  assert.equal(selected.at(-1).content, "latest reply");
  assert.ok(selected.reduce((n, row) => n + row.content.length, 0) <= 32);
});
