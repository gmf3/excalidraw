import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { crearAlmacen } from "../pizarra-server/server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("MCP crea y lee una hoja persistente sin navegador", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pizarra-mcp-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  crearAlmacen(dataDir).crearProyecto("ONCOVET IA", ["General"]);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "server.mjs")],
    env: {
      ...process.env,
      PIZARRA_DATA_DIR: dataDir,
      PIZARRA_PUBLIC_URL: "https://pizarra.example",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "pizarra-mcp-test", version: "1.0.0" });
  t.after(async () => client.close());
  await client.connect(transport);

  const listed = await client.listTools();
  assert(listed.tools.some((tool) => tool.name === "write_diagram"));
  assert(listed.tools.some((tool) => tool.name === "move_sheet"));
  assert(listed.tools.some((tool) => tool.name === "preview_sheet"));
  assert(listed.tools.some((tool) => tool.name === "create_project"));

  const project = await client.callTool({
    name: "create_project",
    arguments: { name: "Sistema de pedidos" },
  });
  assert.equal(project.isError, undefined);
  assert.match(project.content[0].text, /"project": "sistema-de-pedidos"/);
  assert.match(project.content[0].text, /"nombre": "General"/);

  const projects = await client.callTool({ name: "list_projects", arguments: {} });
  assert.match(projects.content[0].text, /"id": "sistema-de-pedidos"/);

  const stack = await client.callTool({
    name: "create_sheet",
    arguments: { project: "oncovet-ia", name: "Stack" },
  });
  assert.equal(stack.isError, undefined);

  const created = await client.callTool({
    name: "create_sheet",
    arguments: {
      project: "oncovet-ia",
      name: "Front",
      elements: JSON.stringify([
        {
          id: "web",
          type: "rectangle",
          x: 40,
          y: 80,
          width: 240,
          height: 100,
          label: "Web\nvanilla JS",
        },
      ]),
    },
  });
  assert.equal(created.isError, undefined);
  assert.match(created.content[0].text, /"id": "front"/);

  const moved = await client.callTool({
    name: "move_sheet",
    arguments: { project: "oncovet-ia", sheet: "front", parent: "stack" },
  });
  assert.equal(moved.isError, undefined);
  assert.match(moved.content[0].text, /"padre": "stack"/);

  const cycle = await client.callTool({
    name: "move_sheet",
    arguments: { project: "oncovet-ia", sheet: "stack", parent: "front" },
  });
  assert.equal(cycle.isError, true);
  assert.match(cycle.content[0].text, /no puede quedar dentro/);

  const read = await client.callTool({
    name: "read_sheet",
    arguments: { project: "oncovet-ia", sheet: "front", full: false },
  });
  assert.equal(read.isError, undefined);
  assert.match(read.content[0].text, /Web\\nvanilla JS/);

  const preview = await client.callTool({
    name: "preview_sheet",
    arguments: { project: "oncovet-ia", sheet: "front", max_width: 800 },
  });
  assert.equal(preview.isError, undefined);
  assert.equal(preview.content[0].type, "image");
  assert.equal(preview.content[0].mimeType, "image/png");
  assert.equal(
    Buffer.from(preview.content[0].data, "base64").subarray(1, 4).toString(),
    "PNG",
  );
  assert.equal(preview.structuredContent.width, 800);
  assert.equal(
    fs.existsSync(path.join(dataDir, "oncovet-ia", "front.excalidraw")),
    true,
  );
});

