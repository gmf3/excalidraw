#!/usr/bin/env node

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { crearAlmacen } from "../pizarra-server/server.mjs";
import { compactScene, elementsFromSkeleton, makeScene } from "./scene.mjs";
import { renderScenePng } from "./preview.mjs";

const DATA_DIR = path.resolve(process.env.PIZARRA_DATA_DIR || "./data");
const PUBLIC_URL = (
  process.env.PIZARRA_PUBLIC_URL || "https://pizarra.ultragfe.uk"
).replace(/\/$/, "");
const almacen = crearAlmacen(DATA_DIR);

const instructions = `Edita la Pizarra persistente de pc3 directamente; no uses el navegador. Antes de escribir, lista proyectos y hojas, lee la hoja destino y usa preview_sheet cuando necesites inspeccion visual. write_diagram acepta elementos abreviados de Excalidraw y protege las escrituras con ETag. Para mover, recolorear o cambiar el texto de algo que ya existe (por ejemplo una tarjeta de Kanban que cambia de columna), usa patch_elements en vez de write_scene: write_scene te obliga a retipear la escena entera y es facil romper el containerId/boundElements/groupIds de un elemento que no pensabas tocar. Usa saltos de linea JSON \\n; nunca uses etiquetas <br>. Las operaciones reemplazan o amplian una hoja real y son visibles en https://pizarra.ultragfe.uk.`;

const server = new McpServer(
  { name: "pizarra-pc3", version: "0.1.0" },
  { instructions },
);

const textResult = (value, structuredContent) => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
  ...(structuredContent ? { structuredContent } : {}),
});

const fail = (error) => ({
  content: [
    {
      type: "text",
      text: error instanceof Error ? error.message : String(error),
    },
  ],
  isError: true,
});

const project = (projectId) => {
  const found = almacen.listar().find((item) => item.id === projectId);
  if (!found) {
    throw new Error(`Proyecto inexistente: ${projectId}`);
  }
  return found;
};

const sheet = (projectId, sheetId) => {
  const found = project(projectId).hojas.find((item) => item.id === sheetId);
  if (!found) {
    throw new Error(`Hoja inexistente: ${projectId}/${sheetId}`);
  }
  return found;
};

const readScene = (projectId, sheetId) => {
  sheet(projectId, sheetId);
  const { contenido, etag } = almacen.leerHoja(projectId, sheetId);
  return { scene: JSON.parse(contenido.toString("utf8")), etag };
};

const urlFor = (projectId, sheetId) =>
  `${PUBLIC_URL}/?proyecto=${encodeURIComponent(
    projectId,
  )}&hoja=${encodeURIComponent(sheetId)}`;

const parseElements = (elements) => {
  if (/<br\s*\/?>/i.test(elements)) {
    throw new Error("No uses <br>; usa \\n dentro del texto JSON");
  }
  let parsed;
  try {
    parsed = JSON.parse(elements);
  } catch (error) {
    throw new Error(`elements no es JSON valido: ${error.message}`);
  }
  return elementsFromSkeleton(parsed);
};

server.registerTool(
  "read_me",
  {
    description:
      "Referencia breve del formato de elementos. Llamar antes del primer write_diagram.",
    annotations: { readOnlyHint: true },
  },
  async () =>
    textResult(`write_diagram recibe un string JSON con un array. Tipos: rectangle, ellipse, diamond, text, arrow y line.

Figura: {"id":"api","type":"rectangle","x":100,"y":80,"width":240,"height":110,"label":"FastAPI\\nPython 3.12","backgroundColor":"#dcfce7","strokeColor":"#16a34a"}
Conexion: {"id":"a1","type":"arrow","from":"web","to":"api","label":"HTTPS / JSON"}
Texto libre: {"type":"text","x":100,"y":20,"text":"BACKEND","fontSize":28}

Los ids de from/to apuntan a figuras del mismo pedido. Usa \\n para saltos reales. Nunca uses <br>. mode=replace sustituye el dibujo; mode=append agrega elementos con ids nuevos.`),
);

