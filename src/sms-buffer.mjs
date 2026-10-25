import crypto from "node:crypto";

export const DEFAULT_BUFFER_RULES = { enabled: false, target: 3, lowWater: 1, perEntry: 1, refillConcurrency: 1, minRemainingSeconds: 480, idleMinutes: 10, maxOutstanding: 10, maxPerMinute: 6 };
const timestamp = (value) => typeof value === "number" ? value : Date.parse(value);
const activeStates = new Set(["purchasing", "ready", "checking", "assigned", "cancel_pending", "purchase_unknown", "quarantined"]);

export function createSmsBuffer({ store, config, mutate, now, createProvider, providerOptions, selectLease, releaseLease, makeConfig, recordFailure, recordSuccess, classifyError, foregroundBusy }) {
  let closing = false; let paused = false; let timer; let tickPromise; let refillRequested = false;
  const purchases = new Set(); const cancellations = new Map(); const inspections = new Map();
  const rules = () => ({ ...DEFAULT_BUFFER_RULES, ...config().rules.buffer });
  const items = () => store.inventoryItems({ activeOnly: true, limit: 1000 });
  const demandAt = () => config().bufferDemandAt || 0;
  const demandActive = () => demandAt() > 0 && now() - demandAt() <= rules().idleMinutes * 60000;
  const enabled = () => config().rules.enabled && rules().enabled;
  const entryAllowed = (item, value = config()) => {
    const entry = value.entries.find((row) => row.id === item.entryId); const credential = value.credentials.find((row) => row.id === item.credentialId);
    return entry?.enabled && entry.state !== "disabled" && credential?.enabled && !credential.blockedReason
      && ["country", "service", "maxPrice", "providerIds"].every((key) => String(entry[key] || "") === String(item.config?.[key] || ""));
  };
  function signalDemand() {
    if (!rules().enabled || closing || paused) return;
    if (now() - demandAt() >= 1000 || !demandAt()) mutate((value) => { value.bufferDemandAt = now(); });
    refillRequested = true;
    setTimeout(() => { void tick().catch(() => {}); }, 0).unref?.();
  }
  function snapshot() {
    const rows = store.inventoryItems({ limit: 200 }); const counts = { ready: 0, purchasing: 0, checking: 0, assigned: 0, cancel_pending: 0, purchase_unknown: 0, closed: 0, quarantined: 0, consumed: 0, ...store.inventoryCounts() };
    return { rules: rules(), counts, activeDemandAt: demandAt() || null, refilling: purchases.size > 0,
      items: rows.map((item) => ({ id: item.id, entryId: item.entryId, providerId: item.providerId, state: item.state,
        phone: item.order?.number?.replace(/.(?=.{4})/g, "*") || null, createdAt: item.createdAt, expiresAt: item.expiresAt,
        expiresSource: item.expiresSource || null, cancelAllowedAt: item.cancelAllowedAt || null, nextActionAt: item.nextActionAt || null,
        refundStatus: item.refundStatus || "unconfirmed", hasSms: item.hasSms === true, canReconcile: ["purchase_unknown", "quarantined", "cancel_pending"].includes(item.state),
        cost: item.order?.cost || null, maxPrice: item.config?.maxPrice || null, currency: item.config?.currency || null,
        cancelState: item.cancelState || null, lastError: item.lastError || "" })) };
  }
  function publicStatus() {
    const ready = enabled() && items().some((item) => item.state === "ready" && entryAllowed(item) && item.expiresAt > now() + rules().minRemainingSeconds * 1000);
    return { ready, refilling: purchases.size > 0 };
  }
  function retire(item, reason) {
    if (["consumed", "closed", "purchase_unknown"].includes(item.state)) return item;
    return store.updateInventory(item.id, (value) => ({ ...value, state: "cancel_pending", lastError: reason,
      nextActionAt: Math.max(now(), value.cancelAllowedAt || 0), cancelState: "pending" }));
  }
  async function cancel(item) {
    if (cancellations.has(item.id) || !item.order?.requestId || item.nextActionAt > now()) return;
    const operation = (async () => {
      const current = store.inventoryItem(item.id); if (!current || !["cancel_pending", "quarantined"].includes(current.state)) return;
      if (current.cancelBeforeAt && now() >= current.cancelBeforeAt) {
        store.updateInventory(item.id, (value) => ({ ...value, state: "quarantined", cancelState: "denied", lastError: "cancellation_window_expired", nextActionAt: 0 })); return;
      }
      try {
        const client = createProvider(current.providerId, current.config, providerOptions);
        if (typeof client.inspect === "function") {
          const status = await client.inspect(current.order.requestId);
          if (status?.hasSms === true) store.updateInventory(item.id, (value) => ({ ...value, hasSms: true }));
          if (status?.state === "cancelled") {
            store.updateInventory(item.id, (value) => ({ ...value, state: "closed", cancelState: "confirmed", cancelledAt: now(), cancellationReceipt: "STATUS_CANCEL",
              refundStatus: "unconfirmed", nextActionAt: 0, lastError: "" })); return;
          }
        }
        if (typeof client.cancelStrict !== "function") throw Object.assign(new Error("strict cancel unavailable"), { code: "CANCEL_UNSUPPORTED" });
        const receipt = await client.cancelStrict(current.order.requestId);
        if (!receipt?.cancelled || receipt.receipt !== "ACCESS_CANCEL") throw new Error("cancellation was not confirmed");
        store.updateInventory(item.id, (value) => ({ ...value, state: "closed", cancelState: "confirmed", cancelledAt: now(), cancellationReceipt: receipt.receipt,
          refundStatus: receipt.refundStatus === "confirmed" && receipt.refundEvidence ? "confirmed" : "unconfirmed", refundEvidence: receipt.refundEvidence || null, nextActionAt: 0, lastError: "" }));
      } catch (error) {
        const code = String(error.code || ""); const denied = /FREE_CANCELLATION_EXPIRED|OTP_RECEIVED|NEW_OTP_RECEIVED|CANCEL_UNSUPPORTED/.test(code);
        store.updateInventory(item.id, (value) => ({ ...value, state: denied ? "quarantined" : "cancel_pending", cancelState: denied ? "denied" : "unknown",
          lastError: code || "cancel_unconfirmed", nextActionAt: denied ? 0 : Math.max(now() + 30000, value.cancelAllowedAt || 0), cancelAttempts: (value.cancelAttempts || 0) + 1 }));
      }
    })();
    cancellations.set(item.id, operation); try { await operation; } finally { cancellations.delete(item.id); }
  }
  async function replenishOne() {
    if (closing || paused || !enabled() || !demandActive() || foregroundBusy()) return;
    const currentRules = rules(); const active = items(); const at = now();
    const lease = selectLease(new Set(), (entry) => active.filter((item) => item.entryId === entry.id && ["purchasing", "ready", "checking"].includes(item.state)).length < currentRules.perEntry);
    if (!lease) return;
    const attemptId = lease.attemptId; let item; let requested = false;
    try {
      const providerConfig = makeConfig(lease.choice, config().rules.maxAttempts); const providerId = lease.choice.credential.providerId;
      const client = createProvider(providerId, providerConfig, providerOptions);
      const policy = client.activationPolicy;
      if (!policy || !Number.isFinite(policy.lifetimeSeconds) || !policy.source || typeof client.inspect !== "function" || typeof client.cancelStrict !== "function") return;
      item = store.createInventoryPurchase({ id: crypto.randomUUID(), entryId: lease.choice.entry.id, credentialId: lease.choice.credential.id, providerId,
        config: providerConfig, configVersion: lease.choice.configVersion, activationPolicy: policy, createdAt: at }, currentRules);
      if (!item) return;
      requested = true; const order = await client.getNumber();
      if (!order?.requestId || !/^\+[1-9]\d{6,14}$/.test(order.number || "")) throw new Error("invalid inventory order");
      const parsedExpiry = timestamp(order.expiresAt); const parsedCancel = timestamp(order.cancelAllowedAt);
      const expiresAt = Number.isFinite(parsedExpiry) && parsedExpiry > at ? parsedExpiry : at + policy.lifetimeSeconds * 1000;
      const cancelAllowedAt = Number.isFinite(parsedCancel) && parsedCancel > 0 ? parsedCancel : now() + (policy.minCancelAgeSeconds || 0) * 1000;
      const expiresSource = Number.isFinite(parsedExpiry) && parsedExpiry > at ? order.expiresAtSource || "provider" : "provider_policy";
      const insufficientLifetime = expiresAt <= now() + currentRules.minRemainingSeconds * 1000;
      const retireOnArrival = !enabled() || !demandActive();
      const overBudget = order.cost?.amount != null && Number(order.cost.amount) > Number(providerConfig.maxPrice);
      store.finishInventoryPurchase(item.id, { order, expiresAt, expiresSource, cancelAllowedAt, cancelBeforeAt: timestamp(order.cancelBeforeAt) || expiresAt,
        state: insufficientLifetime || overBudget || retireOnArrival ? "cancel_pending" : "ready", lastError: insufficientLifetime ? "insufficient_remaining_lifetime" : overBudget ? "price_above_limit" : retireOnArrival ? "inventory_retired_on_arrival" : "",
        nextActionAt: insufficientLifetime || overBudget || retireOnArrival ? cancelAllowedAt : 0 });
      recordSuccess(lease.choice, attemptId);
    } catch (error) {
      const kind = requested ? classifyError(error) : "config_invalid"; recordFailure(lease.choice, kind, attemptId);
      if (item) store.updateInventory(item.id, (value) => ({ ...value, state: requested && kind === "order_unknown" ? "purchase_unknown" : "closed", lastError: kind, nextActionAt: 0 }));
    } finally { releaseLease(lease.choice, attemptId); }
  }
  async function checkAndClaim(ownerId, operationId) {
    if (!enabled() || closing) return null;
    const value = config(); const allowed = items().filter((item) => item.state === "ready" && entryAllowed(item, value)).map((item) => item.entryId);
    for (let index = 0; index < rules().target + 1; index++) {
      const item = store.claimInventoryCheck(ownerId, operationId, { now: now(), minRemainingMs: rules().minRemainingSeconds * 1000, allowedEntryIds: allowed });
      if (!item) return null;
      const inspectTask = (async () => {
        try {
          const client = createProvider(item.providerId, item.config, providerOptions); const status = await client.inspect(item.order.requestId);
          if (status?.state !== "waiting" || status.hasSms !== false) { if (status?.hasSms) store.updateInventory(item.id, (current) => ({ ...current, hasSms: true })); retire(item, status?.hasSms ? "sms_received_before_assignment" : "inventory_status_unconfirmed"); return null; }
          const currentConfig = config(); const entry = currentConfig.entries.find((row) => row.id === item.entryId); const credential = currentConfig.credentials.find((row) => row.id === item.credentialId);
          if (!entry?.enabled || !credential?.enabled || !entryAllowed(item, currentConfig) || !currentConfig.rules.enabled || !rules().enabled) { retire(item, "inventory_configuration_disabled"); return null; }
          const allocation = { allocationId: crypto.randomUUID(), entryId: item.entryId, credentialId: item.credentialId, providerId: item.providerId, config: item.config,
            order: item.order, configVersion: item.configVersion, inventoryId: item.id, abandoned: false, submitted: false };
          const assigned = store.assignInventory(ownerId, operationId, item.id, allocation, now(), rules().minRemainingSeconds * 1000);
          if (!assigned) retire(item, "inventory_assignment_stopped");
          return assigned;
        } catch { retire(item, "inventory_inspection_failed"); return null; }
      })();
      inspections.set(item.id, inspectTask); let claimed;
      try { claimed = await inspectTask; } finally { inspections.delete(item.id); }
      if (claimed) { signalDemand(); return { ...claimed, operationId, poolEntryId: claimed.entryId }; }
    }
    return null;
  }
  async function tick() {
    if (tickPromise) return tickPromise;
    tickPromise = (async () => {
      const at = now(); const settings = rules(); const value = config();
      for (let item of items()) {
        if (item.state === "ready" && (!enabled() || !demandActive() || item.expiresAt <= at + settings.minRemainingSeconds * 1000
          || !entryAllowed(item, value))) item = retire(item, "inventory_retired");
        if (["cancel_pending", "quarantined"].includes(item.state) && item.nextActionAt > 0 && item.nextActionAt <= at) await cancel(item);
      }
      if (closing || paused || !enabled() || !demandActive() || foregroundBusy()) return;
      const active = items(); const supply = active.filter((item) => ["ready", "purchasing", "checking"].includes(item.state)).length;
      if (supply <= settings.lowWater) refillRequested = true;
      if (supply >= settings.target) refillRequested = false;
      if (!refillRequested || active.filter((item) => activeStates.has(item.state)).length >= settings.maxOutstanding) return;
      const slots = Math.min(settings.refillConcurrency - purchases.size, settings.target - supply);
      for (let index = 0; index < slots; index++) {
        const task = replenishOne(); purchases.add(task); void task.then(() => purchases.delete(task), () => purchases.delete(task));
      }
      await Promise.allSettled([...purchases]);
    })();
    try { return await tickPromise; } finally { tickPromise = null; }
  }
  // Unknown purchases cannot be retried after process recovery.
  for (const item of items()) {
    if (item.state === "purchasing") store.updateInventory(item.id, (value) => ({ ...value, state: "purchase_unknown", lastError: "interrupted_purchase", nextActionAt: 0 }));
    else if (item.state === "checking") retire(item, "interrupted_inventory_check");
  }
  return { snapshot, publicStatus, signalDemand, claim: checkAndClaim,
    tick, start() { paused = false; if (!timer && !closing) { timer = setInterval(() => { void tick().catch(() => {}); }, 1000); timer.unref(); } },
    pause() { paused = true; clearInterval(timer); timer = null; },
    warmup() { signalDemand(); return tick(); },
    async drain() { mutate((value) => { value.bufferDemandAt = 0; }); refillRequested = false; for (const item of items()) if (item.state === "ready") retire(item, "administrator_drain"); return tick(); },
    reconcile(id, body, actor) {
      const item = store.inventoryItem(id); if (!item) throw Object.assign(new Error("库存记录不存在"), { status: 404 });
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (body.action !== "close" || !note || note.length > 300) throw Object.assign(new Error("请填写确认服务商订单已结束或未创建的核实依据"), { status: 422 });
      if (item.state === "closed") return;
      if (!["purchase_unknown", "quarantined", "cancel_pending"].includes(item.state) || cancellations.has(id) || inspections.has(id)) throw Object.assign(new Error("只能核实已停止且待处理的库存订单"), { status: 409 });
      const refundEvidence = typeof body.refundEvidence === "string" ? body.refundEvidence.trim().slice(0, 300) : "";
      store.audit(actor, "sms-buffer-reconcile", id, { action: "close", note, refundEvidence });
      store.updateInventory(id, (value) => ({ ...value, state: "closed", cancelState: "confirmed", nextActionAt: 0, reconciledAt: now(), reconciliation: { note, actor },
        refundStatus: refundEvidence ? "confirmed" : "unconfirmed", refundEvidence: refundEvidence || null, lastError: "" }));
    },
    async close() { closing = true; clearInterval(timer); await Promise.allSettled([tickPromise, ...purchases, ...inspections.values(), ...cancellations.values()].filter(Boolean)); },
  };
}
