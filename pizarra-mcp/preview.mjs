import { Resvg } from "@resvg/resvg-js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FONT_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../packages/excalidraw/fonts/Liberation/LiberationSans-Regular.woff2",
);

const xml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const number = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

const liveElements = (scene) =>
  (Array.isArray(scene?.elements) ? scene.elements : []).filter(
    (element) => element && !element.isDeleted,
  );

const boundsOf = (elements) => {
  const drawable = elements.filter(
    (element) =>
      Number.isFinite(Number(element.x)) &&
      Number.isFinite(Number(element.y)) &&
      Number.isFinite(Number(element.width)) &&
      Number.isFinite(Number(element.height)),
  );
  if (!drawable.length) {
    throw new Error("La hoja no tiene elementos visibles para previsualizar");
  }
  const minX = Math.min(...drawable.map((element) => number(element.x)));
  const minY = Math.min(...drawable.map((element) => number(element.y)));
  const maxX = Math.max(
    ...drawable.map((element) => number(element.x) + number(element.width)),
  );
  const maxY = Math.max(
    ...drawable.map((element) => number(element.y) + number(element.height)),
  );
  return { minX, minY, maxX, maxY };
};

const strokeDash = (style) =>
  style === "dashed"
    ? ' stroke-dasharray="12 8"'
    : style === "dotted"
    ? ' stroke-dasharray="3 7" stroke-linecap="round"'
    : "";

const shapeSvg = (element) => {
  const x = number(element.x);
  const y = number(element.y);
  const width = Math.max(1, number(element.width, 1));
  const height = Math.max(1, number(element.height, 1));
  const stroke = xml(element.strokeColor || "#1e1e1e");
  const fill =
    !element.backgroundColor || element.backgroundColor === "transparent"
      ? "none"
      : xml(element.backgroundColor);
  const strokeWidth = Math.max(1, number(element.strokeWidth, 2));
  const common = `fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"${strokeDash(
    element.strokeStyle,
  )} opacity="${Math.max(0, Math.min(1, number(element.opacity, 100) / 100))}"`;

  if (element.type === "rectangle" || element.type === "frame") {
    const radius = element.roundness ? Math.min(14, width / 8, height / 8) : 0;
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" ${common}/>`;
  }
  if (element.type === "ellipse") {
    return `<ellipse cx="${x + width / 2}" cy="${y + height / 2}" rx="${
      width / 2
    }" ry="${height / 2}" ${common}/>`;
  }
  if (element.type === "diamond") {
    const points = [
      [x + width / 2, y],
      [x + width, y + height / 2],
      [x + width / 2, y + height],
      [x, y + height / 2],
    ]
      .map((point) => point.join(","))
      .join(" ");
    return `<polygon points="${points}" ${common}/>`;
  }
  return "";
};

const arrowHead = (from, to, color, size) => {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  const baseX = to[0] - ux * size;
  const baseY = to[1] - uy * size;
  const half = size * 0.45;
  return `${to[0]},${to[1]} ${baseX + px * half},${baseY + py * half} ${
    baseX - px * half
  },${baseY - py * half}`;
};

const linearSvg = (element) => {
  const x = number(element.x);
  const y = number(element.y);
  const rawPoints = Array.isArray(element.points) ? element.points : [];
  if (rawPoints.length < 2) {
    return "";
  }
  const points = rawPoints.map((point) => [
    x + number(point?.[0]),
    y + number(point?.[1]),
  ]);
  const stroke = xml(element.strokeColor || "#1e1e1e");
  const strokeWidth = Math.max(1, number(element.strokeWidth, 2));
  const opacity = Math.max(0, Math.min(1, number(element.opacity, 100) / 100));
  const line = `<polyline points="${points
    .map((point) => point.join(","))
    .join(
      " ",
    )}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round"${strokeDash(
    element.strokeStyle,
  )} opacity="${opacity}"/>`;
  const end = points.at(-1);
  const before = points.at(-2);
  const head =
    element.type === "arrow" && element.endArrowhead && end && before
      ? `<polygon points="${arrowHead(
          before,
          end,
          stroke,
          11 + strokeWidth * 2,
        )}" fill="${stroke}" opacity="${opacity}"/>`
      : "";
  return `${line}${head}`;
};

const textSvg = (element) => {
  const text = String(element.text ?? element.originalText ?? "");
  if (!text) {
    return "";
  }
  const fontSize = Math.max(8, number(element.fontSize, 20));
  const lineHeight = Math.max(1, number(element.lineHeight, 1.25));
  const lines = text.split("\n");
  const totalHeight = lines.length * fontSize * lineHeight;
  const align = element.textAlign || "left";
  const anchor =
    align === "center" ? "middle" : align === "right" ? "end" : "start";
  const x =
    number(element.x) +
    (align === "center"
      ? number(element.width) / 2
      : align === "right"
      ? number(element.width)
      : 0);
  const top =
    element.verticalAlign === "middle"
      ? number(element.y) + (number(element.height) - totalHeight) / 2
      : element.verticalAlign === "bottom"
      ? number(element.y) + number(element.height) - totalHeight
      : number(element.y);
  const color = xml(element.strokeColor || "#1e1e1e");
  const opacity = Math.max(0, Math.min(1, number(element.opacity, 100) / 100));
  const tspans = lines
    .map(
      (line, index) =>
        `<tspan x="${x}" y="${
          top + fontSize * 0.9 + index * fontSize * lineHeight
        }">${xml(line)}</tspan>`,
    )
    .join("");
  return `<text text-anchor="${anchor}" font-family="Liberation Sans" font-size="${fontSize}" font-weight="${
    fontSize >= 28 ? 600 : 400
  }" fill="${color}" opacity="${opacity}">${tspans}</text>`;
};

export const sceneToSvg = (scene, options = {}) => {
  const elements = liveElements(scene);
  const { minX, minY, maxX, maxY } = boundsOf(elements);
  const padding = Math.max(20, number(options.padding, 48));
  const width = Math.max(1, maxX - minX + padding * 2);
  const height = Math.max(1, maxY - minY + padding * 2);
  const offsetX = padding - minX;
  const offsetY = padding - minY;
  const background = xml(
    scene?.appState?.viewBackgroundColor || options.background || "#ffffff",
  );
  const linear = elements
    .filter((element) => element.type === "arrow" || element.type === "line")
    .map(linearSvg)
    .join("");
  const shapes = elements
    .filter((element) =>
      ["rectangle", "ellipse", "diamond", "frame"].includes(element.type),
    )
    .map(shapeSvg)
    .join("");
  const text = elements
    .filter((element) => element.type === "text")
    .map(textSvg)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${background}"/><g transform="translate(${offsetX} ${offsetY})">${linear}${shapes}${text}</g></svg>`;
};

export const renderScenePng = (scene, options = {}) => {
  const maxWidth = Math.max(
    320,
    Math.min(2000, number(options.maxWidth, 1400)),
  );
  const svg = sceneToSvg(scene, options);
  const rendered = new Resvg(svg, {
    fitTo: { mode: "width", value: maxWidth },
    background: scene?.appState?.viewBackgroundColor || "#ffffff",
    font: {
      fontFiles: [FONT_FILE],
      loadSystemFonts: false,
      defaultFontFamily: "Liberation Sans",
    },
  }).render();
  return {
    png: Buffer.from(rendered.asPng()),
    width: rendered.width,
    height: rendered.height,
    svg,
  };
};
