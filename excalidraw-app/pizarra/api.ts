// Cliente de la API de pizarra-server (proyectos y hojas guardados en pc3).

export type Hoja = { id: string; nombre: string };

export type Proyecto = {
  id: string;
  nombre: string;
  hojas: Hoja[];
  actualizado: string | null;
};

export class PizarraApiError extends Error {
  constructor(public status: number, message: string, public etag?: string) {
    super(message);
  }
}

/** Se llama cuando la sesión venció (o nunca se inició). */
let alPedirLogin: () => void = () => {};
export const cuandoPidaLogin = (callback: () => void) => {
  alPedirLogin = callback;
};

const pedir = async <T>(ruta: string, init: RequestInit = {}) => {
  let res: Response;
  try {
    res = await fetch(`/api${ruta}`, {
      credentials: "same-origin",
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
    });
  } catch {
    throw new PizarraApiError(0, "No hay conexión con la pizarra en pc3.");
  }
  if (res.status === 304) {
    return { res, datos: null };
  }
  if (!(res.headers.get("content-type") || "").includes("application/json")) {
    throw new PizarraApiError(
      res.status,
      `Respuesta inesperada del servidor (HTTP ${res.status}).`,
    );
  }
  const datos = await res.json();
  if (!res.ok) {
    if (datos.login) {
      alPedirLogin();
    }
    throw new PizarraApiError(res.status, datos.error, datos.etag);
  }
  return { res, datos: datos as T };
};

const json = (method: string, cuerpo: unknown): RequestInit => ({
  method,
  body: JSON.stringify(cuerpo),
});

const rutaProyecto = (p: string) => `/proyectos/${encodeURIComponent(p)}`;
const rutaHoja = (p: string, h: string) =>
  `${rutaProyecto(p)}/hojas/${encodeURIComponent(h)}`;

export const api = {
  /** false si hay que iniciar sesión */
  haySesion: async () => {
    try {
      await pedir("/sesion");
      return true;
    } catch (error) {
      if (error instanceof PizarraApiError && error.status === 401) {
        return false;
      }
      throw error;
    }
  },

  entrar: async (contrasena: string) => {
    await pedir("/login", json("POST", { contrasena }));
  },

  salir: async () => {
    await pedir("/logout", { method: "POST" });
  },

  listar: async () =>
    (await pedir<{ proyectos: Proyecto[] }>("/proyectos")).datos!.proyectos,

  crearProyecto: async (nombre: string, hojas?: string[]) =>
    (await pedir<Proyecto>("/proyectos", json("POST", { nombre, hojas })))
      .datos!,

  renombrarProyecto: async (p: string, nombre: string) =>
    (await pedir<Proyecto>(rutaProyecto(p), json("PATCH", { nombre }))).datos!,

  borrarProyecto: async (p: string) => {
    await pedir(rutaProyecto(p), { method: "DELETE" });
  },

  crearHoja: async (p: string, nombre: string, escena?: unknown) =>
    (
      await pedir<{ proyecto: Proyecto; hoja: Hoja }>(
        `${rutaProyecto(p)}/hojas`,
        json("POST", { nombre, escena }),
      )
    ).datos!,

  renombrarHoja: async (p: string, h: string, nombre: string) =>
    (await pedir<Proyecto>(rutaHoja(p, h), json("PATCH", { nombre }))).datos!,

  ordenarHojas: async (p: string, hojas: string[]) =>
    (await pedir<Proyecto>(`${rutaProyecto(p)}/orden`, json("PUT", { hojas })))
      .datos!,

  borrarHoja: async (p: string, h: string) =>
    (await pedir<Proyecto>(rutaHoja(p, h), { method: "DELETE" })).datos!,

  /** null si la hoja no cambió desde `etag` */
  leerHoja: async (p: string, h: string, etag?: string | null) => {
    const { res, datos } = await pedir<any>(rutaHoja(p, h), {
      headers: etag ? { "If-None-Match": etag } : {},
    });
    return datos === null
      ? null
      : { escena: datos, etag: res.headers.get("etag")! };
  },

  guardarHoja: async (
    p: string,
    h: string,
    escena: string,
    etag: string,
    keepalive = false,
  ) =>
    (
      await pedir<{ etag: string }>(rutaHoja(p, h), {
        method: "PUT",
        body: escena,
        headers: { "If-Match": etag },
        keepalive,
      })
    ).datos!.etag,
};
