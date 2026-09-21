import { describe, expect, test } from "vitest";

import { elementosParaIA, expandirSeleccion } from "./paraIA";

// helpers para construir elementos mínimos sin repetir todos los campos
// internos de Excalidraw (seed, versionNonce, roundness, etc.) que no le
// importan a esta transformación.
const figura = (over: Record<string, unknown>) => ({
  isDeleted: false,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  groupIds: [] as string[],
  boundElements: [],
  ...over,
});

const texto = (over: Record<string, unknown>) => ({
  type: "text",
  isDeleted: false,
  containerId: null,
  groupIds: [] as string[],
  ...over,
});

describe("elementosParaIA", () => {
  test("figura con rótulo agrupado sin binding (la convención del MCP)", () => {
    // exactamente lo que copia Ctrl+C sobre un rectángulo hecho por
    // pizarra-mcp: rectángulo + texto centrado, mismo groupId, sin containerId
    const elementos = [
      figura({
        id: "r1",
        type: "rectangle",
        x: -116.6,
        y: 639.4,
        width: 280,
        height: 85,
        strokeColor: "#d97706",
        backgroundColor: "#fef3c7",
        groupIds: ["g1"],
      }),
      texto({
        id: "t1",
        x: -23.4,
        y: 669.4,
        width: 75.9,
        height: 25,
        text: "Clientes",
        fontSize: 20,
        groupIds: ["g1"],
      }),
    ];

    const salida = elementosParaIA(elementos as any);

    expect(salida).toEqual([
      {
        id: "r1",
        type: "rectangle",
        x: -116.6,
        y: 639.4,
        width: 280,
        height: 85,
        backgroundColor: "#fef3c7",
        strokeColor: "#d97706",
        label: "Clientes",
      },
    ]);
  });

  test("figura con rótulo ligado nativamente (containerId)", () => {
    const elementos = [
      figura({
        id: "r1",
        type: "ellipse",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      }),
      texto({ id: "t1", containerId: "r1", text: "Nodo", fontSize: 16 }),
    ];
    expect(elementosParaIA(elementos as any)).toEqual([
      {
        id: "r1",
        type: "ellipse",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        label: "Nodo",
      },
    ]);
  });

  test("flecha con bindings nativos usa from/to, no coordenadas", () => {
    const elementos = [
      figura({
        id: "a",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 100,
        height: 50,
      }),
      figura({
        id: "b",
        type: "rectangle",
        x: 300,
        y: 0,
        width: 100,
        height: 50,
      }),
      figura({
        id: "e1",
        type: "arrow",
        x: 100,
        y: 25,
        width: 200,
        height: 0,
        points: [
          [0, 0],
          [200, 0],
        ],
        startBinding: { elementId: "a" },
        endBinding: { elementId: "b" },
      }),
    ];
    const salida = elementosParaIA(elementos as any);
    expect(salida.find((e: any) => e.id === "e1")).toEqual({
      id: "e1",
      type: "arrow",
      from: "a",
      to: "b",
    });
  });

  test("flecha sin bindings (convención del MCP) con rótulo + máscara: la máscara no aparece suelta", () => {
    const elementos = [
      figura({
        id: "a",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 100,
        height: 50,
      }),
      figura({
        id: "b",
        type: "rectangle",
        x: 300,
        y: 0,
        width: 100,
        height: 50,
      }),
      figura({
        id: "e1",
        type: "arrow",
        x: 100,
        y: 25,
        width: 200,
        height: 0,
        points: [
          [0, 0],
          [200, 0],
        ],
        startBinding: null,
        endBinding: null,
        groupIds: ["edge-e1"],
      }),
      // máscara blanca que corta la línea detrás del rótulo
      figura({
        id: "e1-mask",
        type: "rectangle",
        x: 180,
        y: 15,
        width: 40,
        height: 20,
        backgroundColor: "#ffffff",
        groupIds: ["edge-e1"],
      }),
      texto({
        id: "e1-label",
        x: 185,
        y: 17,
        width: 30,
        height: 16,
        text: "API",
        fontSize: 14,
        groupIds: ["edge-e1"],
      }),
    ];
    const salida = elementosParaIA(elementos as any);
    expect(salida.map((e: any) => e.id)).toEqual(["a", "b", "e1"]);
    expect(salida.find((e: any) => e.id === "e1")).toMatchObject({
      type: "arrow",
      x1: 100,
      y1: 25,
      x2: 300,
      y2: 25,
      label: "API",
    });
  });

  test("texto suelto (no ligado a nada) se copia tal cual", () => {
    const elementos = [
      texto({ id: "t1", x: 10, y: 20, text: "TITULO", fontSize: 28 }),
    ];
    expect(elementosParaIA(elementos as any)).toEqual([
      { type: "text", x: 10, y: 20, text: "TITULO", fontSize: 28 },
    ]);
  });

  test("descarta elementos borrados", () => {
    const elementos = [
      figura({
        id: "r1",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        isDeleted: true,
      }),
    ];
    expect(elementosParaIA(elementos as any)).toEqual([]);
  });
});

describe("expandirSeleccion", () => {
  test("agrega el texto ligado nativamente a un contenedor seleccionado", () => {
    const elementos = [
      figura({
        id: "r1",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
      texto({ id: "t1", containerId: "r1", text: "hola" }),
      figura({
        id: "otro",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    ];
    const resultado = expandirSeleccion(elementos as any, { r1: true });
    expect(resultado.map((e) => e.id)).toEqual(["r1", "t1"]);
  });

  test("agrega el resto de un grupo aunque solo un miembro esté marcado como seleccionado", () => {
    const elementos = [
      figura({
        id: "r1",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        groupIds: ["g"],
      }),
      texto({ id: "t1", x: 0, y: 0, text: "hola", groupIds: ["g"] }),
      figura({
        id: "otro",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    ];
    const resultado = expandirSeleccion(elementos as any, { r1: true });
    expect(resultado.map((e) => e.id).sort()).toEqual(["r1", "t1"]);
  });
});
