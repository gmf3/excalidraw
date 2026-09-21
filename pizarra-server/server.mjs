// Servidor de la pizarra: sirve la app compilada y guarda proyectos y hojas
// en disco, cada hoja como un archivo .excalidraw estándar. Las hojas forman
// un árbol de profundidad libre: cada una tiene un `padre` (id de otra hoja
// del mismo proyecto, o null si es de primer nivel).
//
// Estructura en DATA_DIR:
//   <proyecto>/proyecto.json          { nombre, hojas: [{ id, nombre, padre }], creado }
//   <proyecto>/<hoja>.excalidraw      escena de la hoja
//   <proyecto>/.historial/<hoja>/     copias previas (como mucho una cada 10 min)
//   .papelera/                        proyectos y hojas borrados (borrar una hoja
//                                      con sub-hojas se lleva also todo su subárbol)
//
// La API pide iniciar sesión con la contraseña de DATA_DIR/.contrasena; sin
// contraseña cargada responde 503 (salvo PIZARRA_SIN_AUTH=1, solo desarrollo).
// La app en sí es pública: es el mismo código abierto de Excalidraw.
//
// Cargar o cambiar la contraseña:  node server.mjs contrasena

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

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

// --- Contraseña y sesión -----------------------------------------------------
//
// Una sola contraseña, guardada como hash scrypt en DATA_DIR/.contrasena
// (se carga con `node server.mjs contrasena`). La sesión es una cookie firmada
// con HMAC que dura 30 días; la clave de firma depende del hash, así que
// cambiar la contraseña cierra todas las sesiones abiertas.

const COOKIE_SESION = "pizarra_sesion";
const SESION_MS = 30 * 24 * 3600 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const VENTANA_INTENTOS_MS = 15 * 60 * 1000;
const MAX_FALLIDOS_POR_IP = 5;
const MAX_FALLIDOS_TOTAL = 30;

const scrypt = (clave, sal, largo, opciones) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(clave, sal, largo, opciones, (error, hash) =>
      error ? reject(error) : resolve(hash),
    ),
  );

export const hashContrasena = async (contrasena) => {
  const sal = crypto.randomBytes(16);
  const hash = await scrypt(contrasena.normalize("NFC"), sal, 32, SCRYPT);
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    sal.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
};

const coincideContrasena = async (contrasena, guardado) => {
  const [alg, N, r, p, sal, hash] = guardado.split("$");
  if (alg !== "scrypt" || !sal || !hash) {
    return false;
  }
  const esperado = Buffer.from(hash, "base64url");
  const obtenido = await scrypt(
    contrasena.normalize("NFC"),
    Buffer.from(sal, "base64url"),
    esperado.length,
    { N: Number(N), r: Number(r), p: Number(p) },
  );
  return crypto.timingSafeEqual(esperado, obtenido);
};

const leerCookie = (req, nombre) => {
  const match = (req.headers.cookie || "").match(
    new RegExp(`(?:^|;\\s*)${nombre}=([^;]+)`),
  );
  return match ? match[1] : null;
};

const ipDe = (req) =>
  req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "?";

const esHttps = (req) =>
  req.headers["x-forwarded-proto"] === "https" ||
  /"scheme":"https"/.test(req.headers["cf-visitor"] || "");

