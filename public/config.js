// ==============================================================
// 🌐 CONFIGURACIÓN CENTRALIZADA DE BACKEND (PAÑOL CLIENTE)
// ==============================================================

(function() {
  // ⚠️ CONFIGURACIÓN DE BACKEND ACTIVO
  // Para volver a Render en el futuro (Rollback): descomentar Render y comentar Railway.
  // const BACKEND_PROD_URL = "https://panol-monolith-service.onrender.com"; // RENDER (FALLBACK / ROLLBACK)
  const BACKEND_PROD_URL = "https://panolnd-taller.up.railway.app"; // RAILWAY (ACTIVO)

  const isLocal = typeof window !== 'undefined' && window.location && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.protocol === 'file:'
  );

  // Si se abre desde localhost usar backend local, si no usar el backend de producción (Railway / Render)
  const resolvedBackendUrl = isLocal ? 'http://localhost:3000' : BACKEND_PROD_URL;

  window.PANOL_CONFIG = {
    BACKEND_URL: resolvedBackendUrl,
    RENDER_URL: "https://panol-monolith-service.onrender.com",
    RAILWAY_URL: "https://panolnd-taller.up.railway.app",
    IS_LOCAL: isLocal
  };

  window.BACKEND_URL = resolvedBackendUrl;

  /**
   * Helper universal para llamadas API con soporte cross-origin y token de sesión
   */
  window.panolFetch = function(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : (window.BACKEND_URL + (endpoint.startsWith('/') ? '' : '/') + endpoint);
    const headers = options.headers ? { ...options.headers } : {};

    // Inyectar token guardado de localStorage para compatibilidad total cross-site (Render Static <-> Railway)
    let token = '';
    try {
      token = localStorage.getItem('sys_auth_token') || '';
    } catch(e) {}

    if (token && !headers['x-auth-token']) {
      headers['x-auth-token'] = token;
    }
    if (!headers['Content-Type'] && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    return fetch(url, {
      ...options,
      headers,
      credentials: 'include' // Enviar cookies de sesión SameSite=None
    });
  };

  console.log(`🌐 [Pañol Config] Backend conectado a: ${window.BACKEND_URL} (${isLocal ? '🟢 LOCAL' : '🚀 NUBE'})`);
})();
