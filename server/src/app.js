const express = require('express');
const authRoutes = require('./routes/auth');

function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use('/api/auth', authRoutes);

  // Fallback error handler so unexpected throws return JSON, not an HTML
  // stack trace, to a game client.
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  });

  return app;
}

module.exports = { createApp };
