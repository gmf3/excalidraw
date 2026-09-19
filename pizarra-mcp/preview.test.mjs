import assert from "node:assert/strict";
import test from "node:test";
import { renderScenePng, sceneToSvg } from "./preview.mjs";
import { elementsFromSkeleton, makeScene } from "./scene.mjs";

const scene = makeScene(
  elementsFromSkeleton([
    {
      id: "web",
      type: "rectangle",
      x: 20,
      y: 80,
      width: 220,
      height: 100,
      label: "Frontend\nvanilla JS",
      backgroundColor: "#dbeafe",
      strokeColor: "#2563eb",
    },
    {
      id: "api",
      type: "ellipse",
      x: 420,
      y: 80,
      width: 220,
      height: 100,
      label: "FastAPI",
      backgroundColor: "#dcfce7",
      strokeColor: "#16a34a",
    },
    { id: "request", type: "arrow", from: "web", to: "api", label: "HTTPS" },
  ]),
);

test("genera SVG legible con figuras, flechas y texto", () => {
  const svg = sceneToSvg(scene);
  assert.match(svg, /<rect/);
  assert.match(svg, /<ellipse/);
  assert.match(svg, /<polyline/);
  assert.match(svg, /Frontend/);
  assert.match(svg, /FastAPI/);
});

test("renderiza PNG al ancho solicitado", () => {
  const preview = renderScenePng(scene, { maxWidth: 900 });
  assert.equal(preview.width, 900);
  assert(preview.height > 100);
  assert.equal(preview.png.subarray(1, 4).toString(), "PNG");
});

test("rechaza hojas vacias", () => {
  assert.throws(() => renderScenePng(makeScene([])), /no tiene elementos/);
});
