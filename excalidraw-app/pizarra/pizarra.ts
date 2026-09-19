// Controlador de proyectos y hojas: carga cada hoja desde pizarra-server,
// la guarda con debounce y resuelve conflictos entre dispositivos sin perder
// datos (la versión local queda como hoja "(conflicto HH:MM)").

import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";
import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import { getScrollToContentState } from "@excalidraw/excalidraw/scene";
import { hashElementsVersion } from "@excalidraw/element";

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";

import { appJotaiStore, atom } from "../app-jotai";
import { importFromLocalStorage } from "../data/localStorage";

import { api, cuandoPidaLogin, PizarraApiError } from "./api";

import type { Hoja, Proyecto } from "./api";

export const PIZARRA_ENABLED = import.meta.env.VITE_APP_PIZARRA === "true";

export const SIDEBAR_PIZARRA = "pizarra";

export type EstadoGuardado =
  | "cargando"
  | "guardado"
  | "pendiente"
  | "guardando"
  | "error";

export type EstadoPizarra = {
  proyectos: Proyecto[];
  proyectoId: string | null;
  hojaId: string | null;
  guardado: EstadoGuardado;
  error: string | null;
  necesitaLogin: boolean;
};

export const pizarraAtom = atom<EstadoPizarra>({
  proyectos: [],
  proyectoId: null,
  hojaId: null,
  guardado: "cargando",
  error: null,
  necesitaLogin: false,
});

const GUARDAR_TRAS_MS = 800;
const REVISAR_CADA_MS = 20_000;
const REINTENTAR_MS = 5_000;

type Vista = Pick<AppState, "scrollX" | "scrollY" | "zoom">;
type Fondo = Pick<
  AppState,
  "viewBackgroundColor" | "gridModeEnabled" | "gridSize" | "gridStep"
>;

const claveVista = (p: string, h: string) => `pizarra:vista:${p}/${h}`;
const claveUltimaHoja = (p: string) => `pizarra:hoja:${p}`;
const CLAVE_ULTIMO_PROYECTO = "pizarra:proyecto";
const CLAVE_RESCATADO = "pizarra:rescatado";

const leerLocal = <T>(clave: string): T | null => {
  try {
    const valor = localStorage.getItem(clave);
    return valor ? (JSON.parse(valor) as T) : null;
  } catch {
    return null;
  }
};

const guardarLocal = (clave: string, valor: unknown) => {
  try {
    localStorage.setItem(clave, JSON.stringify(valor));
  } catch {
    // almacenamiento lleno o bloqueado: la vista es solo una comodidad
  }
};

/** Cambia cuando cambia algo que se guarda en el archivo (no la vista). */
const firma = (elementos: readonly OrderedExcalidrawElement[], fondo: Fondo) =>
  `${hashElementsVersion(elementos)}|${fondo.viewBackgroundColor}|${
    fondo.gridModeEnabled
  }|${fondo.gridSize}|${fondo.gridStep}`;

const mensajeDe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

class Pizarra {
  private excalidraw: ExcalidrawImperativeAPI | null = null;
  private etag: string | null = null;
  private firmaGuardada: string | null = null;
  private listo = false;
  private cargando = false;
  private enCurso: Promise<boolean> | null = null;
  private timerGuardado: ReturnType<typeof setTimeout> | null = null;
  private timerReintento: ReturnType<typeof setTimeout> | null = null;
  private turno = 0;
  private inicio: Promise<ExcalidrawInitialDataState> | null = null;
  private alEntrar: (() => void) | null = null;

  constructor() {
    cuandoPidaLogin(() => this.actualizar({ necesitaLogin: true }));
  }

  get estado() {
    return appJotaiStore.get(pizarraAtom);
  }

  private actualizar(parcial: Partial<EstadoPizarra>) {
    appJotaiStore.set(pizarraAtom, { ...this.estado, ...parcial });
  }

  proyectoActual() {
    const { proyectos, proyectoId } = this.estado;
    return proyectos.find((p) => p.id === proyectoId) ?? null;
  }

  hojaActual() {
    const { hojaId } = this.estado;
    return this.proyectoActual()?.hojas.find((h) => h.id === hojaId) ?? null;
  }