server.registerTool(
  "list_projects",
  {
    description: "Lista proyectos de la Pizarra y sus hojas.",
    annotations: { readOnlyHint: true },
  },
  async () => textResult({ projects: almacen.listar() }),
);

server.registerTool(
  "create_project",
  {
    description:
      "Crea un proyecto nuevo en la Pizarra, con al menos una hoja (por defecto 'General').",
    inputSchema: z.object({
      name: z.string().min(1).max(80),
      sheets: z.array(z.string().min(1).max(80)).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ name, sheets }) => {
    try {
      const created = almacen.crearProyecto(name, sheets);
      const response = {
        project: created.id,
        name: created.nombre,
        sheets: created.hojas,
        url: urlFor(created.id, created.hojas[0].id),
      };
      return textResult(response, response);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "list_sheets",
  {
    description: "Lista las hojas de un proyecto en su orden actual.",
    inputSchema: z.object({ project: z.string() }),
    annotations: { readOnlyHint: true },
  },
  async ({ project: projectId }) => {
    try {
      const found = project(projectId);
      return textResult({
        project: found.id,
        name: found.nombre,
        sheets: found.hojas,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "read_sheet",
  {
    description:
      "Lee una hoja. Por defecto devuelve una escena compacta; full=true devuelve el JSON Excalidraw completo.",
    inputSchema: z.object({
      project: z.string(),
      sheet: z.string(),
      full: z.boolean().optional().default(false),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ project: projectId, sheet: sheetId, full }) => {
    try {
      const { scene, etag } = readScene(projectId, sheetId);
      const result = {
        project: projectId,
        sheet: sheetId,
        etag,
        url: urlFor(projectId, sheetId),
        scene: full ? scene : compactScene(scene),
      };
      return textResult(result, result);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "preview_sheet",
  {
    description:
      "Renderiza una hoja como PNG y la muestra directamente en la conversacion, sin abrir el navegador.",
    inputSchema: z.object({
      project: z.string(),
      sheet: z.string(),
      max_width: z.number().int().min(320).max(2000).optional().default(1400),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ project: projectId, sheet: sheetId, max_width: maxWidth }) => {
    try {
      const { scene, etag } = readScene(projectId, sheetId);
      const preview = renderScenePng(scene, { maxWidth });
      const metadata = {
        project: projectId,
        sheet: sheetId,
        etag,
        width: preview.width,
        height: preview.height,
        url: urlFor(projectId, sheetId),
      };
      return {
        content: [
          {
            type: "image",
            data: preview.png.toString("base64"),
            mimeType: "image/png",
          },
          { type: "text", text: JSON.stringify(metadata, null, 2) },
        ],
        structuredContent: metadata,
      };
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "create_sheet",
  {
    description:
      "Crea una hoja real, opcionalmente con un diagrama inicial abreviado.",
    inputSchema: z.object({
      project: z.string(),
      name: z.string().min(1).max(80),
      parent: z.string().nullable().optional().default(null),
      elements: z.string().optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ project: projectId, name, parent, elements }) => {
    try {
      project(projectId);
      const scene = elements ? makeScene(parseElements(elements)) : undefined;
      const result = almacen.crearHoja(
        projectId,
        name,
        scene ? JSON.stringify(scene, null, 2) : undefined,
        parent,
      );
      const response = {
        project: projectId,
        sheet: result.hoja,
        url: urlFor(projectId, result.hoja.id),
      };
      return textResult(response, response);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "write_diagram",
  {
    description:
      "Reemplaza o amplia el diagrama de una hoja usando elementos Excalidraw abreviados.",
    inputSchema: z.object({
      project: z.string(),
      sheet: z.string(),
      elements: z.string(),
      mode: z.enum(["replace", "append"]).optional().default("replace"),
      expected_etag: z.string().optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({
    project: projectId,
    sheet: sheetId,
    elements,
    mode,
    expected_etag: expectedEtag,
  }) => {
    try {
      const current = readScene(projectId, sheetId);
      if (expectedEtag && expectedEtag !== current.etag) {
        throw new Error(`ETag desactualizado. Actual: ${current.etag}`);
      }
      const incoming = parseElements(elements);
      const next =
        mode === "append"
          ? {
              ...current.scene,
              elements: [...current.scene.elements, ...incoming],
              source: "pizarra-mcp",
            }
          : makeScene(incoming, current.scene.appState);
      const { etag } = almacen.guardarHoja(
        projectId,
        sheetId,
        JSON.stringify(next, null, 2),
        current.etag,
      );
      const response = {
        ok: true,
        project: projectId,
        sheet: sheetId,
        mode,
        elements: next.elements.length,
        etag,
        url: urlFor(projectId, sheetId),
      };
      return textResult(response, response);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "write_scene",
  {
    description:
      "Reemplaza una hoja con una escena Excalidraw estandar completa. Uso avanzado.",
    inputSchema: z.object({
      project: z.string(),
      sheet: z.string(),
      scene: z.string(),
      expected_etag: z.string().optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({
    project: projectId,
    sheet: sheetId,
    scene,
    expected_etag: expectedEtag,
  }) => {
    try {
      const current = readScene(projectId, sheetId);
      if (expectedEtag && expectedEtag !== current.etag) {
        throw new Error(`ETag desactualizado. Actual: ${current.etag}`);
      }
      const parsed = JSON.parse(scene);
      if (parsed?.type !== "excalidraw" || !Array.isArray(parsed.elements)) {
        throw new Error("scene no tiene formato Excalidraw");
      }
      if (/<br\s*\/?>/i.test(scene)) {
        throw new Error("La escena contiene <br>; usa saltos de linea reales");
      }
      const { etag } = almacen.guardarHoja(
        projectId,
        sheetId,
        JSON.stringify(parsed, null, 2),
        current.etag,
      );
      const response = { ok: true, etag, url: urlFor(projectId, sheetId) };
      return textResult(response, response);
    } catch (error) {
      return fail(error);
    }
  },
);

const CAMPOS_PATCHEABLES = [
  "x",
  "y",
  "width",
  "height",
  "backgroundColor",
  "strokeColor",
  "text",
];

server.registerTool(
  "patch_elements",
  {
    description:
      "Modifica campos puntuales (posicion, tamano, color, texto) de elementos YA EXISTENTES por id, sin tocar nada mas de la escena. A diferencia de write_scene, que te obliga a retipear la escena entera, patch_elements nunca puede romper containerId/boundElements/groupIds de un elemento que no pediste tocar: el servidor edita el objeto guardado en el lugar, no un JSON que reconstruiste vos. Usala siempre que el cambio sea mover, recolorear o cambiar el texto de algo que ya existe (por ejemplo, mover una tarjeta entre columnas de un Kanban); reserva write_diagram/write_scene para crear contenido nuevo o reestructurar el dibujo entero.",
    inputSchema: z.object({
      project: z.string(),
      sheet: z.string(),
      expected_etag: z.string().optional(),
      patches: z
        .array(
          z
            .object({
              id: z.string(),
              x: z.number().optional(),
              y: z.number().optional(),
              width: z.number().optional(),
              height: z.number().optional(),
              backgroundColor: z.string().optional(),
              strokeColor: z.string().optional(),
              text: z.string().optional(),
            })
            .refine(
              (patch) =>
                CAMPOS_PATCHEABLES.some((campo) => patch[campo] !== undefined),
              { message: "cada patch necesita al menos un campo ademas de id" },
            ),
        )
        .min(1),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({
    project: projectId,
    sheet: sheetId,
    expected_etag: expectedEtag,
    patches,
  }) => {
    try {
      const current = readScene(projectId, sheetId);
      if (expectedEtag && expectedEtag !== current.etag) {
        throw new Error(`ETag desactualizado. Actual: ${current.etag}`);
      }
      if (patches.some((patch) => /<br\s*\/?>/i.test(patch.text ?? ""))) {
        throw new Error("No uses <br>; usa \\n dentro del texto JSON");
      }
      const porId = new Map(
        current.scene.elements.map((element) => [element.id, element]),
      );
      const idsVistos = new Set();
      const tocados = [];
      for (const patch of patches) {
        if (idsVistos.has(patch.id)) {
          throw new Error(`Id repetido en la misma llamada: ${patch.id}`);
        }
        idsVistos.add(patch.id);
        const element = porId.get(patch.id);
        if (!element || element.isDeleted) {
          throw new Error(`Elemento inexistente o borrado: ${patch.id}`);
        }
        if (patch.text !== undefined && element.type !== "text") {
          throw new Error(
            `${patch.id} es "${element.type}", no "text": no acepta el campo text`,
          );
        }
        for (const campo of CAMPOS_PATCHEABLES) {
          if (patch[campo] !== undefined) {
            element[campo] = patch[campo];
          }
        }
        element.version += 1;
        element.versionNonce = crypto.randomInt(1, 2_147_483_647);
        element.updated = Date.now();
        tocados.push(patch.id);
      }
      const next = { ...current.scene, source: "pizarra-mcp" };
      const { etag } = almacen.guardarHoja(
        projectId,
        sheetId,
        JSON.stringify(next, null, 2),
        current.etag,
      );
      const response = {
        ok: true,
        project: projectId,
        sheet: sheetId,
        patched: tocados,
        etag,
        url: urlFor(projectId, sheetId),
      };
      return textResult(response, response);
    } catch (error) {
      return fail(error);
    }
  },
);

const soloTexto = (element, campo) => {
  if (!element || element.isDeleted) {
    throw new Error(`Elemento inexistente o borrado: ${campo}`);
  }
  return element;
};

server.registerTool(
  "bind_elements",
  {
    description:
      "Crea relaciones NATIVAS de Excalidraw entre elementos que YA EXISTEN, sin mover ni recolorear nada: texto dentro de una figura (containerId/boundElements, como cuando escribis adentro de un rectangulo en la app), agrupar varios elementos para que se arrastren juntos (groupIds), o atar un extremo de flecha a una figura para que la siga si se mueve (startBinding/endBinding). Usala despues de crear elementos con write_diagram/write_scene cuando quieras que un nodo (figura + texto + flechas que le llegan) se comporte como un solo bloque en la app, igual que un elemento armado a mano.",
    inputSchema: z.object({
      project: z.string(),
      sheet: z.string(),
      expected_etag: z.string().optional(),
      contain: z
        .array(z.object({ container: z.string(), text: z.string() }))
        .optional(),
      group: z
        .array(
          z.object({
            ids: z.array(z.string()).min(2),
            group_id: z.string().optional(),
          }),
        )
        .optional(),
      arrow_bind: z
        .array(
          z.object({
            arrow: z.string(),
            end: z.enum(["start", "end"]),
            target: z.string(),
            fixed_point: z
              .tuple([z.number(), z.number()])
              .optional()
              .default([0.5, 0.5]),
          }),
        )
        .optional(),
    }).refine(
      (v) =>
        (v.contain?.length ?? 0) +
          (v.group?.length ?? 0) +
          (v.arrow_bind?.length ?? 0) >
        0,
      { message: "pasa al menos un contain, group o arrow_bind" },
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({
    project: projectId,
    sheet: sheetId,
    expected_etag: expectedEtag,
    contain,
    group,
    arrow_bind: arrowBind,
  }) => {
    try {
      const current = readScene(projectId, sheetId);
      if (expectedEtag && expectedEtag !== current.etag) {
        throw new Error(`ETag desactualizado. Actual: ${current.etag}`);
      }
      const porId = new Map(
        current.scene.elements.map((element) => [element.id, element]),
      );
      const tocar = (element) => {
        element.version += 1;
        element.versionNonce = crypto.randomInt(1, 2_147_483_647);
        element.updated = Date.now();
      };
      const anotados = { contain: 0, group: 0, arrow_bind: 0 };

      for (const { container: containerId, text: textId } of contain ?? []) {
        const containerEl = soloTexto(porId.get(containerId), containerId);
        const textEl = soloTexto(porId.get(textId), textId);
        if (textEl.type !== "text") {
          throw new Error(`${textId} no es un elemento de texto`);
        }
        if (["arrow", "line"].includes(containerEl.type)) {
          throw new Error(
            `${containerId} es una flecha/linea: usa arrow_bind, no contain`,
          );
        }
        textEl.containerId = containerEl.id;
        if (!containerEl.boundElements.some((b) => b.id === textEl.id)) {
          containerEl.boundElements.push({ id: textEl.id, type: "text" });
        }
        tocar(textEl);
        tocar(containerEl);
        anotados.contain += 1;
      }

      for (const { ids, group_id: groupIdIn } of group ?? []) {
        const groupId = groupIdIn || crypto.randomBytes(12).toString("base64url");
        for (const elId of ids) {
          const element = soloTexto(porId.get(elId), elId);
          if (!element.groupIds.includes(groupId)) {
            element.groupIds.push(groupId);
            tocar(element);
          }
        }
        anotados.group += 1;
      }

      for (const {
        arrow: arrowId,
        end,
        target: targetId,
        fixed_point: fixedPoint,
      } of arrowBind ?? []) {
        const arrowEl = soloTexto(porId.get(arrowId), arrowId);
        if (!["arrow", "line"].includes(arrowEl.type)) {
          throw new Error(`${arrowId} no es una flecha ni una linea`);
        }
        const targetEl = soloTexto(porId.get(targetId), targetId);
        const campo = end === "start" ? "startBinding" : "endBinding";
        arrowEl[campo] = {
          elementId: targetEl.id,
          focus: 0,
          gap: 4,
          fixedPoint,
        };
        if (!targetEl.boundElements.some((b) => b.id === arrowEl.id)) {
          targetEl.boundElements.push({ id: arrowEl.id, type: arrowEl.type });
        }
        tocar(arrowEl);
        tocar(targetEl);
        anotados.arrow_bind += 1;
      }

      const next = { ...current.scene, source: "pizarra-mcp" };
      const { etag } = almacen.guardarHoja(
        projectId,
        sheetId,
        JSON.stringify(next, null, 2),
        current.etag,
      );
      const response = {
        ok: true,
        project: projectId,
        sheet: sheetId,
        applied: anotados,
        etag,
        url: urlFor(projectId, sheetId),
      };
      return textResult(response, response);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "rename_sheet",
  {
    description: "Renombra una hoja sin cambiar su id ni su contenido.",
    inputSchema: z.object({
      project: z.string(),
      sheet: z.string(),
      name: z.string().min(1).max(80),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ project: projectId, sheet: sheetId, name }) => {
    try {
      sheet(projectId, sheetId);
      const result = almacen.renombrarHoja(projectId, sheetId, name);
      return textResult({ ok: true, project: result });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "move_sheet",
  {
    description:
      "Cambia el nivel de una hoja: parent=id la convierte en sub-hoja; parent=null la sube a la raiz. Rechaza ciclos.",
    inputSchema: z.object({
      project: z.string(),
      sheet: z.string(),
      parent: z.string().nullable(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ project: projectId, sheet: sheetId, parent }) => {
    try {
      sheet(projectId, sheetId);
      if (parent !== null) {
        sheet(projectId, parent);
      }
      const result = almacen.moverHoja(projectId, sheetId, parent);
      const moved = result.hojas.find((item) => item.id === sheetId);
      const response = {
        ok: true,
        project: projectId,
        sheet: moved,
        url: urlFor(projectId, sheetId),
      };
      return textResult(response, response);
    } catch (error) {
      return fail(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