export const crearAuth = (dataDir) => {
  fs.mkdirSync(dataDir, { recursive: true });
  const archivoContrasena = path.join(dataDir, ".contrasena");
  const archivoSecreto = path.join(dataDir, ".secreto-sesion");
  if (!fs.existsSync(archivoSecreto)) {
    fs.writeFileSync(archivoSecreto, crypto.randomBytes(32).toString("hex"), {
      mode: 0o600,
    });
  }
  let secreto = fs.readFileSync(archivoSecreto, "utf8").trim();

  const hashActual = () => {
    try {
      return fs.readFileSync(archivoContrasena, "utf8").trim() || null;
    } catch {
      return null;
    }
  };
  const firmar = (dato, hash) =>
    crypto
      .createHmac(
        "sha256",
        crypto.createHmac("sha256", secreto).update(hash).digest(),
      )
      .update(dato)
      .digest("base64url");

  let fallidos = [];
  const fallidosRecientes = () => {
    const desde = Date.now() - VENTANA_INTENTOS_MS;
    fallidos = fallidos.filter((f) => f.cuando > desde);
    return fallidos;
  };

  const cookie = (req, valor, maxAgeMs) =>
    `${COOKIE_SESION}=${valor}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(
      maxAgeMs / 1000,
    )}${esHttps(req) ? "; Secure" : ""}`;

  return {
    configurada: () => hashActual() !== null,

    sesionValida(req) {
      const hash = hashActual();
      const valor = leerCookie(req, COOKIE_SESION);
      if (!hash || !valor) {
        return false;
      }
      const [dato, firma] = valor.split(".");
      if (!dato || !firma) {
        return false;
      }
      const esperada = Buffer.from(firmar(dato, hash));
      const recibida = Buffer.from(firma);
      if (
        esperada.length !== recibida.length ||
        !crypto.timingSafeEqual(esperada, recibida)
      ) {
        return false;
      }
      try {
        const { exp } = JSON.parse(Buffer.from(dato, "base64url").toString());
        return typeof exp === "number" && exp > Date.now();
      } catch {
        return false;
      }
    },

    /** Devuelve el Set-Cookie de la sesión nueva. */
    async entrar(req, contrasena) {
      const hash = hashActual();
      if (!hash) {
        throw new HttpError(503, "Falta configurar la contraseña");
      }
      const ip = ipDe(req);
      const recientes = fallidosRecientes();
      if (
        recientes.filter((f) => f.ip === ip).length >= MAX_FALLIDOS_POR_IP ||
        recientes.length >= MAX_FALLIDOS_TOTAL
      ) {
        const minutos = Math.ceil(
          (recientes[0].cuando + VENTANA_INTENTOS_MS - Date.now()) / 60000,
        );
        throw new HttpError(
          429,
          `Demasiados intentos fallidos. Probá de nuevo en ${minutos} min.`,
        );
      }
      if (
        typeof contrasena !== "string" ||
        !(await coincideContrasena(contrasena, hash))
      ) {
        fallidos.push({ ip, cuando: Date.now() });
        throw new HttpError(401, "Contraseña incorrecta");
      }
      fallidos = fallidos.filter((f) => f.ip !== ip);
      const dato = Buffer.from(
        JSON.stringify({ exp: Date.now() + SESION_MS }),
      ).toString("base64url");
      return cookie(req, `${dato}.${firmar(dato, hash)}`, SESION_MS);
    },

    salir: (req) => cookie(req, "", 0),

    /**
     * Rota el secreto de firma: invalida de golpe cualquier cookie ya
     * emitida (otras pestañas, otros dispositivos) y devuelve una Set-Cookie
     * nueva para que quien pidió esto quede logueado sin reingresar la
     * contraseña. No hay registro de sesiones por dispositivo — es la
     * herramienta que hay sin construir uno.
     */
    async cerrarOtrasSesiones(req) {
      const hash = hashActual();
      if (!hash) {
        throw new HttpError(503, "Falta configurar la contraseña");
      }
      secreto = crypto.randomBytes(32).toString("hex");
      escribirAtomico(archivoSecreto, secreto);
      fs.chmodSync(archivoSecreto, 0o600);
      const dato = Buffer.from(
        JSON.stringify({ exp: Date.now() + SESION_MS }),
      ).toString("base64url");
      return cookie(req, `${dato}.${firmar(dato, hash)}`, SESION_MS);
    },

    async cambiarContrasena(contrasena) {
      escribirAtomico(
        archivoContrasena,
        `${await hashContrasena(contrasena)}\n`,
      );
      fs.chmodSync(archivoContrasena, 0o600);
    },
  };
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

  const parsearEscena = (texto) => {
    let escena;
    try {
      escena = JSON.parse(texto);
    } catch {
      throw new HttpError(400, "La escena no es JSON válido");
    }
    if (escena?.type !== "excalidraw" || !Array.isArray(escena.elements)) {
      throw new HttpError(400, "La escena no tiene formato Excalidraw");
    }
    return escena;
  };

  const serializarEscena = (escena) => `${JSON.stringify(escena, null, 2)}\n`;

  /**
   * Fusiona dos listas de elementos por id, igual que `reconcileElements` de
   * @excalidraw/excalidraw (mismo criterio de desempate: gana la version mas
   * alta, y en empate la de versionNonce mas bajo) pero reimplementado acá
   * liviano porque ese paquete es para el bundle del browser, no para este
   * server. No reordena por índice fraccional: el único costo es que el
   * z-order de un elemento recién fusionado puede no ser el ideal, algo
   * cosmético, nunca pérdida de datos.
   */
  const fusionarElementos = (actuales, entrantes) => {
    const mapaActuales = new Map(actuales.map((el) => [el.id, el]));
    const agregados = new Set();
    const resultado = [];
    for (const entrante of entrantes) {
      if (agregados.has(entrante.id)) {
        continue;
      }
      const actual = mapaActuales.get(entrante.id);
      const ganaElActual =
        actual &&
        (actual.version > entrante.version ||
          (actual.version === entrante.version &&
            actual.versionNonce <= entrante.versionNonce));
      resultado.push(ganaElActual ? actual : entrante);
      agregados.add(entrante.id);
    }
    for (const actual of actuales) {
      if (!agregados.has(actual.id)) {
        resultado.push(actual);
        agregados.add(actual.id);
      }
    }
    return resultado;
  };

  const nuevaHoja = (p, meta, nombre, escena, padre = null) => {
    const base = slug(nombre);
    let id = base;
    for (let n = 2; meta.hojas.some((x) => x.id === id); n++) {
      id = `${base}-${n}`;
    }
    escribirAtomico(
      archivoHoja(p, id),
      escena ? serializarEscena(parsearEscena(escena)) : escenaVacia(),
    );
    const hoja = { id, nombre, padre };
    meta.hojas.push(hoja);
    return hoja;
  };

  /** Ids de todas las sub-hojas de `h`, a cualquier profundidad. */
  const descendientesDe = (meta, h) => {
    const directos = meta.hojas.filter((x) => x.padre === h).map((x) => x.id);
    return directos.flatMap((id) => [id, ...descendientesDe(meta, id)]);
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

    crearHoja(p, nombre, escena, padre = null) {
      const meta = leerMeta(p);
      if (padre != null) {
        hojaDe(meta, padre); // 404 si el padre no existe en este proyecto
      }
      const hoja = nuevaHoja(p, meta, leerNombre(nombre), escena, padre);
      guardarMeta(p, meta);
      return { proyecto: resumen(p, meta), hoja };
    },

    renombrarHoja(p, h, nombre) {
      const meta = leerMeta(p);
      hojaDe(meta, h).nombre = leerNombre(nombre);
      guardarMeta(p, meta);
      return resumen(p, meta);
    },

    moverHoja(p, h, padre) {
      const meta = leerMeta(p);
      const hoja = hojaDe(meta, h);
      if (padre != null) {
        hojaDe(meta, padre);
        if (padre === h || descendientesDe(meta, h).includes(padre)) {
          throw new HttpError(
            400,
            "Una hoja no puede quedar dentro de si misma ni de una sub-hoja",
          );
        }
      }
      hoja.padre = padre;
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
      const aBorrar = [h, ...descendientesDe(meta, h)];
      if (meta.hojas.length - aBorrar.length < 1) {
        throw new HttpError(400, "Un proyecto necesita al menos una hoja");
      }
      for (const id of aBorrar) {
        const archivo = archivoHoja(p, id);
        if (fs.existsSync(archivo)) {
          aPapelera(archivo, `${p}__${id}.excalidraw`);
        }
      }
      meta.hojas = meta.hojas.filter((x) => !aBorrar.includes(x.id));
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
      const entrante = parsearEscena(texto);
      const actual = this.leerHoja(p, h);
      let final = entrante;
      let fusionado = false;
      if (ifMatch !== actual.etag) {
        // alguien más (otra pestaña, otro dispositivo, un agente) guardó en
        // el medio: en vez de rechazar con 409 y obligar a bifurcar una copia
        // "(conflicto)", fusiona elemento por elemento — así dos personas
        // editando la misma hoja a la vez no se pisan.
        const escenaActual = parsearEscena(actual.contenido.toString("utf8"));
        final = {
          ...entrante,
          elements: fusionarElementos(escenaActual.elements, entrante.elements),
        };
        fusionado = true;
      }
      guardarHistorial(p, h);
      const contenido = serializarEscena(final);
      escribirAtomico(archivoHoja(p, h), contenido);
      return { etag: etagDe(Buffer.from(contenido)), fusionado };
    },
  };
};

