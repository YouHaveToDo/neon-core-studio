/* ARCANE LEDGER — thin WebSocket client for the PvP relay (plan.md 4.5,
 * spec-online-pvp.md §6.2-§6.3). Mirrors js/api.js's role for HTTP: a small
 * shared transport layer, no game logic of its own. js/match.js is the only
 * consumer this session; js/state.js's applyRemoteAction() seam is wired to
 * this transport in a later phase (4.7), not here.
 *
 * Auth: server/src/ws/server.js validates the session cookie at the WS
 * upgrade request itself (server/src/ws/server.js's `httpServer.on('upgrade'
 * , ...)` handler reads the same HttpOnly cookie js/api.js's fetch calls
 * already rely on via `credentials: 'include'`). A `new WebSocket(url)` in a
 * browser automatically attaches cookies that are valid for the target
 * origin to the upgrade request -- there is no way to (and no need to)
 * attach the cookie manually from JS here, unlike server/scripts/*-smoke-
 * test.js's Node `ws` client, which has no browser cookie jar and has to set
 * a `Cookie` header itself. If the session is missing/expired, the server
 * responds with a bare "401 Unauthorized" HTTP response instead of
 * completing the WS handshake, which surfaces here as the socket's `error`/
 * `close` event -- connect() below rejects in that case.
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
    return API_BASE_URL.replace(/^http/, 'ws') + '/ws';
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
