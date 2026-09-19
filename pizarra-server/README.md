# pizarra-server

Excalidraw con **proyectos** y **hojas en árbol** (p. ej. `ChemovetGestión` → `Front`, `Back`, `DevOps`, `Pendientes`, y a su vez `Front` → `Componentes` → `Botón`, a cualquier profundidad). Cada hoja se guarda como un archivo `.excalidraw` estándar en el servidor, así que se ve igual desde cualquier dispositivo y se puede editar a mano o con una IA.

## Datos

```
DATA_DIR/
  <proyecto>/proyecto.json       nombre + hojas [{id, nombre, padre}]
  <proyecto>/<hoja>.excalidraw   la escena (JSON legible)
  <proyecto>/.historial/<hoja>/  copia previa, como mucho una cada 10 min (máx. 100)
  .papelera/                     lo borrado desde la app
```

Cada hoja tiene un `padre` (el id de otra hoja del mismo proyecto, o `null` si es de primer nivel), así que las hojas forman un árbol de profundidad libre. Borrar una hoja borra en cascada todas sus sub-hojas.

Si alguien edita el `.excalidraw` directamente, la app lo trae sola (revisa cada 20 s y al volver a la pestaña). Si justo había cambios sin guardar en el navegador, no se pisa nada: la versión del navegador queda como una hoja nueva `"<hoja> (conflicto HH:MM)"`.

## Seguridad

La app en sí es pública (es el mismo código abierto de Excalidraw); lo que está protegido es la API (`/api/*`), que pide iniciar sesión con **una sola contraseña**:

- se guarda como hash scrypt en `DATA_DIR/.contrasena` (nunca en texto);
- la sesión es una cookie `HttpOnly`, `SameSite=Strict` y `Secure` (detrás de Cloudflare), firmada con HMAC y válida por 30 días;
- tras 5 intentos fallidos desde una IP (o 30 en total) se bloquea 15 min;
- cambiar la contraseña cierra todas las sesiones abiertas.

Cargar o cambiar la contraseña (la pide sin mostrarla):

```bash
docker exec -it excalidraw node server.mjs contrasena
```

Sin contraseña cargada la API responde 503. `PIZARRA_SIN_AUTH=1` la desactiva (solo para desarrollo local).

La primera vez que un navegador entra, si tenía un dibujo de la versión anterior (guardado en el navegador), se copia a una hoja "Rescatado del navegador".

## Desarrollo

```bash
# servidor (sin auth, datos en ./data)
PORT=8787 PIZARRA_SIN_AUTH=1 node pizarra-server/server.mjs
# app con recarga en caliente, /api va al servidor de arriba
cd excalidraw-app && VITE_APP_PIZARRA=true \
  VITE_APP_PIZARRA_API_PROXY=http://127.0.0.1:8787 npx vite
# tests del servidor
node --test pizarra-server/server.test.mjs
```

## Producción (pc3)

```bash
docker build -f pizarra-server/Dockerfile -t pizarra .
docker run -d --name excalidraw --restart unless-stopped \
  -p 127.0.0.1:8095:8080 -v ~/pizarra-data:/data pizarra
```

## Traer cambios de Excalidraw

```bash
git fetch upstream && git merge upstream/master
```

Los cambios propios están casi todos en `excalidraw-app/pizarra/` y `pizarra-server/`; en archivos de upstream solo hay enganches chicos marcados con `PIZARRA_ENABLED` (`App.tsx`, `AppFooter.tsx`, `AppWelcomeScreen.tsx`, `vite.config.mts`, `vite-env.d.ts`, `.dockerignore`).
