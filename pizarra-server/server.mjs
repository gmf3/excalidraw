// Servidor de la pizarra: sirve la app compilada y guarda proyectos y hojas
// en disco, cada hoja como un archivo .excalidraw estándar.
//
// Estructura en DATA_DIR:
//   <proyecto>/proyecto.json          { nombre, hojas: [{ id, nombre }], creado }
//   <proyecto>/<hoja>.excalidraw      escena de la hoja
//   <proyecto>/.historial/<hoja>/     copias previas (como mucho una cada 10 min)
//   .papelera/                        proyectos y hojas borrados
//
// La API exige un JWT válido de Cloudflare Access; sin configurarlo responde
// 503 (salvo PIZARRA_SIN_AUTH=1, pensado solo para desarrollo local).

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BODY = 50 * 1024 * 1024;
const HISTORIAL_CADA_MS = 10 * 60 * 1000;
const HISTORIAL_MAX = 100;
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".map": "application/json",
};

class HttpError extends Error {
  constructor(status, mensaje, extra = {}) {
    super(mensaje);
    this.status = status;
    this.extra = extra;
  }
}

export const slug = (nombre) =>
  String(nombre)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "") || "sin-nombre";

const etagDe = (contenido) =>
  `"${crypto.createHash("sha1").update(contenido).digest("hex").slice(0, 20)}"`;

const escenaVacia = () =>
  `${JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "pizarra",
      elements: [],
      appState: {},
      files: {},
    },
    null,
    2,
  )}\n`;

const escribirAtomico = (archivo, contenido) => {
  const tmp = `${archivo}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, archivo);
};

const leerNombre = (valor) => {
  const nombre = typeof valor === "string" ? valor.trim() : "";
  if (!nombre || nombre.length > 80) {
    throw new HttpError(400, "El nombre es obligatorio (máximo 80 caracteres)");
  }
  return nombre;
};

// --- Cloudflare Access -------------------------------------------------------

export const crearVerificadorAccess = ({
  teamDomain,
  aud,
  fetchImpl = fetch,
}) => {
  let claves = new Map();
  let cargadasEn = 0;

  const cargarClaves = async () => {
    cargadasEn = Date.now();
    const res = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) {
      throw new Error(`certs de Access: HTTP ${res.status}`);
    }
    const { keys } = await res.json();
    claves = new Map(
      keys.map((jwk) => [
        jwk.kid,
        crypto.createPublicKey({ key: jwk, format: "jwk" }),
      ]),
    );
  };

  return async (token) => {
    const partes = String(token || "").split(".");
    if (partes.length !== 3) {
      return null;
    }
    const [h, p, firma] = partes;
    let header;
    let payload;
    try {
      header = JSON.parse(Buffer.from(h, "base64url").toString());
      payload = JSON.parse(Buffer.from(p, "base64url").toString());
    } catch {
      return null;
    }
    if (header.alg !== "RS256") {
      return null;
    }
    // recargar cada hora, o ante un kid desconocido (como mucho una vez por minuto)
    const edad = Date.now() - cargadasEn;
    if (edad > 3600_000 || (!claves.has(header.kid) && edad > 60_000)) {
      await cargarClaves();
    }
    const clave = claves.get(header.kid);
    if (!clave) {
      return null;
    }
    const valida = crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${h}.${p}`),
      clave,
      Buffer.from(firma, "base64url"),
    );
    if (!valida) {
      return null;
    }
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) {
      return null;
    }
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
      return null;
    }
    if (payload.iss !== `https://${teamDomain}`) {
      return null;
    }
    return { email: payload.email || null };
  };
};

const tokenDeAccess = (req) => {
  const header = req.headers["cf-access-jwt-assertion"];
  if (header) {
    return header;
  }
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? match[1] : null;
};

// --- Almacenamiento ----------------------------------------------------------

