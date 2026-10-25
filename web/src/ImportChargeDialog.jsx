import React, { useRef } from "react";
import { X } from "lucide-react";
import { useDialogFocus } from "./WorkspaceUi.jsx";
import "./cdk.css";

export default function ImportChargeDialog({ quote, onClose }) {
  const panel = useRef(null);
  const pool = quote.smsPool;
  const maximum = quote.charge + (pool?.maximum || 0);
  const affordable = pool && !pool.admin ? Math.min(pool.count, Math.max(0, Math.floor(quote.after / pool.fee))) : pool?.count;
  useDialogFocus(true, () => onClose(false), panel);

  return <div className="modal-backdrop cdk-import-backdrop">
    <section ref={panel} className={`cdk-confirm${pool ? " cdk-combined-confirm" : ""}`} role="dialog" aria-modal="true" aria-labelledby="import-quote-title">
      <header className="cdk-confirm-heading"><h2 id="import-quote-title">{pool ? "确认导入并使用接码池" : "确认导入账号"}</h2><button type="button" className="icon-button" aria-label="关闭费用确认" onClick={() => onClose(false)}><X size={18} /></button></header>
      <p>去重后 {quote.count} 个账号，其中新增 {quote.added} 个，已有 {quote.updated} 个。</p>
      {pool ? <>
        <dl className="cdk-charge-lines">
          <div><dt>账号导入<small>新增 {quote.added} 个账号入库时扣除，已有账号不重复扣。</small></dt><dd>{quote.charge}<span> 次</span></dd></div>
          <div><dt>接码池<small>每个账号手机验证成功扣 {pool.fee} 次，最多 {pool.count} 个账号。</small></dt><dd><small>最多 </small>{pool.maximum}<span> 次</span></dd></div>
        </dl>
        <div className="cdk-charge-total"><span>本次最高合计<small>导入与接码分别结算</small></span><strong>{maximum}<small> 次</small></strong></div>
        <p className="cdk-charge-balance">当前可用 {quote.balance ?? "不限"}{quote.balance !== null && " 次"}，导入后可用 {quote.after ?? "不限"}{quote.after !== null && " 次"}。</p>
        {pool.admin ? <p className="cdk-helper">当前为管理员自己的工作区，导入与接码均不扣 CDK 次数。</p> : <>
          {affordable < pool.count && <p className="cdk-charge-capacity" role="status">导入后的余额最多支持 {affordable} 个账号接码。其余任务余额不足时停止取号。</p>}
          <p className="cdk-helper">接码费用按实际验证成功数扣除，最高合计不会一次性扣除。每个账号取号前预留 {pool.fee} 次；明确失败释放预留，结果不明时等待核实。</p>
          <p className="cdk-helper">新增账号入库后，任务失败或取消不退导入次数。手机验证码通过后，即使后续授权失败，仍扣本次接码费用。</p>
        </>}
      </> : <>
        <div className="cdk-equation"><div><span>当前可用</span><strong>{quote.balance ?? "不限"}</strong></div><div><span>本次扣次</span><strong>{quote.charge}</strong></div><div><span>导入后可用</span><strong>{quote.after ?? "不限"}</strong></div></div>
        <p className="cdk-helper">已有账号更新和内部流转不重复扣次。新增账号入库后，任务失败或取消不自动退次。</p>
      </>}
      <footer><button className="secondary-button" type="button" onClick={() => onClose(false)}>取消</button><button className="primary-button" type="button" onClick={() => onClose(true)}>{pool ? "确认导入并创建任务" : `确认导入${quote.charge ? `，消耗 ${quote.charge} 次` : "，不扣次数"}`}</button></footer>
    </section>
  </div>;
}
