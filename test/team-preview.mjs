// Optional desktop acceptance fixture. All upstream requests stay on loopback.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConsoleWorkspace } from "../src/console-server.mjs";
import { startCdkServer } from "../src/cdk-server.mjs";
import { createTeamClient } from "../src/team-client.mjs";
import { createTeamFixture, fixtureSession } from "./team-fixture.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-team-preview-")), fixture = await createTeamFixture();
Object.assign(process.env, { TOSUB2_ADMIN_CDK: "team-local-preview-administrator-only", TOSUB2_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"), CHATGPT_BASE: fixture.base, AUTH_BASE: fixture.base });
const app = await startCdkServer({ root, listen: false, createWorkspace: (options) => createConsoleWorkspace({ ...options,
  teamClientFactory: (input) => createTeamClient({ ...input, chatgptBase: fixture.base }) }) });
const [owner] = app.store.generate({ count: 1, quota: 10, note: "Team 开发验收（模拟数据）", teamManagementEnabled: true }, app.store.adminId);
const workspace = await app.workspaceFor(owner.id);
const raw = JSON.stringify(["owner@example.com", "other-owner@example.com", "viewer@example.com"].map((email) => fixtureSession(email, fixture.base)));
const parse = (response) => JSON.parse(response.body.toString());
const preview = parse(await workspace.dispatch("POST", "/api/teams/import/preview", { text: raw }));
const importKey = crypto.randomUUID();
await app.importFor(owner.id, "team", { text: raw, digest: preview.digest, requestKey: importKey }, importKey, owner.id);
const until = Date.now() + 8000;
while (Date.now() < until) { const value = parse(await workspace.dispatch("GET", "/api/teams/state")); if (!value.overview.active) break; await new Promise((resolve) => setTimeout(resolve, 30)); }
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
console.log(JSON.stringify({ url: `http://127.0.0.1:${app.server.address().port}`, cdk: owner.secret, root, upstream: fixture.base }));
let stopping;
async function close() { if (stopping) return stopping; stopping = (async () => { await app.close(); await fixture.close(); await fs.rm(root, { recursive: true, force: true }); })(); return stopping; }
process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
