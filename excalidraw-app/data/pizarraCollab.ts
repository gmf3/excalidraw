// Reemplazo de data/firebase.ts para la Pizarra: misma forma exacta de las
// cinco funciones que importa collab/Collab.tsx, así ese archivo (1000+
// líneas, compartido con el modo normal de excalidraw.com) no necesita
// tocarse más que el import.
//
// La persistencia durable de la escena NO pasa por acá: ya la resuelve
// pizarra.ts con su guardado REST propio (que además fusiona cambios
// concurrentes, Fase 0). Collab solo necesita la sincronización EN VIVO
// (socket.io, Fase 2) — así que "guardar/cargar de Firebase" acá es un
// no-op: cuando alguien entra a una sala, lo que ya pintó pizarra.iniciar()
// es el estado inicial correcto, y si hay otro par conectado, Portal ya le
// pide la escena completa por el socket (evento "new-user" → broadcastScene).
//
// Las imágenes SÍ quedan con una limitación real: viajan embebidas dentro
// del JSON de la hoja (como ya hace pizarra-server), pero no en vivo por el
// socket — un par ve la imagen que agregó el otro recién cuando pizarra.ts
// vuelve a leer la hoja (el aviso de la Fase 1 lo dispara al instante, así
// que en la práctica es casi inmediato, no instantáneo pixel a pixel).

import type { FileId } from "@excalidraw/element/types";
import type { AppState, BinaryFileData } from "@excalidraw/excalidraw/types";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";

export const isSavedToFirebase = (
  _portal: Portal,
  _elements: readonly SyncableExcalidrawElement[],
): boolean => true;

export const saveToFirebase = async (
  _portal: Portal,
  _elements: readonly SyncableExcalidrawElement[],
  _appState: AppState,
) => null;

export const loadFromFirebase = async (
  _roomId: string,
  _roomKey: string,
  _socket: unknown,
): Promise<readonly SyncableExcalidrawElement[] | null> => null;

export const saveFilesToFirebase = async ({
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => ({
  savedFiles: [] as FileId[],
  erroredFiles: files.map((f) => f.id),
});

export const loadFilesFromFirebase = async (
  _prefix: string,
  _decryptionKey: string,
  filesIds: readonly FileId[],
) => ({
  loadedFiles: [] as BinaryFileData[],
  erroredFiles: new Map(filesIds.map((id) => [id, true as const])),
});
