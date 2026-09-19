import crypto from "node:crypto";

const FONT_FAMILY = 5;
const LINE_HEIGHT = 1.25;
const DEFAULT_STROKE = "#1e1e1e";
const DEFAULT_BACKGROUND = "transparent";

const id = () => crypto.randomBytes(12).toString("base64url");
const randomInt = () => crypto.randomInt(1, 2_147_483_647);

const assertNumber = (value, name) => {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} tiene que ser un numero`);
  }
  return value;
};

const assertText = (value, name) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} tiene que ser texto no vacio`);
  }
  if (/<br\s*\/?>/i.test(value)) {
    throw new Error(
      `${name} contiene <br>. Usa \\n para un salto de linea real`,
    );
  }
  return value;
};

const baseElement = (type, spec) => ({
  id: spec.id || id(),
  type,
  x: assertNumber(spec.x, `${type}.x`),
  y: assertNumber(spec.y, `${type}.y`),
  width: Math.max(1, Number(spec.width) || 1),
  height: Math.max(1, Number(spec.height) || 1),
  angle: Number(spec.angle) || 0,
  strokeColor: spec.strokeColor || DEFAULT_STROKE,
  backgroundColor: spec.backgroundColor || DEFAULT_BACKGROUND,
  fillStyle: spec.fillStyle || "solid",
  strokeWidth: Number(spec.strokeWidth) || 2,
  strokeStyle: spec.strokeStyle || "solid",
  roughness: Number.isFinite(spec.roughness) ? spec.roughness : 1,
  opacity: Number.isFinite(spec.opacity) ? spec.opacity : 100,
  groupIds: Array.isArray(spec.groupIds) ? spec.groupIds : [],
  frameId: spec.frameId ?? null,
  index: null,
  roundness:
    type === "rectangle"
      ? { type: 3 }
      : type === "diamond" || type === "ellipse"
      ? { type: 2 }
      : null,
  seed: randomInt(),
  version: 1,
  versionNonce: randomInt(),
  isDeleted: false,
  boundElements: [],
  updated: Date.now(),
  created: null,
  link: spec.link ?? null,
  locked: Boolean(spec.locked),
});

const textMetrics = (text, fontSize) => {
  const lines = text.split("\n");
  return {
    // Excalifont es más ancho que una sans promedio. El margen adicional evita
    // que Excalidraw recorte la última letra de títulos y labels de flechas.
    width:
      Math.max(...lines.map((line) => line.length), 1) * fontSize * 0.65 + 8,
    height: lines.length * fontSize * LINE_HEIGHT,
  };
};

const textElement = (spec, container = null, sharedGroup = null) => {
  const text = assertText(spec.text ?? spec.label, "text");
  const fontSize = Number(spec.fontSize) || 20;
  const measured = textMetrics(text, fontSize);
  const width = container
    ? Math.max(20, container.width - 20)
    : Number(spec.width) || measured.width;
  const height = container
    ? measured.height
    : Number(spec.height) || measured.height;
  const groupIds = [
    ...(Array.isArray(spec.groupIds) ? spec.groupIds : []),
    ...(sharedGroup ? [sharedGroup] : []),
  ];
  const element = baseElement("text", {
    ...spec,
    x: container
      ? container.x + (container.width - width) / 2
      : assertNumber(spec.x, "text.x"),
    y: container
      ? container.y + (container.height - height) / 2
      : assertNumber(spec.y, "text.y"),
    width,
    height,
    groupIds,
    backgroundColor: "transparent",
    strokeWidth: spec.strokeWidth || 1,
    roughness: 0,
  });
  return {
    ...element,
    roundness: null,
    text,
    fontSize,
    baseFontSize: null,
    fontFamily: Number(spec.fontFamily) || FONT_FAMILY,
    textAlign: spec.textAlign || (container ? "center" : "left"),
    verticalAlign: spec.verticalAlign || (container ? "middle" : "top"),
    containerId: null,
    originalText: text,
    autoResize: true,
    lineHeight: Number(spec.lineHeight) || LINE_HEIGHT,
    labelPosition: null,
  };
};

const shapeElement = (spec) => {
  if (!["rectangle", "ellipse", "diamond"].includes(spec.type)) {
    throw new Error(`Tipo de figura no soportado: ${spec.type}`);
  }
  return baseElement(spec.type, {
    width: 220,
    height: 100,
    ...spec,
  });
};

const borderPoint = (from, to) => {
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) {
    return { x: cx, y: cy };
  }
  const sx =
    dx === 0 ? Number.POSITIVE_INFINITY : from.width / 2 / Math.abs(dx);
  const sy =
    dy === 0 ? Number.POSITIVE_INFINITY : from.height / 2 / Math.abs(dy);
  const scale = Math.min(sx, sy);
  return { x: cx + dx * scale, y: cy + dy * scale };
};

