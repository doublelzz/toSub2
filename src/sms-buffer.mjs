import { poolCostOrder } from "./sms-pool-costs.mjs";

// The former inventory worker only finishes orders bought by older releases.
// New tasks acquire directly from configured quotations in sms-pool.mjs.
export function createSmsBuffer({ store, now, createProvider, providerOptions }) {
  let closing = false; let timer; let tickPromise;
  const cancellations = new Map();
  const items = () => store.inventoryItems({ activeOnly: true, limit: 1000 });
  function publicItem(item) {
    return { id: item.id, entryId: item.entryId, providerId: item.providerId, state: item.state, createdAt: item.createdAt, expiresAt: item.expiresAt,
      expiresSource: item.expiresSource || null, cancelAllowedAt: item.cancelAllowedAt || null, nextActionAt: item.nextActionAt || null,
      ...poolCostOrder(item, { refundExpected: ["cancel_pending", "quarantined", "closed"].includes(item.state) }),
      phone: item.order?.number || null, hasSms: item.hasSms === true, canReconcile: ["purchase_unknown", "quarantined", "cancel_pending"].includes(item.state),
      cancelState: item.cancelState || null, retirementReason: item.retirementReason || "", lastError: item.lastError || "" };
  }
  function snapshot() {
    return { counts: store.inventoryCounts(), items: store.inventoryItems({ limit: 200 }).map(publicItem) };
  }
  function retire(item, reason) {
    return store.updateInventory(item.id, (value) => ({ ...value, state: "cancel_pending", retirementReason: value.retirementReason || reason,
      lastError: reason, nextActionAt: Math.max(now(), value.cancelAllowedAt || 0), cancelState: "pending" }));
  }
  async function cancel(item) {
    if (cancellations.has(item.id) || !item.order?.requestId || item.nextActionAt > now()) return;
    const task = (async () => {
      const current = store.inventoryItem(item.id); if (!current || !["cancel_pending", "quarantined"].includes(current.state)) return;
      if (current.cancelAllowedAt > now()) { store.updateInventory(item.id, (value) => ({ ...value, nextActionAt: value.cancelAllowedAt })); return; }
      try {
        const client = createProvider(current.providerId, current.config, providerOptions);
        const status = typeof client.inspect === "function" ? await client.inspect(current.order.requestId) : null;
        if (status?.state === "cancelled") {
          store.updateInventory(item.id, (value) => ({ ...value, state: "closed", cancelState: "confirmed", cancelledAt: now(), cancellationReceipt: "STATUS_CANCEL", nextActionAt: 0, lastError: "" })); return;
        }
        if (current.cancelBeforeAt && now() >= current.cancelBeforeAt) {
          store.updateInventory(item.id, (value) => ({ ...value, state: "quarantined", cancelState: "denied", lastError: "cancellation_window_expired", nextActionAt: 0 })); return;
        }
        if (status?.hasSms === true) throw Object.assign(new Error("order has SMS"), { code: "OTP_RECEIVED" });
        if (typeof client.cancelStrict !== "function") throw Object.assign(new Error("strict cancel unavailable"), { code: "CANCEL_UNSUPPORTED" });
        const receipt = await client.cancelStrict(current.order.requestId);
        if (!receipt?.cancelled || receipt.receipt !== "ACCESS_CANCEL") throw new Error("cancellation was not confirmed");
        store.updateInventory(item.id, (value) => ({ ...value, state: "closed", cancelState: "confirmed", cancelledAt: now(), cancellationReceipt: receipt.receipt,
          refundStatus: receipt.refundStatus === "confirmed" && receipt.refundEvidence ? "confirmed" : "unconfirmed", refundEvidence: receipt.refundEvidence || null, nextActionAt: 0, lastError: "" }));
      } catch (error) {
        const code = String(error.code || ""); const denied = /FREE_CANCELLATION_EXPIRED|OTP_RECEIVED|NEW_OTP_RECEIVED|CANCEL_UNSUPPORTED/.test(code);
        store.updateInventory(item.id, (value) => ({ ...value, state: denied ? "quarantined" : "cancel_pending", cancelState: denied ? "denied" : "unknown",
          lastError: code || "cancel_unconfirmed", hasSms: value.hasSms || code === "OTP_RECEIVED", nextActionAt: denied ? 0 : Math.max(now() + 30000, value.cancelAllowedAt || 0), cancelAttempts: (value.cancelAttempts || 0) + 1 }));
      }
    })();
    cancellations.set(item.id, task); try { await task; } finally { cancellations.delete(item.id); }
  }
  async function tick() {
    if (tickPromise) return tickPromise;
    tickPromise = (async () => {
      for (let item of items()) {
        if (item.state === "ready") item = retire(item, "legacy_inventory_retired");
        if (item.state === "checking") item = retire(item, "interrupted_inventory_check");
        if (item.state === "purchasing") { store.updateInventory(item.id, (value) => ({ ...value, state: "purchase_unknown", lastError: "interrupted_purchase", nextActionAt: 0 })); continue; }
        if (["cancel_pending", "quarantined"].includes(item.state) && item.nextActionAt > 0 && item.nextActionAt <= now()) await cancel(item);
      }
    })();
    try { return await tickPromise; } finally { tickPromise = null; }
  }
  return {
    snapshot, inventoryPage(query = {}) { const page = store.inventoryPage(query); return { ...page, items: page.items.map(publicItem) }; },
    tick, start() { if (!timer && !closing) { timer = setInterval(() => { void tick().catch(() => {}); }, 1000); timer.unref(); } },
    pause() { clearInterval(timer); timer = null; }, configurationChanged() {},
    async drain(actor) { store.audit(actor, "sms-legacy-inventory-drain", "sms-pool"); return tick(); },
    reconcile(id, body, actor) {
      const item = store.inventoryItem(id); if (!item) throw Object.assign(new Error("库存记录不存在"), { status: 404 });
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (body.action !== "close" || !note || note.length > 300) throw Object.assign(new Error("请填写确认服务商订单已结束或未创建的核实依据"), { status: 422 });
      if (item.state === "closed") return;
      if (!["purchase_unknown", "quarantined", "cancel_pending"].includes(item.state) || cancellations.has(id)) throw Object.assign(new Error("只能核实已停止且待处理的库存订单"), { status: 409 });
      const refundEvidence = typeof body.refundEvidence === "string" ? body.refundEvidence.trim().slice(0, 300) : "";
      store.audit(actor, "sms-buffer-reconcile", id, { action: "close", note, refundEvidence });
      store.updateInventory(id, (value) => ({ ...value, state: "closed", cancelState: "confirmed", nextActionAt: 0, reconciledAt: now(), reconciliation: { note, actor },
        refundStatus: refundEvidence ? "confirmed" : "unconfirmed", refundEvidence: refundEvidence || null, lastError: "" }));
    },
    async close() { closing = true; clearInterval(timer); await Promise.allSettled([tickPromise, ...cancellations.values()].filter(Boolean)); },
  };
}
