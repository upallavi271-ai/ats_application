const http = require('http');
const app = require('./src/app');
const { initRealtime } = require('./src/realtime');
require('dotenv').config();

const port = process.env.PORT || 4000;

// The WebSocket server shares the same HTTP server (and therefore the same
// port and the same Render URL) as the API — one service, ws:// upgrades on
// /ws, normal requests everywhere else.
const server = http.createServer(app);
initRealtime(server);

server.listen(port, () => {
  console.log(`TeamLink ATS listening on port ${port} (HTTP + WebSocket)`);
});
