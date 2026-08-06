const http = require('http');
const { createApp } = require('./app');
const { attachWebSocketServer } = require('./ws/server');
const { PORT } = require('./config');

const app = createApp();

// The WS relay (plan.md Phase 2.1) attaches to the same HTTP server as the
// Express app, so both HTTP API and WS traffic share one port within this
// process -- no separate WS process/port. This API runs as its own Render
// Web Service (render.yaml: neon-core-api); the static client is a
// separate Render Static Site (neon-core-client) with no Node process at
// all, so it isn't part of this port-sharing at all.
const server = http.createServer(app);
attachWebSocketServer(server);

server.listen(PORT, () => {
  console.log(`Arcane Ledger server listening on http://localhost:${PORT} (WS relay at ws://localhost:${PORT}/ws)`);
});
