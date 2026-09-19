#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { crearAlmacen } from "../pizarra-server/server.mjs";
import { compactScene, elementsFromSkeleton, makeScene } from "./scene.mjs";

const DATA_DIR = path.resolve(process.env.PIZARRA_DATA_DIR || "./data");
const PUBLIC_URL = (
  process.env.PIZARRA_PUBLIC_URL || "https://pizarra.ultragfe.uk"
).replace(/\/$/, "");
const almacen = crearAlmacen(DATA_DIR);

const instructions = `Edita la Pizarra persistente de pc3 directamente; no uses el navegador. Antes de escribir, lista proyectos y hojas y lee la hoja destino. write_diagram acepta elementos abreviados de Excalidraw y protege las escrituras con ETag. Usa saltos de linea JSON \\n; nunca uses etiquetas <br>. Las operaciones reemplazan o amplian una hoja real y son visibles en https://pizarra.ultragfe.uk.`;

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

const transport = new StdioServerTransport();
await server.connect(transport);
