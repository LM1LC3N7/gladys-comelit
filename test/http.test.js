// The HTTP transport against a server on the loopback interface (never
// leaves the machine): the veto right before the write, the bounded answer,
// "sent or not" on errors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ComelitError, nodeTransport } from '../src/http.js';

async function server(t, handler) {
  const seen = [];
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, cookie: req.headers.cookie });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  t.after(() => s.close());
  return { port: s.address().port, seen };
}

const base = (port) => ({ host: '127.0.0.1', port, method: 'GET', path: '/x', timeout: 1000 });

test('an answer, its status and cookies; the body posted', async (t) => {
  const { port, seen } = await server(t, (req, res) => {
    res.setHeader('Set-Cookie', ['uid=abc; path=/']);
    res.end('{"ok":1}');
  });
  const res = await nodeTransport({
    ...base(port),
    method: 'POST',
    body: 'dom=1234',
    headers: { Cookie: 'a=b' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.text, '{"ok":1}');
  assert.deepEqual(res.headers['set-cookie'], ['uid=abc; path=/']);
  assert.deepEqual(seen, [{ method: 'POST', url: '/x', body: 'dom=1234', cookie: 'a=b' }]);
});

test('a veto right before the write: nothing reaches the server', async (t) => {
  const { port, seen } = await server(t, (req, res) => res.end('ok'));
  const veto = new ComelitError('withdrawn', 'withdrawn');
  const err = await nodeTransport({ ...base(port), beforeSend: () => veto }).catch((e) => e);
  assert.equal(err, veto);
  assert.equal(err.sent, false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.length, 0);
});

test('a refused connection was not sent; a silent server was', async (t) => {
  const { port } = await server(t, () => {});
  const silent = await nodeTransport({ ...base(port), timeout: 100 }).catch((e) => e);
  assert.equal(silent.kind, 'timeout');
  assert.equal(silent.sent, true);
  const closed = await new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const refused = await nodeTransport({ ...base(closed) }).catch((e) => e);
  assert.equal(refused.kind, 'offline');
  assert.equal(refused.sent, false);
});

test('an answer over the limit is cut', async (t) => {
  const { port } = await server(t, (req, res) => res.end('x'.repeat(5000)));
  const err = await nodeTransport({ ...base(port), maxBody: 1000 }).catch((e) => e);
  assert.equal(err.kind, 'answer');
  assert.equal(err.sent, true);
});
