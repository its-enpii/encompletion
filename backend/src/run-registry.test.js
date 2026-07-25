/**
 * Registry fan-out test — verifies the one-load-runner, many-subscriber
 * model that SSE multi-tab sync depends on. Uses a hand-rolled FakeRes
 * so we don't need Express or HTTP plumbing.
 *
 * Run: node --test backend/src/run-registry.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import registry from './run-registry.js';

class FakeRes extends Writable {
  written = [];
  ended = false;
  headers = {};
  statusCode = 200;
  _write(chunk, _enc, cb) { this.written.push(chunk.toString()); cb(); }
  setHeader(k, v) { this.headers[k] = v; }
  flushHeaders() {}
  status(code) { this.statusCode = code; return this; }
  json(obj) { this.jsonBody = obj; this.end(); return this; }
  end() { this.ended = true; }
  write(s) { this.written.push(s); return true; }
}

class FakeReq extends EventEmitter {
  constructor() { super(); this.headers = {}; }
}

test('emit fans out to every active subscriber', () => {
  const runId = registry.create({ sessionId: 1, userId: 7 });
  const fakeRunner = new EventEmitter();
  registry.attachRunner(runId, fakeRunner, { kill() {} });

  const a = new FakeRes();
  const b = new FakeRes();
  registry.subscribe(runId, new FakeReq(), a);
  registry.subscribe(runId, new FakeReq(), b);

  registry.emit(runId, 'text', { sessionId: 1, text: 'halo' });

  assert.equal(a.written.length, 2); // ": open" + frame
  assert.equal(b.written.length, 2);
  assert.match(a.written[1], /event: text\ndata: \{"sessionId":1,"text":"halo"\}\n\n/);
  assert.match(b.written[1], /event: text\ndata: \{"sessionId":1,"text":"halo"\}\n\n/);
  registry.end(runId, { immediate: true });
});

test('keepalive comment is written on subscribe', () => {
  const runId = registry.create({ sessionId: 1, userId: 7 });
  registry.attachRunner(runId, new EventEmitter(), { kill() {} });
  const r = new FakeRes();
  registry.subscribe(runId, new FakeReq(), r);
  assert.ok(r.written.some((line) => line.startsWith(': open')));
  registry.end(runId, { immediate: true });
});

test('stop requires ownership', () => {
  const runId = registry.create({ sessionId: 1, userId: 7 });
  registry.attachRunner(runId, new EventEmitter(), { kill() {} });
  assert.equal(registry.stop(runId, 7), true);
  assert.equal(registry.stop(runId, 99), false); // wrong user
  assert.equal(registry.stop(runId, 7), true);  // idempotent
});

test('stop calls kill on the controller', () => {
  const runId = registry.create({ sessionId: 1, userId: 7 });
  let killed = 0;
  registry.attachRunner(runId, new EventEmitter(), { kill() { killed++; } });
  registry.stop(runId, 7);
  assert.equal(killed, 1);
});

test('end closes subscribers and emits closing comment', () => {
  const runId = registry.create({ sessionId: 1, userId: 7 });
  registry.attachRunner(runId, new EventEmitter(), { kill() {} });
  const r = new FakeRes();
  registry.subscribe(runId, new FakeReq(), r);
  registry.end(runId, { immediate: true });
  assert.ok(r.ended);
  assert.ok(r.written.some((line) => line.startsWith(': end')));
});

test('subscribe after end returns false (404 path)', () => {
  const runId = registry.create({ sessionId: 1, userId: 7 });
  registry.attachRunner(runId, new EventEmitter(), { kill() {} });
  registry.end(runId, { immediate: true });
  const r = new FakeRes();
  const ok = registry.subscribe(runId, new FakeReq(), r);
  assert.equal(ok, false);
  assert.equal(r.statusCode, 404);
});

test('emit after end is silently dropped', () => {
  const runId = registry.create({ sessionId: 1, userId: 7 });
  registry.attachRunner(runId, new EventEmitter(), { kill() {} });
  registry.end(runId, { immediate: true });
  // Should not throw, should not write to anyone.
  registry.emit(runId, 'text', { text: 'late' });
});

test('req close removes the subscriber', () => {
  const runId = registry.create({ sessionId: 1, userId: 7 });
  registry.attachRunner(runId, new EventEmitter(), { kill() {} });
  const req = new FakeReq();
  const a = new FakeRes();
  const b = new FakeRes();
  registry.subscribe(runId, req, a);
  registry.subscribe(runId, new FakeReq(), b);

  // Simulate client disconnect on a's request.
  req.emit('close');

  registry.emit(runId, 'text', { text: 'after-close' });
  // a's written should not include the new frame (only initial ": open").
  assert.equal(a.written.length, 1);
  // b still gets it.
  assert.equal(b.written.length, 2);
  registry.end(runId, { immediate: true });
});
