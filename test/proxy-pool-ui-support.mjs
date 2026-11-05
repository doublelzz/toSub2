import fs from "node:fs/promises";
import React, { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { transformWithEsbuild } from "vite";
import { parseProxyPoolText } from "../web/src/proxy-pool.mjs";

export * from "../web/src/proxy-pool.mjs";
export { prepareProxyNetworkOptions, prepareWorkspaceProxyPool, readWorkspaceProxyPoolText, setWorkspaceProxyPoolDraft } from "../web/src/cdk-api.mjs";

const source = await fs.readFile(new URL("../web/src/ProxyPoolInput.jsx", import.meta.url), "utf8");
const code = source.replace(/^import[^\n]+\n/gm, "").replace(/^export /gm, "");
const compiled = await transformWithEsbuild(code, "ProxyPoolInput.jsx", { loader: "jsx", jsx: "transform" });
const scope = { React, useId, useState, Eye, EyeOff, parseProxyPoolText };
export const { ProxyPoolInput, ProxyNetworkOptions } = new Function(...Object.keys(scope), `${compiled.code};return {ProxyPoolInput,ProxyNetworkOptions};`)(...Object.values(scope));
