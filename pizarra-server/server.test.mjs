import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { crearServidor, crearVerificadorAccess, slug } from "./server.mjs";

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

  test("proyecto con hojas: crear, leer, guardar y conflicto", async () => {
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

    // un guardado con el etag viejo no pisa lo nuevo
    res = await fetch(url, {
      method: "PUT",
      headers: { "If-Match": etag },
      body: escena("pisado"),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).etag, etag2);

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
      ["chemovetgestion", "solo"],
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

describe("API con Cloudflare Access", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
  const teamDomain = "equipo.cloudflareaccess.com";
  const aud = "aud-pizarra";
  const firmar = (payload, kid = "k1") => {
    const h = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString(
      "base64url",
    );
    const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const s = crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey);
    return `${h}.${p}.${s.toString("base64url")}`;
  };
  const valido = {
    aud: [aud],
    iss: `https://${teamDomain}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "yo@example.com",
  };

  let server;
  let base;
  before(async () => {
    const verificar = crearVerificadorAccess({
      teamDomain,
      aud,
      fetchImpl: async (url) => {
        assert.equal(url, `https://${teamDomain}/cdn-cgi/access/certs`);
        return new Response(JSON.stringify({ keys: [jwk] }));
      },
    });
    ({ server, base } = await levantar({
      dataDir: path.join(tmp, "data-auth"),
      verificar,
    }));
  });
  after(() => server.close());

  const pedir = (token, porCookie = false) =>
    fetch(`${base}/api/proyectos`, {
      headers: token
        ? porCookie
          ? { Cookie: `otra=1; CF_Authorization=${token}` }
          : { "Cf-Access-Jwt-Assertion": token }
        : {},
    });

  test("acepta un JWT válido por header o cookie", async () => {
    assert.equal((await pedir(firmar(valido))).status, 200);
    assert.equal((await pedir(firmar(valido), true)).status, 200);
  });

  test("rechaza sin token, aud o iss ajenos, vencido o mal firmado", async () => {
    assert.equal((await pedir(null)).status, 401);
    assert.equal(
      (await pedir(firmar({ ...valido, aud: ["otra"] }))).status,
      401,
    );
    assert.equal(
      (
        await pedir(
          firmar({ ...valido, iss: "https://otro.cloudflareaccess.com" }),
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await pedir(
          firmar({ ...valido, exp: Math.floor(Date.now() / 1000) - 10 }),
        )
      ).status,
      401,
    );
    const [h, p] = firmar(valido).split(".");
    assert.equal((await pedir(`${h}.${p}.AAAA`)).status, 401);
    assert.equal((await pedir(firmar(valido, "desconocido"))).status, 401);
  });

  test("sin Access configurado la API responde 503", async () => {
    const { server: s, base: b } = await levantar({
      dataDir: path.join(tmp, "data-503"),
    });
    const res = await fetch(`${b}/api/proyectos`);
    assert.equal(res.status, 503);
    // la app en sí se sigue sirviendo
    assert.equal((await fetch(`${b}/`)).status, 200);
    s.close();
  });
});
