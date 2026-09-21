// Convierte elementos de Excalidraw (el formato interno, con seed/versionNonce/
// roundness/timestamps) al formato abreviado que también entiende pizarra-mcp
// (ver pizarra-mcp/scene.mjs): figuras con id/type/x/y/width/height/label,
// flechas con from/to. Pensado para pegarse en un chat con una IA — es
// compacto, legible, y si la IA lo modifica se puede escribir de vuelta tal
// cual con la tool `write_diagram` del MCP.

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

type ElementoAbreviado = Record<string, unknown>;

const TRANSPARENTE = "transparent";
const TRAZO_POR_DEFECTO = "#1e1e1e";
const FIGURAS = new Set(["rectangle", "ellipse", "diamond"]);
const LINEALES = new Set(["arrow", "line"]);

const redondear = (n: number) => Math.round(n * 100) / 100;

const centro = (caja: {
  x: number;
  y: number;
  width: number;
  height: number;
}) => ({
  x: caja.x + caja.width / 2,
  y: caja.y + caja.height / 2,
});

const dentroDe = (
  punto: { x: number; y: number },
  caja: { x: number; y: number; width: number; height: number },
  margen = 6,
) =>
  punto.x >= caja.x - margen &&
  punto.x <= caja.x + caja.width + margen &&
  punto.y >= caja.y - margen &&
  punto.y <= caja.y + caja.height + margen;

/**
 * Selección "real" para copiar: agrega los rótulos ligados nativamente a un
 * contenedor seleccionado y el resto de los elementos de un mismo grupo
 * (clickear una figura agrupada selecciona todo el grupo, pero por las dudas
 * se completa acá también).
 */
export const expandirSeleccion = (
  todos: readonly ExcalidrawElement[],
  seleccionadosIds: AppState["selectedElementIds"],
): ExcalidrawElement[] => {
  const vivos = todos.filter((el) => !el.isDeleted);
  const ids = new Set(Object.keys(seleccionadosIds));
  const grupos = new Set(
    vivos.filter((el) => ids.has(el.id)).flatMap((el) => el.groupIds),
  );
  for (const el of vivos) {
    if (
      ids.has(el.id) ||
      (el.type === "text" && el.containerId && ids.has(el.containerId)) ||
      el.groupIds.some((g) => grupos.has(g))
    ) {
      ids.add(el.id);
    }
  }
  return vivos.filter((el) => ids.has(el.id));
};

/** Busca el texto de `figura`: ligado nativamente, o agrupado y centrado encima
 * (la convención sin bindings que usa pizarra-mcp para no disparar conflictos). */
const etiquetaDe = (
  figura: ExcalidrawElement,
  textos: ExcalidrawElement[],
  usados: Set<string>,
): string | undefined => {
  const ligado = textos.find(
    (t) =>
      !usados.has(t.id) && "containerId" in t && t.containerId === figura.id,
  );
  if (ligado && "text" in ligado) {
    usados.add(ligado.id);
    return ligado.text;
  }
  const grupos = new Set(figura.groupIds);
  const agrupado = textos.find(
    (t) =>
      !usados.has(t.id) &&
      "containerId" in t &&
      !t.containerId &&
      t.groupIds.some((g) => grupos.has(g)) &&
      "width" in t &&
      dentroDe(centro(t), figura),
  );
  if (agrupado && "text" in agrupado) {
    usados.add(agrupado.id);
    return agrupado.text;
  }
  return undefined;
};

