import React, { useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { filterSmsCountries, findSmsNumberOption, formatSmsSuccessRate, groupSmsCountries, smsPriceOptionKey } from "./sms-number-options.mjs";

const COUNTRIES_PER_PAGE = 5;

export default function SmsPriceSelector({ provider, options, loading, onRefresh, onSelect, countryName }) {
  const [search, setSearch] = useState("");
  const [quality, setQuality] = useState("all");
  const [page, setPage] = useState(0);
  const hasQuality = provider.id === "herosms";
  const countries = useMemo(() => groupSmsCountries(options, countryName), [options, countryName]);
  const filtered = useMemo(() => filterSmsCountries(countries, { search, quality, sort: hasQuality ? "quality" : "price" }), [countries, search, quality, hasQuality]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / COUNTRIES_PER_PAGE) - 1));
  const visible = filtered.slice(currentPage * COUNTRIES_PER_PAGE, (currentPage + 1) * COUNTRIES_PER_PAGE);
  const selected = findSmsNumberOption(options, provider.config);
  const selectedCountry = countries.find((country) => country.country === selected?.country);

  return <section className="sms-price-selector wide-settings-field" aria-label={`${provider.name} 国家与质量选择`} aria-busy={loading}>
    <div className="sms-selector-heading">
      <strong>{hasQuality ? "国家与质量" : "国家与价格"}</strong>
      <button type="button" className="price-refresh-button" onClick={onRefresh} disabled={loading || !provider.config.apiKey}>
        {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
        {loading ? "查询中" : "查询价格"}
      </button>
    </div>
    {!options.length ? <p className="sms-selector-empty" role="status">{loading ? "正在查询国家、价格和库存…" : "填写 API Key 后查询价格，再选择国家。"}</p> : <>
      <div className="sms-selector-filters">
        <label className="sms-country-search">
          <Search size={15} aria-hidden="true" />
          <input type="search" aria-label={`${provider.name} 搜索国家`} placeholder="搜索国家 / ID" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} disabled={loading} />
        </label>
        {hasQuality ? <label className="sms-quality-filter">
          <select aria-label={`${provider.name} 质量筛选`} value={quality} onChange={(event) => { setQuality(event.target.value); setPage(0); }} disabled={loading}>
            <option value="all">全部质量</option>
            <option value="high">高：≥90%</option>
            <option value="medium">中：70%–&lt;90%</option>
            <option value="low">低：&lt;70%</option>
            <option value="unknown">暂无数据</option>
          </select>
        </label> : <span className="sms-quality-kind">Gold 供应商</span>}
      </div>
      <div className="sms-country-list" role="group" aria-label={`${provider.name} 国家列表`}>
        <div className="sms-country-columns" aria-hidden="true"><span>国家</span><span>{hasQuality ? "平台成功率" : "类型"}</span><span>起价</span></div>
        {visible.map((country) => <button type="button" className={`sms-country-row ${selected?.country === country.country ? "selected" : ""}`} key={country.country}
          aria-pressed={selected?.country === country.country} disabled={loading} onClick={() => onSelect(selected?.country === country.country ? selected : country.tiers[0])}>
          <span className="sms-country-title">{selected?.country === country.country && <Check size={13} aria-hidden="true" />}{country.title}</span>
          <span className="sms-country-quality">{hasQuality ? formatSmsSuccessRate(country.successRate) : "Gold"}</span>
          <span className="sms-country-price">{country.minPrice}</span>
        </button>)}
        {!visible.length && <p className="sms-selector-empty" role="status">没有符合条件的国家，试试其他名称或质量条件。</p>}
      </div>
      <div className="sms-country-pagination">
        <span role="status">{filtered.length ? `${currentPage * COUNTRIES_PER_PAGE + 1}–${Math.min((currentPage + 1) * COUNTRIES_PER_PAGE, filtered.length)} / ${filtered.length} 个国家` : "0 个国家"}</span>
        <div><button type="button" aria-label="上一页国家" onClick={() => setPage(currentPage - 1)} disabled={loading || currentPage === 0}><ChevronLeft size={16} /></button>
          <button type="button" aria-label="下一页国家" onClick={() => setPage(currentPage + 1)} disabled={loading || (currentPage + 1) * COUNTRIES_PER_PAGE >= filtered.length}><ChevronRight size={16} /></button></div>
      </div>
      {selectedCountry && <label className="sms-tier-select">
        <span>已选 {selectedCountry.title} · {selectedCountry.tiers.length} 个价格档位</span>
        <select aria-label={`${provider.name} 价格档位`} value={smsPriceOptionKey(selected)} disabled={loading} onChange={(event) => {
          const option = selectedCountry.tiers.find((tier) => smsPriceOptionKey(tier) === event.target.value);
          if (option) onSelect(option);
        }}>{selectedCountry.tiers.map((tier) => <option key={smsPriceOptionKey(tier)} value={smsPriceOptionKey(tier)}>价格 {tier.price} · 库存 {tier.count}</option>)}</select>
      </label>}
      {hasQuality && <p className="sms-quality-note">质量按国家统计：平台近 24 小时成功率，成功激活样本至少 50 次。同一国家的价格档位共享该指标。</p>}
    </>}
  </section>;
}
