import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useEffect, useRef } from "react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const source = await fs.readFile(new URL("../web/src/WorkspaceUi.jsx", import.meta.url), "utf8");
const code = source.replace(/^import[^\n]+\n/gm, "").replace(/^export /gm, "");
const compiled = await transformWithEsbuild(code, "WorkspaceUi.jsx", { loader: "jsx", jsx: "transform" });
const { useDialogFocus } = new Function("React", "useEffect", "useRef", `${compiled.code};return {useDialogFocus};`)(React, useEffect, useRef);
const dom = new JSDOM('<button id="launch">Open task</button><div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalRects = window.HTMLElement.prototype.getClientRects;
window.HTMLElement.prototype.getClientRects = function () { return this.isConnected && !this.hasAttribute("data-hidden") ? [{ width: 10, height: 10 }] : []; };
const { createRoot } = await import("react-dom/client");
const root = createRoot(document.getElementById("root")); const closed = [];

function Panel({ name, onClose, disabledTrigger = false }) {
  const ref = useRef(null);
  useDialogFocus(true, onClose, ref);
  return React.createElement("section", { ref, role: "dialog", "aria-modal": "true", "data-name": name },
    React.createElement("button", { "data-hidden": true, id: `${name}-hidden` }, "Hidden"),
    React.createElement("button", { disabled: true }, "Disabled"),
    React.createElement("input", { id: `${name}-first`, "aria-label": `${name} first` }),
    React.createElement("button", { id: `${name}-last`, disabled: disabledTrigger }, "Continue"));
}
function Fixture({ charge = false, base = false, disabledTrigger = false, chargeClose = () => closed.push("charge"), baseClose = () => closed.push("base") }) {
  return React.createElement(React.Fragment, null,
    charge && React.createElement(Panel, { key: "charge", name: "charge", onClose: chargeClose }),
    base && React.createElement(Panel, { key: "base", name: "base", onClose: baseClose, disabledTrigger }));
}
const render = (props) => act(() => root.render(React.createElement(Fixture, props)));
const key = async (value, shiftKey = false) => {
  const event = new window.KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true });
  await act(() => document.dispatchEvent(event)); return event;
};

try {
  const launch = document.getElementById("launch");
  document.body.style.overflow = "scroll"; launch.focus();
  await render({ base: true });
  assert.equal(document.body.style.overflow, "hidden");
  assert.equal(document.activeElement.id, "base-first", "opening skips hidden and disabled controls");
  document.getElementById("base-last").focus();
  await render({ base: true, charge: true });
  assert.deepEqual([...document.querySelectorAll('[role="dialog"]')].map((element) => element.dataset.name), ["charge", "base"]);
  assert.equal(document.activeElement.id, "charge-first", "new activation owns focus even when it appears earlier in the DOM");
  await key("Escape"); assert.deepEqual(closed, ["charge"], "only the newest active modal handles Escape");
  document.getElementById("charge-last").focus();
  assert.equal((await key("Tab")).defaultPrevented, true);
  assert.equal(document.activeElement.id, "charge-first");
  assert.equal((await key("Tab", true)).defaultPrevented, true);
  assert.equal(document.activeElement.id, "charge-last");
  document.getElementById("base-first").focus();
  await key("Tab"); assert.equal(document.activeElement.id, "charge-first", "Tab cannot be trapped by an underlying modal");
  await render({ base: true });
  assert.equal(document.body.style.overflow, "hidden", "closing a nested dialog keeps the base locked");
  assert.equal(document.activeElement.id, "base-last", "closing the top modal restores its trigger inside the base");
  await key("Escape"); assert.deepEqual(closed, ["charge", "base"]);
  await render({});
  assert.equal(document.body.style.overflow, "scroll");
  assert.equal(document.activeElement, launch);

  document.body.style.overflow = ""; launch.focus();
  await render({ base: true });
  document.getElementById("base-last").focus();
  await render({ base: true, charge: true });
  const chargeFocus = document.activeElement;
  await render({ charge: true });
  assert.equal(document.body.style.overflow, "hidden", "non-LIFO base removal must not unlock scrolling");
  assert.equal(document.activeElement, chargeFocus, "removing an underlying modal must not steal focus");
  await render({});
  assert.equal(document.body.style.overflow, "", "the last cleanup restores the original style after non-LIFO removal");
  assert.equal(document.activeElement, launch, "removed parent triggers inherit the original return target");

  launch.focus(); await render({ base: true });
  document.getElementById("base-last").focus();
  await render({ base: true, charge: true });
  await render({ base: true, disabledTrigger: true });
  assert.equal(document.activeElement.id, "base-first", "a disabled return target falls back to an available base control");
  await render({}); assert.equal(document.activeElement, launch);

  const latest = [];
  await render({ base: true, baseClose: () => latest.push("old") });
  await render({ base: true, baseClose: () => latest.push("new") });
  await key("Escape"); assert.deepEqual(latest, ["new"], "onClose stays current without reordering the stack");
  await render({});
  assert.equal(document.body.style.overflow, "");
  console.log("Dialog focus stack passed (activation order, Escape/Tab ownership, nested/non-LIFO scroll locks and focus restoration)");
} finally {
  await act(() => root.unmount()); window.HTMLElement.prototype.getClientRects = originalRects; dom.window.close();
}