const linearElement = (spec, shapes) => {
  const from = spec.from ? shapes.get(spec.from) : null;
  const to = spec.to ? shapes.get(spec.to) : null;
  if ((spec.from && !from) || (spec.to && !to)) {
    throw new Error(`Conexion ${spec.id || "sin id"}: from/to no existe`);
  }
  const start = from
    ? borderPoint(from, to || from)
    : {
        x: assertNumber(spec.x, `${spec.type}.x`),
        y: assertNumber(spec.y, `${spec.type}.y`),
      };
  const end = to
    ? borderPoint(to, from || to)
    : {
        x: start.x + assertNumber(spec.width, `${spec.type}.width`),
        y: start.y + assertNumber(spec.height, `${spec.type}.height`),
      };
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const element = baseElement(spec.type, {
    ...spec,
    x,
    y,
    width: Math.max(1, Math.abs(end.x - start.x)),
    height: Math.max(1, Math.abs(end.y - start.y)),
    backgroundColor: "transparent",
    roundness: null,
  });
  return {
    ...element,
    roundness: spec.roundness === false ? null : { type: 2 },
    points: [
      [start.x - x, start.y - y],
      [end.x - x, end.y - y],
    ],
    lastCommittedPoint: null,
    // Quedan visualmente apoyadas en el borde, pero libres de bindings.
    // Excalidraw normalizaba bindings incompletos al abrir la hoja y generaba
    // falsos cambios locales que luego chocaban con la próxima escritura MCP.
    startBinding: null,
    endBinding: null,
    startArrowhead: spec.startArrowhead ?? null,
    endArrowhead:
      spec.endArrowhead === undefined
        ? spec.type === "arrow"
          ? "arrow"
          : null
        : spec.endArrowhead,
    elbowed: false,
    moveMidPointsWithElement: false,
  };
};

export const elementsFromSkeleton = (input) => {
  if (!Array.isArray(input)) {
    throw new Error("elements tiene que ser un array JSON");
  }
  const elements = [];
  const shapes = new Map();

  for (const raw of input) {
    if (!raw || typeof raw !== "object") {
      throw new Error("Cada elemento tiene que ser un objeto");
    }
    if (["rectangle", "ellipse", "diamond"].includes(raw.type)) {
      const shape = shapeElement(raw);
      if (shapes.has(shape.id)) {
        throw new Error(`Id duplicado: ${shape.id}`);
      }
      const groupId = raw.label ? raw.groupId || `node-${shape.id}` : null;
      if (groupId && !shape.groupIds.includes(groupId)) {
        shape.groupIds.push(groupId);
      }
      shapes.set(shape.id, shape);
      elements.push(shape);
      if (raw.label) {
        const label = textElement(
          { ...raw, id: raw.labelId || id(), text: raw.label },
          shape,
          groupId,
        );
        elements.push(label);
      }
    } else if (raw.type === "text") {
      elements.push(textElement(raw));
    }
  }

  for (const raw of input) {
    if (!["arrow", "line"].includes(raw?.type)) {
      continue;
    }
    const linear = linearElement(raw, shapes);
    const groupId = raw.label ? raw.groupId || `edge-${linear.id}` : null;
    if (groupId && !linear.groupIds.includes(groupId)) {
      linear.groupIds.push(groupId);
    }
    elements.push(linear);
    if (raw.label) {
      const fontSize = Number(raw.fontSize) || 16;
      const metrics = textMetrics(raw.label, fontSize);
      const label = textElement({
        id: raw.labelId || id(),
        type: "text",
        text: raw.label,
        x: linear.x + (linear.width - metrics.width) / 2,
        y: linear.y + (linear.height - metrics.height) / 2 - 8,
        width: metrics.width,
        height: metrics.height,
        fontSize,
        textAlign: "center",
        verticalAlign: "middle",
        groupIds: groupId ? [groupId] : [],
      });
      elements.push(label);
    }
  }

  const ids = new Set();
  for (const element of elements) {
    if (ids.has(element.id)) {
      throw new Error(`Id duplicado: ${element.id}`);
    }
    ids.add(element.id);
  }
  return elements;
};

export const makeScene = (elements, appState = {}) => ({
  type: "excalidraw",
  version: 2,
  source: "pizarra-mcp",
  elements,
  appState: {
    viewBackgroundColor: "#ffffff",
    currentItemFontFamily: FONT_FAMILY,
    ...appState,
  },
  files: {},
});

export const compactScene = (scene) => ({
  type: scene.type,
  version: scene.version,
  source: scene.source,
  elements: scene.elements
    .filter((element) => !element.isDeleted)
    .map((element) => ({
      id: element.id,
      type: element.type,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      text: element.text,
      containerId: element.containerId,
      boundElements: element.boundElements,
      startBinding: element.startBinding,
      endBinding: element.endBinding,
    })),
});
