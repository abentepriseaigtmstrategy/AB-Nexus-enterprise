// backend/durable-objects.js
// Cloudflare Durable Objects — Real-time WebSocket Hub
// One DO instance per tenant = isolated real-time channel per organisation

export class NexusRealtimeHub {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
    this.sessions = new Map(); // sessionId → { ws, userId, tenantId, role }
  }

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    // Internal broadcast endpoint (called by Worker when DB changes)
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const body = await request.json();
      this.broadcast(body.tenantId, body.event, body.data);
      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  }

  async handleWebSocket(request) {
    const url = new URL(request.url);
    const token    = url.searchParams.get('token');
    const tenantId = url.searchParams.get('tenantId');

    if (!token || !tenantId) {
      return new Response('Missing token or tenantId', { status: 401 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server, [tenantId]);

    // Attach metadata via tag
    server._nexusUserId   = url.searchParams.get('userId') || 'unknown';
    server._nexusTenantId = tenantId;
    server._nexusRole     = url.searchParams.get('role') || 'viewer';

    server.addEventListener('message', async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'ping') {
        server.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      }

      if (msg.type === 'subscribe_claim') {
        server._subscribedClaim = msg.claimId;
        server.send(JSON.stringify({ type: 'subscribed', claimId: msg.claimId }));
      }
    });

    server.addEventListener('close', () => {
      // Clean up handled automatically by Durable Object hibernation
    });

    server.addEventListener('error', (err) => {
      console.error('[DO] WebSocket error:', err);
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: {
        'Access-Control-Allow-Origin': '*',
      }
    });
  }

  // Called internally to push updates to all connected clients in a tenant
  broadcast(tenantId, event, data) {
    const payload = JSON.stringify({ event, data, ts: Date.now() });
    const wss = this.state.getWebSockets(tenantId);
    for (const ws of wss) {
      try { ws.send(payload); } catch { /* client disconnected */ }
    }
  }

  // Broadcast only to subscribers of a specific claim
  broadcastToClaim(tenantId, claimId, event, data) {
    const payload = JSON.stringify({ event, data, claimId, ts: Date.now() });
    const wss = this.state.getWebSockets(tenantId);
    for (const ws of wss) {
      if (!ws._subscribedClaim || ws._subscribedClaim === claimId) {
        try { ws.send(payload); } catch { /* ignore */ }
      }
    }
  }

  // Durable Object hibernation handler
  webSocketMessage(ws, message) {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
    } catch { /* ignore malformed */ }
  }

  webSocketClose(ws, code, reason) {
    ws.close(code, 'Connection closed');
  }
}
