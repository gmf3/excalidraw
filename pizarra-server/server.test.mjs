import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { execFileSync } from "node:child_process";

import { crearAuth, crearServidor, slug } from "./server.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pizarra-test-"));
const staticDir = path.join(tmp, "build");
fs.mkdirSync(path.join(staticDir, "assets"), { recursive: true });
fs.writeFileSync(path.join(staticDir, "index.html"), "<title>app</title>");
fs.writeFileSync(path.join(staticDir, "assets", "a.js"), "console.log(1)");
fs.writeFileSync(path.join(tmp, "secreto.txt"), "no");

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

const escenaDeElementos = (elementos) =>
  JSON.stringify({
    type: "excalidraw",
    version: 2,
    elements: elementos,
    appState: {},
    files: {},
  });

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("slug normaliza tildes, espacios y símbolos", () => {
  assert.equal(slug("ChemovetGestión Web!"), "chemovetgestion-web");
  assert.equal(slug("  DevOps / CI  "), "devops-ci");
  assert.equal(slug("¿?"), "sin-nombre");
});

describe("API sin auth", () => {
  let server;
  let base;
  const dataDir = path.join(tmp, "data");

  before(async () => {
    ({ server, base } = await levantar({ dataDir, sinAuth: true }));
  });
  after(() => server.close());

  test("proyecto con hojas: crear, leer y guardar", async () => {
    let res = await fetch(`${base}/api/proyectos`, {
      method: "POST",
      body: JSON.stringify({
        nombre: "ChemovetGestión",
        hojas: ["Front", "Back", "DevOps", "Pendientes"],
      }),
    });
    assert.equal(res.status, 201);
    const proyecto = await res.json();
    assert.equal(proyecto.id, "chemovetgestion");
    assert.deepEqual(
      proyecto.hojas.map((h) => h.id),
      ["front", "back", "devops", "pendientes"],
    );

    const url = `${base}/api/proyectos/chemovetgestion/hojas/front`;
    res = await fetch(url);
    assert.equal(res.status, 200);
    const etag = res.headers.get("etag");
    assert.equal((await res.json()).elements.length, 0);

    res = await fetch(url, { headers: { "If-None-Match": etag } });
    assert.equal(res.status, 304);

    res = await fetch(url, { method: "PUT", body: escena("hola") });
    assert.equal(res.status, 428);

    res = await fetch(url, {
      method: "PUT",
      headers: { "If-Match": etag },
      body: escena("hola"),
    });
    assert.equal(res.status, 200);
    const etag2 = (await res.json()).etag;
    assert.notEqual(etag2, etag);

    const enDisco = JSON.parse(
      fs.readFileSync(
        path.join(dataDir, "chemovetgestion", "front.excalidraw"),
        "utf8",
      ),
    );
    assert.equal(enDisco.elements[0].text, "hola");
    // el primer guardado deja copia de la versión anterior
    assert.equal(
      fs.readdirSync(
        path.join(dataDir, "chemovetgestion", ".historial", "front"),
      ).length,
      1,
    );
  });

  test("un guardado con etag viejo fusiona en vez de rechazar", async () => {
    const hojas = `${base}/api/proyectos`;
    const proyecto = await (
      await fetch(hojas, {
        method: "POST",
        body: JSON.stringify({ nombre: "Fusion", hojas: ["tablero"] }),
      })
    ).json();
    const url = `${base}/api/proyectos/${proyecto.id}/hojas/tablero`;

    // Guillermo entra y guarda el elemento "a" (version 1) y "b" (version 1).
    let res = await fetch(url);
    const etagInicial = res.headers.get("etag");
    res = await fetch(url, {
      method: "PUT",
      headers: { "If-Match": etagInicial },
      body: escenaDeElementos([
        { id: "a", type: "text", text: "uno", version: 1, versionNonce: 1 },
        { id: "b", type: "text", text: "dos", version: 1, versionNonce: 1 },
      ]),
    });
    assert.equal(res.status, 200);
    const etagDeGuillermo = (await res.json()).etag;

    // Federico había cargado la hoja ANTES de eso (etagInicial, sin "a" ni
    // "b") y ahora guarda su propia versión de "a" en version 2 — no vio "b".
    res = await fetch(url, {
      method: "PUT",
      headers: { "If-Match": etagInicial },
      body: escenaDeElementos([
        {
          id: "a",
          type: "text",
          text: "uno-editado-por-federico",
          version: 2,
          versionNonce: 1,
        },
      ]),
    });
    assert.equal(res.status, 200);
    const { etag: etagFusionado, fusionado } = await res.json();
    assert.equal(fusionado, true);
    assert.notEqual(etagFusionado, etagDeGuillermo);

    const final = JSON.parse(
      fs.readFileSync(
        path.join(dataDir, proyecto.id, "tablero.excalidraw"),
        "utf8",
      ),
    );
    const porId = Object.fromEntries(final.elements.map((el) => [el.id, el]));
    // "a" quedó en la edición de Federico porque tiene mayor version...
    assert.equal(porId.a.text, "uno-editado-por-federico");
    // ...y "b" (que Federico nunca vio) no se perdió.
    assert.equal(porId.b.text, "dos");
  });

  test("una edición externa del archivo cambia el etag", async () => {
    const url = `${base}/api/proyectos/chemovetgestion/hojas/back`;
    const etag = (await fetch(url)).headers.get("etag");
    fs.writeFileSync(
      path.join(dataDir, "chemovetgestion", "back.excalidraw"),
      escena("editado por IA"),
    );
    const res = await fetch(url, { headers: { "If-None-Match": etag } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).elements[0].text, "editado por IA");
  });

  test("hojas: crear con escena, renombrar, ordenar y borrar", async () => {
    const hojas = `${base}/api/proyectos/chemovetgestion/hojas`;
    let res = await fetch(hojas, {
      method: "POST",
      body: JSON.stringify({
        nombre: "Front",
        escena: JSON.parse(escena("copia")),
      }),
    });
    assert.equal(res.status, 201);
    const { hoja } = await res.json();
    assert.equal(hoja.id, "front-2");

    res = await fetch(`${hojas}/front-2`, {
      method: "PATCH",
      body: JSON.stringify({ nombre: "Front (conflicto)" }),
    });
    assert.equal((await res.json()).hojas.at(-1).nombre, "Front (conflicto)");

    res = await fetch(`${base}/api/proyectos/chemovetgestion/orden`, {
      method: "PUT",
      body: JSON.stringify({
        hojas: ["pendientes", "front", "front-2", "back", "devops"],
      }),
    });
    assert.equal((await res.json()).hojas[0].id, "pendientes");

    res = await fetch(`${base}/api/proyectos/chemovetgestion/orden`, {
      method: "PUT",
      body: JSON.stringify({ hojas: ["front"] }),
    });
    assert.equal(res.status, 400);

    res = await fetch(`${hojas}/front-2`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.equal(fs.readdirSync(path.join(dataDir, ".papelera")).length, 1);
  });

  test("hojas: árbol de sub-hojas a varios niveles", async () => {
    const hojas = `${base}/api/proyectos/chemovetgestion/hojas`;

    let res = await fetch(hojas, {
      method: "POST",
      body: JSON.stringify({ nombre: "Componentes", padre: "front" }),
    });
    assert.equal(res.status, 201);
    const { hoja: componentes } = await res.json();
    assert.equal(componentes.padre, "front");

    res = await fetch(hojas, {
      method: "POST",
      body: JSON.stringify({ nombre: "Botón", padre: componentes.id }),
    });
    assert.equal(res.status, 201);
    const { hoja: boton, proyecto } = await res.json();
    assert.equal(boton.padre, "componentes");
    assert.deepEqual(
      proyecto.hojas.map((h) => [h.id, h.padre]),
      [
        ["pendientes", null],
        ["front", null],
        ["back", null],
        ["devops", null],
        ["componentes", "front"],
        ["boton", "componentes"],
      ],
    );

    res = await fetch(`${hojas}/boton`, {
      method: "PATCH",
      body: JSON.stringify({ padre: "front" }),
    });
    assert.equal(res.status, 200);
    assert.equal(
      (await res.json()).hojas.find((h) => h.id === "boton").padre,
      "front",
    );

    res = await fetch(`${hojas}/boton`, {
      method: "PATCH",
      body: JSON.stringify({ padre: null }),
    });
    assert.equal(res.status, 200);
    assert.equal(
      (await res.json()).hojas.find((h) => h.id === "boton").padre,
      null,
    );

    res = await fetch(`${hojas}/boton`, {
      method: "PATCH",
      body: JSON.stringify({ padre: "componentes" }),
    });
    assert.equal(res.status, 200);

    res = await fetch(`${hojas}/componentes`, {
      method: "PATCH",
      body: JSON.stringify({ padre: "boton" }),
    });
    assert.equal(res.status, 400);

    res = await fetch(`${hojas}/front`, {
      method: "PATCH",
      body: JSON.stringify({ padre: "front" }),
    });
    assert.equal(res.status, 400);

    res = await fetch(`${hojas}/boton`, {
      method: "PATCH",
      body: JSON.stringify({ padre: "no-existe" }),
    });
    assert.equal(res.status, 404);

    res = await fetch(hojas, {
      method: "POST",
      body: JSON.stringify({ nombre: "Huérfana", padre: "no-existe" }),
    });
    assert.equal(res.status, 404);

    // borrar "Componentes" se lleva en cascada a "Botón" (su sub-hoja),
    // pero no toca a "front" ni al resto
    res = await fetch(`${hojas}/componentes`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const idsRestantes = (await res.json()).hojas.map((h) => h.id);
    assert.deepEqual(idsRestantes.sort(), [
      "back",
      "devops",
      "front",
      "pendientes",
    ]);
    const papelera = fs.readdirSync(path.join(dataDir, ".papelera"));
    for (const id of ["componentes", "boton"]) {
      assert.ok(
        papelera.some((n) =>
          n.startsWith(`chemovetgestion__${id}.excalidraw__`),
        ),
        `${id} no fue a la papelera`,
      );
    }
  });

  test("no borra si la cascada dejaría el proyecto sin hojas", async () => {
    // servidor aparte: no debe figurar en el listado de "chemovetgestion"/"solo"
    const { server: s, base: b } = await levantar({
      dataDir: path.join(tmp, "data-arbol"),
      sinAuth: true,
    });
    let res = await fetch(`${b}/api/proyectos`, {
      method: "POST",
      body: JSON.stringify({ nombre: "Arbolito" }),
    });
    const raiz = (await res.json()).hojas[0].id;
    const hojas = `${b}/api/proyectos/arbolito/hojas`;
    res = await fetch(hojas, {
      method: "POST",
      body: JSON.stringify({ nombre: "Hijo", padre: raiz }),
    });
    const { hoja: hijo } = await res.json();
    res = await fetch(hojas, {
      method: "POST",
      body: JSON.stringify({ nombre: "Nieto", padre: hijo.id }),
    });
    assert.equal(res.status, 201);

    res = await fetch(`${b}/api/proyectos/arbolito/hojas/${raiz}`, {
      method: "DELETE",
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /al menos una hoja/);
    s.close();
  });

  test("no se puede borrar la última hoja", async () => {
    await fetch(`${base}/api/proyectos`, {
      method: "POST",
      body: JSON.stringify({ nombre: "Solo" }),
    });
    const res = await fetch(`${base}/api/proyectos/solo/hojas/general`, {
      method: "DELETE",
    });
    assert.equal(res.status, 400);
  });

  test("rechaza ids con rutas y escenas inválidas", async () => {
    let res = await fetch(`${base}/api/proyectos/..%2F..%2Fetc/hojas/passwd`);
    assert.equal(res.status, 404);
    res = await fetch(`${base}/api/proyectos/chemovetgestion/hojas/front`);
    const etag = res.headers.get("etag");
    res = await fetch(`${base}/api/proyectos/chemovetgestion/hojas/front`, {
      method: "PUT",
      headers: { "If-Match": etag },
      body: JSON.stringify({ hola: 1 }),
    });
    assert.equal(res.status, 400);
  });

  test("lista proyectos ordenados por nombre", async () => {
    const { proyectos } = await (await fetch(`${base}/api/proyectos`)).json();
    assert.deepEqual(
      proyectos.map((p) => p.id),
      ["chemovetgestion", "fusion", "solo"],
    );
    assert.ok(proyectos[0].actualizado);
  });

  test("estáticos: SPA, caché y sin salir del directorio", async () => {
    let res = await fetch(`${base}/cualquier/ruta`);
    assert.equal(await res.text(), "<title>app</title>");
    assert.equal(res.headers.get("cache-control"), "no-cache");
    res = await fetch(`${base}/assets/a.js`);
    assert.match(res.headers.get("cache-control"), /immutable/);
    res = await fetch(`${base}/..%2Fsecreto.txt`);
    assert.notEqual(await res.text(), "no");
  });
});

describe("API con contraseña", () => {
  const dataDir = path.join(tmp, "data-auth");
  let server;
  let base;

  before(async () => {
    await crearAuth(dataDir).cambiarContrasena("clave-larga-1");
    ({ server, base } = await levantar({ dataDir }));
  });
  after(() => server.close());

  const entrar = (contrasena, ip = "1.1.1.1") =>
    fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "CF-Connecting-IP": ip, "X-Forwarded-Proto": "https" },
      body: JSON.stringify({ contrasena }),
    });
  const cookieDe = (res) => res.headers.get("set-cookie").split(";")[0];
  const pedir = (cookie) =>
    fetch(`${base}/api/proyectos`, {
      headers: cookie ? { Cookie: cookie } : {},
    });

  test("sin sesión la API pide login pero la app se sirve igual", async () => {
    const res = await pedir();
    assert.equal(res.status, 401);
    assert.equal((await res.json()).login, true);
    assert.equal((await fetch(`${base}/api/sesion`)).status, 401);
    assert.equal((await fetch(`${base}/`)).status, 200);
  });

  test("con la contraseña correcta queda una cookie de 30 días", async () => {
    const res = await entrar("clave-larga-1");
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /Max-Age=2592000/);
    const cookie = cookieDe(res);
    assert.equal((await pedir(cookie)).status, 200);
    assert.equal(
      (await fetch(`${base}/api/sesion`, { headers: { Cookie: cookie } }))
        .status,
      200,
    );
  });

  test("rechaza contraseña incorrecta y cookies adulteradas", async () => {
    assert.equal((await entrar("otra-cosa", "2.2.2.2")).status, 401);
    const cookie = cookieDe(await entrar("clave-larga-1", "2.2.2.2"));
    const [nombre, valor] = cookie.split("=");
    const [dato, firma] = valor.split(".");
    const otroDato = Buffer.from(
      JSON.stringify({ exp: Date.now() + 1e12 }),
    ).toString("base64url");
    assert.equal((await pedir(`${nombre}=${otroDato}.${firma}`)).status, 401);
    assert.equal((await pedir(`${nombre}=${dato}.AAAA`)).status, 401);
  });

  test("bloquea una IP tras 5 intentos fallidos", async () => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await entrar("mal", "3.3.3.3")).status, 401);
    }
    const res = await entrar("clave-larga-1", "3.3.3.3");
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /Demasiados intentos/);
    // otra IP sigue pudiendo entrar
    assert.equal((await entrar("clave-larga-1", "4.4.4.4")).status, 200);
  });

  test("cambiar la contraseña cierra las sesiones abiertas", async () => {
    const cookie = cookieDe(await entrar("clave-larga-1", "5.5.5.5"));
    assert.equal((await pedir(cookie)).status, 200);
    await crearAuth(dataDir).cambiarContrasena("clave-larga-2");
    assert.equal((await pedir(cookie)).status, 401);
    assert.equal((await entrar("clave-larga-2", "5.5.5.5")).status, 200);
  });

  test("cerrar otras sesiones invalida las demás cookies, no la propia", async () => {
    const cookieA = cookieDe(await entrar("clave-larga-2", "7.7.7.7"));
    const cookieB = cookieDe(await entrar("clave-larga-2", "7.7.7.8"));
    assert.equal((await pedir(cookieA)).status, 200);
    assert.equal((await pedir(cookieB)).status, 200);

    assert.equal(
      (
        await fetch(`${base}/api/sesion/cerrar-otras`, {
          headers: { Cookie: cookieA },
        })
      ).status,
      405,
    );
    assert.equal(
      (await fetch(`${base}/api/sesion/cerrar-otras`, { method: "POST" }))
        .status,
      401,
    );

    const res = await fetch(`${base}/api/sesion/cerrar-otras`, {
      method: "POST",
      headers: { Cookie: cookieA },
    });
    assert.equal(res.status, 200);
    const cookieAnueva = cookieDe(res);

    assert.equal((await pedir(cookieAnueva)).status, 200);
    assert.equal((await pedir(cookieA)).status, 401);
    assert.equal((await pedir(cookieB)).status, 401);
  });

  test("logout borra la cookie", async () => {
    const res = await fetch(`${base}/api/logout`, { method: "POST" });
    assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
  });

  test("sin contraseña cargada la API responde 503", async () => {
    const { server: s, base: b } = await levantar({
      dataDir: path.join(tmp, "data-503"),
    });
    assert.equal((await fetch(`${b}/api/proyectos`)).status, 503);
    assert.equal(
      (await fetch(`${b}/api/login`, { method: "POST" })).status,
      503,
    );
    assert.equal((await fetch(`${b}/`)).status, 200);
    s.close();
  });

  test("el comando `contrasena` guarda el hash, no el texto", () => {
    const dir = path.join(tmp, "data-cli");
    const salida = execFileSync(
      process.execPath,
      [path.join(import.meta.dirname, "server.mjs"), "contrasena"],
      {
        env: { ...process.env, DATA_DIR: dir },
        input: "secreta-123\nsecreta-123\n",
      },
    ).toString();
    assert.match(salida, /Listo/);
    const guardado = fs.readFileSync(path.join(dir, ".contrasena"), "utf8");
    assert.match(guardado, /^scrypt\$/);
    assert.doesNotMatch(guardado, /secreta-123/);
    assert.equal(
      fs.statSync(path.join(dir, ".contrasena")).mode & 0o777,
      0o600,
    );
  });
});