export const elementosParaIA = (
  elementos: readonly ExcalidrawElement[],
): ElementoAbreviado[] => {
  const vivos = elementos.filter((el) => !el.isDeleted);
  const textos = vivos.filter((el) => el.type === "text");
  const idsFigura = new Set(
    vivos.filter((el) => FIGURAS.has(el.type)).map((el) => el.id),
  );
  const usados = new Set<string>();
  const transformadas = new Map<string, ElementoAbreviado>();
  // grupos de una flecha CON rótulo: la máscara blanca que le corta la línea
  // detrás comparte ese grupo (ver linearElement en pizarra-mcp/scene.mjs) y
  // no es una figura en sí — se descarta más abajo.
  const gruposDeRotuloDeFlecha = new Set<string>();

  // primera pasada: flechas, para que sus grupos-de-rótulo ya estén resueltos
  // cuando la segunda pasada decida si una figura es una máscara descartable
  for (const el of vivos) {
    if (!(LINEALES.has(el.type) && "points" in el)) {
      continue;
    }
    const label = etiquetaDe(el, textos, usados);
    if (label) {
      el.groupIds.forEach((g) => gruposDeRotuloDeFlecha.add(g));
    }
    const inicio = { x: el.x + el.points[0][0], y: el.y + el.points[0][1] };
    const fin = {
      x: el.x + el.points[el.points.length - 1][0],
      y: el.y + el.points[el.points.length - 1][1],
    };
    const flecha: ElementoAbreviado = { id: el.id, type: el.type };
    const origenId =
      "startBinding" in el ? el.startBinding?.elementId : undefined;
    const destinoId = "endBinding" in el ? el.endBinding?.elementId : undefined;
    if (origenId && idsFigura.has(origenId)) {
      flecha.from = origenId;
    } else {
      flecha.x1 = redondear(inicio.x);
      flecha.y1 = redondear(inicio.y);
    }
    if (destinoId && idsFigura.has(destinoId)) {
      flecha.to = destinoId;
    } else {
      flecha.x2 = redondear(fin.x);
      flecha.y2 = redondear(fin.y);
    }
    if (label) {
      flecha.label = label;
    }
    transformadas.set(el.id, flecha);
  }

  // segunda pasada: figuras. las que no tienen rótulo propio y comparten un
  // grupo con una flecha rotulada son la máscara de esa flecha: se saltean.
  for (const el of vivos) {
    if (!FIGURAS.has(el.type)) {
      continue;
    }
    const label = etiquetaDe(el, textos, usados);
    if (!label && el.groupIds.some((g) => gruposDeRotuloDeFlecha.has(g))) {
      continue;
    }
    const figura: ElementoAbreviado = {
      id: el.id,
      type: el.type,
      x: redondear(el.x),
      y: redondear(el.y),
      width: redondear(el.width),
      height: redondear(el.height),
    };
    if ("backgroundColor" in el && el.backgroundColor !== TRANSPARENTE) {
      figura.backgroundColor = el.backgroundColor;
    }
    if ("strokeColor" in el && el.strokeColor !== TRAZO_POR_DEFECTO) {
      figura.strokeColor = el.strokeColor;
    }
    if (label) {
      figura.label = label;
    }
    transformadas.set(el.id, figura);
  }

  // segunda pasada, en el orden original: figuras/flechas ya resueltas, y los
  // textos sueltos que no quedaron consumidos como etiqueta de nada
  const salida: ElementoAbreviado[] = [];
  for (const el of vivos) {
    const lista = transformadas.get(el.id);
    if (lista) {
      salida.push(lista);
    } else if (
      el.type === "text" &&
      !usados.has(el.id) &&
      (!el.containerId || !idsFigura.has(el.containerId))
    ) {
      salida.push({
        type: "text",
        x: redondear(el.x),
        y: redondear(el.y),
        text: el.text,
        fontSize: el.fontSize,
      });
    }
  }
  return salida;
};

const PREAMBULO =
  "Fragmento de un diagrama de la Pizarra, en el formato abreviado de pizarra-mcp " +
  "(figuras: id/type/x/y/width/height/label; flechas: from/to o x1,y1/x2,y2). " +
  "Si lo modificás, se puede escribir de vuelta tal cual con la tool write_diagram del MCP.";

export const textoParaPortapapeles = (elementos: ElementoAbreviado[]) =>
  `${PREAMBULO}\n\n${JSON.stringify(elementos, null, 2)}`;
