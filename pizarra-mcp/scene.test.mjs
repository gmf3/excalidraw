import assert from "node:assert/strict";
import test from "node:test";
import { elementsFromSkeleton, makeScene } from "./scene.mjs";

test("convierte figuras, labels y conexiones a elementos Excalidraw", () => {
  const elements = elementsFromSkeleton([
    {
      id: "web",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      label: "Web\nvanilla JS",
    },
    {
      id: "api",
      type: "rectangle",
      x: 400,
      y: 0,
      width: 200,
      height: 100,
      label: "FastAPI",
    },
    { id: "request", type: "arrow", from: "web", to: "api", label: "HTTPS" },
  ]);
  assert.equal(
    elements.filter((element) => element.type === "rectangle").length,
    2,
  );
  assert.equal(elements.filter((element) => element.type === "text").length, 3);
  const arrow = elements.find((element) => element.type === "arrow");
  assert.equal(arrow.startBinding.elementId, "web");
  assert.equal(arrow.endBinding.elementId, "api");
  assert.equal(makeScene(elements).type, "excalidraw");
});

test("rechaza etiquetas br para evitar texto literal en el lienzo", () => {
  assert.throws(
    () =>
      elementsFromSkeleton([
        { id: "x", type: "rectangle", x: 0, y: 0, label: "A<br>B" },
      ]),
    /contiene <br>/,
  );
});

test("rechaza conexiones a ids inexistentes", () => {
  assert.throws(
    () =>
      elementsFromSkeleton([
        { id: "a", type: "arrow", from: "missing", to: "other" },
      ]),
    /from\/to no existe/,
  );
});
