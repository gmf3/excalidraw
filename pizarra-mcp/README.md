# Pizarra MCP

Servidor MCP por `stdio` para crear y editar proyectos/hojas de la Pizarra de pc3 sin automatizar el navegador. Usa el mismo almacenamiento y control de concurrencia (`ETag`) que `pizarra-server`.

Se inspira en [`excalidraw/excalidraw-mcp`](https://github.com/excalidraw/excalidraw-mcp), pero persiste cada diagrama en una hoja real en lugar de crear un checkpoint temporal dentro del chat.

## Herramientas

- `read_me`
- `list_projects`
- `create_project` — crea un proyecto nuevo con al menos una hoja
- `list_sheets`
- `read_sheet`
- `preview_sheet` — devuelve una vista PNG directamente al cliente MCP
- `create_sheet`
- `write_diagram`
- `write_scene`
- `rename_sheet`
- `move_sheet` — baja una hoja bajo otra o la sube nuevamente a la raíz

`write_diagram` recibe figuras abreviadas y las convierte a elementos Excalidraw editables. Los textos usan `\n` para saltos de línea; `<br>` se rechaza para impedir que aparezca como texto literal. Figuras y rótulos se agrupan sin bindings internos, y las flechas se guardan como conectores libres: así abrir una hoja no dispara normalizaciones automáticas ni falsos conflictos. Los bloques con `label` ajustan su altura al texto; `fitToText:false` conserva una altura explícita cuando el diseño lo necesita. Los rótulos de flechas quedan centrados sobre el conector y llevan una máscara blanca agrupada detrás para cortar la línea sin bindings.

## Ejecutar localmente

```bash
cd pizarra-mcp
npm ci
PIZARRA_DATA_DIR=../data node server.mjs
```

## Ejecutar contra pc3 mediante SSH

El servidor se instala en `/home/efe-go/excalidraw/pizarra-mcp` y usa `/home/efe-go/pizarra-data`. La configuración recomendada de Codex es:

```toml
[mcp_servers.pizarra]
command = "ssh"
args = ["pc3", "env", "PIZARRA_DATA_DIR=/home/efe-go/pizarra-data", "PIZARRA_PUBLIC_URL=https://pizarra.ultragfe.uk", "node", "/home/efe-go/excalidraw/pizarra-mcp/server.mjs"]
startup_timeout_sec = 20
tool_timeout_sec = 60
```

SSH proporciona autenticación y el MCP no expone un puerto adicional.

## Claude Code

Ya está registrado en `.mcp.json` del vault (scope `project`, mismo comando que usa Codex arriba) y tiene un agente equivalente, `diagramador-pizarra` (`.claude/agents/diagramador-pizarra.md`), con las mismas reglas de composición que su par de Codex. Al abrir una sesión nueva en el vault, Claude Code pide aprobar el servidor `pizarra` una vez (`claude mcp list` para ver el estado).
