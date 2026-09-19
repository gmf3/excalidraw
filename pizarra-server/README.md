# pizarra-server

Excalidraw con **proyectos** y **hojas** (p. ej. `ChemovetGestión` → `Front`, `Back`, `DevOps`, `Pendientes`). Cada hoja se guarda como un archivo `.excalidraw` estándar en el servidor, así que se ve igual desde cualquier dispositivo y se puede editar a mano o con una IA.

## Datos

```
DATA_DIR/
  <proyecto>/proyecto.json       nombre + orden de las hojas
  <proyecto>/<hoja>.excalidraw   la escena (JSON legible)
  <proyecto>/.historial/<hoja>/  copia previa, como mucho una cada 10 min (máx. 100)
  .papelera/                     lo borrado desde la app
```

Si alguien edita el `.excalidraw` directamente, la app lo trae sola (revisa cada 20 s y al volver a la pestaña). Si justo había cambios sin guardar en el navegador, no se pisa nada: la versión del navegador queda como una hoja nueva `"<hoja> (conflicto HH:MM)"`.

## Seguridad

La API (`/api/*`) solo responde con un JWT válido de **Cloudflare Access** (header `Cf-Access-Jwt-Assertion` o cookie `CF_Authorization`), verificado contra las claves del equipo. Sin configurar responde 503.

| Variable                | Ejemplo                         |
| ----------------------- | ------------------------------- |
| `CF_ACCESS_TEAM_DOMAIN` | `miequipo.cloudflareaccess.com` |
| `CF_ACCESS_AUD`         | Application Audience (AUD) Tag  |
| `PIZARRA_SIN_AUTH=1`    | solo desarrollo local           |

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
  -p 127.0.0.1:8095:8080 -v ~/pizarra-data:/data \
  --env-file ~/pizarra.env pizarra
```

## Traer cambios de Excalidraw

```bash
git fetch upstream && git merge upstream/master
```

Los cambios propios están casi todos en `excalidraw-app/pizarra/` y `pizarra-server/`; en archivos de upstream solo hay enganches chicos marcados con `PIZARRA_ENABLED` (`App.tsx`, `AppFooter.tsx`, `AppWelcomeScreen.tsx`, `vite.config.mts`, `vite-env.d.ts`, `.dockerignore`).
