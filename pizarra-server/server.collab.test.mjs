import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { io as ioClient } from "socket.io-client";

import { crearServidor, crearAuth } from "./server.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pizarra-collab-test-"));
const staticDir = path.join(tmp, "build");
fs.mkdirSync(staticDir, { recursive: true });
fs.writeFileSync(path.join(staticDir, "index.html"), "<title>app</title>");

const levantar = async (opts) => {
  const server = crearServidor({ staticDir, ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
};

/**
 * Conecta y se une a una sala, igual que Portal.open() de verdad: el
 * listener de "init-room" (que dispara el join-room) se registra ANTES de
 * conectar, porque el servidor lo emite apenas acepta la conexión — si el
 * listener llega tarde (después de un await), el mensaje ya se perdió.
 */
const conectarYUnirse = (base, roomId, opts = {}) => {
  const socket = ioClient(base, { transports: ["websocket"], ...opts });
  socket.on("init-room", () => socket.emit("join-room", roomId));
  return socket;
};

const esperarConexion = (socket) =>
  new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });

const esperar = (socket, evento) =>
  new Promise((resolve) => socket.once(evento, (...args) => resolve(args)));

describe("colaboración en vivo (socket.io)", () => {
  let server;
  let base;

  before(async () => {
    ({ server, base } = await levantar({
      dataDir: path.join(tmp, "data"),
      sinAuth: true,
    }));
  });
  after(() => server.close());

  test("primero en la sala recibe first-in-room, el segundo dispara new-user y se ven en room-user-change", async () => {
    const a = conectarYUnirse(base, "proyecto-x/hoja-y");
    const aEnSala = esperar(a, "first-in-room");
    await esperarConexion(a);
    await aEnSala;

    const aVeNuevoUsuario = esperar(a, "new-user");
    const b = conectarYUnirse(base, "proyecto-x/hoja-y");
    const bCambioDeSala = esperar(b, "room-user-change");
    await esperarConexion(b);

    const [idDeB] = await aVeNuevoUsuario;
    assert.equal(idDeB, b.id);
    const [roster] = await bCambioDeSala;
    assert.deepEqual([...roster].sort(), [a.id, b.id].sort());

    a.close();
    b.close();
  });

  test("server-broadcast llega como client-broadcast a los demás, no al emisor", async () => {
    const a = conectarYUnirse(base, "otra-sala");
    const b = conectarYUnirse(base, "otra-sala");
    await Promise.all([esperarConexion(a), esperarConexion(b)]);
    await new Promise((r) => setTimeout(r, 100));

    let aRecibio = false;
    a.once("client-broadcast", () => {
      aRecibio = true;
    });
    const bRecibe = esperar(b, "client-broadcast");

    const buffer = new Uint8Array([1, 2, 3]).buffer;
    const iv = new Uint8Array([9, 9, 9]);
    a.emit("server-broadcast", "otra-sala", buffer, iv);

    const [datos] = await bRecibe;
    assert.deepEqual([...new Uint8Array(datos)], [1, 2, 3]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(aRecibio, false);

    a.close();
    b.close();
  });

  test("al desconectarse, los que quedan reciben room-user-change sin el que se fue", async () => {
    const a = conectarYUnirse(base, "sala-adios");
    const b = conectarYUnirse(base, "sala-adios");
    await Promise.all([esperarConexion(a), esperarConexion(b)]);
    await new Promise((r) => setTimeout(r, 100));

    const aVeCambio = esperar(a, "room-user-change");
    b.close();
    const [roster] = await aVeCambio;
    assert.deepEqual(roster, [a.id]);

    a.close();
  });
});

describe("colaboración con contraseña", () => {
  let server;
  let base;
  const dataDir = path.join(tmp, "data-auth");

  before(async () => {
    await crearAuth(dataDir).cambiarContrasena("clave-larga-1");
    ({ server, base } = await levantar({ dataDir }));
  });
  after(() => server.close());

  test("sin cookie de sesión, la conexión socket.io se rechaza", async () => {
    const socket = ioClient(base, { transports: ["websocket"] });
    await assert.rejects(esperarConexion(socket));
  });
});