  private reemplazarProyecto(proyecto: Proyecto) {
    const proyectos = this.estado.proyectos.filter((p) => p.id !== proyecto.id);
    proyectos.push(proyecto);
    proyectos.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    this.actualizar({ proyectos });
  }

  private avisar(mensaje: string, fijo = false) {
    this.excalidraw?.setToast({
      message: mensaje,
      closable: true,
      duration: fijo ? Infinity : 5000,
    });
  }

  // --- carga -----------------------------------------------------------------

  /** Primera carga: devuelve la escena inicial para `initialData`. */
  iniciar(excalidraw: ExcalidrawImperativeAPI) {
    this.inicio ??= this.cargarInicial(excalidraw);
    return this.inicio;
  }

  private async cargarInicial(
    excalidraw: ExcalidrawImperativeAPI,
  ): Promise<ExcalidrawInitialDataState> {
    this.excalidraw = excalidraw;
    excalidraw.onEvent("editor:initialize", (editor) => {
      this.firmaGuardada = firma(
        editor.getSceneElementsIncludingDeleted(),
        editor.getAppState(),
      );
      this.listo = true;
    });

    if (!(await api.haySesion())) {
      this.actualizar({ necesitaLogin: true });
      await new Promise<void>((resolve) => {
        this.alEntrar = resolve;
      });
    }

    let proyectos = await api.listar();
    if (!proyectos.length) {
      proyectos = [await api.crearProyecto("Brainstorming")];
    }
    this.actualizar({ proyectos });

    const params = new URLSearchParams(window.location.search);
    const p =
      [params.get("proyecto"), leerLocal<string>(CLAVE_ULTIMO_PROYECTO)].find(
        (id) => id && proyectos.some((x) => x.id === id),
      ) ?? proyectos[0].id;
    const rescatada = await this.rescatarDelNavegador(p);
    const h = rescatada ?? this.hojaInicial(p, params.get("hoja"));

    const { escena, etag } = (await api.leerHoja(p, h))!;
    this.etag = etag;
    this.marcarAbierta(p, h);
    const vista = leerLocal<Vista>(claveVista(p, h));
    return {
      elements: escena.elements,
      appState: {
        ...escena.appState,
        ...vista,
        name: this.nombreEscena(),
      },
      files: escena.files,
      scrollToContent: !vista,
    };
  }

  /**
   * La versión anterior de la pizarra guardaba el dibujo en el navegador: si
   * quedó algo, pasa una sola vez a una hoja nueva del proyecto inicial.
   */
  private async rescatarDelNavegador(p: string) {
    if (leerLocal(CLAVE_RESCATADO)) {
      return null;
    }
    const vivos = (importFromLocalStorage().elements ?? []).filter(
      (elemento) => !elemento.isDeleted,
    );
    if (!vivos.length) {
      guardarLocal(CLAVE_RESCATADO, true);
      return null;
    }
    try {
      const escena = JSON.parse(serializeAsJSON(vivos, {}, {}, "local"));
      const { proyecto, hoja } = await api.crearHoja(
        p,
        "Rescatado del navegador",
        escena,
      );
      this.reemplazarProyecto(proyecto);
      guardarLocal(CLAVE_RESCATADO, true);
      return hoja.id;
    } catch (error) {
      // no frena la carga: se reintenta la próxima vez que se abra
      console.error("No se pudo rescatar el dibujo del navegador", error);
      return null;
    }
  }

  // --- sesión ----------------------------------------------------------------

  /** Lanza el error del servidor (contraseña incorrecta, demasiados intentos). */
  async iniciarSesion(contrasena: string) {
    await api.entrar(contrasena);
    this.actualizar({ necesitaLogin: false });
    if (this.alEntrar) {
      this.alEntrar();
      this.alEntrar = null;
    } else if (this.listo) {
      // la sesión venció con la pizarra abierta: retomar lo pendiente
      await this.guardarPendiente();
      await this.revisarRemoto();
    }
  }

  async cerrarSesion() {
    await this.guardarPendiente();
    await this.hacer(() => api.salir());
    window.location.reload();
  }

  private hojaInicial(p: string, pedida?: string | null) {
    const hojas = this.estado.proyectos.find((x) => x.id === p)!.hojas;
    return (
      [pedida, leerLocal<string>(claveUltimaHoja(p))].find(
        (id) => id && hojas.some((x) => x.id === id),
      ) ?? hojas[0].id
    );
  }

