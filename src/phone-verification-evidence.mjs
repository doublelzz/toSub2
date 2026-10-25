import crypto from "node:crypto";
import fs from "./workspace-storage.mjs";
import path from "node:path";

const identityFields = ["operationId", "allocationId", "jobId", "runId", "orderId", "providerId"];
const validText = value => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);

export function matchesPhoneEvidence(value, expected) {
  return value?.version === 1 && value.type === "phone_verification"
    && ["pending", "verified", "rejected", "unknown"].includes(value.state)
    && validText(value.eventId) && Number.isFinite(Date.parse(value.at))
    && identityFields.every(key => validText(value[key]) && value[key] === expected?.[key]);
}

export async function readPhoneEvidence(file, expected) {
  if (!file) return null;
  let value;
  try { value = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error("PHONE_EVIDENCE_INVALID"); }
  if (!matchesPhoneEvidence(value, expected)) throw new Error("PHONE_EVIDENCE_MISMATCH");
  return value;
}

export async function writePhoneEvidence(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

// The parent creates this private context before submitting the allocated number.
// A protocol process can attest only its own run and the number it just verified.
export async function phoneEvidenceContext(phone, environment = process.env) {
  const file = environment.TOSUB2_PHONE_CONTEXT_PATH;
  if (!file || !environment.TOSUB2_PHONE_RESULT_PATH) return null;
  let context;
  try { context = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error("PHONE_CONTEXT_INVALID"); }
  if (context?.version !== 1 || context.phone !== phone
      || context.jobId !== environment.TOSUB2_PHONE_JOB_ID || context.runId !== environment.TOSUB2_PHONE_RUN_ID
      || !identityFields.every(key => validText(context[key]))) throw new Error("PHONE_CONTEXT_MISMATCH");
  return Object.fromEntries(identityFields.map(key => [key, context[key]]));
}

export async function persistPhoneOutcome(context, state, previous = null, environment = process.env) {
  if (!context) return null;
  const evidence = { version: 1, type: "phone_verification", ...context,
    eventId: previous?.eventId || crypto.randomUUID(), state, at: new Date().toISOString() };
  if (state === "verified") evidence.verifiedAt = evidence.at;
  await writePhoneEvidence(environment.TOSUB2_PHONE_RESULT_PATH, evidence);
  return evidence;
}
