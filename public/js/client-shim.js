/**
 * SHIM DE COMPATIBILIDAD TRANSPARENTE PARA ENTORNO NODE.JS EN RENDER
 * Reemplaza google.script.run por peticiones REST API + WebSockets en tiempo real (< 20ms)
 */
(function() {
  if (typeof window === 'undefined') return;

  // Si ya estamos corriendo dentro del iframe nativo de Apps Script, no sobreescribimos
  if (window.google && window.google.script && window.google.script.run && typeof window.google.script.run.getPendingOrdersEnriched === 'function') {
    console.log("ℹ️ Ejecutando en entorno Google Apps Script nativo.");
    return;
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};

  // Conexión WebSockets
  let socket = null;
  if (typeof io !== 'undefined') {
    socket = io();
    socket.on('orders_sync', function(orders) {
      if (typeof window.onDataReceived === 'function') {
        window.onDataReceived(orders);
      }
    });
  }

  function createRunner() {
    return {
      _success: null,
      _failure: null,
      withSuccessHandler: function(cb) { this._success = cb; return this; },
      withFailureHandler: function(cb) { this._failure = cb; return this; },

      // === LECTURA ===
      getPendingOrdersEnriched: async function() {
        try {
          const res = await fetch('/api/orders');
          const data = await res.json();
          if (this._success) this._success(data);
        } catch(e) { if (this._failure) this._failure(e); }
      },

      getPendingOrders: async function() {
        return this.getPendingOrdersEnriched();
      },

      getInventoryItems: async function(query) {
        try {
          const res = await fetch('/api/inventory?q=' + encodeURIComponent(query || ''));
          const data = await res.json();
          if (this._success) this._success(data);
        } catch(e) { if (this._failure) this._failure(e); }
      },

      getAllData: async function() {
        try {
          const res = await fetch('/api/all-data');
          const data = await res.json();
          if (this._success) this._success(data);
        } catch(e) { if (this._failure) this._failure(e); }
      },

      // === CREACIÓN Y EDICIÓN ===
      createOrder: async function(payload) {
        try {
          const res = await fetch('/api/orders/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          if (this._success) this._success(data);
        } catch(e) { if (this._failure) this._failure(e); }
      },

      updatePendingItemQty: async function(reqId, itemName, newQty) {
        try {
          const res = await fetch('/api/orders/update-item-qty', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reqId, itemName, newQty })
          });
          const data = await res.json();
          if (this._success) this._success(data);
        } catch(e) { if (this._failure) this._failure(e); }
      },

      removePendingItem: async function(reqId, itemName) {
        try {
          const res = await fetch('/api/orders/remove-item', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reqId, itemName })
          });
          const data = await res.json();
          if (this._success) this._success(data);
        } catch(e) { if (this._failure) this._failure(e); }
      },

      addItemToPendingOrder: async function(reqId, itemName, qty) {
        try {
          const res = await fetch('/api/orders/add-item', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reqId, itemName, qty })
          });
          const data = await res.json();
          if (this._success) this._success(data);
        } catch(e) { if (this._failure) this._failure(e); }
      },

      markAsReady: async function(reqId, panolOpId) {
        try {
          const res = await fetch('/api/orders/mark-ready', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reqId, panolOpId })
          });
          const data = await res.json();
          if (this._success) this._success(data);
        } catch(e) { if (this._failure) this._failure(e); }
      },

      requestRefund: async function(reqId, itemName, reason, returnQty) {
        try {
          const res = await fetch('/api/orders/request-return', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reqId, itemName, reason, returnQty })
          });
          const data = await res.json();
          if (this._success) this._success(data);
        } catch(e) { if (this._failure) this._failure(e); }
      },

      processNewItemReturn: async function(reqId, itemName, returnQty, reason, panolOpId) {
        try {
          const res = await fetch('/api/orders/process-new-return', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reqId, itemName, returnQty, reason, panolOpId })
          });
          const data = await res.json();
          if (this._success) this._success(data);
        } catch(e) { if (this._failure) this._failure(e); }
      },

      confirmReturnItem: async function(reqId, itemName, opId, status, declaredQty) {
        try {
          const res = await fetch('/api/orders/audit-return', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reqId, itemName, opId, status, declaredQty })
          });
          const data = await res.json();
          if (this._success) this._success(data);
        } catch(e) { if (this._failure) this._failure(e); }
      },

      setOrderCardColor: async function(reqId, color) {
        try {
          const res = await fetch('/api/orders/set-color', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reqId, color })
          });
          const data = await res.json();
          if (this._success) this._success(data);
        } catch(e) { if (this._failure) this._failure(e); }
      },

      sendOrderPing: async function(reqId) {
        try {
          const res = await fetch('/api/orders/send-ping', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reqId })
          });
          const data = await res.json();
          if (this._success) this._success(data);
        } catch(e) { if (this._failure) this._failure(e); }
      }
    };
  }

  // Asignamos una propiedad reactiva a google.script.run para crear nuevos runners encadenados
  Object.defineProperty(window.google.script, 'run', {
    get: function() {
      return createRunner();
    }
  });

  console.log("🚀 Shim de Render Node.js inicializado correctamente.");
})();