// --- Relay WebSocket ----------------------------------------------------------
//
// Aviso en vivo de que una hoja cambió, para no depender del polling de 5s.
// No es la fuente de verdad: si el socket se cae o no llega a conectar, todo
// sigue funcionando igual con el polling existente (revisarRemoto).

export const crearRelay = () => {
  const wss = new WebSocketServer({ noServer: true });
  const salas = new Map();

  const claveDe = (proyecto, hoja) => `${proyecto}/${hoja}`;

  const salirDeSala = (ws) => {
    if (!ws.sala) {
      return;
    }
    const set = salas.get(ws.sala);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        salas.delete(ws.sala);
      }
    }
    ws.sala = null;
  };

  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.sala = null;

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (datos) => {
      let mensaje;
      try {
        mensaje = JSON.parse(datos.toString());
      } catch {
        return;
      }
      if (
        mensaje?.tipo !== "unirse" ||
        typeof mensaje.proyecto !== "string" ||
        !mensaje.proyecto ||
        typeof mensaje.hoja !== "string" ||
        !mensaje.hoja
      ) {
        return;
      }
      salirDeSala(ws);
      const clave = claveDe(mensaje.proyecto, mensaje.hoja);
      let set = salas.get(clave);
      if (!set) {
        set = new Set();
        salas.set(clave, set);
      }
      set.add(ws);
      ws.sala = clave;
    });

    ws.on("close", () => salirDeSala(ws));
  });

  const intervaloLatido = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  intervaloLatido.unref();

  return {
    manejarUpgrade(req, socket, head, auth, sinAuth) {
      const { pathname } = new URL(req.url, "http://x");
      if (pathname !== "/ws") {
        socket.destroy();
        return;
      }
      if (!sinAuth && !auth.sesionValida(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
    },

    avisarCambio(proyecto, hoja) {
      const mensaje = JSON.stringify({ tipo: "cambio", proyecto, hoja });
      const set = salas.get(claveDe(proyecto, hoja));
      if (!set) {
        return;
      }
      for (const ws of set) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(mensaje);
        }
      }
    },
  };
};

