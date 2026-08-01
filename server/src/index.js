const { createApp } = require('./app');
const { PORT } = require('./config');

const app = createApp();

app.listen(PORT, () => {
  console.log(`Arcane Ledger server listening on http://localhost:${PORT}`);
});
