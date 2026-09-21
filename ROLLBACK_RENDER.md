# 🔄 Guía de Reversión: De Railway a Render (Rollback para Pañol)

> **Contexto:** Esta arquitectura desacoplada fue implementada debido a la suspensión / limitaciones de ancho de banda de los Web Services en Render.  
> - **Backend (Node.js + WebSockets + Sync):** Desplegado en **Railway** (`https://panolnd-production.up.railway.app`).  
> - **Frontend (HTML, JS, CSS):** Publicado como **Static Site en Render** (`panol-static-site`), lo que mantiene los enlaces idénticos (`/coordinacion`, `/panol`, `/mobile`, `/login`, `/`) con **0 consumo de RAM y 100 GB de ancho de banda gratuito en CDN**.

---

## ⚡ Paso Rápido para Revertir a Render (Rollback en 1 Paso)

Si reactivas el Web Service en Render (`https://panol-monolith-service.onrender.com`) y deseas que el frontend vuelva a comunicarse con el backend de Render en lugar de Railway:

### 1. Modificar [`public/config.js`](file:///c:/Users/Matias%20Rodriguez/Desktop/panolnd/public/config.js) (Línea ~8)

Descomentar la URL de Render y comentar la de Railway:

```javascript
// --- [TAG: CONEXIÓN BACKEND ACTIVO] ---
const BACKEND_PROD_URL = "https://panol-monolith-service.onrender.com"; // RENDER (ACTIVO)
// const BACKEND_PROD_URL = "https://panolnd-production.up.railway.app"; // RAILWAY (DESACTIVADO)
```

> **Nota:** Al estar también en `public/js/config.js`, puedes sincronizarlo ejecutando:
> ```powershell
> Copy-Item "public\config.js" -Destination "public\js\config.js" -Force
> ```

---

## ⚙️ Pasos en el Panel de Render

### 2. Reactivar el Web Service `panol-monolith-service`
1. Ingresa a [dashboard.render.com](https://dashboard.render.com).
2. Localiza el servicio **`panol-monolith-service`**.
3. Si estaba suspendido, haz clic en **Resume** o despliega desde el blueprint `render.yaml`.
4. Verifica que las variables de entorno estén presentes en la pestaña **Environment**:
   * `NODE_ENV`: `production`
   * `SPREADSHEET_ID`: `1aKptNgy8a9Ca3rDW-HSlWEiriMRJMOIJuFsdViwEGFc`
   * `SOURCE_SPREADSHEET_ID`: `1HKXGsRC149Kw4aBXQwGcPVpAvObvTUFis6YV6R5cTXk`
   * `MES_MOVIMIENTOS_ID`: `1Bwj8WCykMn_FbZhQ_FqnDH3K_WCod52YTSvsaxIDNS8`
   * `GOOGLE_CREDENTIALS`: *(JSON de la cuenta de servicio)*
   * `DIAGRAMAS_URL`: `https://diagramasnode-production.up.railway.app/api/datos` (o `https://diagramasnode.onrender.com/api/datos` si diagramasnode también volvió a Render).

---

## 🔗 ¿Cómo se mantienen los mismos links?

Gracias a las reglas de **rewrite** configuradas en [`render.yaml`](file:///c:/Users/Matias%20Rodriguez/Desktop/panolnd/render.yaml), tanto en el **Static Site** como en el **Web Service**, las siguientes URLs funcionan de forma idéntica para los operadores:

| Enlace Operativo | Archivo Servido | Función |
|---|---|---|
| `https://<dominio>/` | `index.html` | Terminal de Órdenes & Pedidos |
| `https://<dominio>/coordinacion` | `coordinacion.html` | Tablero de Coordinación (Tractor + Semi) |
| `https://<dominio>/panol` | `panol.html` | Monitor Pañol en tiempo real |
| `https://<dominio>/mobile` | `mobile.html` | App Móvil de Mecánico / Taller |
| `https://<dominio>/login` | `login.html` | Pantalla de Autenticación |
| `https://<dominio>/wireframe` | `coordinacion.html` | Redirección canónica a Coordinación |

---

## 🐘 PostgreSQL (`pg` Client Pool) en Render

Si en Render deseas vincular una base de datos PostgreSQL:
* Agrega la variable `DATABASE_URL` con tu cadena de conexión `postgresql://...`.
* El pool nativo detectará automáticamente la conexión con un límite de **5 conexiones concurrentes** y reciclaje periódico para no superar los 512 MB de RAM de Render.
