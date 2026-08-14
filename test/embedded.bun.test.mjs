import { test } from "bun:test";
import assert from "node:assert/strict";
import { runApiCheck, runEmbeddedCheck, runV012Check } from "./basic-check.mjs";

test("embedded put/get, retrieval, atlas, and orbit helpers", () => {
  runEmbeddedCheck(assert);
});

test("id helpers and typed errors", () => {
  runApiCheck(assert);
});

test("v0.12 CRUD, maintenance, metrics, and checkpoints", () => {
  runV012Check(assert);
});
