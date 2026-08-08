const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const deckRoutes = require('./routes/decks');
const matchHistoryRoutes = require('./routes/matchHistory');
const roomRoutes = require('./routes/rooms');
const economyRoutes = require('./routes/economy');
const { CLIENT_ORIGIN, IS_PRODUCTION } = require('./config');

function createApp() {
  const app = express();

  // Deck endpoints (and future Phase 4 endpoints) are called via browser
  // `fetch` from a client that is NOT same-origin with this API (the client
  // is a static file set, this is a separate Node process/port) -- so unlike
  // Phase 1's auth routes (only ever smoke-tested via server-side fetch,
  // which isn't subject to CORS), real cross-origin cookies now require
  // both `credentials: true` here and `credentials: 'include'` client-side
  // (js/api.js). `credentials: true` forbids the `*` wildcard origin, so:
  // in production, only the explicitly configured CLIENT_ORIGIN(s) are
  // allowed (unset = no cross-origin access at all, a safe default); in
  // development, the request's own origin is reflected back so a local
  // static server on any port works without extra config.
  app.use(cors({
    origin: IS_PRODUCTION
      ? (CLIENT_ORIGIN ? CLIENT_ORIGIN.split(',').map((s) => s.trim()) : false)
      : true,
    credentials: true,
  }));
  app.use(express.json());

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use('/api/auth', authRoutes);
  app.use('/api/decks', deckRoutes);
  app.use('/api/match-history', matchHistoryRoutes);
  app.use('/api/rooms', roomRoutes);
  app.use('/api/economy', economyRoutes);

  // Fallback error handler so unexpected throws return JSON, not an HTML
  // stack trace, to a game client.
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  });

  return app;
}

module.exports = { createApp };
