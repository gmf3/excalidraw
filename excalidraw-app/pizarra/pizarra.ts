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
import { collabAPIAtom } from "../collab/Collab";
import { importFromLocalStorage } from "../data/localStorage";

import { api, cuandoPidaLogin, descendientesDe, hijosDe } from "./api";

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
  /** Ícono breve arriba a la derecha: el servidor acaba de fusionar este
   * guardado con cambios de otro lado (Fase 0). */
  fusionReciente: boolean;
};

export const pizarraAtom = atom<EstadoPizarra>({
  proyectos: [],
  proyectoId: null,
  hojaId: null,
  guardado: "cargando",
  error: null,
  necesitaLogin: false,
  fusionReciente: false,
});

const GUARDAR_TRAS_MS = 800;
const REVISAR_CADA_MS = 5_000;
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

/**
 * Clave de colaboración determinística para una hoja: misma hoja siempre da
 * la misma clave (no como un link de sala real, que la genera al azar), así
 * que cualquiera que la abra puede descifrar sin compartir nada aparte. No
 * es la única defensa del contenido -- eso ya lo hace la contraseña única de
 * la Pizarra -- es nomás para no reusar la MISMA clave AES en todas las
 * hojas.
 */
const claveDeColaboracion = async (proyecto: string, hoja: string) => {
  const datos = new TextEncoder().encode(`pizarra-collab:${proyecto}/${hoja}`);
  const hash = await crypto.subtle.digest("SHA-256", datos);
  const bytes = new Uint8Array(hash).slice(0, 16);
  let binario = "";
  for (const byte of bytes) {
    binario += String.fromCharCode(byte);
  }
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

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
  private socket: WebSocket | null = null;
  private timerReconexion: ReturnType<typeof setTimeout> | null = null;
  private salaColaboracionActual: string | null = null;

  constructor() {
    cuandoPidaLogin(() => this.actualizar({ necesitaLogin: true }));
    // Collab (Fase 2) monta y registra collabAPIAtom en su propio efecto de
    // React, en paralelo a este controlador -- puede no estar listo todavía
    // cuando se abre la primera hoja. Esta suscripción (fuera de React, el
    // store de Jotai lo permite) agarra la sala actual apenas aparece.
    appJotaiStore.sub(collabAPIAtom, () => {
      const { proyectoId, hojaId } = this.estado;
      if (proyectoId && hojaId) {
        this.sincronizarColaboracion(proyectoId, hojaId);
      }
    });
  }

  /**
   * Arranca (o cambia de) la colaboración en vivo para la hoja indicada. Sala
   * determinística `${proyecto}/${hoja}` -- no hace falta compartir ningún
   * link, cualquiera que abra la misma hoja entra a la misma sala.
   */
  private sincronizarColaboracion(p: string, h: string) {
    const collabAPI = appJotaiStore.get(collabAPIAtom);
    if (!collabAPI) {
      return;
    }
    const sala = `${p}/${h}`;
    if (sala === this.salaColaboracionActual) {
      return;
    }
    if (collabAPI.isCollaborating()) {
      collabAPI.stopCollaboration(false);
    }
    this.salaColaboracionActual = sala;
    claveDeColaboracion(p, h).then((roomKey) => {
      // si cambiaste de hoja mientras se calculaba la clave, esta ya no es
      // la sala vigente -- no la arranques.
      if (this.salaColaboracionActual === sala) {
        collabAPI.startCollaboration({ roomId: sala, roomKey, keepLocalScene: true });
      }
    });
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

  private timerFusion: ReturnType<typeof setTimeout> | null = null;

  /** Ícono breve arriba a la derecha en vez de un toast de texto. */
  private mostrarFusion() {
    if (this.timerFusion) {
      clearTimeout(this.timerFusion);
    }
    this.actualizar({ fusionReciente: true });
    this.timerFusion = setTimeout(() => {
      this.timerFusion = null;
      this.actualizar({ fusionReciente: false });
    }, 2500);
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

  /**
   * Corta cualquier otra pestaña/dispositivo abierto con la misma
   * contraseña. Guarda lo pendiente ACÁ primero (para no perderlo) y avisa
   * que las otras se van a desloguear solas en su próximo pedido.
   */
  async cerrarOtrasSesiones() {
    if (!(await this.guardarPendiente())) {
      this.avisar("No se pudo guardar lo pendiente; cancelado.");
      return;
    }
    await this.hacer(() => api.cerrarOtrasSesiones());
    this.avisar(
      "Listo. Cualquier otra pestaña o dispositivo va a pedir la contraseña de nuevo.",
    );
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
    this.enviarUnion();
    this.sincronizarColaboracion(p, h);
  }

  // --- aviso instantáneo por WebSocket ----------------------------------------

  private conectarSocket() {
    const protocolo = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocolo}//${location.host}/ws`;
    this.socket = new WebSocket(url);
    this.socket.onopen = () => {
      this.enviarUnion();
    };
    this.socket.onmessage = (event) => {
      let mensaje: any;
      try {
        mensaje = JSON.parse(event.data);
      } catch {
        return;
      }
      if (
        mensaje?.tipo === "cambio" &&
        mensaje.proyecto === this.estado.proyectoId &&
        mensaje.hoja === this.estado.hojaId
      ) {
        this.revisarRemoto();
      }
    };
    this.socket.onclose = () => this.programarReconexion();
    this.socket.onerror = () => this.programarReconexion();
  }

  private programarReconexion() {
    if (this.timerReconexion) {
      return;
    }
    this.timerReconexion = setTimeout(() => {
      this.timerReconexion = null;
      this.conectarSocket();
    }, 3000);
  }

  private enviarUnion() {
    const { proyectoId, hojaId } = this.estado;
    if (this.socket?.readyState === WebSocket.OPEN && proyectoId && hojaId) {
      this.socket.send(
        JSON.stringify({ tipo: "unirse", proyecto: proyectoId, hoja: hojaId }),
      );
    }
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
      const { etag, fusionado } = await api.guardarHoja(
        p,
        h,
        texto,
        this.etag,
        keepalive,
      );
      // si nadie tocó el lienzo desde que armamos `texto`, podemos aplicar la
      // versión ya fusionada; si Federico siguió dibujando mientras el
      // pedido viajaba, no la pisamos — el próximo guardado o `revisarRemoto`
      // la va a traer igual, sin perder lo que está dibujando ahora.
      const sinCambiosDesdeElEnvio =
        firma(
          excalidraw.getSceneElementsIncludingDeleted(),
          excalidraw.getAppState(),
        ) === firmaSubida;
      const combinado =
        fusionado && sinCambiosDesdeElEnvio && !keepalive
          ? await api.leerHoja(p, h)
          : null;
      if (
        combinado &&
        this.estado.proyectoId === p &&
        this.estado.hojaId === h
      ) {
        this.aplicarEscena(combinado.escena, combinado.etag, this.vistaActual());
        this.mostrarFusion();
      } else {
        this.etag = etag;
        this.firmaGuardada = firmaSubida;
      }
      this.actualizar({
        guardado: this.hayCambios() ? "pendiente" : "guardado",
        error: null,
      });
      return true;
    } catch (error) {
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
    this.conectarSocket();
    return () => {
      clearInterval(id);
      if (this.timerReconexion) {
        clearTimeout(this.timerReconexion);
        this.timerReconexion = null;
      }
      if (this.socket) {
        // si no se desengancha, el "close" que dispara este mismo cierre
        // (async) reprograma una reconexión zombie después de desmontar.
        this.socket.onclose = null;
        this.socket.onerror = null;
        this.socket.close();
        this.socket = null;
      }
    };
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

  crearHoja(nombre: string, padre: string | null = null) {
    const p = this.estado.proyectoId!;
    return this.hacer(async () => {
      const { proyecto, hoja } = await api.crearHoja(
        p,
        nombre,
        undefined,
        padre,
      );
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

  /** Mueve `h` un lugar entre sus hermanas (misma hoja padre). */
  moverHoja(h: string, delta: -1 | 1) {
    const proyecto = this.proyectoActual();
    const hoja = proyecto?.hojas.find((x) => x.id === h);
    if (!proyecto || !hoja) {
      return;
    }
    const hermanas = hijosDe(proyecto.hojas, hoja.padre);
    const vecina = hermanas[hermanas.findIndex((x) => x.id === h) + delta];
    if (!vecina) {
      return;
    }
    const ids = proyecto.hojas.map((x) => x.id);
    const posA = ids.indexOf(h);
    const posB = ids.indexOf(vecina.id);
    [ids[posA], ids[posB]] = [ids[posB], ids[posA]];
    return this.hacer(async () => {
      this.reemplazarProyecto(await api.ordenarHojas(proyecto.id, ids));
    });
  }

  /** Borra `h` y, en cascada, todas sus sub-hojas a cualquier profundidad. */
  borrarHoja(h: string) {
    const proyecto = this.proyectoActual();
    if (!proyecto) {
      return;
    }
    const afectadas = new Set([h, ...descendientesDe(proyecto.hojas, h)]);
    if (proyecto.hojas.length - afectadas.size < 1) {
      this.avisar("Un proyecto necesita al menos una hoja.");
      return;
    }
    return this.hacer(async () => {
      if (afectadas.has(this.estado.hojaId!)) {
        // prioriza una hermana de la hoja borrada; si no hay, cualquier otra
        const padre = proyecto.hojas.find((x) => x.id === h)?.padre ?? null;
        const destino =
          hijosDe(proyecto.hojas, padre).find((x) => !afectadas.has(x.id)) ??
          proyecto.hojas.find((x) => !afectadas.has(x.id));
        await this.abrirHoja(proyecto.id, destino!.id);
        if (afectadas.has(this.estado.hojaId!)) {
          return;
        }
      }
      this.reemplazarProyecto(await api.borrarHoja(proyecto.id, h));
    });
  }
}

export const pizarra = new Pizarra();

export type { Hoja, Proyecto };
