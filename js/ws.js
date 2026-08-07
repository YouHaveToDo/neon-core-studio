/* ARCANE LEDGER — thin WebSocket client for the PvP relay (plan.md 4.5,
 * spec-online-pvp.md §6.2-§6.3). Mirrors js/api.js's role for HTTP: a small
 * shared transport layer, no game logic of its own. js/match.js is the only
 * consumer this session; js/state.js's applyRemoteAction() seam is wired to
 * this transport in a later phase (4.7), not here.
 *
 * Auth (revised -- see js/api.js's top comment and server/src/lib/
 * session.js's setSessionCookie comment for the full mobile-ITP history):
 * this used to rely on the browser automatically attaching the HttpOnly
 * session cookie to the WS upgrade request. Production no longer sets that
 * cookie at all (mobile Safari/iOS in-app-browser ITP unreliably evicts it),
 * and even where it's still set (local dev), a WebSocket upgrade can't
 * carry a custom `Authorization` header the way js/api.js's fetch calls
 * can -- there's no browser API for that. So the same token js/api.js
 * stores in localStorage after login/signup is instead appended as a
 * `?token=` query-string param on the `/ws` connection URL (see wsUrl()
 * below); server/src/ws/server.js's upgrade handler reads it from there.
 * server/scripts/*-smoke-test.js's Node `ws` client has no browser cookie
 * jar or localStorage either and continues to set a `Cookie` header itself
 * (the server accepts that as a fallback -- see readWsToken there). If the
 * session/token is missing/invalid, the server responds with a bare "401
 * Unauthorized" HTTP response instead of completing the WS handshake, which
 * surfaces here as the socket's `error`/`close` event -- connect() below
 * rejects in that case.
 */
const Net = (() => {
  let ws = null;
  const handlers = {}; // type -> [fn]
  const closeHandlers = [];

  function wsUrl() {
    // API_BASE_URL (global const from js/config.js, read into js/api.js) is
    // the same origin/port the relay listens on (server/src/index.js
    // attaches the WS server to the same HTTP server as the Express app) --
    // just swap the scheme, same host:port, same /ws path server/src/ws/
    // server.js expects (WS_PATH). This holds in both local dev and
    // production even though the WS relay's origin is NOT the client's own
    // origin there (client and API are separate Render services) -- it only
    // needs to match the API's origin, which is exactly what API_BASE_URL is.
    const base = API_BASE_URL.replace(/^http/, 'ws') + '/ws';
    // See the file's top comment: the token travels as a query param since
    // a WS handshake can't carry a custom Authorization header. Omitted
    // entirely if there's no stored token (e.g. dev, where the server also
    // still accepts the session cookie the browser attaches automatically)
    // rather than sending a literal "?token=null".
    const token = API.getToken();
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  function isConnected() {
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  function connect() {
    if (isConnected()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl());
      let settled = false;

      socket.addEventListener('open', () => {
        settled = true;
        ws = socket;
        resolve();
      });

      socket.addEventListener('message', (evt) => {
        let msg;
        try {
          msg = JSON.parse(evt.data);
        } catch (err) {
          return; // malformed frame -- nothing sensible to do with it
        }
        if (!msg || typeof msg.type !== 'string') return;
        (handlers[msg.type] || []).forEach((fn) => fn(msg));
      });

      socket.addEventListener('close', () => {
        if (ws === socket) ws = null;
        closeHandlers.forEach((fn) => fn());
        if (!settled) {
          settled = true;
          reject(new Error('서버에 연결할 수 없습니다 (세션이 만료되었을 수 있습니다)'));
        }
      });

      socket.addEventListener('error', () => {
        // The 'close' event above always follows 'error' for a socket that
        // never finished opening, so rejection is handled there -- this
        // listener only exists so an uncaught-error console warning doesn't
        // show up for an expected connect failure.
      });
    });
  }

  function on(type, fn) {
    (handlers[type] = handlers[type] || []).push(fn);
  }

  function onClose(fn) {
    closeHandlers.push(fn);
  }

  function send(type, payload) {
    if (!isConnected()) return;
    ws.send(JSON.stringify(Object.assign({ type }, payload)));
  }

  function close() {
    if (ws) ws.close();
    ws = null;
  }

  return { connect, on, onClose, send, close, isConnected };
})();
