const http = require('http');
const { createApp } = require('./app');
const { attachWebSocketServer } = require('./ws/server');
const { PORT } = require('./config');

const app = createApp();

// The WS relay (plan.md Phase 2.1) attaches to the same HTTP server as the
// Express app, so both HTTP API and WS traffic share one port -- matches
// the plan's "single Render service" infra decision, no separate process.
const server = http.createServer(app);
attachWebSocketServer(server);

server.listen(PORT, () => {
  console.log(`Arcane Ledger server listening on http://localhost:${PORT} (WS relay at ws://localhost:${PORT}/ws)`);
});
