import * as signalR from '@microsoft/signalr';

/**
 * Nối Azure /hubs/tracking từ server (không bị CORS trình duyệt),
 * rồi đẩy boatLocation vào callback để FE nhận qua SSE cùng origin.
 */
export function createSignalRRelay({ getHubUrl, onBoatLocation, onStatus }) {
  let connection = null;
  let starting = false;
  let stopped = false;
  let broadcastTimer = null;
  const status = {
    connected: false,
    hubUrl: '',
    lastError: null,
    lastEventAt: null,
    transport: null,
  };

  function emitStatus() {
    onStatus?.({ ...status });
  }

  function scheduleReconnect() {
    if (stopped) return;
    setTimeout(() => {
      start().catch(() => {});
    }, 5000);
  }

  async function start() {
    if (stopped || starting) return;
    const hubUrl = String(getHubUrl?.() || '').trim();
    status.hubUrl = hubUrl;
    if (!hubUrl) {
      status.connected = false;
      status.lastError = 'Chưa có hub URL';
      emitStatus();
      return;
    }
    if (connection) return;

    starting = true;
    try {
      connection = new signalR.HubConnectionBuilder()
        .withUrl(hubUrl, {
          withCredentials: false,
          // Azure hiện chỉ advertise SSE + LongPolling (không có WebSockets).
          transport: signalR.HttpTransportType.ServerSentEvents
            | signalR.HttpTransportType.LongPolling,
        })
        .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
        .configureLogging(signalR.LogLevel.Warning)
        .build();

      const handle = (payload) => {
        status.lastEventAt = new Date().toISOString();
        onBoatLocation?.(payload);
      };
      connection.on('boatLocation', handle);
      connection.on('BoatLocationUpdated', handle);

      connection.onreconnecting((error) => {
        status.connected = false;
        status.lastError = error?.message || 'reconnecting';
        emitStatus();
      });
      connection.onreconnected(() => {
        status.connected = true;
        status.lastError = null;
        emitStatus();
        console.log(`[signalr-relay] reconnected ${hubUrl}`);
      });
      connection.onclose((error) => {
        status.connected = false;
        status.lastError = error?.message || 'closed';
        connection = null;
        emitStatus();
        scheduleReconnect();
      });

      await connection.start();
      status.connected = true;
      status.lastError = null;
      status.transport = connection.connection?.transport?.name || null;
      emitStatus();
      console.log(`[signalr-relay] connected ${hubUrl}`);
    } catch (error) {
      status.connected = false;
      status.lastError = error?.message || String(error);
      connection = null;
      emitStatus();
      console.warn(`[signalr-relay] connect failed: ${status.lastError}`);
      scheduleReconnect();
    } finally {
      starting = false;
    }
  }

  function getStatus() {
    return { ...status };
  }

  function stop() {
    stopped = true;
    if (broadcastTimer) clearTimeout(broadcastTimer);
    const conn = connection;
    connection = null;
    return conn?.stop?.().catch(() => {});
  }

  return { start, stop, getStatus };
}
