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
  assert.equal(arrow.startBinding, null);
  assert.equal(arrow.endBinding, null);
  const web = elements.find((element) => element.id === "web");
  const webLabel = elements.find(
    (element) => element.type === "text" && element.text.startsWith("Web"),
  );
  assert.equal(web.boundElements.length, 0);
  assert.equal(webLabel.containerId, null);
  assert.deepEqual(web.groupIds, webLabel.groupIds);
  const arrowLabel = elements.find(
    (element) => element.type === "text" && element.text === "HTTPS",
  );
  assert.equal(arrowLabel.containerId, null);
  assert.deepEqual(arrow.groupIds, arrowLabel.groupIds);
  assert.equal(web.height, 60);
  assert.equal(elements.find((element) => element.id === "api").height, 50);
  assert.equal(makeScene(elements).type, "excalidraw");
});

test("permite conservar una altura explícita cuando fitToText es false", () => {
  const [shape] = elementsFromSkeleton([
    {
      id: "panel",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 300,
      height: 180,
      label: "Panel",
      fitToText: false,
    },
  ]);
  assert.equal(shape.height, 180);
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

test("deja margen horizontal en títulos para no recortar la última letra", () => {
  const [title] = elementsFromSkeleton([
    {
      type: "text",
      x: 0,
      y: 0,
      fontSize: 32,
      text: "ONCOVET IA · FRONTEND",
    },
  ]);
  assert(title.width >= 440);
});
