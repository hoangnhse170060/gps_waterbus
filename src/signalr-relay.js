import * as signalR from '@microsoft/signalr';

/**
 * Nối Azure SignalR hub từ server (tránh CORS trình duyệt),
 * rồi đẩy event vào callback để FE nhận qua SSE cùng origin.
 *
 * @param {{
 *   name?: string,
 *   getHubUrl: () => string,
 *   getAccessToken?: () => string | null | undefined,
 *   events?: Array<{ names: string[], onEvent: (payload: unknown, eventName: string) => void }>,
 *   onStatus?: (status: object) => void,
 * }} options
 */
export function createSignalRRelay({
  name = 'signalr-relay',
  getHubUrl,
  getAccessToken,
  events = [],
  onStatus,
}) {
  let connection = null;
  let starting = false;
  let stopped = false;
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
      const hubOptions = {
        withCredentials: false,
        // Azure hiện chỉ advertise SSE + LongPolling (không có WebSockets).
        transport: signalR.HttpTransportType.ServerSentEvents
          | signalR.HttpTransportType.LongPolling,
      };
      const token = String(getAccessToken?.() || '').trim();
      if (token) {
        hubOptions.accessTokenFactory = () => token;
      }

      connection = new signalR.HubConnectionBuilder()
        .withUrl(hubUrl, hubOptions)
        .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
        .configureLogging(signalR.LogLevel.Warning)
        .build();

      for (const group of events) {
        const names = group?.names || [];
        for (const eventName of names) {
          connection.on(eventName, (payload) => {
            status.lastEventAt = new Date().toISOString();
            group.onEvent?.(payload, eventName);
          });
        }
      }

      connection.onreconnecting((error) => {
        status.connected = false;
        status.lastError = error?.message || 'reconnecting';
        emitStatus();
      });
      connection.onreconnected(() => {
        status.connected = true;
        status.lastError = null;
        emitStatus();
        console.log(`[${name}] reconnected ${hubUrl}`);
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
      console.log(`[${name}] connected ${hubUrl}`);
    } catch (error) {
      status.connected = false;
      status.lastError = error?.message || String(error);
      connection = null;
      emitStatus();
      console.warn(`[${name}] connect failed: ${status.lastError}`);
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
    const conn = connection;
    connection = null;
    return conn?.stop?.().catch(() => {});
  }

  return { start, stop, getStatus };
}