test("patch_elements mueve y recolorea sin romper containerId/boundElements/groupIds ajenos", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pizarra-mcp-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  crearAlmacen(dataDir).crearProyecto("Sistema de pedidos", ["Pendientes"]);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "server.mjs")],
    env: {
      ...process.env,
      PIZARRA_DATA_DIR: dataDir,
      PIZARRA_PUBLIC_URL: "https://pizarra.example",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "pizarra-mcp-test", version: "1.0.0" });
  t.after(async () => client.close());
  await client.connect(transport);

  // Un texto NATIVO dentro de un rectángulo (containerId/boundElements reales,
  // no el patrón de label agrupado de elementsFromSkeleton): es justo lo que
  // write_scene rompía cuando el agente reconstruía la escena a mano.
  const escenaInicial = {
    type: "excalidraw",
    version: 2,
    source: "test",
    elements: [
      {
        id: "tarjeta",
        type: "rectangle",
        x: 10,
        y: 10,
        width: 200,
        height: 80,
        backgroundColor: "#fef3c7",
        strokeColor: "#d97706",
        groupIds: ["grupo-tarjeta"],
        boundElements: [{ id: "titulo", type: "text" }],
        version: 1,
        versionNonce: 1,
        isDeleted: false,
      },
      {
        id: "titulo",
        type: "text",
        x: 20,
        y: 30,
        width: 180,
        height: 25,
        text: "T080-011",
        containerId: "tarjeta",
        groupIds: ["grupo-tarjeta"],
        boundElements: [],
        version: 1,
        versionNonce: 1,
        isDeleted: false,
      },
    ],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
  const escrita = await client.callTool({
    name: "write_scene",
    arguments: {
      project: "sistema-de-pedidos",
      sheet: "pendientes",
      scene: JSON.stringify(escenaInicial),
    },
  });
  assert.equal(escrita.isError, undefined);

  const patched = await client.callTool({
    name: "patch_elements",
    arguments: {
      project: "sistema-de-pedidos",
      sheet: "pendientes",
      patches: [
        { id: "tarjeta", x: 300, backgroundColor: "#dcfce7" },
        { id: "titulo", x: 310, text: "T080-011 (listo)" },
      ],
    },
  });
  assert.equal(patched.isError, undefined);
  assert.deepEqual(JSON.parse(patched.content[0].text).patched, [
    "tarjeta",
    "titulo",
  ]);

  const releida = await client.callTool({
    name: "read_sheet",
    arguments: { project: "sistema-de-pedidos", sheet: "pendientes", full: true },
  });
  const escena = JSON.parse(releida.content[0].text).scene;
  const tarjeta = escena.elements.find((el) => el.id === "tarjeta");
  const titulo = escena.elements.find((el) => el.id === "titulo");

  assert.equal(tarjeta.x, 300, "el campo pedido sí cambió");
  assert.equal(tarjeta.backgroundColor, "#dcfce7");
  assert.equal(titulo.x, 310);
  assert.equal(titulo.text, "T080-011 (listo)");
  // Lo que NO se pidió tocar sigue byte a byte igual: el binding nativo sobrevive.
  assert.equal(tarjeta.y, 10);
  assert.deepEqual(tarjeta.boundElements, [{ id: "titulo", type: "text" }]);
  assert.deepEqual(tarjeta.groupIds, ["grupo-tarjeta"]);
  assert.equal(titulo.containerId, "tarjeta");
  assert.deepEqual(titulo.groupIds, ["grupo-tarjeta"]);
  assert.equal(titulo.y, 30);

  const rechazoBorrado = await client.callTool({
    name: "patch_elements",
    arguments: {
      project: "sistema-de-pedidos",
      sheet: "pendientes",
      patches: [{ id: "no-existe", x: 0 }],
    },
  });
  assert.equal(rechazoBorrado.isError, true);
  assert.match(rechazoBorrado.content[0].text, /inexistente o borrado/);

  const rechazoTextoEnFigura = await client.callTool({
    name: "patch_elements",
    arguments: {
      project: "sistema-de-pedidos",
      sheet: "pendientes",
      patches: [{ id: "tarjeta", text: "esto no es texto" }],
    },
  });
  assert.equal(rechazoTextoEnFigura.isError, true);
  assert.match(rechazoTextoEnFigura.content[0].text, /no acepta el campo text/);
});

