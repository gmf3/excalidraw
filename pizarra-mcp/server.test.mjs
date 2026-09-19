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