export const crearAlmacen = (dataDir) => {
  fs.mkdirSync(dataDir, { recursive: true });

  const dirProyecto = (p) => path.join(dataDir, p);
  const archivoMeta = (p) => path.join(dirProyecto(p), "proyecto.json");
  const archivoHoja = (p, h) => path.join(dirProyecto(p), `${h}.excalidraw`);

  const validarId = (id) => {
    if (!ID_RE.test(id)) {
      throw new HttpError(404, "No existe");
    }
  };

  const leerMeta = (p) => {
    validarId(p);
    try {
      return JSON.parse(fs.readFileSync(archivoMeta(p), "utf8"));
    } catch {
      throw new HttpError(404, "El proyecto no existe");
    }
  };

  const guardarMeta = (p, meta) =>
    escribirAtomico(archivoMeta(p), `${JSON.stringify(meta, null, 2)}\n`);

  const hojaDe = (meta, h) => {
    validarId(h);
    const hoja = meta.hojas.find((x) => x.id === h);
    if (!hoja) {
      throw new HttpError(404, "La hoja no existe");
    }
    return hoja;
  };

  const resumen = (p, meta) => {
    let actualizado = 0;
    for (const hoja of meta.hojas) {
      try {
        actualizado = Math.max(
          actualizado,
          fs.statSync(archivoHoja(p, hoja.id)).mtimeMs,
        );
      } catch {
        // hoja sin archivo todavía
      }
    }
    return {
      id: p,
      nombre: meta.nombre,
      hojas: meta.hojas,
      actualizado: actualizado ? new Date(actualizado).toISOString() : null,
    };
  };

  const aPapelera = (origen, nombre) => {
    const papelera = path.join(dataDir, ".papelera");
    fs.mkdirSync(papelera, { recursive: true });
    const sello = new Date().toISOString().replace(/[:.]/g, "-");
    fs.renameSync(origen, path.join(papelera, `${nombre}__${sello}`));
  };

  const guardarHistorial = (p, h) => {
    const actual = archivoHoja(p, h);
    if (!fs.existsSync(actual)) {
      return;
    }
    const dir = path.join(dirProyecto(p), ".historial", h);
    fs.mkdirSync(dir, { recursive: true });
    const copias = fs.readdirSync(dir).sort();
    const ultima = copias[copias.length - 1];
    if (
      ultima &&
      Date.now() - fs.statSync(path.join(dir, ultima)).mtimeMs <
        HISTORIAL_CADA_MS
    ) {
      return;
    }
    const sello = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(actual, path.join(dir, `${sello}.excalidraw`));
    copias.push(`${sello}.excalidraw`);
    for (const vieja of copias.slice(
      0,
      Math.max(0, copias.length - HISTORIAL_MAX),
    )) {
      fs.rmSync(path.join(dir, vieja), { force: true });
    }
  };

  const validarEscena = (texto) => {
    let escena;
    try {
      escena = JSON.parse(texto);
    } catch {
      throw new HttpError(400, "La escena no es JSON válido");
    }
    if (escena?.type !== "excalidraw" || !Array.isArray(escena.elements)) {
      throw new HttpError(400, "La escena no tiene formato Excalidraw");
    }
    return texto.endsWith("\n") ? texto : `${texto}\n`;
  };

  const nuevaHoja = (p, meta, nombre, escena) => {
    const base = slug(nombre);
    let id = base;
    for (let n = 2; meta.hojas.some((x) => x.id === id); n++) {
      id = `${base}-${n}`;
    }
    escribirAtomico(
      archivoHoja(p, id),
      escena ? validarEscena(escena) : escenaVacia(),
    );
    meta.hojas.push({ id, nombre });
    return { id, nombre };
  };

  return {
    listar() {
      return fs
        .readdirSync(dataDir)
        .filter((p) => ID_RE.test(p) && fs.existsSync(archivoMeta(p)))
        .map((p) => resumen(p, leerMeta(p)))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    },

    crearProyecto(nombre, hojas) {
      nombre = leerNombre(nombre);
      const base = slug(nombre);
      let p = base;
      for (let n = 2; fs.existsSync(dirProyecto(p)); n++) {
        p = `${base}-${n}`;
      }
      fs.mkdirSync(dirProyecto(p));
      const meta = { nombre, hojas: [], creado: new Date().toISOString() };
      const nombresHojas =
        Array.isArray(hojas) && hojas.length ? hojas : ["General"];
      for (const nombreHoja of nombresHojas) {
        nuevaHoja(p, meta, leerNombre(nombreHoja));
      }
      guardarMeta(p, meta);
      return resumen(p, meta);
    },

    renombrarProyecto(p, nombre) {
      const meta = leerMeta(p);
      meta.nombre = leerNombre(nombre);
      guardarMeta(p, meta);
      return resumen(p, meta);
    },

    borrarProyecto(p) {
      leerMeta(p);
      aPapelera(dirProyecto(p), p);
    },

    crearHoja(p, nombre, escena) {
      const meta = leerMeta(p);
      const hoja = nuevaHoja(p, meta, leerNombre(nombre), escena);
      guardarMeta(p, meta);
      return { proyecto: resumen(p, meta), hoja };
    },

    renombrarHoja(p, h, nombre) {
      const meta = leerMeta(p);
      hojaDe(meta, h).nombre = leerNombre(nombre);
      guardarMeta(p, meta);
      return resumen(p, meta);
    },

    ordenarHojas(p, ids) {
      const meta = leerMeta(p);
      const actuales = meta.hojas.map((x) => x.id);
      if (
        !Array.isArray(ids) ||
        ids.length !== actuales.length ||
        [...ids].sort().join() !== [...actuales].sort().join()
      ) {
        throw new HttpError(400, "El orden tiene que incluir todas las hojas");
      }
      meta.hojas = ids.map((id) => hojaDe(meta, id));
      guardarMeta(p, meta);
      return resumen(p, meta);
    },

    borrarHoja(p, h) {
      const meta = leerMeta(p);
      hojaDe(meta, h);
      if (meta.hojas.length === 1) {
        throw new HttpError(400, "Un proyecto necesita al menos una hoja");
      }
      const archivo = archivoHoja(p, h);
      if (fs.existsSync(archivo)) {
        aPapelera(archivo, `${p}__${h}.excalidraw`);
      }
      meta.hojas = meta.hojas.filter((x) => x.id !== h);
      guardarMeta(p, meta);
      return resumen(p, meta);
    },

    leerHoja(p, h) {
      hojaDe(leerMeta(p), h);
      let contenido;
      try {
        contenido = fs.readFileSync(archivoHoja(p, h));
      } catch {
        contenido = Buffer.from(escenaVacia());
      }
      return { contenido, etag: etagDe(contenido) };
    },

    guardarHoja(p, h, texto, ifMatch) {
      hojaDe(leerMeta(p), h);
      if (!ifMatch) {
        throw new HttpError(428, "Falta If-Match");
      }
      const contenido = validarEscena(texto);
      const actual = this.leerHoja(p, h);
      if (ifMatch !== actual.etag) {
        throw new HttpError(409, "La hoja cambió desde la última carga", {
          etag: actual.etag,
        });
      }
      guardarHistorial(p, h);
      escribirAtomico(archivoHoja(p, h), contenido);
      return { etag: etagDe(Buffer.from(contenido)) };
    },
  };
};