test("bind_elements ata texto a figura, agrupa y liga una flecha, sin mover nada", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pizarra-mcp-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  crearAlmacen(dataDir).crearProyecto("Sistema de pedidos", ["Pendientes"]);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "server.mjs")],
    env: {
      ...process.env,
      PIZARRA_DATA_DIR: dataDir,
      PIZARRA_PUBLIC_URL: "https://pizarra.example",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "pizarra-mcp-test", version: "1.0.0" });
  t.after(async () => client.close());
  await client.connect(transport);

  // Dos nodos (figura + texto SUELTOS, como los deja write_diagram) y una flecha
  // sin bindear entre ellos: el estado real que dejó este mismo agente en
  // sistema-de-pedidos/pendientes antes de este fix.
  const escenaInicial = {
    type: "excalidraw",
    version: 2,
    source: "test",
    elements: [
      {
        id: "nodoA",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 200,
        height: 80,
        groupIds: [],
        boundElements: [],
        version: 1,
        versionNonce: 1,
        isDeleted: false,
      },
      {
        id: "textoA",
        type: "text",
        x: 10,
        y: 10,
        width: 100,
        height: 25,
        text: "Nodo A",
        containerId: null,
        groupIds: [],
        boundElements: [],
        version: 1,
        versionNonce: 1,
        isDeleted: false,
      },
      {
        id: "nodoB",
        type: "rectangle",
        x: 300,
        y: 0,
        width: 200,
        height: 80,
        groupIds: [],
        boundElements: [],
        version: 1,
        versionNonce: 1,
        isDeleted: false,
      },
      {
        id: "flecha",
        type: "arrow",
        x: 200,
        y: 40,
        width: 100,
        height: 0,
        points: [
          [0, 0],
          [100, 0],
        ],
        startBinding: null,
        endBinding: null,
        groupIds: [],
        boundElements: [],
        version: 1,
        versionNonce: 1,
        isDeleted: false,
      },
    ],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
  const escrita = await client.callTool({
    name: "write_scene",
    arguments: {
      project: "sistema-de-pedidos",
      sheet: "pendientes",
      scene: JSON.stringify(escenaInicial),
    },
  });
  assert.equal(escrita.isError, undefined);

  const bound = await client.callTool({
    name: "bind_elements",
    arguments: {
      project: "sistema-de-pedidos",
      sheet: "pendientes",
      contain: [{ container: "nodoA", text: "textoA" }],
      group: [{ ids: ["nodoA", "textoA"], group_id: "grupo-a" }],
      arrow_bind: [{ arrow: "flecha", end: "end", target: "nodoB" }],
    },
  });
  assert.equal(bound.isError, undefined);
  const resultado = JSON.parse(bound.content[0].text);
  assert.deepEqual(resultado.applied, { contain: 1, group: 1, arrow_bind: 1 });

  const releida = await client.callTool({
    name: "read_sheet",
    arguments: { project: "sistema-de-pedidos", sheet: "pendientes", full: true },
  });
  const escena = JSON.parse(releida.content[0].text).scene;
  const nodoA = escena.elements.find((el) => el.id === "nodoA");
  const textoA = escena.elements.find((el) => el.id === "textoA");
  const nodoB = escena.elements.find((el) => el.id === "nodoB");
  const flecha = escena.elements.find((el) => el.id === "flecha");

  assert.equal(textoA.containerId, "nodoA");
  assert.deepEqual(nodoA.boundElements, [{ id: "textoA", type: "text" }]);
  assert.deepEqual(nodoA.groupIds, ["grupo-a"]);
  assert.deepEqual(textoA.groupIds, ["grupo-a"]);
  assert.equal(flecha.endBinding.elementId, "nodoB");
  assert.deepEqual(nodoB.boundElements, [{ id: "flecha", type: "arrow" }]);
  // Nada de posicion, tamano ni color cambio.
  assert.equal(nodoA.x, 0);
  assert.equal(textoA.x, 10);
  assert.equal(nodoB.x, 300);

  const rechazoInexistente = await client.callTool({
    name: "bind_elements",
    arguments: {
      project: "sistema-de-pedidos",
      sheet: "pendientes",
      contain: [{ container: "nodoA", text: "no-existe" }],
    },
  });
  assert.equal(rechazoInexistente.isError, true);
  assert.match(rechazoInexistente.content[0].text, /inexistente o borrado/);

  const rechazoNoTexto = await client.callTool({
    name: "bind_elements",
    arguments: {
      project: "sistema-de-pedidos",
      sheet: "pendientes",
      contain: [{ container: "nodoA", text: "nodoB" }],
    },
  });
  assert.equal(rechazoNoTexto.isError, true);
  assert.match(rechazoNoTexto.content[0].text, /no es un elemento de texto/);
});
