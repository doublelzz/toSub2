import React, { useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, Search } from "lucide-react";

const SERVICES_PER_PAGE = 5;

export default function SmsServiceSelector({ provider, options, loading, onRefresh, onSelect }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const query = search.trim().toLocaleLowerCase();
  const filtered = useMemo(() => options.filter((option) => (
    !query || `${option.title} ${option.country} ${option.project} ${option.serviceId}`.toLocaleLowerCase().includes(query)
  )).sort((left, right) => Number(left.uses) - Number(right.uses) || String(left.title).localeCompare(String(right.title), "zh-CN")), [options, query]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / SERVICES_PER_PAGE) - 1));
  const visible = filtered.slice(currentPage * SERVICES_PER_PAGE, (currentPage + 1) * SERVICES_PER_PAGE);
  const selected = options.find((option) => String(option.serviceId) === String(provider.config.serviceId || ""))
    || options.find((option) => option.country === provider.config.country && option.project === provider.config.project);

  return <section className="sms-price-selector wide-settings-field" aria-label={`${provider.name} 服务选择`} aria-busy={loading}>
    <div className="sms-selector-heading">
      <strong>接码服务</strong>
      <button type="button" className="price-refresh-button" onClick={onRefresh} disabled={loading || !provider.config.apiKey}>
        {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
        {loading ? "查询中" : "查询服务"}
      </button>
    </div>
    {!options.length ? <p className="sms-selector-empty" role="status">{loading ? "正在查询当前上架服务…" : "填写 API Key 后查询服务，再选择项目。"}</p> : <>
      <div className="sms-selector-filters">
        <label className="sms-country-search">
          <Search size={15} aria-hidden="true" />
          <input type="search" aria-label={`${provider.name} 搜索服务`} placeholder="搜索服务 / 国家 / 项目" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} disabled={loading} />
        </label>
      </div>
      <div className="sms-country-list" role="group" aria-label={`${provider.name} 服务列表`}>
        <div className="sms-country-columns" aria-hidden="true"><span>服务</span><span>国家 / 项目</span><span>次数</span></div>
        {visible.map((option) => <button type="button" className={`sms-country-row ${selected?.serviceId === option.serviceId ? "selected" : ""}`} key={option.serviceId}
          aria-pressed={selected?.serviceId === option.serviceId} disabled={loading} onClick={() => onSelect(option)}>
          <span className="sms-country-title">{selected?.serviceId === option.serviceId && <Check size={13} aria-hidden="true" />}{option.title}</span>
          <span className="sms-country-quality">{option.country} / {option.project}</span>
          <span className="sms-country-price">{option.uses} 次</span>
        </button>)}
        {!visible.length && <p className="sms-selector-empty" role="status">没有匹配的服务，请调整搜索条件。</p>}
      </div>
      <div className="sms-country-pagination">
        <span role="status">{filtered.length ? `${currentPage * SERVICES_PER_PAGE + 1}–${Math.min((currentPage + 1) * SERVICES_PER_PAGE, filtered.length)} / ${filtered.length} 个服务` : "0 个服务"}</span>
        <div><button type="button" aria-label="上一页服务" onClick={() => setPage(currentPage - 1)} disabled={loading || currentPage === 0}><ChevronLeft size={16} /></button>
          <button type="button" aria-label="下一页服务" onClick={() => setPage(currentPage + 1)} disabled={loading || (currentPage + 1) * SERVICES_PER_PAGE >= filtered.length}><ChevronRight size={16} /></button></div>
      </div>
      <p className="sms-quality-note">每单先冻结所示次数；收到短信后消耗，明确失败或确认取消后由平台退回。</p>
    </>}
  </section>;
}