// --- HTTP --------------------------------------------------------------------

const leerCuerpo = (req) =>
  new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on("data", (parte) => {
      total += parte.length;
      if (total > MAX_BODY) {
        reject(new HttpError(413, "La escena supera los 50 MB"));
        req.destroy();
        return;
      }
      partes.push(parte);
    });
    req.on("end", () => resolve(Buffer.concat(partes).toString("utf8")));
    req.on("error", reject);
  });

const leerJson = async (req) => {
  const texto = await leerCuerpo(req);
  try {
    return texto ? JSON.parse(texto) : {};
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
};

const responderJson = (res, status, cuerpo, headers = {}) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(cuerpo));
};

const manejarApi = async (req, res, almacen, segmentos) => {
  const [, recurso, p, sub, h, ...resto] = segmentos;
  const metodo = req.method;
  if (recurso !== "proyectos" || resto.length) {
    throw new HttpError(404, "Ruta desconocida");
  }

  if (!p) {
    if (metodo === "GET") {
      return responderJson(res, 200, { proyectos: almacen.listar() });
    }
    if (metodo === "POST") {
      const { nombre, hojas } = await leerJson(req);
      return responderJson(res, 201, almacen.crearProyecto(nombre, hojas));
    }
  } else if (!sub) {
    if (metodo === "PATCH") {
      const { nombre } = await leerJson(req);
      return responderJson(res, 200, almacen.renombrarProyecto(p, nombre));
    }
    if (metodo === "DELETE") {
      almacen.borrarProyecto(p);
      return responderJson(res, 200, { ok: true });
    }
  } else if (sub === "orden" && !h) {
    if (metodo === "PUT") {
      const { hojas } = await leerJson(req);
      return responderJson(res, 200, almacen.ordenarHojas(p, hojas));
    }
  } else if (sub === "hojas" && !h) {
    if (metodo === "POST") {
      const { nombre, escena } = await leerJson(req);
      return responderJson(
        res,
        201,
        almacen.crearHoja(
          p,
          nombre,
          escena === undefined ? undefined : JSON.stringify(escena, null, 2),
        ),
      );
    }
  } else if (sub === "hojas") {
    if (metodo === "GET") {
      const { contenido, etag } = almacen.leerHoja(p, h);
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ETag: etag, "Cache-Control": "no-store" });
        return res.end();
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ETag: etag,
      });
      return res.end(contenido);
    }
    if (metodo === "PUT") {
      const texto = await leerCuerpo(req);
      const { etag } = almacen.guardarHoja(
        p,
        h,
        texto,
        req.headers["if-match"],
      );
      return responderJson(res, 200, { etag }, { ETag: etag });
    }
    if (metodo === "PATCH") {
      const { nombre } = await leerJson(req);
      return responderJson(res, 200, almacen.renombrarHoja(p, h, nombre));
    }
    if (metodo === "DELETE") {
      return responderJson(res, 200, almacen.borrarHoja(p, h));
    }
  }
  throw new HttpError(405, "Método no permitido");
};

