import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCdkStore } from "./cdk-store.mjs";
import { createCdkVault } from "./cdk-vault.mjs";
import { normalizeClientIp } from "./cdk-security.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(process.env.ONBOARDING_OUTPUT_ROOT || path.join(projectRoot, "tmp", "chatgpt-onboarding-console"));
const action = process.argv[2];
if (!["initial", "rotate-admin", "unban", "bans"].includes(action)) {
  console.log("Usage: node src/cdk-admin.mjs initial | rotate-admin | bans | unban <ip>"); process.exitCode = 1;
} else {
  const vault = await createCdkVault(root); const store = await createCdkStore(root, vault);
  try {
    if (action === "initial") {
      const secret = store.readInitialSecret();
      if (!secret) throw new Error("初始化 CDK 已领取。如需恢复，请在本机执行 rotate-admin");
      console.log(secret);
    }
    if (action === "rotate-admin") console.log(store.rotate(store.adminId, "local-operator").secret);
    if (action === "bans") console.log(JSON.stringify(store.bans(), null, 2));
    if (action === "unban") {
      const ip = normalizeClientIp(process.argv[3]); if (!ip) throw new Error("请填写有效 IP");
      for (const ban of store.bans().filter((ban) => ban.ip === ip && ban.active)) store.unban(ban.id, "local-operator");
      console.log("IP unblocked; audit saved");
    }
  } finally { store.close(); }
}