// --- HTTP --------------------------------------------------------------------

const leerCuerpo = (req, maximo = MAX_BODY) =>
  new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on("data", (parte) => {
      total += parte.length;
      if (total > maximo) {
        reject(new HttpError(413, "El pedido es demasiado grande"));
        req.destroy();
        return;
      }
      partes.push(parte);
    });
    req.on("end", () => resolve(Buffer.concat(partes).toString("utf8")));
    req.on("error", reject);
  });

const leerJson = async (req, maximo) => {
  const texto = await leerCuerpo(req, maximo);
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

const manejarApi = async (req, res, almacen, segmentos, avisarCambio) => {
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
      const { nombre, escena, padre } = await leerJson(req);
      return responderJson(
        res,
        201,
        almacen.crearHoja(
          p,
          nombre,
          escena === undefined ? undefined : JSON.stringify(escena, null, 2),
          padre ?? null,
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
      const { etag, fusionado } = almacen.guardarHoja(
        p,
        h,
        texto,
        req.headers["if-match"],
      );
      avisarCambio(p, h);
      return responderJson(res, 200, { etag, fusionado }, { ETag: etag });
    }
    if (metodo === "PATCH") {
      const cambios = await leerJson(req);
      let proyecto;
      if (Object.hasOwn(cambios, "nombre")) {
        proyecto = almacen.renombrarHoja(p, h, cambios.nombre);
      }
      if (Object.hasOwn(cambios, "padre")) {
        proyecto = almacen.moverHoja(p, h, cambios.padre ?? null);
      }
      if (!proyecto) {
        throw new HttpError(400, "Falta nombre o padre");
      }
      return responderJson(res, 200, proyecto);
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

const manejarSesion = async (req, res, auth, accion) => {
  if (accion === "sesion" && req.method === "GET") {
    if (!auth.sesionValida(req)) {
      throw new HttpError(401, "Necesitás iniciar sesión", { login: true });
    }
    return responderJson(res, 200, { ok: true });
  }
  if (accion === "login" && req.method === "POST") {
    const { contrasena } = await leerJson(req, 10_000);
    const cookie = await auth.entrar(req, contrasena);
    return responderJson(res, 200, { ok: true }, { "Set-Cookie": cookie });
  }
  if (accion === "logout" && req.method === "POST") {
    return responderJson(
      res,
      200,
      { ok: true },
      { "Set-Cookie": auth.salir(req) },
    );
  }
  throw new HttpError(405, "Método no permitido");
};

const ACCIONES_DE_SESION = new Set(["sesion", "login", "logout"]);

export const crearServidor = ({ staticDir, dataDir, sinAuth = false }) => {
  const almacen = crearAlmacen(dataDir);
  const auth = crearAuth(dataDir);
  const relay = crearRelay();
  const raizEstatica = path.resolve(staticDir);

  const servidor = http.createServer(async (req, res) => {
    const segmentos = new URL(req.url, "http://x").pathname
      .split("/")
      .filter(Boolean);
    if (segmentos[0] !== "api") {
      return servirEstatico(req, res, raizEstatica);
    }
    try {
      if (!sinAuth) {
        if (!auth.configurada()) {
          throw new HttpError(
            503,
            "Falta configurar la contraseña (node server.mjs contrasena)",
          );
        }
        if (ACCIONES_DE_SESION.has(segmentos[1]) && segmentos.length === 2) {
          return await manejarSesion(req, res, auth, segmentos[1]);
        }
        if (!auth.sesionValida(req)) {
          throw new HttpError(401, "Necesitás iniciar sesión", { login: true });
        }
        if (
          segmentos[1] === "sesion" &&
          segmentos[2] === "cerrar-otras" &&
          segmentos.length === 3
        ) {
          if (req.method !== "POST") {
            throw new HttpError(405, "Método no permitido");
          }
          const cookieNueva = await auth.cerrarOtrasSesiones(req);
          return responderJson(
            res,
            200,
            { ok: true },
            { "Set-Cookie": cookieNueva },
          );
        }
      } else if (segmentos[1] === "sesion") {
        return responderJson(res, 200, { ok: true });
      }
      await manejarApi(req, res, almacen, segmentos, relay.avisarCambio);
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

  servidor.on("upgrade", (req, socket, head) =>
    relay.manejarUpgrade(req, socket, head, auth, sinAuth),
  );

  return servidor;
};

// --- Línea de comandos -------------------------------------------------------

/** Lee una línea sin mostrarla (o de stdin si no es una terminal). */
const leerOculto = (pregunta) =>
  new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(pregunta);
    let valor = "";
    if (!stdin.isTTY) {
      // sin terminal (tests o scripts): una línea por pregunta
      const alLeer = () => {
        let parte;
        while ((parte = stdin.read(1)) !== null) {
          if (parte === "\n") {
            stdin.off("readable", alLeer);
            stdout.write("\n");
            return resolve(valor);
          }
          valor += parte;
        }
      };
      stdin.setEncoding("utf8");
      stdin.on("readable", alLeer);
      return alLeer();
    }
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const alTeclear = (teclas) => {
      for (const tecla of teclas) {
        if (tecla === "\r" || tecla === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", alTeclear);
          stdout.write("\n");
          return resolve(valor);
        }
        if (tecla === "\u0003") {
          stdout.write("\n");
          process.exit(130);
        }
        valor = tecla === "\u007f" ? valor.slice(0, -1) : valor + tecla;
      }
    };
    stdin.on("data", alTeclear);
  });

const comandoContrasena = async (dataDir) => {
  const nueva = await leerOculto("Contraseña nueva: ");
  if (nueva.length < 8) {
    console.error("Tiene que tener al menos 8 caracteres.");
    process.exit(1);
  }
  if ((await leerOculto("Repetila: ")) !== nueva) {
    console.error("No coinciden.");
    process.exit(1);
  }
  await crearAuth(dataDir).cambiarContrasena(nueva);
  console.log(
    "Listo. Las sesiones abiertas se cerraron; entrá de nuevo con la contraseña nueva.",
  );
  process.exit(0);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const {
    PORT = "8080",
    HOST = "0.0.0.0",
    STATIC_DIR = "./build",
    DATA_DIR = "./data",
    PIZARRA_SIN_AUTH,
  } = process.env;
  if (process.argv[2] === "contrasena") {
    await comandoContrasena(DATA_DIR);
  }
  const sinAuth = PIZARRA_SIN_AUTH === "1";
  crearServidor({ staticDir: STATIC_DIR, dataDir: DATA_DIR, sinAuth }).listen(
    Number(PORT),
    HOST,
    () => {
      const auth = crearAuth(DATA_DIR);
      console.log(
        `pizarra escuchando en ${HOST}:${PORT} (datos: ${path.resolve(
          DATA_DIR,
        )}, login: ${
          sinAuth
            ? "DESACTIVADO"
            : auth.configurada()
            ? "con contraseña"
            : "sin contraseña cargada → API 503"
        })`,
      );
    },
  );
}