const servirEstatico = (req, res, staticDir) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    return res.end();
  }
  let ruta;
  try {
    ruta = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  let archivo = path.resolve(staticDir, `.${ruta}`);
  if (archivo !== staticDir && !archivo.startsWith(`${staticDir}${path.sep}`)) {
    res.writeHead(404);
    return res.end();
  }
  if (!fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
    const indice = path.join(archivo, "index.html");
    archivo = fs.existsSync(indice)
      ? indice
      : path.join(staticDir, "index.html");
  }
  if (!fs.existsSync(archivo)) {
    res.writeHead(404);
    return res.end();
  }
  const inmutable = ruta.startsWith("/assets/");
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(archivo)] || "application/octet-stream",
    "Cache-Control": inmutable
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    return res.end();
  }
  fs.createReadStream(archivo).pipe(res);
};

export const crearServidor = ({
  staticDir,
  dataDir,
  verificar, // async (token) => usuario | null; null = Access sin configurar
  sinAuth = false,
}) => {
  const almacen = crearAlmacen(dataDir);
  const raizEstatica = path.resolve(staticDir);

  return http.createServer(async (req, res) => {
    const segmentos = new URL(req.url, "http://x").pathname
      .split("/")
      .filter(Boolean);
    if (segmentos[0] !== "api") {
      return servirEstatico(req, res, raizEstatica);
    }
    try {
      if (!sinAuth) {
        if (!verificar) {
          throw new HttpError(
            503,
            "Cloudflare Access no está configurado en el servidor",
          );
        }
        const usuario = await verificar(tokenDeAccess(req));
        if (!usuario) {
          throw new HttpError(
            401,
            "Sesión de Cloudflare Access inválida o vencida",
          );
        }
      }
      await manejarApi(req, res, almacen, segmentos);
    } catch (error) {
      if (error instanceof HttpError) {
        return responderJson(res, error.status, {
          error: error.message,
          ...error.extra,
        });
      }
      console.error(error);
      responderJson(res, 500, { error: "Error interno" });
    }
  });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const {
    PORT = "8080",
    HOST = "0.0.0.0",
    STATIC_DIR = "./build",
    DATA_DIR = "./data",
    CF_ACCESS_TEAM_DOMAIN,
    CF_ACCESS_AUD,
    PIZARRA_SIN_AUTH,
  } = process.env;
  const verificar =
    CF_ACCESS_TEAM_DOMAIN && CF_ACCESS_AUD
      ? crearVerificadorAccess({
          teamDomain: CF_ACCESS_TEAM_DOMAIN,
          aud: CF_ACCESS_AUD,
        })
      : null;
  const sinAuth = PIZARRA_SIN_AUTH === "1";
  crearServidor({
    staticDir: STATIC_DIR,
    dataDir: DATA_DIR,
    verificar,
    sinAuth,
  }).listen(Number(PORT), HOST, () => {
    console.log(
      `pizarra escuchando en ${HOST}:${PORT} (datos: ${path.resolve(
        DATA_DIR,
      )}, ` +
        `auth: ${
          sinAuth
            ? "DESACTIVADA"
            : verificar
            ? "Cloudflare Access"
            : "sin configurar → API 503"
        })`,
    );
  });
}
