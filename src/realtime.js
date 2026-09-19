const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');

// The frontend connects to  {ws|wss}://<origin>/ws?token=<JWT>  and, on any
// message that isn't {event:'connected'}, refetches the endpoints it needs.
// So events here are deliberately DATA-FREE notifications-to-refetch: the
// socket never carries record contents, which means it can't leak a row to
// someone whose RBAC scope wouldn't have returned it. Each client refetches
// through the normal authorized endpoints.
let wss = null;
const clients = new Set(); // { socket, userId, role }

function initRealtime(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket, req) => {
    const { token } = url.parse(req.url, true).query;
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      socket.close(4001, 'Invalid token');
      return;
    }

    const entry = { socket, userId: payload.userId, role: payload.role };
    clients.add(entry);
    socket.send(JSON.stringify({ event: 'connected' }));

    // Keepalive: Render (and most proxies) drop idle sockets after ~60s.
    // The frontend already auto-reconnects on close, but pinging keeps the
    // connection alive so users don't see a reconnect gap mid-work.
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('close', () => clients.delete(entry));
    socket.on('error', () => clients.delete(entry));
  });

  const heartbeat = setInterval(() => {
    clients.forEach((c) => {
      if (c.socket.isAlive === false) { c.socket.terminate(); clients.delete(c); return; }
      c.socket.isAlive = false;
      try { c.socket.ping(); } catch (e) { /* socket already gone */ }
    });
  }, 30000);
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

// Tell every connected client "something changed, refetch". Optionally
// carries application_ref/status purely so the frontend can show a toast —
// never used as authoritative data.
function broadcast(event, meta = {}) {
  const msg = JSON.stringify({ event, ...meta });
  clients.forEach((c) => {
    try {
      if (c.socket.readyState === 1) c.socket.send(msg);
    } catch (err) { /* drop silently; heartbeat will clean it up */ }
  });
}

function connectedCount() { return clients.size; }

module.exports = { initRealtime, broadcast, connectedCount };
