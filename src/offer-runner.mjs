import { spawn } from "node:child_process";
import readline from "node:readline";
import { protocolEnvironment } from "./cdk-security.mjs";
import { OFFER_ERRORS, offerError } from "./offer-checker.mjs";

// Private JSON messages use pipes. Credentials never enter argv or diagnostic logs.
export function createOfferRunner(protocolScript) {
  return (payload, { signal, onPrompt = () => {}, onSession = () => {}, onMailSent = () => {} } = {}) => {
    const child = spawn(process.execPath, [protocolScript, "--offer-check"], {
      env: { ...protocolEnvironment(), CHATGPT_PROXY_URL: payload.proxyUrl || "", CHATGPT_LOGIN_PASSWORD: "", CHATGPT_TOTP_SECRET: "" },
      stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
    });
    child.stdin.on("error", () => {});
    const lines = readline.createInterface({ input: child.stdout });
    let settled = false; let timer;
    let resolve; let reject;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    const abort = () => child.kill("SIGTERM");
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); lines.close(); signal?.removeEventListener("abort", abort);
      child.stdin.end(); if (error) reject(error); else resolve(value);
    };
    timer = setTimeout(() => { abort(); finish(offerError("timeout")); }, 10 * 60_000);
    lines.on("line", (line) => {
      if (line.length > 1_000_000) { abort(); finish(offerError("invalid_response")); return; }
      try {
        const message = JSON.parse(line);
        if (message.type === "prompt" && ["email", "totp", "password"].includes(message.kind) && typeof message.id === "string") onPrompt(message);
        else if (message.type === "mail_sent") onMailSent(message.at);
        else if (message.type === "session") onSession(message.session);
        else if (message.type === "result") finish(null, message.result);
        else if (message.type === "error") finish(offerError(Object.hasOwn(OFFER_ERRORS, message.code) ? message.code : "login_failed", message.retryable === true, message.stage));
      } catch { abort(); finish(offerError("invalid_response")); }
    });
    child.once("error", () => finish(offerError("network", true)));
    child.once("close", () => finish(offerError(signal?.aborted ? "cancelled" : "network", !signal?.aborted)));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.write(`${JSON.stringify({ type: "start", ...payload })}\n`);
    return { done, reply: (id, value) => { if (settled) throw offerError("cancelled"); child.stdin.write(`${JSON.stringify({ type: "input", id, value })}\n`); } };
  };
}
