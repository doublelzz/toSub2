import crypto from "node:crypto";
import { poolCostOrder } from "./sms-pool-costs.mjs";

export const DEFAULT_BUFFER_RULES = { enabled: false, forceRefill: false, target: 3, lowWater: 1, perEntry: 1, refillConcurrency: 1, minRemainingSeconds: 480, idleMinutes: 10, maxOutstanding: 10, maxPerMinute: 6 };
export const AGGRESSIVE_REFILL_INTERVAL_MS = 5000;
const timestamp = (value) => typeof value === "number" ? value : Date.parse(value);
const inventoryRiskStates = new Set(["cancel_pending", "purchase_unknown", "quarantined"]);

export function createSmsBuffer({ store, config, mutate, now, createProvider, providerOptions, selectLease, releaseLease, makeConfig, recordFailure, recordSuccess, classifyError, foregroundBusy }) {
  let closing = false; let paused = false; let timer; let tickPromise; let drainGeneration = 0;
  let nextRetryAt = 0; let reason = ""; let attempts = 0; let obtained = 0; let blocked = false;
  const purchases = new Set(); const cancellations = new Map(); const inspections = new Map();
  const failures = new Map();
  const unsupportedEntries = new Set();
  const rules = () => ({ ...DEFAULT_BUFFER_RULES, ...config().rules.buffer });
  const items = () => store.inventoryItems({ activeOnly: true, limit: 1000 });
  const demandAt = () => config().bufferDemandAt || 0;
  const enabled = () => config().rules.enabled && rules().enabled;
  const wantsRefill = () => enabled() && !config().bufferRefillPaused && (rules().forceRefill || config().bufferManualRefill === true);
  const entryAllowed = (item, value = config()) => {
    const entry = value.entries.find((row) => row.id === item.entryId); const credential = value.credentials.find((row) => row.id === item.credentialId);
    return entry?.enabled && entry.state !== "disabled" && credential?.enabled && !credential.blockedReason
      && ["country", "service", "maxPrice", "providerIds"].every((key) => String(entry[key] || "") === String(item.config?.[key] || ""));
  };
  function signalDemand() {
    if (!rules().enabled || closing || paused) return;
    if (now() - demandAt() >= 1000 || !demandAt()) mutate((value) => { value.bufferDemandAt = now(); });
    if (wantsRefill()) setTimeout(() => { void tick().catch(() => {}); }, 0).unref?.();
  }
  const availableRows = () => items().filter((item) => item.state === "ready" && entryAllowed(item) && item.expiresAt > now() + rules().minRemainingSeconds * 1000);
  function progress() {
    const active = items(); const ready = availableRows().length;
    const purchasing = active.filter((item) => item.state === "purchasing").length; const checking = active.filter((item) => item.state === "checking").length;
    const state = !enabled() || config().bufferRefillPaused ? "paused" : ready >= rules().target ? "full" : blocked && wantsRefill() ? "blocked"
      : purchases.size ? "filling" : wantsRefill() ? nextRetryAt > now() ? "waiting" : "filling" : "idle";
    return { state, target: rules().target, ready, purchasing, checking, remaining: Math.max(0, rules().target - ready - purchasing - checking),
      nextRetryAt: wantsRefill() && nextRetryAt > now() ? nextRetryAt : null, reason: !config().rules.enabled ? "pool_disabled" : !rules().enabled ? "buffer_disabled" : reason,
      attempts, obtained, failures: [...failures.values()].sort((a, b) => b.lastAt - a.lastAt) };
  }
  function publicItem(item) {
    return { id: item.id, entryId: item.entryId, providerId: item.providerId, state: item.state, createdAt: item.createdAt, expiresAt: item.expiresAt,
      expiresSource: item.expiresSource || null, cancelAllowedAt: item.cancelAllowedAt || null, nextActionAt: item.nextActionAt || null,
      ...poolCostOrder(item, { refundExpected: ["cancel_pending", "quarantined", "closed"].includes(item.state) }),
      phone: item.order?.number || null, hasSms: item.hasSms === true, canReconcile: ["purchase_unknown", "quarantined", "cancel_pending"].includes(item.state),
      cancelState: item.cancelState || null, lastError: item.lastError || "" };
  }
  function snapshot() {
    const rows = [...new Map([...items(), ...store.inventoryItems({ limit: 200 })].map((item) => [item.id, item])).values()];
    const counts = { ready: 0, purchasing: 0, checking: 0, assigned: 0, cancel_pending: 0, purchase_unknown: 0, closed: 0, quarantined: 0, consumed: 0, ...store.inventoryCounts() };
    return { rules: rules(), counts, activeDemandAt: demandAt() || null, refilling: purchases.size > 0, progress: progress(), items: rows.map(publicItem) };
  }
  function inventoryPage(query = {}) { const page = store.inventoryPage(query); return { ...page, items: page.items.map(publicItem) }; }
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
  function noteFailure(choice, kind) {
    const key = `${choice.entry.id}:${kind}`; const previous = failures.get(key);
    failures.set(key, { entryId: choice.entry.id, providerId: choice.credential.providerId, countryLabel: choice.entry.countryLabel || choice.entry.country,
      kind, count: (previous?.count || 0) + 1, lastAt: now(), nextRetryAt: kind === "no_stock" ? now() + AGGRESSIVE_REFILL_INTERVAL_MS : null });
    if (failures.size > 100) failures.delete(failures.keys().next().value);
  }
  async function replenishOne(excluded) {
    if (closing || paused || !wantsRefill()) return { attempted: false };
    const currentRules = rules(); const at = now();
    const lease = selectLease(excluded, (entry) => !unsupportedEntries.has(entry.id), { buffer: true });
    if (!lease) return { attempted: false };
    excluded.add(lease.choice.entry.id);
    const attemptId = lease.attemptId; let item; let requested = false;
    const generation = drainGeneration;
    try {
      const providerConfig = makeConfig(lease.choice, config().rules.maxAttempts); const providerId = lease.choice.credential.providerId;
      const client = createProvider(providerId, providerConfig, providerOptions);
      const policy = client.activationPolicy;
      if (!policy || !Number.isFinite(policy.lifetimeSeconds) || !policy.source || typeof client.inspect !== "function" || typeof client.cancelStrict !== "function") {
        unsupportedEntries.add(lease.choice.entry.id); noteFailure(lease.choice, "buffer_unsupported");
        return { attempted: true, kind: "buffer_unsupported" };
      }
      item = store.createInventoryPurchase({ id: crypto.randomUUID(), entryId: lease.choice.entry.id, credentialId: lease.choice.credential.id, providerId,
        config: providerConfig, configVersion: lease.choice.configVersion, activationPolicy: policy, createdAt: at }, { ...currentRules, simplified: true });
      if (!item) return { attempted: true, kind: "inventory_limit" };
      requested = true; attempts++; const order = await client.getNumber();
      if (!order?.requestId || !/^\+[1-9]\d{6,14}$/.test(order.number || "")) throw new Error("invalid inventory order");
      const parsedExpiry = timestamp(order.expiresAt); const parsedCancel = timestamp(order.cancelAllowedAt);
      const expiresAt = Number.isFinite(parsedExpiry) && parsedExpiry > at ? parsedExpiry : at + policy.lifetimeSeconds * 1000;
      const cancelAllowedAt = Number.isFinite(parsedCancel) && parsedCancel > 0 ? parsedCancel : now() + (policy.minCancelAgeSeconds || 0) * 1000;
      const expiresSource = Number.isFinite(parsedExpiry) && parsedExpiry > at ? order.expiresAtSource || "provider" : "provider_policy";
      const insufficientLifetime = expiresAt <= now() + currentRules.minRemainingSeconds * 1000;
      const retireOnArrival = !enabled() || generation !== drainGeneration;
      const overBudget = order.cost?.amount != null && Number(order.cost.amount) > Number(providerConfig.maxPrice);
      const saved = store.finishInventoryPurchase(item.id, { order, expiresAt, expiresSource, cancelAllowedAt, cancelBeforeAt: timestamp(order.cancelBeforeAt) || expiresAt,
        state: insufficientLifetime || overBudget || retireOnArrival ? "cancel_pending" : "ready", lastError: insufficientLifetime ? "insufficient_remaining_lifetime" : overBudget ? "price_above_limit" : retireOnArrival ? "inventory_retired_on_arrival" : "",
        nextActionAt: insufficientLifetime || overBudget || retireOnArrival ? cancelAllowedAt : 0 });
      obtained++;
      if (["purchase_unknown", "quarantined"].includes(saved?.state)) {
        noteFailure(lease.choice, saved.lastError || "order_unknown"); return { attempted: true, kind: saved.lastError || "order_unknown", uncertain: true };
      }
      recordSuccess(lease.choice, attemptId);
      if (saved?.state !== "ready") { noteFailure(lease.choice, saved?.lastError || "inventory_unavailable"); return { attempted: true, kind: saved?.lastError || "inventory_unavailable" }; }
      return { attempted: true, success: true };
    } catch (error) {
      const kind = requested ? classifyError(error) : "config_invalid"; recordFailure(lease.choice, kind, attemptId, { buffer: true }); noteFailure(lease.choice, kind);
      if (item) store.updateInventory(item.id, (value) => ({ ...value, state: requested && kind === "order_unknown" ? "purchase_unknown" : "closed", lastError: kind, nextActionAt: 0 }));
      return { attempted: true, kind, uncertain: kind === "order_unknown" };
    } finally { releaseLease(lease.choice, attemptId); }
  }
  async function checkAndClaim(ownerId, operationId, canAssign = () => true) {
    if (!enabled() || closing) return null;
    const value = config(); const allowed = items().filter((item) => item.state === "ready" && entryAllowed(item, value)).map((item) => item.entryId);
    for (let index = 0; index < rules().target + 1; index++) {
      if (!canAssign()) return null;
      const item = store.claimInventoryCheck(ownerId, operationId, { now: now(), minRemainingMs: rules().minRemainingSeconds * 1000, allowedEntryIds: allowed });
      if (!item) return null;
      const inspectTask = (async () => {
        try {
          const client = createProvider(item.providerId, item.config, providerOptions); const status = await client.inspect(item.order.requestId);
          if (status?.state !== "waiting" || status.hasSms !== false) { if (status?.hasSms) store.updateInventory(item.id, (current) => ({ ...current, hasSms: true })); retire(item, status?.hasSms ? "sms_received_before_assignment" : "inventory_status_unconfirmed"); return null; }
          if (!canAssign()) { store.updateInventory(item.id, (current) => ({ ...current, state: "ready", claimOwner: null, claimOperation: null })); return null; }
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
        if (item.state === "ready" && (!enabled() || item.expiresAt <= at + settings.minRemainingSeconds * 1000
          || !entryAllowed(item, value))) item = retire(item, "inventory_retired");
        if (["cancel_pending", "quarantined"].includes(item.state) && item.nextActionAt > 0 && item.nextActionAt <= at) await cancel(item);
      }
      if (closing || paused || !wantsRefill() || nextRetryAt > now()) return;
      blocked = false; reason = ""; nextRetryAt = 0;
      const excluded = new Set(); let resetRound = false;
      // An unsuccessful route is excluded for this pass. Successful routes can
      // start another fair round immediately, including the sole configured route.
      const passLimit = Math.max(20, rules().target * 3 + config().entries.length * 2);
      for (let step = 0; step < passLimit && !closing && !paused && wantsRefill(); step++) {
        const active = items(); const current = progress();
        if (current.ready >= rules().target) {
          if (config().bufferManualRefill) mutate((state) => { state.bufferManualRefill = false; });
          reason = ""; nextRetryAt = 0; return;
        }
        if (active.some((item) => item.state === "purchase_unknown" || item.state === "quarantined" && ["duplicate_phone", "duplicate_order", "duplicate_active_phone"].includes(item.lastError))) {
          blocked = true; reason = "order_unknown"; return;
        }
        if (active.filter((item) => inventoryRiskStates.has(item.state)).length >= Math.max(10, rules().target)) { blocked = true; reason = "inventory_risk_limit"; return; }
        if (current.remaining <= 0) { reason = "inventory_checking"; nextRetryAt = now() + 1000; return; }
        const slots = Math.min(3, current.remaining);
        const batch = [];
        for (let index = 0; index < slots; index++) {
          const task = replenishOne(excluded); purchases.add(task); batch.push(task);
          void task.then(() => purchases.delete(task), () => purchases.delete(task));
        }
        const outcomes = await Promise.all(batch);
        if (outcomes.some((outcome) => outcome.uncertain)) { blocked = true; reason = "order_unknown"; return; }
        if (outcomes.some((outcome) => outcome.kind === "inventory_limit")) {
          if (progress().ready >= rules().target) continue;
          blocked = true; reason = "inventory_risk_limit"; return;
        }
        if (!outcomes.some((outcome) => outcome.attempted)) {
          if (excluded.size && !resetRound) { excluded.clear(); resetRound = true; continue; }
          const currentConfig = config(); const configured = currentConfig.entries.filter((entry) => entry.enabled && entry.state !== "disabled");
          const allUnsupported = configured.length > 0 && configured.every((entry) => unsupportedEntries.has(entry.id));
          blocked = !configured.length || allUnsupported || configured.every((entry) => {
            const credential = currentConfig.credentials.find((row) => row.id === entry.credentialId);
            return !credential?.enabled || credential.blockedReason;
          });
          const allRateLimited = configured.length > 0 && configured.every((entry) => (currentConfig.credentials.find((row) => row.id === entry.credentialId)?.cooldownUntil || 0) > now());
          reason = !configured.length ? "no_sources" : allUnsupported ? "buffer_unsupported" : blocked ? "credential_error" : allRateLimited ? "rate_limited"
            : [...failures.values()].some((failure) => failure.kind === "no_stock") ? "no_stock" : "provider_busy";
          nextRetryAt = now() + AGGRESSIVE_REFILL_INTERVAL_MS; return;
        }
        resetRound = false;
        // Let foreground requests take a free credential between acquisitions.
        // They no longer disable all buffer work for their full lifetime.
        await new Promise((resolve) => setTimeout(resolve, foregroundBusy() ? 100 : 50));
      }
      if (wantsRefill()) { reason = "retry_pending"; nextRetryAt = now() + AGGRESSIVE_REFILL_INTERVAL_MS; }
    })();
    try { return await tickPromise; } finally { tickPromise = null; }
  }
  // Unknown purchases cannot be retried after process recovery.
  for (const item of items()) {
    if (item.state === "purchasing") store.updateInventory(item.id, (value) => ({ ...value, state: "purchase_unknown", lastError: "interrupted_purchase", nextActionAt: 0 }));
    else if (item.state === "checking") retire(item, "interrupted_inventory_check");
  }
  return { snapshot, publicStatus, inventoryPage, signalDemand, claim: checkAndClaim,
    tick, start() { paused = false; if (!timer && !closing) { timer = setInterval(() => { void tick().catch(() => {}); }, 1000); timer.unref(); } },
    pause() { paused = true; clearInterval(timer); timer = null; },
    warmup(actor) {
      if (!config().rules.enabled) throw Object.assign(new Error("接码池尚未开放，请先开启接码池"), { status: 409 });
      const existing = wantsRefill();
      mutate((value) => { value.rules.buffer = { ...rules(), enabled: true }; value.bufferManualRefill = true; value.bufferRefillPaused = false; value.bufferDemandAt = now(); }, actor, "sms-buffer-warmup");
      if (!existing) { attempts = 0; obtained = 0; failures.clear(); unsupportedEntries.clear(); }
      nextRetryAt = 0; reason = ""; blocked = false;
      void tick().catch(() => { reason = "refill_failed"; blocked = true; });
    },
    pauseRefill(actor) {
      mutate((value) => { value.bufferManualRefill = false; value.bufferRefillPaused = true; value.rules.buffer = { ...rules(), forceRefill: false }; value.version++; }, actor, "sms-buffer-pause");
      nextRetryAt = 0; reason = ""; blocked = false;
    },
    configurationChanged() {
      nextRetryAt = 0; reason = ""; blocked = false; unsupportedEntries.clear();
      if (wantsRefill()) setTimeout(() => { void tick().catch(() => {}); }, 0).unref?.();
    },
    async drain(actor) {
      mutate((value) => {
        value.bufferDemandAt = 0; value.bufferManualRefill = false; value.bufferRefillPaused = true;
        if (value.rules.buffer?.forceRefill) { value.rules.buffer.forceRefill = false; value.version++; }
      }, actor, "sms-buffer-drain");
      drainGeneration++; nextRetryAt = 0; reason = ""; blocked = false;
      for (const item of items()) if (item.state === "ready") retire(item, "administrator_drain");
      return tick();
    },
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
      nextRetryAt = 0; reason = ""; blocked = false;
    },
    async close() { closing = true; clearInterval(timer); await Promise.allSettled([tickPromise, ...purchases, ...inspections.values(), ...cancellations.values()].filter(Boolean)); },
  };
}