  private marcarAbierta(p: string, h: string) {
    this.actualizar({
      proyectoId: p,
      hojaId: h,
      guardado: "guardado",
      error: null,
    });
    guardarLocal(CLAVE_ULTIMO_PROYECTO, p);
    guardarLocal(claveUltimaHoja(p), h);
    const url = new URL(window.location.href);
    url.searchParams.set("proyecto", p);
    url.searchParams.set("hoja", h);
    window.history.replaceState({}, "", url);
    document.title = `${this.proyectoActual()?.nombre} › ${
      this.hojaActual()?.nombre
    } · Pizarra`;
  }

  private nombreEscena() {
    return `${this.proyectoActual()?.nombre ?? ""} - ${
      this.hojaActual()?.nombre ?? ""
    }`;
  }

  private aplicarEscena(escena: any, etag: string, vista: Vista | null) {
    const excalidraw = this.excalidraw!;
    const elements = restoreElements(escena.elements, null, {
      repairBindings: true,
      deleteInvisibleElements: true,
    });
    const restaurado = restoreAppState(escena.appState, null);
    const fondo: Fondo = {
      viewBackgroundColor: restaurado.viewBackgroundColor,
      gridModeEnabled: restaurado.gridModeEnabled,
      gridSize: restaurado.gridSize,
      gridStep: restaurado.gridStep,
    };
    this.cargando = true;
    try {
      excalidraw.updateScene({
        elements,
        appState: {
          ...fondo,
          ...(vista ??
            getScrollToContentState(elements, excalidraw.getAppState())),
          name: this.nombreEscena(),
          selectedElementIds: {},
          selectedGroupIds: {},
          editingGroupId: null,
          newElement: null,
          selectionElement: null,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      if (escena.files) {
        excalidraw.addFiles(Object.values(escena.files) as BinaryFileData[]);
      }
      excalidraw.history.clear();
      this.etag = etag;
      this.firmaGuardada = firma(
        excalidraw.getSceneElementsIncludingDeleted(),
        fondo,
      );
    } finally {
      this.cargando = false;
    }
  }

  private vistaActual(): Vista | null {
    if (!this.excalidraw) {
      return null;
    }
    const { scrollX, scrollY, zoom } = this.excalidraw.getAppState();
    return { scrollX, scrollY, zoom };
  }

  guardarVista() {
    const { proyectoId, hojaId } = this.estado;
    const vista = this.vistaActual();
    if (proyectoId && hojaId && vista) {
      guardarLocal(claveVista(proyectoId, hojaId), vista);
    }
  }

  // --- guardado --------------------------------------------------------------

  private hayCambios() {
    if (!this.excalidraw || this.firmaGuardada === null || !this.etag) {
      return false;
    }
    return (
      firma(
        this.excalidraw.getSceneElementsIncludingDeleted(),
        this.excalidraw.getAppState(),
      ) !== this.firmaGuardada
    );
  }

  onChange(elementos: readonly OrderedExcalidrawElement[], appState: AppState) {
    if (!this.listo || this.cargando || this.firmaGuardada === null) {
      return;
    }
    if (firma(elementos, appState) === this.firmaGuardada) {
      return;
    }
    if (this.estado.guardado === "guardado") {
      this.actualizar({ guardado: "pendiente" });
    }
    if (this.timerGuardado) {
      clearTimeout(this.timerGuardado);
    }
    this.timerGuardado = setTimeout(() => {
      this.timerGuardado = null;
      this.guardarPendiente();
    }, GUARDAR_TRAS_MS);
  }

  /** Guarda todo lo pendiente; false si no se pudo. */
  async guardarPendiente(): Promise<boolean> {
    if (this.timerGuardado) {
      clearTimeout(this.timerGuardado);
      this.timerGuardado = null;
    }
    while (true) {
      if (this.enCurso) {
        await this.enCurso;
        continue;
      }
      if (!this.hayCambios()) {
        return this.estado.guardado !== "error";
      }
      this.enCurso = this.subir().finally(() => {
        this.enCurso = null;
      });
      if (!(await this.enCurso)) {
        return false;
      }
    }
  }

  private async subir(keepalive = false): Promise<boolean> {
    const excalidraw = this.excalidraw!;
    const { proyectoId: p, hojaId: h } = this.estado;
    if (!p || !h || !this.etag) {
      return true;
    }
    const appState = excalidraw.getAppState();
    const firmaSubida = firma(
      excalidraw.getSceneElementsIncludingDeleted(),
      appState,
    );
    const texto = serializeAsJSON(
      excalidraw.getSceneElements(),
      appState,
      excalidraw.getFiles(),
      "local",
    );
    this.actualizar({ guardado: "guardando" });
    try {
      this.etag = await api.guardarHoja(p, h, texto, this.etag, keepalive);
      this.firmaGuardada = firmaSubida;
      this.actualizar({
        guardado: this.hayCambios() ? "pendiente" : "guardado",
        error: null,
      });
      return true;
    } catch (error) {
      if (error instanceof PizarraApiError && error.status === 409) {
        return this.resolverConflicto(p, h, texto);
      }
      this.actualizar({ guardado: "error", error: mensajeDe(error) });
      this.reintentarLuego();
      return false;
    }
  }

  private reintentarLuego() {
    if (this.timerReintento) {
      return;
    }
    this.timerReintento = setTimeout(() => {
      this.timerReintento = null;
      if (this.hayCambios()) {
        this.guardarPendiente();
      }
    }, REINTENTAR_MS);
  }

  /** La hoja cambió en otro lado: la versión local pasa a una hoja nueva. */
  private async resolverConflicto(p: string, h: string, textoLocal: string) {
    const hora = new Date().toLocaleTimeString("es-AR", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const nombre = `${this.hojaActual()?.nombre ?? h} (conflicto ${hora})`;
    try {
      const { proyecto } = await api.crearHoja(
        p,
        nombre,
        JSON.parse(textoLocal),
      );
      this.reemplazarProyecto(proyecto);
      const servidor = await api.leerHoja(p, h);
      if (servidor) {
        this.aplicarEscena(servidor.escena, servidor.etag, this.vistaActual());
      }
      this.actualizar({ guardado: "guardado", error: null });
      this.avisar(
        `Esta hoja cambió en otro dispositivo. Tu versión quedó guardada en «${nombre}».`,
        true,
      );
      return true;
    } catch (error) {
      this.actualizar({ guardado: "error", error: mensajeDe(error) });
      this.reintentarLuego();
      return false;
    }
  }

  /** Al cerrar o esconder la pestaña: intento rápido sin esperar respuesta. */
  guardarAlSalir() {
    this.guardarVista();
    if (this.hayCambios() && !this.enCurso) {
      this.enCurso = this.subir(true).finally(() => {
        this.enCurso = null;
      });
    }
  }

  tieneCambiosSinGuardar() {
    return this.hayCambios() || this.estado.guardado === "guardando";
  }

  /** Trae cambios hechos en otro dispositivo (o por la IA en el archivo). */
  async revisarRemoto() {
    const { proyectoId: p, hojaId: h } = this.estado;
    if (
      !this.listo ||
      !p ||
      !h ||
      this.enCurso ||
      this.hayCambios() ||
      document.visibilityState !== "visible"
    ) {
      return;
    }
    try {
      const [proyectos, nueva] = await Promise.all([
        api.listar(),
        api.leerHoja(p, h, this.etag),
      ]);
      this.actualizar({ proyectos });
      if (
        !proyectos.some((x) => x.id === p && x.hojas.some((y) => y.id === h))
      ) {
        // la borraron en otro dispositivo
        const destino = proyectos.find((x) => x.id === p) ?? proyectos[0];
        if (destino) {
          await this.abrirHoja(destino.id, this.hojaInicial(destino.id));
        }
        return;
      }
      if (
        nueva &&
        !this.hayCambios() &&
        this.estado.proyectoId === p &&
        this.estado.hojaId === h
      ) {
        this.aplicarEscena(nueva.escena, nueva.etag, this.vistaActual());
      }
      if (this.estado.guardado === "error") {
        this.actualizar({ guardado: "guardado", error: null });
      }
    } catch {
      // sin red: se reintenta en la próxima vuelta
    }
  }

  iniciarRevision() {
    const id = setInterval(() => this.revisarRemoto(), REVISAR_CADA_MS);
    return () => clearInterval(id);
  }

  // --- acciones del panel ----------------------------------------------------

  async abrirHoja(p: string, h: string) {
    if (p === this.estado.proyectoId && h === this.estado.hojaId) {
      return;
    }
    const turno = ++this.turno;
    if (!(await this.guardarPendiente())) {
      this.avisar("No se pudo guardar la hoja actual; seguís en ella.");
      return;
    }
    this.guardarVista();
    try {
      const { escena, etag } = (await api.leerHoja(p, h))!;
      if (turno !== this.turno) {
        return;
      }
      this.actualizar({ proyectoId: p, hojaId: h });
      this.aplicarEscena(escena, etag, leerLocal<Vista>(claveVista(p, h)));
      this.marcarAbierta(p, h);
    } catch (error) {
      this.avisar(mensajeDe(error));
    }
  }

  abrirProyecto(p: string) {
    return this.abrirHoja(p, this.hojaInicial(p));
  }

  private async hacer<T>(accion: () => Promise<T>) {
    try {
      return await accion();
    } catch (error) {
      this.avisar(mensajeDe(error));
      return null;
    }
  }

  crearProyecto(nombre: string) {
    return this.hacer(async () => {
      const proyecto = await api.crearProyecto(nombre);
      this.reemplazarProyecto(proyecto);
      await this.abrirHoja(proyecto.id, proyecto.hojas[0].id);
    });
  }

  renombrarProyecto(p: string, nombre: string) {
    return this.hacer(async () => {
      this.reemplazarProyecto(await api.renombrarProyecto(p, nombre));
      if (p === this.estado.proyectoId) {
        this.marcarAbierta(p, this.estado.hojaId!);
      }
    });
  }

  borrarProyecto(p: string) {
    return this.hacer(async () => {
      if (p === this.estado.proyectoId) {
        let otro = this.estado.proyectos.find((x) => x.id !== p);
        if (!otro) {
          otro = await api.crearProyecto("Brainstorming");
          this.reemplazarProyecto(otro);
        }
        // guarda lo pendiente de la hoja actual antes de irse
        await this.abrirProyecto(otro.id);
        if (this.estado.proyectoId === p) {
          return;
        }
      }
      await api.borrarProyecto(p);
      this.actualizar({
        proyectos: this.estado.proyectos.filter((x) => x.id !== p),
      });
    });
  }

  crearHoja(nombre: string) {
    const p = this.estado.proyectoId!;
    return this.hacer(async () => {
      const { proyecto, hoja } = await api.crearHoja(p, nombre);
      this.reemplazarProyecto(proyecto);
      await this.abrirHoja(p, hoja.id);
    });
  }

  renombrarHoja(h: string, nombre: string) {
    const p = this.estado.proyectoId!;
    return this.hacer(async () => {
      this.reemplazarProyecto(await api.renombrarHoja(p, h, nombre));
      if (h === this.estado.hojaId) {
        this.marcarAbierta(p, h);
        this.excalidraw?.updateScene({
          appState: { name: this.nombreEscena() },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
    });
  }

  moverHoja(h: string, delta: -1 | 1) {
    const proyecto = this.proyectoActual();
    if (!proyecto) {
      return;
    }
    const ids = proyecto.hojas.map((x) => x.id);
    const i = ids.indexOf(h);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) {
      return;
    }
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return this.hacer(async () => {
      this.reemplazarProyecto(await api.ordenarHojas(proyecto.id, ids));
    });
  }

  borrarHoja(h: string) {
    const proyecto = this.proyectoActual();
    if (!proyecto || proyecto.hojas.length < 2) {
      this.avisar("Un proyecto necesita al menos una hoja.");
      return;
    }
    return this.hacer(async () => {
      if (h === this.estado.hojaId) {
        const i = proyecto.hojas.findIndex((x) => x.id === h);
        const vecina = proyecto.hojas[i + 1] ?? proyecto.hojas[i - 1];
        await this.abrirHoja(proyecto.id, vecina.id);
        if (this.estado.hojaId === h) {
          return;
        }
      }
      this.reemplazarProyecto(await api.borrarHoja(proyecto.id, h));
    });
  }
}

export const pizarra = new Pizarra();

export type { Hoja, Proyecto };
