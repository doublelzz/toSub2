import crypto from "node:crypto";
import fs from "../src/workspace-storage.mjs";

const at = process.argv.indexOf("--email");
const email = at < 0 ? "fixture@example.invalid" : process.argv[at + 1];
const proxy = process.env.CHATGPT_PROXY_URL || "";
const host = proxy ? new URL(proxy).hostname : "direct";
console.log(`[fixture-proxy] ${JSON.stringify({ host, poolEnabled: process.env.CHATGPT_PROXY_POOL_ENABLED === "1" })}`);
const checkpointAt = process.argv.indexOf("--resume-checkpoint");
if (checkpointAt >= 0) {
  try {
    const checkpoint = JSON.parse(await fs.readFile(process.argv[checkpointAt + 1], "utf8"));
    console.log(`[fixture-checkpoint] ${JSON.stringify({ stage: checkpoint.stage, email: checkpoint.email })}`);
  } catch (failure) { if (failure.code !== "ENOENT") throw failure; }
}
const connectionFailure = email.startsWith("pool-connect-always@");
const securityFailure = email.startsWith("pool-risk-always@") || email.startsWith("pool-switch-once@") && host === "proxy-a.example.invalid";
if (securityFailure || connectionFailure) {
  if (!connectionFailure) console.log(`[proxy-session-attempt] ${crypto.randomUUID()}`);
  setTimeout(() => console.error(`[proxy-risk-retry] ${connectionFailure ? "PROXY_CONNECTION_RETRY" : "PROXY_RISK_CONTROL"}: synthetic proxy failure`), 20);
} else {
  console.log(`[1/5] Mock login started for ${email}`);
  console.log("Email OTP (r=resend, q=quit):");
}
await new Promise((resolve) => {
  const timer = setTimeout(resolve, 60_000);
  process.once("SIGTERM", () => { clearTimeout(timer); resolve(); });
});
