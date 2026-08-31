/**
 * SHIM DE COMPATIBILIDAD TRANSPARENTE CON PROXY DINÁMICO PARA ENTORNO NODE.JS EN RENDER
 * Reemplaza google.script.run por peticiones RPC universales + WebSockets en tiempo real (< 20ms)
 */
(function() {
  if (typeof window === 'undefined') return;

  // Si se ejecuta dentro del iframe de Google Apps Script nativo, no interfiere
  if (window.google && window.google.script && window.google.script.run && typeof window.google.script.run.getPendingOrdersEnriched === 'function') {
    console.log("ℹ️ Ejecutando en entorno Google Apps Script nativo.");
    return;
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};

  // Conexión WebSockets para actualización instantánea
  if (typeof io !== 'undefined') {
    try {
      const socket = io();
      socket.on('orders_sync', function(orders) {
        if (typeof window.onDataReceived === 'function') {
          window.onDataReceived(orders);
        }
      });
    } catch(e) {}
  }

  function createRunner() {
    let successCb = null;
    let failureCb = null;

    const runnerTarget = {
      withSuccessHandler: function(cb) { successCb = cb; return runnerProxy; },
      withFailureHandler: function(cb) { failureCb = cb; return runnerProxy; }
    };

    const runnerProxy = new Proxy(runnerTarget, {
      get: function(target, prop) {
        if (prop in target) return target[prop];

        return function(...args) {
          fetch('/api/rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: prop, args: args })
          })
          .then(async res => {
            if (res.status === 401) {
              window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname + window.location.search);
              return;
            }
            if (!res.ok) {
              const errBody = await res.text().catch(() => '');
              throw new Error(`HTTP ${res.status}: ${res.statusText || 'Error del Servidor'}`);
            }
            return res.json();
          })
          .then(data => {
            if (data.error) {
              if (failureCb) failureCb(new Error(data.error));
              else console.warn('RPC Notice [' + prop + ']:', data.error);
            } else {
              if (successCb) successCb(data.result);
            }
          })
          .catch(err => {
            if (failureCb) failureCb(err);
            else console.error('RPC Network Error [' + prop + ']:', err);
          });
        };
      }
    });

    return runnerProxy;
  }

  Object.defineProperty(window.google.script, 'run', {
    get: function() {
      return createRunner();
    }
  });

  console.log("🚀 Shim Proxy de Node.js inicializado correctamente.");
})();
