import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { WebSocket } from "ws";

import { crearServidor } from "./server.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pizarra-ws-test-"));
const staticDir = path.join(tmp, "build");
fs.mkdirSync(staticDir, { recursive: true });
fs.writeFileSync(path.join(staticDir, "index.html"), "<title>app</title>");

const levantar = async (opts) => {
  const server = crearServidor({ staticDir, ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
};

const escena = (texto) =>
  JSON.stringify({
    type: "excalidraw",
    version: 2,
    elements: [{ id: "a", type: "text", text: texto }],
    appState: {},
    files: {},
  });

describe("relay WebSocket", () => {
  let server;
  let base;
  const dataDir = path.join(tmp, "data");

  before(async () => {
    ({ server, base } = await levantar({ dataDir, sinAuth: true }));
  });
  after(() => server.close());

  test("avisa por WebSocket cuando se guarda la hoja de la sala", async () => {
    const proyecto = await (
      await fetch(`${base}/api/proyectos`, {
        method: "POST",
        body: JSON.stringify({ nombre: "WsTest", hojas: ["Tablero"] }),
      })
    ).json();
    const p = proyecto.id;
    const h = proyecto.hojas[0].id;

    const wsUrl = `${base.replace("http", "ws")}/ws`;
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    ws.send(JSON.stringify({ tipo: "unirse", proyecto: p, hoja: h }));

    const mensajePromise = new Promise((resolve) => {
      ws.on("message", (datos) => resolve(JSON.parse(datos.toString())));
    });

    // Da tiempo a que el servidor procese "unirse" antes del PUT.
    await new Promise((r) => setTimeout(r, 50));

    const url = `${base}/api/proyectos/${p}/hojas/${h}`;
    const etag = (await fetch(url)).headers.get("etag");
    const res = await fetch(url, {
      method: "PUT",
      headers: { "If-Match": etag },
      body: escena("hola desde ws"),
    });
    assert.equal(res.status, 200);

    const mensaje = await mensajePromise;
    assert.deepEqual(mensaje, { tipo: "cambio", proyecto: p, hoja: h });

    ws.close();
  });
});
