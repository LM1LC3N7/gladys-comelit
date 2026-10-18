// -----------------------------------------------------------------------------
// One plain HTTP request on the local network (the bridge and the Vedo speak
// HTTP only), on node:http, with:
// - a new TCP connection per request (no keep-alive, as aiocomelit's test
//   script uses), so "connected" means "this request may now be written";
// - `beforeSend()`, called once the TCP connection is up, right before the
//   request is written: false withdraws it (nothing written);
// - an answer read up to `maxBody` bytes, then cut (a hostile peer cannot fill
//   the memory);
// - an error that tells whether the request may have reached the peer
//   (`sent`): a refused or timed out connection never did.
// The request body (a PIN, a login form) and the cookies are never logged.
// -----------------------------------------------------------------------------

import { request as httpRequest } from 'node:http';
import { LIMITS } from './constants.js';

/**
 * kind: `offline` (no connection, nothing sent), `late` (withdrawn or too
 * late, nothing sent), `withdrawn` (its option was switched off before the
 * write, nothing sent), `timeout` (sent, no answer in time), `lost` (the
 * connection ended after the write), `session` (the bridge says the session
 * is not logged in, nothing done), `answer` (an answer that is not what was
 * expected). `sent` tells whether the request may have reached the peer.
 */
export class ComelitError extends Error {
  constructor(message, kind, { sent = false, status } = {}) {
    super(message);
    this.kind = kind;
    this.sent = sent;
    this.status = status;
  }
}

/**
 * The default transport. Resolves `{ status, headers, text }`; rejects a
 * ComelitError.
 */
export function nodeTransport({
  host,
  port,
  method,
  path,
  headers = {},
  body,
  timeout,
  beforeSend = () => true,
  maxBody = LIMITS.maxBody,
}) {
  return new Promise((resolve, reject) => {
    let connected = false;
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = httpRequest({
      host,
      port,
      method,
      path,
      agent: false,
      headers: {
        ...headers,
        Connection: 'close',
        ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    });
    const timer = setTimeout(() => {
      done(
        reject,
        new ComelitError(
          connected ? 'No answer in time' : 'Connection timed out',
          connected ? 'timeout' : 'offline',
          { sent: connected },
        ),
      );
      req.destroy();
    }, timeout);
    req.on('socket', (socket) => {
      const ready = () => {
        if (settled) return;
        // true, or the ComelitError (not sent) the request is withdrawn with.
        const veto = beforeSend();
        if (veto !== true) {
          done(
            reject,
            veto instanceof ComelitError
              ? veto
              : new ComelitError('Withdrawn before it was written', 'withdrawn'),
          );
          req.destroy();
          return;
        }
        connected = true;
        req.end(body);
      };
      if (socket.connecting) socket.once('connect', ready);
      else ready();
    });
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBody) {
          done(reject, new ComelitError('Answer too large', 'answer', { sent: true }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        done(resolve, {
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => done(reject, new ComelitError(err.message, 'lost', { sent: true })));
    });
    req.on('error', (err) =>
      done(
        reject,
        new ComelitError(err.code ?? err.message, connected ? 'lost' : 'offline', {
          sent: connected,
        }),
      ),
    );
  });
}
