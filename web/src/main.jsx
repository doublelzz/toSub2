import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Filter,
  Globe2,
  KeyRound,
  ListPlus,
  LoaderCircle,
  LogIn,
  Mail,
  MailCheck,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Smartphone,
  PhoneIncoming,
  Trash2,
  X,
} from "lucide-react";
import "./styles.css";
import "./workspace.css";
import MfaWorkspace from "./MfaWorkspace.jsx";
import EmailRebindWorkspace from "./EmailRebindWorkspace.jsx";
import SmsPoolWorkspace, { SmsPoolChoice, SmsPoolChargeDialog } from "./SmsPoolWorkspace.jsx";
import CdkGate from "./CdkGate.jsx";
import CdkWorkspace from "./CdkWorkspace.jsx";
import CurrentCdk from "./CurrentCdk.jsx";
import { cdkFetch, flushWorkspaceSettings, readWorkspaceValue, writeWorkspaceValue } from "./cdk-api.mjs";
import SmsPriceSelector from "./SmsPriceSelector.jsx";
import { filterSmsOptionsByGrade, findSmsNumberOption, preferredSmsNumberOption } from "./sms-number-options.mjs";
import { Drawer, MoreActions, TaskFilters, TaskOverview, ThemeControl, useCalendarDay, useDialogFocus } from "./WorkspaceUi.jsx";
import { AUTH_STATUSES, DEFAULT_FILTERS, hasFilters, queryFilters } from "./task-filters.mjs";

const POLL_INTERVAL_MS = 900;
const LUBAN_API_KEY_STORAGE_KEY = "chatgpt-onboarding.luban-api-key";
const LUBAN_SERVICE_ID_STORAGE_KEY = "chatgpt-onboarding.luban-service-id";
const SMS_PROVIDER_SETTINGS_KEY = "chatgpt-onboarding.sms-provider-settings-v1";
const MAIL_REQUEST_SETTINGS_KEY = "chatgpt-onboarding.mail-request-settings-v1";
const SUB2API_UPLOAD_SETTINGS_KEY = "chatgpt-onboarding.sub2api-upload-settings-v1";
const ACCOUNT_PROXY_STORAGE_KEY = "chatgpt-onboarding.account-proxy-v1";
const SMS_PROVIDER_EXTERNAL_LINKS = {
  luban: {
    href: "https://lubansms.com/",
    label: "点击获取 API 密钥",
  },
  smsbower: {
    href: "https://smsbower.app/cabinet/profile",
    label: "点击获取 API 密钥",
  },
  herosms: {
    href: "https://hero-sms.com/cn/api",
    label: "查看 API 与密钥",
  },
};
const REGION_NAMES = typeof Intl.DisplayNames === "function"
  ? new Intl.DisplayNames(["zh-CN"], { type: "region" })
  : null;

function PhoneBindingOption({ enabled, onChange, disabled }) {
  return <label className="phone-binding-option">
    <input type="checkbox" role="switch" checked={enabled} onChange={(event) => onChange(event.target.checked)} disabled={disabled} aria-label="允许手机号接码" />
    <span><strong>登录后自动接码</strong><small>{enabled ? "登录后先检测额度，再自动申请手机号继续授权。" : "登录后先检测额度；需要手机号时，在任务列表点击开始接码。"}</small></span>
  </label>;
}

function App({ auth }) {
  const [adminView, setAdminView] = useState(auth.account.role === "admin" && auth.account.id === auth.workspace.id);
  const [activeWorkspace, setActiveWorkspace] = useState(auth.account.role === "admin" && auth.account.id === auth.workspace.id ? "cdk-management" : "authorization");
  const [mfaFocusAccountId, setMfaFocusAccountId] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [remoteBindingOpen, setRemoteBindingOpen] = useState(false);
  const [remoteBindingError, setRemoteBindingError] = useState("");
  const [remoteBindingBusy, setRemoteBindingBusy] = useState(false);
  const [singleOpen, setSingleOpen] = useState(false);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [phoneTab, setPhoneTab] = useState("all");
  const [phoneBindingEnabled, setPhoneBindingEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [density, setDensity] = useState(() => readLocalTextSetting("tosub2.density") === "compact" ? "compact" : "comfortable");
  const calendarDay = useCalendarDay();
  const requestFilters = useMemo(() => ({ ...queryFilters(filters), phoneBinding: phoneTab }), [filters, calendarDay, phoneTab]);
  const [token, setToken] = useState(auth.token);
  const [features, setFeatures] = useState(auth.features);
  const [jobs, setJobs] = useState([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [filterError, setFilterError] = useState("");
  const [emailFilter, setEmailFilter] = useState([]);
  const [error, setError] = useState("");
  const [expandedJobId, setExpandedJobId] = useState(null);
  const [selectedJobIds, setSelectedJobIds] = useState(() => new Set());
  const [jobSelectionIndex, setJobSelectionIndex] = useState([]);
  const [batchAction, setBatchAction] = useState("");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  const [stats, setStats] = useState({ active: 0, queued: 0, completed: 0 });
  const [smsSettings, setSmsSettings] = useState(readSmsProviderSettings);
  const [smsSettingsOpen, setSmsSettingsOpen] = useState(false);
  const [smsSettingsDraft, setSmsSettingsDraft] = useState(readSmsProviderSettings);
  const [smsSettingsError, setSmsSettingsError] = useState("");
  const [smsChargeQuote, setSmsChargeQuote] = useState(null);
  const [smsNumberOptionsState, setSmsNumberOptionsState] = useState(null);
  const [smsOptionsLoading, setSmsOptionsLoading] = useState(false);
  const [mailRequestSettings, setMailRequestSettings] = useState(readMailRequestSettings);
  const [mailRequestSettingsDraft, setMailRequestSettingsDraft] = useState(readMailRequestSettings);
  const [mailRequestSettingsOpen, setMailRequestSettingsOpen] = useState(false);
  const [mailRequestSettingsError, setMailRequestSettingsError] = useState("");
  const [mailRequestSettingsSaving, setMailRequestSettingsSaving] = useState(false);
  const [sub2apiSettings, setSub2apiSettings] = useState(readSub2ApiSettings);
  const [sub2apiSettingsDraft, setSub2apiSettingsDraft] = useState(readSub2ApiSettings);
  const [sub2apiGroups, setSub2apiGroups] = useState([]);
  const [sub2apiProxies, setSub2apiProxies] = useState([]);
  const [sub2apiSettingsOpen, setSub2apiSettingsOpen] = useState(false);
  const [sub2apiSettingsError, setSub2apiSettingsError] = useState("");
  const [sub2apiGroupsLoading, setSub2apiGroupsLoading] = useState(false);
  const [sub2apiSettingsSaving, setSub2apiSettingsSaving] = useState(false);
  const [sub2apiMonitorChecking, setSub2apiMonitorChecking] = useState(false);
  const [sub2apiMonitorStatus, setSub2apiMonitorStatus] = useState({
    configured: false,
    enabled: false,
    running: false,
    lastCheckAt: null,
    nextCheckAt: null,
    lastError: null,
    lastResult: null,
    intervalMinutes: 5,
  });
  const [uploadNotice, setUploadNotice] = useState("");
  const [exportReport, setExportReport] = useState(null);
  const [accountProxyUrl, setAccountProxyUrl] = useState(() => readLocalTextSetting(ACCOUNT_PROXY_STORAGE_KEY));

  useDialogFocus(smsSettingsOpen || mailRequestSettingsOpen || sub2apiSettingsOpen || batchOpen || filterOpen, () => {
    setSmsSettingsOpen(false);
    if (!mailRequestSettingsSaving) setMailRequestSettingsOpen(false);
    if (!sub2apiSettingsSaving) setSub2apiSettingsOpen(false);
    if (!batchBusy) setBatchOpen(false);
    setFilterOpen(false);
  });

  useEffect(() => writeLocalJson(SMS_PROVIDER_SETTINGS_KEY, smsSettings), [smsSettings]);
  useEffect(() => writeLocalJson(MAIL_REQUEST_SETTINGS_KEY, mailRequestSettings), [mailRequestSettings]);
  useEffect(() => writeLocalJson(SUB2API_UPLOAD_SETTINGS_KEY, sub2apiSettings), [sub2apiSettings]);
  useEffect(() => writeLocalTextSetting(ACCOUNT_PROXY_STORAGE_KEY, accountProxyUrl.trim()), [accountProxyUrl]);
  useEffect(() => writeLocalTextSetting("tosub2.density", density), [density]);

  useEffect(() => {
    let stopped = false;
    cdkFetch("/api/bootstrap")
      .then(readResponse)
      .then((data) => {
        if (!stopped) {
          if (!data.authenticated) { window.dispatchEvent(new Event("cdk-session-refresh")); return; }
          setToken(data.token);
          setFeatures(data.features || {});
        }
      })
      .catch((requestError) => { if (!stopped) setError(requestError.message); });
    return () => {
      stopped = true;
    };
  }, [connectionAttempt]);

  useEffect(() => {
    if (!token) return;
    void apiFetch(token, "/api/mail-request-config", {
      method: "POST",
      body: JSON.stringify({ config: buildMailRequestConfig(mailRequestSettings) }),
    }).catch((requestError) => setError(requestError.message));
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    if (requestFilters.error) {
      setJobs([]);
      setJobSelectionIndex([]);
      setPagination({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
      return undefined;
    }
    let stopped = false;
    let timer;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const data = emailFilter.length
          ? await apiFetch(token, "/api/jobs/query", {
              method: "POST",
              body: JSON.stringify({ page, emails: emailFilter, ...requestFilters }),
              signal: controller.signal,
            })
          : await apiFetch(token, `/api/jobs?${new URLSearchParams({ page, ...requestFilters })}`, { signal: controller.signal });
        if (!stopped) {
          setJobs(data.jobs);
          setJobSelectionIndex(data.selection || data.jobs);
          setPagination(data.pagination || { page, pageSize: 20, total: data.jobs.length, totalPages: 1 });
          setStats(data.stats || { active: 0, queued: 0, completed: 0 });
          setLoaded(true);
          if (data.pagination?.page && data.pagination.page !== page) setPage(data.pagination.page);
          setError("");
        }
      } catch (requestError) {
        if (!stopped) setError(requestError.message);
      } finally {
        if (!stopped) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    poll();
    return () => {
      stopped = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [token, page, emailFilter, requestFilters, connectionAttempt]);

  useEffect(() => {
    if (!token || !features.sub2apiMonitor) return undefined;
    let stopped = false;
    const load = async () => {
      try {
        const data = await apiFetch(token, "/api/sub2api/monitor");
        if (!stopped) {
          setSub2apiMonitorStatus(data);
          setSub2apiSettings((current) => ({ ...current, monitorEnabled: Boolean(data.enabled) }));
        }
      } catch {}
    };
    void load();
    const timer = window.setInterval(load, 5_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [token, features.sub2apiMonitor]);

  const pageJobIds = useMemo(() => jobs.map((job) => job.id), [jobs]);
  const smsProviderDefinitions = Array.isArray(features.smsProviders) ? features.smsProviders : [];
  const activeSmsProvider = useMemo(
    () => resolveSmsProvider(smsProviderDefinitions, smsSettings),
    [smsProviderDefinitions, smsSettings],
  );
  const draftSmsProvider = useMemo(
    () => resolveSmsProvider(smsProviderDefinitions, smsSettingsDraft),
    [smsProviderDefinitions, smsSettingsDraft],
  );
  const smsNumberOptions = smsNumberOptionsState?.providerId === draftSmsProvider.id
    && smsNumberOptionsState.apiKey === draftSmsProvider.config.apiKey
    && smsNumberOptionsState.service === draftSmsProvider.config.service
    ? smsNumberOptionsState.options
    : [];
  const selectedJobs = useMemo(
    () => jobSelectionIndex.filter((job) => selectedJobIds.has(job.id)),
    [jobSelectionIndex, selectedJobIds],
  );
  const downloadableSelectedCount = selectedJobs.filter((job) => job.canDownload).length;
  const allPageSelected = pageJobIds.length > 0 && pageJobIds.every((id) => selectedJobIds.has(id));
  const canDownloadSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && downloadableSelectedCount > 0;
  const canReauthorizeSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && selectedJobs.every((job) => job.canRegenerate || job.canRetry);
  const forceReloginSelectedCount = selectedJobs.filter((job) => job.canForceRelogin).length;
  const canForceReloginSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && forceReloginSelectedCount > 0;
  const canUploadSelected = selectedJobs.length > 0 && downloadableSelectedCount > 0;
  const phoneBindingSelectedCount = selectedJobs.filter((job) => job.canStartPhoneBinding).length;
  const canStartPhoneSelected = selectedJobs.length === selectedJobIds.size && phoneBindingSelectedCount > 0;
  const totpSetupSelectedCount = selectedJobs.filter((job) => job.canSetupTotp).length;
  const canSetupTotpSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && totpSetupSelectedCount > 0;
  const passwordAddSelectedCount = selectedJobs.filter((job) => job.canAddPassword).length;
  const canAddPasswordSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && passwordAddSelectedCount > 0;

  function openSmsSettings() {
    const draft = withSmsProviderDefaults(smsProviderDefinitions, smsSettings);
    setSmsSettingsDraft(draft);
    setSmsSettingsError("");
    setSmsSettingsOpen(true);
  }

  function openMailRequestSettings() {
    setMailRequestSettingsDraft({ ...mailRequestSettings });
    setMailRequestSettingsError("");
    setMailRequestSettingsOpen(true);
  }

  async function saveMailRequestSettings(event) {
    event.preventDefault();
    let config;
    try {
      config = buildMailRequestConfig(mailRequestSettingsDraft);
    } catch (requestError) {
      setMailRequestSettingsError(requestError.message);
      return;
    }
    setMailRequestSettingsSaving(true);
    setMailRequestSettingsError("");
    try {
      await apiFetch(token, "/api/mail-request-config", {
        method: "POST",
        body: JSON.stringify({ config }),
      });
      setMailRequestSettings(normalizeMailRequestSettings(mailRequestSettingsDraft));
      setMailRequestSettingsOpen(false);
    } catch (requestError) {
      setMailRequestSettingsError(requestError.message);
    } finally {
      setMailRequestSettingsSaving(false);
    }
  }

  function openSub2ApiSettings() {
    setSub2apiSettingsDraft({ ...sub2apiSettings, monitorEnabled: Boolean(sub2apiMonitorStatus.enabled) });
    setSub2apiSettingsError("");
    setSub2apiSettingsOpen(true);
  }

  async function loadSub2ApiOptions(settings = sub2apiSettingsDraft) {
    setSub2apiGroupsLoading(true);
    setSub2apiSettingsError("");
    try {
      const data = await apiFetch(token, "/api/sub2api/options", {
        method: "POST",
        body: JSON.stringify({ config: settings }),
      });
      setSub2apiGroups(Array.isArray(data.groups) ? data.groups : []);
      setSub2apiProxies(Array.isArray(data.proxies) ? data.proxies : []);
    } catch (requestError) {
      setSub2apiGroups([]);
      setSub2apiProxies([]);
      setSub2apiSettingsError(requestError.message);
    } finally {
      setSub2apiGroupsLoading(false);
    }
  }

  async function saveSub2ApiSettings(event) {
    event.preventDefault();
    const baseUrl = String(sub2apiSettingsDraft.baseUrl || "").trim();
    const adminApiKey = String(sub2apiSettingsDraft.adminApiKey || "").trim();
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      setSub2apiSettingsError("请输入 http:// 或 https:// 开头的 Sub2API 后端地址");
      return;
    }
    if (!adminApiKey) {
      setSub2apiSettingsError("请输入 Sub2API 管理员 API Key");
      return;
    }
    const nextSettings = {
      ...readSub2ApiSettings(sub2apiSettingsDraft),
      baseUrl: baseUrl.replace(/\/+$/, ""),
      adminApiKey,
    };
    setSub2apiSettingsSaving(true);
    try {
      const monitor = await apiFetch(token, "/api/sub2api/monitor", {
        method: "POST",
        body: JSON.stringify({ enabled: nextSettings.monitorEnabled, config: nextSettings }),
      });
      setSub2apiSettings(nextSettings);
      setSub2apiMonitorStatus(monitor);
      setSub2apiSettingsOpen(false);
      setSub2apiSettingsError("");
    } catch (requestError) {
      setSub2apiSettingsError(requestError.message);
    } finally {
      setSub2apiSettingsSaving(false);
    }
  }

  async function checkSub2ApiMonitorNow() {
    if (!sub2apiMonitorStatus.enabled || sub2apiMonitorChecking) return;
    setSub2apiMonitorChecking(true);
    setSub2apiSettingsError("");
    try {
      const data = await apiFetch(token, "/api/sub2api/monitor/check", { method: "POST" });
      setSub2apiMonitorStatus(data);
      setUploadNotice(formatMonitorResult(data.result));
      setError("");
    } catch (requestError) {
      if (sub2apiSettingsOpen) setSub2apiSettingsError(requestError.message);
      else setError(requestError.message);
    } finally {
      setSub2apiMonitorChecking(false);
    }
  }

  function setSub2ApiGroupChecked(groupId, checked) {
    setSub2apiSettingsDraft((current) => {
      const selected = new Set(current.groupIds);
      if (checked) selected.add(String(groupId));
      else selected.delete(String(groupId));
      return { ...current, groupIds: [...selected] };
    });
  }

  async function previewExport(ids) {
    const report = await apiFetch(token, "/api/jobs/export-preview", {
      method: "POST", body: JSON.stringify({ ids }),
    });
    setExportReport(report);
    if (!report.exportable) throw new Error("没有通过校验的导入文件，请查看导出检查结果");
    return report;
  }

  function showStartedMfa(accountId) {
    setMfaFocusAccountId(accountId);
    setExpandedJobId(null);
    setActiveWorkspace("mfa");
  }

  async function uploadSelected(ids) {
    if (!sub2apiSettings.baseUrl || !sub2apiSettings.adminApiKey) {
      openSub2ApiSettings();
      setUploadNotice("请先配置 Sub2API 后端地址、管理员 API Key 和目标号池");
      return;
    }
    if (batchAction) return;
    setBatchAction("upload");
    setUploadNotice("");
    try {
      await previewExport(ids);
      const data = await apiFetch(token, "/api/sub2api/upload", {
        method: "POST",
        body: JSON.stringify({ ids, config: sub2apiSettings }),
      });
      setExportReport(data);
      setUploadNotice(`已创建 ${data.uploaded} 条${data.failed ? `，失败 ${data.failed} 条` : ""}${data.unknown ? `，结果未确认 ${data.unknown} 条` : ""}${data.skipped ? `，跳过 ${data.skipped} 条` : ""}`);
      setSelectedJobIds(new Set([
        ...(data.rows || []).filter((row) => row.status !== "ready").map((row) => row.id),
        ...(data.result?.results || []).filter((row) => row.success !== true).map((row) => row.jobId),
      ].filter(Boolean)));
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function loadSmsNumberOptions(settings = smsSettingsDraft) {
    const resolved = resolveSmsProvider(smsProviderDefinitions, settings);
    if (!resolved.definition?.optionsEndpoint) return;
    if (!String(resolved.config.apiKey || "").trim()) {
      setSmsSettingsError("请先填写 API Key");
      return;
    }
    setSmsOptionsLoading(true);
    setSmsSettingsError("");
    try {
      const data = await apiFetch(token, resolved.definition.optionsEndpoint, {
        method: "POST",
        body: JSON.stringify({ config: resolved.config }),
      });
      const options = Array.isArray(data.options) ? data.options : [];
      setSmsNumberOptionsState({ providerId: resolved.id, apiKey: resolved.config.apiKey, service: resolved.config.service, options });
      const eligible = resolved.id === "smsbower" ? filterSmsOptionsByGrade(options, resolved.config.gradeFilter) : options;
      const current = resolved.config.maxPrice
        ? findSmsNumberOption(eligible, resolved.config) || preferredSmsNumberOption(eligible, resolved.id)
        : preferredSmsNumberOption(eligible, resolved.id);
      if (!current && options.length && resolved.id === "smsbower") {
        changeSmsGrade(resolved.config.gradeFilter || "all", options);
        return;
      }
      if (!current) throw new Error("当前没有可购买的国家号码");
      updateSmsProviderConfig(resolved.id, {
        country: current.country,
        maxPrice: String(current.price),
        quotedPrice: String(current.price),
        providerIds: current.providerIds || "",
        countryLabel: formatSmsCountryName(current),
      });
    } catch (requestError) {
      setSmsNumberOptionsState(null);
      setSmsSettingsError(requestError.message);
    } finally {
      setSmsOptionsLoading(false);
    }
  }

  function changeSmsGrade(gradeFilter, options = smsNumberOptions) {
    const eligible = filterSmsOptionsByGrade(options, gradeFilter);
    const current = findSmsNumberOption(eligible, draftSmsProvider.config) || preferredSmsNumberOption(eligible, "smsbower");
    updateSmsProviderConfig("smsbower", {
      gradeFilter,
      country: current?.country || "",
      maxPrice: current ? String(current.price) : "",
      quotedPrice: current ? String(current.price) : "",
      providerIds: current?.providerIds || "",
      countryLabel: current ? formatSmsCountryName(current) : "",
    });
    setSmsSettingsError(current ? "" : "当前档位暂无可用报价，请切换其他档位。");
  }

  function updateSmsProviderConfig(providerId, values) {
    setSmsSettingsDraft((current) => ({
      ...current,
      configs: {
        ...(current.configs || {}),
        [providerId]: {
          ...(current.configs?.[providerId] || {}),
          ...values,
        },
      },
    }));
  }

  function saveSmsSettings(event) {
    event.preventDefault();
    const resolved = resolveSmsProvider(smsProviderDefinitions, smsSettingsDraft);
    if (!resolved.definition) {
      setSmsSettingsError("请选择接码平台");
      return;
    }
    const missing = resolved.definition.fields.find((field) => (
      field.required !== false && !String(resolved.config[field.key] || "").trim()
    ));
    if (missing) {
      setSmsSettingsError(`请填写${missing.label}`);
      return;
    }
    if (resolved.id === "custom") {
      const customEntries = inspectCustomSmsEntries(resolved.config.entries);
      if (customEntries.error) {
        setSmsSettingsError(customEntries.error);
        return;
      }
    }
    if (resolved.id === "pool") {
      setSmsSettings(withSmsProviderDefaults(smsProviderDefinitions, smsSettingsDraft));
      setSmsSettingsOpen(false);
      setSmsSettingsError("");
      return;
    }
    const maxRotationAttempts = Number(resolved.config.maxRotationAttempts);
    const rotationIntervalSeconds = Number(resolved.config.rotationIntervalSeconds);
    if (!Number.isSafeInteger(maxRotationAttempts) || maxRotationAttempts < 1 || maxRotationAttempts > 20) {
      setSmsSettingsError("最大取号次数必须是 1 到 20 之间的整数");
      return;
    }
    if (!Number.isFinite(rotationIntervalSeconds) || rotationIntervalSeconds < 0 || rotationIntervalSeconds > 600) {
      setSmsSettingsError("自动换号间隔必须是 0 到 600 秒");
      return;
    }
    setSmsSettings(withSmsProviderDefaults(smsProviderDefinitions, smsSettingsDraft));
    setSmsSettingsOpen(false);
    setSmsSettingsError("");
  }

  useEffect(() => {
    const valid = new Set(jobSelectionIndex.map((job) => job.id));
    setSelectedJobIds((current) => {
      const next = new Set([...current].filter((id) => valid.has(id)));
      if (next.size === current.size && [...next].every((id) => current.has(id))) return current;
      return next;
    });
  }, [jobSelectionIndex]);

  useEffect(() => {
    setExpandedJobId(null);
  }, [page]);

  function updateFilters(next) {
    setFilters(next);
    setPage(1);
    setSelectedJobIds(new Set());
    setExpandedJobId(null);
  }

  function clearFilters() {
    updateFilters(DEFAULT_FILTERS);
    clearEmailFilter();
  }

  async function createJob(event) {
    event.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    try {
      const smsProvider = phoneBindingEnabled && activeSmsProvider.ready ? await prepareSmsProvider(1) : undefined;
      if (phoneBindingEnabled && activeSmsProvider.id === "pool" && !smsProvider) return;
      await apiFetch(token, "/api/jobs", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), proxyUrl: accountProxyUrl.trim(), phoneBindingMode: phoneBindingEnabled ? "automatic" : "manual", phoneBindingEnabled, ...(smsProvider ? { smsProvider } : {}) }),
      });
      setPage(1);
      setPhoneTab(phoneBindingEnabled ? "enabled" : "disabled");
      setSelectedJobIds(new Set());
      setEmail("");
      setSingleOpen(false);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function createBatch(event) {
    event.preventDefault();
    if (!batchText.trim() || batchBusy) return;
    setBatchBusy(true);
    try {
      const smsProvider = phoneBindingEnabled && activeSmsProvider.ready ? await prepareSmsProvider(batchText.split(/\r?\n/).filter((line) => line.trim()).length) : undefined;
      if (phoneBindingEnabled && activeSmsProvider.id === "pool" && !smsProvider) return;
      await apiFetch(token, "/api/jobs/batch", {
        method: "POST",
        body: JSON.stringify({ text: batchText, proxyUrl: accountProxyUrl.trim(), phoneBindingMode: phoneBindingEnabled ? "automatic" : "manual", phoneBindingEnabled, ...(smsProvider ? { smsProvider } : {}) }),
      });
      setPage(1);
      setPhoneTab(phoneBindingEnabled ? "enabled" : "disabled");
      setSelectedJobIds(new Set());
      setBatchText("");
      setBatchError("");
      setBatchOpen(false);
      setError("");
    } catch (requestError) {
      setBatchError(requestError.message);
    } finally {
      setBatchBusy(false);
    }
  }

  function applyEmailFilter(event) {
    event.preventDefault();
    try {
      const emails = parseEmailFilter(filterText);
      setEmailFilter(emails);
      setFilterText(emails.join("\n"));
      setSelectedJobIds(new Set());
      setExpandedJobId(null);
      setPage(1);
      setFilterError("");
      setFilterOpen(false);
    } catch (filterParseError) {
      setFilterError(filterParseError.message);
    }
  }

  function clearEmailFilter() {
    setEmailFilter([]);
    setFilterText("");
    setSelectedJobIds(new Set());
    setExpandedJobId(null);
    setPage(1);
    setFilterError("");
  }

  function toggleJobSelection(jobId) {
    setSelectedJobIds((current) => {
      const next = new Set(current);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  function toggleAllOnPage() {
    setSelectedJobIds((current) => {
      const next = new Set(current);
      pageJobIds.forEach((id) => {
        if (allPageSelected) next.delete(id);
        else next.add(id);
      });
      return next;
    });
  }

  async function downloadSelected() {
    if (!canDownloadSelected || batchAction) return;
    setBatchAction("download");
    try {
      await previewExport([...selectedJobIds]);
      const response = await cdkFetch("/api/jobs/download-batch", {
        method: "POST",
        headers: { "content-type": "application/json", "x-console-token": token },
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "批量下载失败");
      await saveDownloadResponse(response, `sub2api-import-oauth-${downloadableSelectedCount}-accounts-${localTimestamp()}.json`);
      setUploadNotice(downloadSummary(response));
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function reauthorizeSelected() {
    if (!canReauthorizeSelected || batchAction) return;
    setBatchAction("reauthorize");
    try {
      await apiFetch(token, "/api/jobs/reauthorize-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], proxyUrl: accountProxyUrl.trim() }),
      });
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function startPhoneSelected() {
    if (!canStartPhoneSelected || !activeSmsProvider.ready || batchAction) return;
    setBatchAction("start-phone");
    try {
      const smsProvider = await prepareSmsProvider(phoneBindingSelectedCount);
      if (!smsProvider) return;
      const data = await apiFetch(token, "/api/jobs/start-phone-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], smsProvider }),
      });
      setUploadNotice(`已开始为 ${data.started} 个账号接码${data.skipped ? `，跳过 ${data.skipped} 个` : ""}${data.failed ? `，失败 ${data.failed} 个` : ""}`);
      setSelectedJobIds(new Set());
      setError(data.failures?.map((item) => `${item.email}：${item.error}`).join("；") || "");
      if (data.started) {
        setPhoneTab("enabled");
        setPage(1);
        setExpandedJobId(null);
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function prepareSmsProvider(count = 1) {
    if (activeSmsProvider.id !== "pool") return { id: activeSmsProvider.id, config: activeSmsProvider.config };
    const summary = await apiFetch(token, "/api/sms-pool");
    if (!summary.enabled || !summary.available) throw new Error("接码池暂时无法取号，请稍后重试或选择自己的接码平台");
    const admin = auth.workspace.role === "admin";
    if (!admin && auth.workspace.balance < summary.fee) throw new Error(`接码池需要预留 ${summary.fee} 次，当前可用 ${auth.workspace.balance} 次`);
    return new Promise((resolve) => setSmsChargeQuote({ fee: summary.fee, count, admin, resolve }));
  }

  async function setupTotpSelected() {
    if (!canSetupTotpSelected || batchAction) return;
    const skipped = selectedJobIds.size - totpSetupSelectedCount;
    const message = `确定为选中的 ${totpSetupSelectedCount} 个账号设置 2FA 吗？${skipped ? `另有 ${skipped} 个账号不符合条件，将自动跳过。` : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("setup-2fa");
    try {
      const data = await apiFetch(token, "/api/jobs/setup-2fa-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], proxyUrl: accountProxyUrl.trim() }),
      });
      setUploadNotice(`已开始为 ${data.started} 个账号设置 2FA${data.skipped ? `，跳过 ${data.skipped} 个` : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function addPasswordSelected() {
    if (!canAddPasswordSelected || batchAction) return;
    const skipped = selectedJobIds.size - passwordAddSelectedCount;
    const message = `确定为选中的 ${passwordAddSelectedCount} 个无密码账号生成并添加随机强密码吗？${skipped ? `另有 ${skipped} 个账号已有密码或不符合条件，将自动跳过。` : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("add-password");
    try {
      const data = await apiFetch(token, "/api/jobs/add-password-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], proxyUrl: accountProxyUrl.trim() }),
      });
      setUploadNotice(`已开始为 ${data.started} 个账号添加密码${data.skipped ? `，跳过 ${data.skipped} 个` : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function forceReloginSelected() {
    if (!canForceReloginSelected || batchAction) return;
    const skipped = selectedJobIds.size - forceReloginSelectedCount;
    const message = `确定让选中的 ${forceReloginSelectedCount} 个账号跳过刷新令牌，重新登录并授权吗？${skipped ? `另有 ${skipped} 个进行中账号将自动跳过。` : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("relogin");
    try {
      const data = await apiFetch(token, "/api/jobs/relogin-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], proxyUrl: accountProxyUrl.trim() }),
      });
      setUploadNotice(`已开始重新登录并授权 ${data.started} 个账号${data.skipped ? `，跳过 ${data.skipped} 个` : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function exportSelectedSource() {
    if (!selectedJobIds.size || batchAction) return;
    setBatchAction("source");
    try {
      const response = await cdkFetch("/api/jobs/export-source", {
        method: "POST",
        headers: { "content-type": "application/json", "x-console-token": token },
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "原始信息导出失败");
      await saveDownloadResponse(response, `chatgpt-account-source-${selectedJobIds.size}-accounts-${localTimestamp()}.txt`);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function deleteSelected() {
    if (!selectedJobIds.size || batchAction) return;
    if (!window.confirm(`确定删除选中的 ${selectedJobIds.size} 条任务吗？对应的本地授权文件也会被删除。`)) return;
    setBatchAction("delete");
    try {
      await apiFetch(token, "/api/jobs/delete-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      setJobs((current) => current.filter((job) => !selectedJobIds.has(job.id)));
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function cancelAllRunningJobs() {
    const runningCount = (stats.active || 0) + (stats.queued || 0);
    if (!runningCount || batchAction) return;
    if (!window.confirm(`确定停止全部 ${runningCount} 条进行中和排队任务吗？`)) return;
    setBatchAction("cancel-all");
    try {
      await apiFetch(token, "/api/jobs/cancel-all", { method: "POST" });
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  return (
    <main className={`app-shell density-${density}`}>
      <aside className="app-sidebar">
        <div className="brand-block"><div className="brand-mark"><ShieldCheck size={21} /></div><h1>账号工作台</h1></div>
        <nav className="workspace-tabs" aria-label="工作区">
          <button type="button" className={activeWorkspace === "authorization" ? "active" : ""} aria-pressed={activeWorkspace === "authorization"} onClick={() => setActiveWorkspace("authorization")}><LogIn size={17} />账号授权</button>
          <button type="button" className={activeWorkspace === "mfa" ? "active" : ""} aria-pressed={activeWorkspace === "mfa"} onClick={() => setActiveWorkspace("mfa")}><ShieldCheck size={17} />MFA 修改</button>
          <button type="button" className={activeWorkspace === "rebind" ? "active" : ""} aria-pressed={activeWorkspace === "rebind"} onClick={() => setActiveWorkspace("rebind")}><MailCheck size={17} />邮箱换绑</button>
          <button type="button" className={activeWorkspace === "cdk-mine" ? "active" : ""} aria-pressed={activeWorkspace === "cdk-mine"} onClick={() => setActiveWorkspace("cdk-mine")}><KeyRound size={17} />我的 CDK</button>
          {adminView && auth.account.role === "admin" && <>
            <button type="button" className={activeWorkspace === "sms-pool" ? "active" : ""} aria-pressed={activeWorkspace === "sms-pool"} onClick={() => setActiveWorkspace("sms-pool")}><Globe2 size={17} />接码池</button>
            <button type="button" className={activeWorkspace === "cdk-management" ? "active" : ""} aria-pressed={activeWorkspace === "cdk-management"} onClick={() => setActiveWorkspace("cdk-management")}><KeyRound size={17} />CDK 管理</button>
            <button type="button" className={activeWorkspace === "cdk-security" ? "active" : ""} aria-pressed={activeWorkspace === "cdk-security"} onClick={() => setActiveWorkspace("cdk-security")}><ShieldCheck size={17} />安全中心</button>
          </>}
          <button type="button" className="sidebar-settings" onClick={() => setSettingsOpen(true)}><Settings2 size={17} />{auth.account.role === "admin" ? "系统配置" : "配置"}</button>
        </nav>
        <div className="sidebar-footer"><span>{auth.workspace.note || "当前 CDK 工作区"}</span><p>授权与 MFA 共用账号归属</p></div>
      </aside>
      <div className="workspace-content">
      <header className="topbar">
        <div className="workspace-path"><span>工作区</span><ChevronRight size={14} /><strong>{({ authorization: "账号授权", mfa: "MFA 修改", rebind: "邮箱换绑", "sms-pool": "接码池", "cdk-mine": "我的 CDK", "cdk-management": "CDK 管理", "cdk-security": "安全中心" })[activeWorkspace]}</strong></div>
        <div className="topbar-actions cdk-session-actions">
          <CurrentCdk auth={auth} onOpen={() => setActiveWorkspace("cdk-mine")} />
          {auth.account.role === "admin" && <button className="secondary-button" onClick={async () => {
            try {
              if (adminView) { setAdminView(false); setActiveWorkspace("authorization"); }
              else if (auth.workspace.id !== auth.account.id) await auth.switchWorkspace(auth.account.id);
              else { setAdminView(true); setActiveWorkspace("cdk-management"); }
            } catch (failure) { setError(failure.message); }
          }}>{adminView ? "切换用户视角" : "返回管理视角"}</button>}
          <ThemeControl /><button type="button" className="secondary-button" onClick={() => setSettingsOpen(true)}><Settings2 size={16} />{auth.account.role === "admin" ? "系统配置" : "配置"}</button>
          <button type="button" className="secondary-button" onClick={() => void auth.logout().catch((failure) => setError(failure.message))}>退出</button>
        </div>
      </header>
      {auth.workspace.id !== auth.account.id && <p className="cdk-scope-note">管理员正在查看 {auth.workspace.note || auth.workspace.label} 的工作区。此处操作和新增导入属于该 CDK。</p>}
      {activeWorkspace.startsWith("cdk-") && <CdkWorkspace auth={auth} section={activeWorkspace.slice(4)} onNavigate={(section) => setActiveWorkspace(`cdk-${section}`)} />}
      {activeWorkspace === "sms-pool" && auth.account.role === "admin" && <SmsPoolWorkspace token={token} />}
      {activeWorkspace === "rebind" && <EmailRebindWorkspace token={token} onOpenAuthorization={() => { setPhoneTab("disabled"); setFilters(DEFAULT_FILTERS); setPage(1); setSelectedJobIds(new Set()); setExpandedJobId(null); setEmailFilter([]); setActiveWorkspace("authorization"); }} />}
      {activeWorkspace === "mfa" && <MfaWorkspace token={token} defaultProxyUrl={accountProxyUrl} focusAccountId={mfaFocusAccountId} onReconnect={() => setConnectionAttempt((current) => current + 1)} onOpenAuthorization={() => {
        setPhoneTab("disabled"); setFilters(DEFAULT_FILTERS); setEmailFilter([]); setSelectedJobIds(new Set()); setExpandedJobId(null); setPage(1); setActiveWorkspace("authorization");
      }} />}
      {activeWorkspace === "authorization" && <>
      <section className="workspace">
        <div className="section-heading"><div><h2>账号授权</h2><p>查看任务进度、管理授权和账号额度</p></div><button type="button" className="primary-button" disabled={!token} onClick={() => setSingleOpen(true)}><Plus size={17} />新建任务</button></div>
        <TaskOverview today={loaded ? stats.today : null} total={loaded ? stats.total : null}
          onToday={() => updateFilters({ ...filters, dateField: "createdAt", preset: "today" })}
          onTotal={() => updateFilters({ ...filters, preset: "all" })}
          items={[
            { key: "running", label: "进行中", count: stats.running, tone: "running" },
            { key: "queued", label: "排队中", count: stats.queued, tone: "queued" },
            { key: "waiting", label: "待输入", count: stats.waiting, tone: "waiting" },
            { key: "completed", label: "已完成", count: stats.completed, tone: "complete" },
            { key: "failed", label: "失败", count: stats.failed, tone: "failed" },
          ].map((item) => ({ ...item, onClick: () => updateFilters({ ...filters, status: item.key }) }))} />
        <div className="task-mode-tabs" role="tablist" aria-label="按接码设置切换任务" onKeyDown={(event) => {
          const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')];
          const index = tabs.indexOf(document.activeElement);
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
          if (next !== null) { event.preventDefault(); tabs[next].focus(); tabs[next].click(); }
        }}>
          {[["all", "全部任务", stats.total], ["enabled", "接码任务", stats.phoneEnabled], ["disabled", "不接码任务", stats.phoneDisabled]].map(([key, label, count]) => <button key={key} id={`phone-tab-${key}`} type="button" role="tab" aria-selected={phoneTab === key} aria-controls="authorization-task-panel" tabIndex={phoneTab === key ? 0 : -1} onClick={() => { setPhoneTab(key); setPage(1); setSelectedJobIds(new Set()); setExpandedJobId(null); }}>
            {label}<span>{loaded && count !== undefined ? count : "—"}</span>
          </button>)}
        </div>
        <div id="authorization-task-panel" role="tabpanel" aria-labelledby={`phone-tab-${phoneTab}`}>
        <TaskFilters value={filters} onChange={updateFilters} statuses={AUTH_STATUSES} dateFields={{ createdAt: "创建时间", lastOperationAt: "最近操作时间" }} day={calendarDay}
          extra={<button className={`secondary-button ${emailFilter.length ? "filter-active" : ""}`} type="button" onClick={() => { setFilterError(""); setFilterText(emailFilter.join("\n")); setFilterOpen(true); }} disabled={!token}><Filter size={16} />{emailFilter.length ? `精确邮箱 ${emailFilter.length}` : "精确邮箱"}</button>} />
        <div className="config-summary"><Settings2 size={14} /><button type="button" onClick={() => setSettingsOpen(true)}>配置摘要</button><span>代理 · {accountProxyUrl.trim() ? "已配置" : "本地网络"}</span><span>短信 · {activeSmsProvider.ready ? activeSmsProvider.name : "未配置"}</span><span>邮件 · {mailRequestSettings.method}</span><span>Sub2API · {sub2apiSettings.adminApiKey ? "已配置" : "未配置"}</span>{sub2apiMonitorStatus.enabled && <span>号池巡检 · {sub2apiMonitorStatus.running ? "正在检查" : "已开启"}</span>}</div>

        {error && (
          <div className="global-error" role="alert">
            <CircleAlert size={17} />
            <span>{error}</span>
            <button type="button" className="error-retry" onClick={() => setConnectionAttempt((current) => current + 1)}><RefreshCw size={15} />重新读取</button>
            <button type="button" onClick={() => setError("")} title="关闭"><X size={16} /></button>
          </div>
        )}
        {exportReport && <ExportReport report={exportReport} onClose={() => setExportReport(null)} />}
        {uploadNotice && (
          <div className="global-success" role="status">
            <Check size={17} />
            <span>{uploadNotice}</span>
            <button type="button" onClick={() => setUploadNotice("")} title="关闭"><X size={16} /></button>
          </div>
        )}

        {features.bulkActions && selectedJobIds.size > 0 && (
          <div className="selection-toolbar">
            <div className="selection-summary">
              <span>当前页 {jobs.length} 条，跨页已选 {selectedJobIds.size} 条，可下载 {downloadableSelectedCount} 条</span>
              <button type="button" className="selection-text-button" onClick={toggleAllOnPage} disabled={allPageSelected || !pageJobIds.length}>
                本页全选
              </button>
              <button type="button" className="selection-text-button" onClick={() => setSelectedJobIds(new Set())} disabled={!selectedJobIds.size}>
                清除选择
              </button>
            </div>
            <div className="bulk-actions">
              {features.batchPhoneBinding && phoneTab !== "enabled" && (
                <button type="button" className="primary-button bulk-button" onClick={startPhoneSelected}
                  disabled={!canStartPhoneSelected || !activeSmsProvider.ready || Boolean(batchAction)}
                  title={activeSmsProvider.ready ? `使用 ${activeSmsProvider.name} 为选中的可接码任务开始接码` : "请先完成接码平台配置"}>
                  {batchAction === "start-phone" ? <LoaderCircle className="spin" size={16} /> : <PhoneIncoming size={16} />}
                  批量接码（{phoneBindingSelectedCount}）
                </button>
              )}
              {features.cancelAll && (
                <button
                  type="button"
                  className="stop-all-button"
                  onClick={cancelAllRunningJobs}
                  disabled={!(stats.active || stats.queued) || Boolean(batchAction)}
                >
                  {batchAction === "cancel-all" ? <LoaderCircle className="spin" size={16} /> : <Ban size={16} />}
                  停止全部
                </button>
              )}
              <button type="button" className="download-button" onClick={downloadSelected} disabled={!canDownloadSelected || Boolean(batchAction)}>
                {batchAction === "download" ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
                批量下载
              </button>
              {features.sub2apiUpload && (
                <button type="button" className="secondary-button bulk-button" onClick={() => uploadSelected([...selectedJobIds])} disabled={!canUploadSelected || Boolean(batchAction)}>
                  {batchAction === "upload" ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
                  上传到 Sub2API
                </button>
              )}
              <MoreActions label="更多">
              {features.sourceExport && (
                <button type="button" className="secondary-button bulk-button" onClick={exportSelectedSource} disabled={!selectedJobIds.size || Boolean(batchAction)}>
                  {batchAction === "source" ? <LoaderCircle className="spin" size={16} /> : <FileText size={16} />}
                  导出原始信息
                </button>
              )}
              <button type="button" className="regenerate-button bulk-button" onClick={reauthorizeSelected} disabled={!canReauthorizeSelected || Boolean(batchAction)}>
                {batchAction === "reauthorize" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                批量重新授权
              </button>
              {features.forceRelogin && (
                <button type="button" className="relogin-button bulk-button" onClick={forceReloginSelected} disabled={!canForceReloginSelected || Boolean(batchAction)}>
                  {batchAction === "relogin" ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}
                  批量重新登录并授权
                </button>
              )}
              {features.totpSetup && (
                <button type="button" className="secondary-button bulk-button" onClick={setupTotpSelected} disabled={!canSetupTotpSelected || Boolean(batchAction)}>
                  {batchAction === "setup-2fa" ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
                  批量设置 2FA
                </button>
              )}
              {features.passwordAdd && (
                <button type="button" className="secondary-button bulk-button" onClick={addPasswordSelected} disabled={!canAddPasswordSelected || Boolean(batchAction)}>
                  {batchAction === "add-password" ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
                  批量添加密码
                </button>
              )}
              <button type="button" className="delete-button" onClick={deleteSelected} disabled={!selectedJobIds.size || Boolean(batchAction)}>
                {batchAction === "delete" ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
                批量删除
              </button>
              </MoreActions>
            </div>
          </div>
        )}

        <div className="table-frame task-list-panel">
          <div className="list-heading"><strong>任务列表</strong><span aria-live="polite">匹配 {pagination.total} 条{emailFilter.length ? ` · 精确邮箱 ${emailFilter.length} 个` : ""}</span><div>{features.cancelAll && <button type="button" className="selection-text-button" onClick={cancelAllRunningJobs} disabled={!(stats.active || stats.queued) || Boolean(batchAction)} title="停止所有运行和排队任务，不受当前筛选影响"><Ban size={14} />停止全部</button>}<button type="button" className="selection-text-button" onClick={clearFilters} disabled={!hasFilters(filters) && !emailFilter.length}>清除筛选</button></div></div>
          <table className="authorization-table"><thead><tr>
            <th className="select-heading"><input type="checkbox" checked={allPageSelected} onChange={toggleAllOnPage} disabled={!features.bulkActions || !pageJobIds.length} aria-label="选择当前页全部任务" /></th>
            <th>账号</th><th>状态与进度</th><th>额度与订阅</th><th>接码与费用</th><th>时间</th><th className="actions-heading">操作</th>
          </tr></thead><tbody>
            {!jobs.length && <EmptyState filtered={hasFilters(filters) || emailFilter.length > 0} loaded={loaded} onCreate={() => setSingleOpen(true)} onClear={clearFilters} />}
            {jobs.map((job) => <JobRow key={job.id}
                    job={job}
                    token={token}
                    expanded={expandedJobId === job.id}
                    onToggleLogs={() => setExpandedJobId((current) => current === job.id ? null : job.id)}
                    onError={setError}
                    onPreviewExport={previewExport}
                    onDownloadNotice={setUploadNotice}
                    onMfaStarted={showStartedMfa}
                    mfaChangeAvailable={Boolean(features.mfaChange)}
                    selected={selectedJobIds.has(job.id)}
                    onToggleSelected={() => toggleJobSelection(job.id)}
                    selectionSupported={Boolean(features.bulkActions)}
                    smsProviderAvailable={smsProviderDefinitions.length > 0}
                    smsProvider={activeSmsProvider}
                    prepareSmsProvider={prepareSmsProvider}
                    onUpload={() => uploadSelected([job.id])}
                    sub2apiUploadAvailable={Boolean(features.sub2apiUpload && sub2apiSettings.baseUrl && sub2apiSettings.adminApiKey)}
                    totpSetupAvailable={Boolean(features.totpSetup)}
                    passwordAddAvailable={Boolean(features.passwordAdd)}
                    forceReloginAvailable={Boolean(features.forceRelogin)}
                    accountProxyUrl={accountProxyUrl}
            />)}
          </tbody></table>
          <nav className="pagination" aria-label="任务分页"><span>共 {pagination.total} 条 · 每页 {pagination.pageSize} 条</span><div><button type="button" className="icon-button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1} aria-label="上一页"><ChevronLeft size={17} /></button><span>{pagination.page} / {pagination.totalPages}</span><button type="button" className="icon-button" onClick={() => setPage((current) => Math.min(pagination.totalPages, current + 1))} disabled={page >= pagination.totalPages} aria-label="下一页"><ChevronRight size={17} /></button></div></nav>
        </div>
        {expandedJobId && jobs.find((job) => job.id === expandedJobId) && <Drawer title="任务详情" onClose={() => setExpandedJobId(null)} wide>
          {(() => { const job = jobs.find((item) => item.id === expandedJobId); return <JobRow key={job.id} detail
                    job={job}
                    token={token}
                    expanded={expandedJobId === job.id}
                    onToggleLogs={() => setExpandedJobId((current) => current === job.id ? null : job.id)}
                    onError={setError}
                    onPreviewExport={previewExport}
                    onDownloadNotice={setUploadNotice}
                    onMfaStarted={showStartedMfa}
                    mfaChangeAvailable={Boolean(features.mfaChange)}
                    selected={selectedJobIds.has(job.id)}
                    onToggleSelected={() => toggleJobSelection(job.id)}
                    selectionSupported={Boolean(features.bulkActions)}
                    smsProviderAvailable={smsProviderDefinitions.length > 0}
                    smsProvider={activeSmsProvider}
                    prepareSmsProvider={prepareSmsProvider}
                    onUpload={() => uploadSelected([job.id])}
                    sub2apiUploadAvailable={Boolean(features.sub2apiUpload && sub2apiSettings.baseUrl && sub2apiSettings.adminApiKey)}
                    totpSetupAvailable={Boolean(features.totpSetup)}
                    passwordAddAvailable={Boolean(features.passwordAdd)}
                    forceReloginAvailable={Boolean(features.forceRelogin)}
                    accountProxyUrl={accountProxyUrl}
          />; })()}
        </Drawer>}
        {singleOpen && <Drawer title="新建授权任务" onClose={() => setSingleOpen(false)}><div className="creation-switch"><strong>单个添加</strong><button type="button" className="text-action" onClick={() => { setSingleOpen(false); setBatchError(""); setBatchOpen(true); }}><ListPlus size={16} />批量导入</button></div><form className="add-form" onSubmit={createJob}><label className="creation-email"><span>邮箱地址</span><div className="email-field"><Mail size={17} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" autoComplete="email" required /></div></label><PhoneBindingOption enabled={phoneBindingEnabled} onChange={setPhoneBindingEnabled} disabled={busy} />{error && <p className="dialog-error" role="alert">{error}</p>}<button className="primary-button" type="submit" disabled={!token || busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}添加任务</button></form></Drawer>}
        </div>
      </section>
      </>}
      {smsChargeQuote && <SmsPoolChargeDialog quote={smsChargeQuote} onClose={(value) => { const resolve = smsChargeQuote.resolve; setSmsChargeQuote(null); resolve(value); }} />}
      {smsSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSmsSettingsOpen(false);
        }}>
          <form className="batch-dialog sms-settings-dialog" onSubmit={saveSmsSettings} role="dialog" aria-modal="true" aria-labelledby="sms-settings-title">
            <div className="dialog-header">
              <div>
                <h2 id="sms-settings-title">接码平台配置</h2>
                <span>配置保存在当前 CDK 的工作区</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setSmsSettingsOpen(false)} title="关闭">
                <X size={18} />
              </button>
            </div>

            <div className="provider-tabs" role="tablist" aria-label="选择接码平台">
              {smsProviderDefinitions.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  role="tab"
                  aria-selected={draftSmsProvider.id === provider.id}
                  className={draftSmsProvider.id === provider.id ? "active" : ""}
                  onClick={() => {
                    setSmsSettingsDraft((current) => withSmsProviderDefaults(smsProviderDefinitions, {
                      ...current,
                      selectedProviderId: provider.id,
                    }));
                    setSmsSettingsError("");
                  }}
                >
                  {provider.name}
                </button>
              ))}
            </div>

            {draftSmsProvider.id === "pool" && <SmsPoolChoice token={token} onManage={auth.account.role === "admin" ? () => { setSmsSettingsOpen(false); setActiveWorkspace("sms-pool"); } : undefined} />}
            {draftSmsProvider.definition && draftSmsProvider.id !== "pool" && (
              <div className="provider-config-section">
                <div className="provider-description-row">
                  <div className="provider-description">{draftSmsProvider.definition.description}</div>
                  {SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id] && (
                    <a
                      className="provider-external-link"
                      href={SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id].href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={13} aria-hidden="true" />
                      {SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id].label}
                    </a>
                  )}
                </div>
                <div className="provider-config-grid">
                  {draftSmsProvider.definition.fields.filter((field) => field.type !== "hidden").map((field) => field.type === "price-select" ? (
                    <SmsPriceSelector key={`${draftSmsProvider.id}-${field.key}`} provider={draftSmsProvider} options={smsNumberOptions} loading={smsOptionsLoading}
                      onGradeChange={changeSmsGrade}
                      onRefresh={() => loadSmsNumberOptions()} countryName={formatSmsCountryName} onSelect={(selected) => updateSmsProviderConfig(draftSmsProvider.id, {
                        country: selected.country, maxPrice: String(selected.price), quotedPrice: String(selected.price), providerIds: selected.providerIds || "", countryLabel: formatSmsCountryName(selected),
                      })} />
                  ) : (
                    <label key={field.key} className={`settings-field ${field.type === "textarea" ? "wide-settings-field" : ""}`}>
                      <span>{field.label}</span>
                      {field.type === "textarea" ? (
                        <textarea
                          className="settings-textarea"
                          value={draftSmsProvider.config[field.key] || ""}
                          onChange={(event) => updateSmsProviderConfig(draftSmsProvider.id, { [field.key]: event.target.value })}
                          placeholder={field.placeholder}
                          rows="8"
                          autoComplete="off"
                          spellCheck="false"
                        />
                      ) : (
                        <div>
                          {field.type === "password" ? <KeyRound size={15} /> : <Settings2 size={15} />}
                          <input
                            type={field.type || "text"}
                            min={field.min}
                            max={field.max}
                            step={field.step}
                            value={draftSmsProvider.config[field.key] || ""}
                            onChange={(event) => updateSmsProviderConfig(draftSmsProvider.id, { [field.key]: event.target.value })}
                            placeholder={field.placeholder}
                            autoComplete="off"
                            spellCheck="false"
                          />
                        </div>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {smsSettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{smsSettingsError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setSmsSettingsOpen(false)}>取消</button>
              <button type="submit" className="primary-button" disabled={!draftSmsProvider.definition}>
                <Check size={17} />保存配置
              </button>
            </div>
          </form>
        </div>
      )}
      {mailRequestSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !mailRequestSettingsSaving) setMailRequestSettingsOpen(false);
        }}>
          <form className="batch-dialog mail-request-settings-dialog" onSubmit={saveMailRequestSettings} role="dialog" aria-modal="true" aria-labelledby="mail-request-settings-title">
            <div className="dialog-header">
              <div>
                <h2 id="mail-request-settings-title">邮件 API 请求配置</h2>
                <span>配置保存在当前浏览器，请求内容不会写入任务日志</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setMailRequestSettingsOpen(false)} disabled={mailRequestSettingsSaving} title="关闭">
                <X size={18} />
              </button>
            </div>

            <div className="provider-tabs mail-method-tabs" role="tablist" aria-label="邮件 API 请求方式">
              {["GET", "POST"].map((method) => (
                <button
                  key={method}
                  type="button"
                  role="tab"
                  aria-selected={mailRequestSettingsDraft.method === method}
                  className={mailRequestSettingsDraft.method === method ? "active" : ""}
                  onClick={() => setMailRequestSettingsDraft((current) => ({ ...current, method }))}
                >
                  {method}
                </button>
              ))}
            </div>

            <div className="provider-config-grid mail-request-config-grid">
              {mailRequestSettingsDraft.method === "POST" && (
                <label className="settings-field wide-settings-field">
                  <span className="mail-request-url-label">
                    统一 POST 请求 URL
                    <small>必填</small>
                  </span>
                  <input
                    className="mail-request-url-input"
                    type="url"
                    value={mailRequestSettingsDraft.url}
                    onChange={(event) => setMailRequestSettingsDraft((current) => ({ ...current, url: event.target.value }))}
                    placeholder="https://mail.example/api/messages"
                    autoComplete="off"
                    spellCheck="false"
                  />
                  <small>每个账号自己的请求体请在批量添加账号时一并导入</small>
                </label>
              )}
              <label className="settings-field wide-settings-field">
                <span>请求头 JSON</span>
                <textarea
                  className="settings-textarea"
                  value={mailRequestSettingsDraft.headersText}
                  onChange={(event) => setMailRequestSettingsDraft((current) => ({ ...current, headersText: event.target.value }))}
                  placeholder={'{"Authorization":"Bearer ...","Referer":"https://mail.example/"}'}
                  rows="7"
                  autoComplete="off"
                  spellCheck="false"
                />
              </label>
            </div>

            {mailRequestSettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{mailRequestSettingsError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setMailRequestSettingsOpen(false)} disabled={mailRequestSettingsSaving}>取消</button>
              <button type="submit" className="primary-button" disabled={mailRequestSettingsSaving || !token}>
                {mailRequestSettingsSaving ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
                保存配置
              </button>
            </div>
          </form>
        </div>
      )}
      {sub2apiSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSub2apiSettingsOpen(false);
        }}>
          <form className="batch-dialog sub2api-settings-dialog" onSubmit={saveSub2ApiSettings} role="dialog" aria-modal="true" aria-labelledby="sub2api-settings-title">
            <div className="dialog-header">
              <div>
                <h2 id="sub2api-settings-title">Sub2API 配置</h2>
                <span>管理员 Key 不写入任务文件或日志；启用监控后由本机服务保存</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setSub2apiSettingsOpen(false)} title="关闭"><X size={18} /></button>
            </div>
            <div className="provider-config-grid sub2api-config-grid">
              <label className="settings-field wide-settings-field">
                <span>Sub2API 后端地址</span>
                <input
                  type="url"
                  value={sub2apiSettingsDraft.baseUrl}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                  placeholder="例如 http://127.0.0.1:8080"
                  autoComplete="url"
                />
              </label>
              {features.sub2apiMonitor && (
                <label className="settings-field wide-settings-field sub2api-monitor-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(sub2apiSettingsDraft.monitorEnabled)}
                    onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, monitorEnabled: event.target.checked }))}
                  />
                  <span>
                    <strong>每 5 分钟监控异常账号</strong>
                    <small>只自动处理上次完整登录未人工输入密码、邮箱码或登录 2FA 的任务</small>
                  </span>
                </label>
              )}
              <label className="settings-field wide-settings-field">
                <span>管理员 API Key</span>
                <input
                  type="password"
                  value={sub2apiSettingsDraft.adminApiKey}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, adminApiKey: event.target.value }))}
                  placeholder="输入 sub2api 管理员 API Key"
                  autoComplete="off"
                />
              </label>
              <fieldset className="settings-field wide-settings-field sub2api-group-field">
                <legend>目标号池（可多选）</legend>
                <section className="sub2api-group-picker" aria-label="目标号池">
                  {sub2apiGroups.length ? sub2apiGroups.map((group) => {
                    const groupId = String(group.id);
                    return (
                      <label key={group.id} className="sub2api-group-option">
                        <input
                          type="checkbox"
                          checked={sub2apiSettingsDraft.groupIds.includes(groupId)}
                          onChange={(event) => setSub2ApiGroupChecked(groupId, event.target.checked)}
                        />
                        <span>{group.name}</span>
                        <small>ID: {group.id}</small>
                      </label>
                    );
                  }) : <div className="sub2api-group-empty">暂无可选号池</div>}
                </section>
                <section className="sub2api-group-selection" aria-label="号池选择操作">
                  <span>已选 {sub2apiSettingsDraft.groupIds.length} 个</span>
                  <button
                    type="button"
                    onClick={() => setSub2apiSettingsDraft((current) => ({ ...current, groupIds: sub2apiGroups.map((group) => String(group.id)) }))}
                    disabled={!sub2apiGroups.length || sub2apiGroups.every((group) => sub2apiSettingsDraft.groupIds.includes(String(group.id)))}
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    onClick={() => setSub2apiSettingsDraft((current) => ({ ...current, groupIds: [] }))}
                    disabled={!sub2apiSettingsDraft.groupIds.length}
                  >
                    清空
                  </button>
                </section>
              </fieldset>
              <label className="settings-field wide-settings-field">
                <span>代理 IP</span>
                <select
                  value={sub2apiSettingsDraft.proxyId}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, proxyId: event.target.value }))}
                >
                  <option value="">使用账号原配置</option>
                  {sub2apiProxies.map((proxy) => <option key={proxy.id} value={String(proxy.id)}>{formatSub2ApiProxy(proxy)}</option>)}
                </select>
              </label>
              <label className="settings-field wide-settings-field">
                <span>Codex 指纹收敛</span>
                <select
                  value={sub2apiSettingsDraft.codexFingerprintMode}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, codexFingerprintMode: event.target.value }))}
                >
                  <option value="off">关闭（默认）</option>
                  <option value="device">仅设备</option>
                  <option value="session">设备+会话</option>
                  <option value="full">完全收敛</option>
                </select>
              </label>
              <label className="settings-field">
                <span>并发数</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  value={sub2apiSettingsDraft.concurrency}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, concurrency: event.target.value }))}
                  placeholder="留空使用账号原值"
                />
              </label>
              <label className="settings-field">
                <span>负载因子</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  value={sub2apiSettingsDraft.loadFactor}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, loadFactor: event.target.value }))}
                  placeholder="留空使用账号原值"
                />
              </label>
              <label className="settings-field">
                <span>优先级</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  value={sub2apiSettingsDraft.priority}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, priority: event.target.value }))}
                  placeholder="留空使用账号原值"
                />
              </label>
              <label className="settings-field wide-settings-field">
                <span>允许使用的模型</span>
                <textarea
                  className="sub2api-model-textarea"
                  value={sub2apiSettingsDraft.modelWhitelist}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, modelWhitelist: event.target.value }))}
                  placeholder={"每行一个模型，也支持逗号分隔，例如：\ngpt-5\ngpt-5-mini\ngpt-4.1"}
                  rows="5"
                  spellCheck="false"
                />
              </label>
            </div>
            <div className="dialog-hint">分组为空时，上传使用 Sub2API 默认号池，监控检查全部 OpenAI 账号；选择分组后只监控这些号池。Codex 指纹收敛会写入每个上传或巡检更新的 OpenAI OAuth 账号。</div>
            {features.sub2apiMonitor && sub2apiMonitorStatus.configured && (
              <div className={`sub2api-monitor-status ${sub2apiMonitorStatus.lastError ? "error" : ""}`}>
                <ShieldCheck size={15} />
                <span>{sub2apiMonitorStatus.lastError
                  ? `上次巡检失败：${sub2apiMonitorStatus.lastError}`
                  : sub2apiMonitorStatus.lastCheckAt
                    ? formatMonitorResult(sub2apiMonitorStatus.lastResult)
                    : "尚未执行号池巡检"}</span>
              </div>
            )}
            {sub2apiSettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{sub2apiSettingsError}</div>}
            <div className="dialog-actions sub2api-dialog-actions">
              <button type="button" className="secondary-button" onClick={() => loadSub2ApiOptions()} disabled={sub2apiGroupsLoading || !token}>
                {sub2apiGroupsLoading ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}读取配置
              </button>
              {features.sub2apiMonitor && sub2apiMonitorStatus.enabled && (
                <button type="button" className="secondary-button" onClick={checkSub2ApiMonitorNow} disabled={sub2apiMonitorChecking || sub2apiMonitorStatus.running}>
                  {sub2apiMonitorChecking || sub2apiMonitorStatus.running ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}立即检查
                </button>
              )}
              <span className="dialog-actions-spacer" />
              <button type="button" className="cancel-button" onClick={() => setSub2apiSettingsOpen(false)} disabled={sub2apiSettingsSaving}>取消</button>
              <button type="submit" className="primary-button" disabled={sub2apiSettingsSaving}>
                {sub2apiSettingsSaving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存配置
              </button>
            </div>
          </form>
        </div>
      )}
      {activeWorkspace === "authorization" && <>
      {batchOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !batchBusy) setBatchOpen(false);
        }}>
          <form className="batch-dialog" onSubmit={createBatch} role="dialog" aria-modal="true" aria-labelledby="batch-title">
            <div className="dialog-header">
              <div>
                <h2 id="batch-title">批量添加账号</h2>
                <span>{countBatchLines(batchText)} 条，超出并发上限后自动排队</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setBatchOpen(false)} disabled={batchBusy} title="关闭">
                <X size={18} />
              </button>
            </div>
            <label className="batch-label" htmlFor="batch-input">
              {mailRequestSettings.method === "POST"
                ? "每行：邮箱----编码请求体，或 邮箱----密码----编码请求体；邮箱及可识别字段顺序不限"
                : "每行一个账号：自动识别邮箱、密码、邮件 API 和 2FA，字段顺序不限"}
            </label>
            <textarea
              id="batch-input"
              value={batchText}
              onChange={(event) => setBatchText(event.target.value)}
              placeholder={mailRequestSettings.method === "POST"
                ? "a@example.com----eyJtYWlsYm94X2lkIjoiaWQtYSJ9\nb@example.com----账号密码----mailbox_id%3Did-b"
                : "name@icloud.com----https://mail.example/messages/name\nhttps://mail.example/messages/name2|账号密码|name2@example.co.uk|BASE32二步验证密钥\nBASE32二步验证密钥::name3@example.dev::账号密码"}
              spellCheck="false"
              autoFocus
            />
            <PhoneBindingOption enabled={phoneBindingEnabled} onChange={setPhoneBindingEnabled} disabled={batchBusy} />
            {batchError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{batchError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setBatchOpen(false)} disabled={batchBusy}>取消</button>
              <button type="submit" className="primary-button" disabled={!batchText.trim() || batchBusy || countBatchLines(batchText) > 500}>
                {batchBusy ? <LoaderCircle className="spin" size={17} /> : <ListPlus size={17} />}
                创建 {countBatchLines(batchText) || ""} 条任务
              </button>
            </div>
          </form>
        </div>
      )}
      {filterOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setFilterOpen(false);
        }}>
          <form className="batch-dialog filter-dialog" onSubmit={applyEmailFilter} role="dialog" aria-modal="true" aria-labelledby="filter-title">
            <div className="dialog-header">
              <div>
                <h2 id="filter-title">筛选账号</h2>
                <span>{countBatchLines(filterText)} 个邮箱</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setFilterOpen(false)} title="关闭">
                <X size={18} />
              </button>
            </div>
            <label className="batch-label" htmlFor="filter-input">每行输入邮箱，或账号----密码----2fa</label>
            <textarea
              id="filter-input"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              placeholder={"name1@icloud.com----密码----2fa\nname2@icloud.com"}
              spellCheck="false"
              aria-describedby="filter-hint"
              autoFocus
            />
            <div id="filter-hint" className="dialog-hint">自动提取每行的邮箱并去重，支持与纯邮箱混合粘贴。</div>
            {filterError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{filterError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setFilterOpen(false)}>取消</button>
              <button type="submit" className="primary-button" disabled={!filterText.trim() || countBatchLines(filterText) > 500}>
                <Filter size={17} />应用筛选
              </button>
            </div>
          </form>
        </div>
      )}
      </>}
      {settingsOpen && <Drawer title={auth.account.role === "admin" ? "系统配置" : "工作区配置"} onClose={() => setSettingsOpen(false)} wide><p className="drawer-description">配置当前 CDK 的代理、接码平台、邮件 API 和 Sub2API。配置加密保存在服务端，切换 CDK 后分别加载。</p>
        <div className="provider-toolbar sms-provider-toolbar" aria-label="接码平台配置">
          <div className="provider-heading"><PhoneIncoming size={17} /><strong>接码平台</strong></div>
          <span className="provider-name">{activeSmsProvider.name || "未选择"}</span>
          <span className={`provider-ready ${activeSmsProvider.ready ? "" : "incomplete"}`}>
            {activeSmsProvider.ready ? <Check size={14} /> : <CircleAlert size={14} />}
            {activeSmsProvider.ready
              ? (activeSmsProvider.summary ? `已配置 · ${activeSmsProvider.summary}` : "已配置")
              : "未完成配置"}
          </span>
          <button type="button" className="secondary-button provider-settings-button" onClick={() => { setSettingsOpen(false); openSmsSettings(); }} disabled={!smsProviderDefinitions.length}>
            <Settings2 size={16} />配置
          </button>
        </div>

        <div className="provider-toolbar mail-request-toolbar" aria-label="邮件接码请求配置">
          <div className="provider-heading"><MailCheck size={17} /><strong>邮件 API</strong></div>
          <span className="provider-name">{mailRequestSettings.method}</span>
          <span className="provider-ready">
            <Check size={14} />
            {formatMailRequestSummary(mailRequestSettings)}
          </span>
          <button type="button" className="secondary-button provider-settings-button" onClick={() => { setSettingsOpen(false); openMailRequestSettings(); }} disabled={!token}>
            <Settings2 size={16} />配置
          </button>
        </div>

        <div className="provider-toolbar sub2api-toolbar" aria-label="Sub2API 配置与号池监控">
          <div className="provider-heading"><Send size={17} /><strong>Sub2API</strong></div>
          <span className="provider-name">{sub2apiSettings.baseUrl || "未配置后端"}</span>
          <span className={`provider-ready ${sub2apiSettings.adminApiKey ? "" : "incomplete"}`}>
            {sub2apiSettings.adminApiKey ? <Check size={14} /> : <CircleAlert size={14} />}
            {sub2apiSettings.adminApiKey
              ? `${sub2apiSettings.groupIds.length ? `已配置 · ${sub2apiSettings.groupIds.length} 个号池` : "已配置 · 默认号池"}${sub2apiSettings.proxyId ? " · 已指定代理" : ""}`
              : "未完成配置"}
          </span>
          {features.sub2apiMonitor && (
            <span className={`provider-ready monitor-ready ${sub2apiMonitorStatus.enabled ? "" : "incomplete"}`}>
              {sub2apiMonitorStatus.running
                ? <LoaderCircle className="spin" size={14} />
                : sub2apiMonitorStatus.enabled ? <ShieldCheck size={14} /> : <CircleAlert size={14} />}
              {sub2apiMonitorStatus.running
                ? "正在巡检"
                : sub2apiMonitorStatus.enabled
                  ? `号池监控已启用${sub2apiMonitorStatus.lastCheckAt ? ` · ${formatRelativeMonitorTime(sub2apiMonitorStatus.lastCheckAt)}` : ""}`
                  : "号池监控未启用"}
            </span>
          )}
          {features.sub2apiMonitor && sub2apiMonitorStatus.enabled && (
            <button
              type="button"
              className="icon-button monitor-check-button"
              onClick={checkSub2ApiMonitorNow}
              disabled={sub2apiMonitorChecking || sub2apiMonitorStatus.running}
              title="立即检查 Sub2API 异常账号"
            >
              <RefreshCw className={sub2apiMonitorChecking || sub2apiMonitorStatus.running ? "spin" : ""} size={16} />
            </button>
          )}
          <button type="button" className="secondary-button provider-settings-button" onClick={() => { setSettingsOpen(false); openSub2ApiSettings(); }} disabled={!token}>
            <Settings2 size={16} />配置
          </button>
          <button type="button" className="secondary-button" disabled={!sub2apiSettings.adminApiKey} onClick={() => { setSettingsOpen(false); setRemoteBindingError(""); setRemoteBindingOpen(true); }}>关联已有远端账号</button>
        </div>

        <div className="provider-toolbar account-proxy-toolbar" aria-label="代理 IP 配置">
          <div className="provider-heading"><Globe2 size={17} /><strong>代理 IP</strong></div>
          <div className="account-proxy-input">
            <label className="provider-field account-proxy-field" title="支持 http://、https://、socks5:// 和 socks5h://；用户名中包含 -sid- 时会自动轮换会话编号">
              <Globe2 size={15} aria-hidden="true" />
              <input
                value={accountProxyUrl}
                onChange={(event) => setAccountProxyUrl(event.target.value)}
                placeholder="socks5h://用户名:密码@主机:端口"
                spellCheck="false"
                aria-label="代理 IP 地址"
              />
            </label>
          </div>
          <span className={`provider-ready ${accountProxyUrl.trim() ? "" : "incomplete"}`}>
            {accountProxyUrl.trim() ? <Check size={14} /> : <CircleAlert size={14} />}
            {accountProxyUrl.trim() ? "已配置，按账号检测出口" : "未配置，使用本地 IP"}
          </span>
          <a
            className="provider-external-link"
            href="https://invite.zooproxy.com/share/ez2v2jdb7"
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={13} aria-hidden="true" />
            点击获取代理 IP
          </a>
        </div>

      </Drawer>}
      {remoteBindingOpen && <Drawer title="关联 Sub2API 远端账号" onClose={() => { if (!remoteBindingBusy) setRemoteBindingOpen(false); }}><p className="drawer-description">仅关联当前 CDK 下同邮箱的账号，供自动修复使用。先保存本 CDK 的 Sub2API 配置。</p><form onSubmit={async (event) => {
        event.preventDefault(); const values = new FormData(event.currentTarget); setRemoteBindingBusy(true); setRemoteBindingError("");
        try { await flushWorkspaceSettings(); await apiFetch(token, "/api/sub2api/bind", { method: "POST", body: JSON.stringify({ email: values.get("email"), remoteId: Number(values.get("remoteId")) }) }); setRemoteBindingOpen(false); }
        catch (failure) { setRemoteBindingError(failure.message); } finally { setRemoteBindingBusy(false); }
      }}><label className="cdk-field">本地账号邮箱<input name="email" type="email" required /></label><label className="cdk-field">远端账号 ID<input name="remoteId" type="number" min="1" required /></label>{remoteBindingError && <p className="cdk-error" role="alert">{remoteBindingError}</p>}<button className="primary-button" disabled={remoteBindingBusy}>{remoteBindingBusy ? "正在核对" : "核对并关联"}</button></form></Drawer>}
      </div>
    </main>
  );
}

function EmptyState({ filtered = false, loaded, onCreate, onClear }) {
  return <tr><td colSpan="7"><div className="empty-state"><div><Mail size={24} /></div><h3>{!loaded ? "正在读取任务" : filtered ? "没有匹配的任务" : "暂无授权任务"}</h3><p>{filtered ? "调整邮箱、状态或日期范围。" : "添加一个账号或批量导入，开始第一条任务。"}</p>{loaded && <button type="button" className="secondary-button" onClick={filtered ? onClear : onCreate}>{filtered ? "清除筛选" : "新建任务"}</button>}</div></td></tr>;
}

function InsightError({ item }) {
  return <span className="insight-error" title={item?.message || "接口未提供该字段"}>{item?.message || "未知"}</span>;
}

function formatInsightDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

function quotaWindowLabel(window) {
  const seconds = window.windowSeconds;
  if (!seconds) return window.key === "primary" ? "主窗口" : "次窗口";
  if (seconds === 604800) return "周额度";
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  return `${Math.round(seconds / 60)} 分钟`;
}

function QuotaInfo({ insights }) {
  if (!insights) return <span className="insight-note">未检测</span>;
  const quota = insights.quota;
  if (quota?.status !== "ok") return <InsightError item={quota} />;
  const windows = quota.windows || [];
  const weeklyOnly = windows.some((window) => window.windowSeconds === 604800)
    && !windows.some((window) => window.windowSeconds === 18000);
  const visibleWindows = weeklyOnly ? windows.filter((window) => window.windowSeconds === 604800) : windows;
  return <div className="quota-info">
    <span className={`quota-plan ${quota.limitReached || quota.allowed === false ? "exhausted" : ""}`}>
      {quota.planType || "额度"}{quota.limitReached || quota.allowed === false ? " · 暂不可用" : ""}
    </span>
    {(quota.stale || quota.error) && <span className="insight-note">上次成功结果 · 本次检测失败</span>}
    {visibleWindows.map((window) => <div className="quota-window" key={window.key}>
      <div className="quota-window-label"><span>{quotaWindowLabel(window)}</span><strong>剩余 {Number(window.remainingPercent.toFixed(1))}%</strong></div>
      <div className="quota-track" role="progressbar" aria-label={`${quotaWindowLabel(window)}剩余额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remainingPercent}>
        <span className={window.remainingPercent <= 10 ? "low" : ""} style={{ width: `${window.remainingPercent}%` }} />
      </div>
      {window.resetAt && <span className="insight-note">重置 {formatInsightDate(window.resetAt)}</span>}
    </div>)}
    {!visibleWindows.length && <span className="insight-note">接口未提供窗口额度</span>}
    {quota.credits?.unlimited ? <span className="insight-note">点数不限量</span>
      : quota.credits?.balance != null && <span className="insight-note">点数余额 {quota.credits.balance}</span>}
  </div>;
}

function SubscriptionInfo({ insights }) {
  if (!insights) return <span className="insight-note">未检测</span>;
  const subscription = insights.subscription;
  if (subscription?.status !== "ok") return <InsightError item={subscription} />;
  if (["free", "basic", "xbasic"].includes(subscription.planType)) return <span className="insight-note">免费套餐</span>;
  const expiresAt = Date.parse(subscription.expiresAt);
  if (!Number.isFinite(expiresAt)) return <span className="insight-note">{subscription.planType || "未知"} 套餐 · 到期时间未知</span>;
  const remainingDays = Number.isFinite(expiresAt) ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000)) : null;
  return <div className="subscription-info">
    <time dateTime={subscription.expiresAt}>{formatInsightDate(subscription.expiresAt)}</time>
    <span className="insight-note">{subscription.planType} · {remainingDays !== null && `剩余${remainingDays}天 · `}{remainingDays === 0 ? "已到期" : subscription.willRenew === true ? "自动续订" : subscription.willRenew === false ? "到期不续订" : "续订状态未知"}</span>
    {(subscription.stale || subscription.error) && <span className="insight-note">上次成功结果</span>}
  </div>;
}

function SmsSummary({ summary, billing }) {
  if (billing) {
    const completed = billing.state === "verified";
    const released = billing.state === "released";
    const unknown = billing.state === "unknown";
    const queued = billing.state === "queued";
    return <div className="sms-summary"><strong>{completed ? "已接码" : released ? "接码已结束" : unknown ? "接码待核实" : queued ? "等待池名额" : "池接码中"}</strong><span>管理员接码池</span><span>{completed ? billing.fee ? `已扣 ${billing.fee} 次` : "管理员工作区，不扣次" : released ? "未扣次，预留已释放" : queued ? "尚未取号，未预留次数" : `预留 ${billing.reserved} 次`}</span>{unknown && <small>结果未确认，等待核实</small>}{summary?.historyCount > 1 && <small>{summary.historyCount} 次取号记录</small>}</div>;
  }
  if (!summary || summary.verificationStatus === "not_started") return <div className="sms-summary"><span className="insight-note">未接码</span></div>;
  const latest = summary.latest;
  const status = { verified: "已接码", processing: "接码中", canceled: "已取消", failed: "接码失败", not_required: "无需接码" }[summary.verificationStatus] || "未接码";
  const money = latest?.amount && latest?.currency ? `${latest.amount} ${latest.currency}` : latest?.quote ? `报价 ${latest.quote}${latest.quoteCurrency ? ` ${latest.quoteCurrency}` : ""}` : latest ? "金额待确认" : "未接码";
  return <div className="sms-summary"><strong>{status}</strong>{latest?.providerName && <span>{latest.providerName}</span>}<span>{money}</span>{summary.historyCount > 1 && <small>{summary.historyCount} 次记录</small>}{summary.unknownCount > 0 && <small>部分金额未记录</small>}</div>;
}

function smsOrderStatusText(status) {
  return ({ acquired: "已取号", submitted: "已提交", complete_pending: "等待完成确认", completed: "已完成", cancel_pending: "等待取消确认", cancel_requested: "已请求取消", cancel_failed: "取消失败", complete_failed: "完成确认失败", error: "失败" })[status] || status || "未知";
}

function JobRow({ prepareSmsProvider, job, token, expanded, onToggleLogs, onError, onPreviewExport, onDownloadNotice, onMfaStarted, mfaChangeAvailable, selected, onToggleSelected, selectionSupported, smsProviderAvailable, smsProvider, onUpload, sub2apiUploadAvailable, totpSetupAvailable, passwordAddAvailable, forceReloginAvailable, accountProxyUrl, detail = false }) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setValue(""), [job.status]);

  async function sendInput(action, submittedValue = value) {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/input`, {
        method: "POST",
        body: JSON.stringify({ action, value: submittedValue }),
      });
      setValue("");
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/cancel`, { method: "POST" });
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function retry() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/retry`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function regenerate() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/regenerate`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function checkInsights() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/account-insights`, { method: "POST", body: "{}" });
      onError("");
    } catch (requestError) { onError(requestError.message); }
    finally { setSubmitting(false); }
  }

  async function changeMfa() {
    if (submitting || !job.canChangeMfa) return;
    setSubmitting(true);
    try {
      const result = await apiFetch(token, `/api/jobs/${job.id}/change-mfa`, { method: "POST", body: "{}" });
      onError("");
      onMfaStarted(result.accountId);
    } catch (requestError) { onError(requestError.message); }
    finally { setSubmitting(false); }
  }

  async function forceRelogin() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/relogin`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function setupTotp() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/setup-2fa`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function addPassword() {
    if (!window.confirm("确定为该账号生成并添加随机强密码吗？成功后会自动更新账号原始信息。")) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/add-password`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function copyTotpSecret() {
    try {
      await navigator.clipboard.writeText(job.totpSetupSecret || "");
      onError("");
    } catch {
      onError("无法自动复制，请手动选择 2FA 密钥");
    }
  }

  async function requestSmsNumber() {
    if (!smsProvider.ready) return;
    setSubmitting(true);
    try {
      const setup = prepareSmsProvider ? await prepareSmsProvider(1) : { id: smsProvider.id, config: smsProvider.config };
      if (!setup) return;
      await apiFetch(token, `/api/jobs/${job.id}/sms-number`, {
        method: "POST",
        body: JSON.stringify({ providerId: setup.id, config: setup.config }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function startPhoneBinding() {
    if (!smsProvider.ready || !job.canStartPhoneBinding) return;
    setSubmitting(true);
    try {
      const setup = prepareSmsProvider ? await prepareSmsProvider(1) : { id: smsProvider.id, config: smsProvider.config };
      if (!setup) return;
      await apiFetch(token, `/api/jobs/${job.id}/start-phone`, {
        method: "POST",
        body: JSON.stringify({ smsProvider: setup }),
      });
      onError("");
    } catch (requestError) { onError(requestError.message); }
    finally { setSubmitting(false); }
  }

  async function download() {
    try {
      await onPreviewExport([job.id]);
      const response = await cdkFetch(`/api/jobs/${job.id}/download`, {
        headers: { "x-console-token": token },
      });
      if (!response.ok) throw new Error((await response.json()).error || "下载失败");
      await saveDownloadResponse(response, `${job.email}-sub2api-import-oauth-${localTimestamp()}.json`);
      onDownloadNotice(downloadSummary(response));
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    }
  }

  const inputConfig = getInputConfig(job.status, job.currentPhone);
  const terminal = ["completed", "failed", "canceled", "reauth_required", "resume_available", "phone_skipped"].includes(job.status);

  const stepContent = <>
        <div className="prompt-line">{job.prompt}</div>
        {job.lastError && <div className="row-error">{extractResponseMessage(job.lastError)}</div>}
        {job.autoRepairBlocked && (
          <div className="row-error">号池监控已永久跳过：{extractResponseMessage(job.autoRepairBlockedReason || "账号已不可用")}</div>
        )}
        {job.totpSetupError && <div className="row-error">2FA：{extractResponseMessage(job.totpSetupError)}</div>}
        {job.passwordAddError && <div className="row-error">添加密码：{extractResponseMessage(job.passwordAddError)}</div>}
        {job.mailApiError && job.status === "email_otp" && <div className="mail-error">{job.mailApiError}</div>}
        {job.currentPhone && ["working", "phone", "phone_otp"].includes(job.status) && (
          <div className="phone-target"><Smartphone size={13} />当前手机号：<strong>{job.currentPhone}</strong></div>
        )}
        {job.phoneError && <div className="phone-error"><CircleAlert size={13} />{job.phoneError}</div>}
        {job.smsStatus && !["idle", "unavailable"].includes(job.smsStatus) && (
          <div className={`sms-status ${job.smsStatus === "error" ? "error" : ""}`}>
            {job.smsStatus === "error" ? <CircleAlert size={13} /> : <PhoneIncoming size={13} />}
            <span>{smsStatusText(job)}</span>
          </div>
        )}
        {job.status === "totp_setup_otp" && job.totpSetupSecret && (
          <div className="totp-setup-secret">
            <span>2FA 密钥</span>
            <code>{job.totpSetupSecret}</code>
            <button type="button" className="icon-button" onClick={copyTotpSecret} title="复制 2FA 密钥">
              <Copy size={15} />
            </button>
          </div>
        )}
        {inputConfig && (
          <div className="inline-entry">
            <div className="compact-input">
              {inputConfig.icon}
              <input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && value && !submitting) sendInput(inputConfig.action);
                }}
                inputMode={inputConfig.inputMode}
                type={inputConfig.type || "text"}
                placeholder={inputConfig.placeholder}
                aria-label={inputConfig.placeholder}
                autoComplete={inputConfig.autoComplete || "one-time-code"}
              />
            </div>
            <button
              type="button"
              className="icon-button submit"
              onClick={() => sendInput(inputConfig.action)}
              disabled={!value || submitting}
              title={inputConfig.submitLabel}
            >
              {submitting ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
            </button>
            {job.status === "email_otp" && (
              <button type="button" className="text-action" onClick={() => sendInput("resend_email", "")} disabled={submitting}>
                <RefreshCw size={14} />重发
              </button>
            )}
            {job.status === "phone_otp" && (
              <>
                <button type="button" className="text-action" onClick={() => sendInput("resend_phone", "")} disabled={submitting}>
                  <RefreshCw size={14} />重发
                </button>
                <button type="button" className="text-action" onClick={() => sendInput("change_phone", "")} disabled={submitting}>
                  <RotateCcw size={14} />换号
                </button>
              </>
            )}
            {job.status === "phone" && smsProviderAvailable && (
              <>
                <span className="input-separator" aria-hidden="true" />
                <button
                  type="button"
                  className="platform-number-button"
                  onClick={requestSmsNumber}
                  disabled={!smsProvider.ready || submitting || job.smsStatus === "requesting"}
                  title={smsProvider.ready ? `使用 ${smsProvider.name} 取号` : "请先完成接码平台配置"}
                >
                  {submitting || job.smsStatus === "requesting" ? <LoaderCircle className="spin" size={15} /> : <PhoneIncoming size={15} />}
                  {smsProvider.name || "平台"}取号
                </button>
              </>
            )}
          </div>
        )}</>;
  const quotaContent = <div className="account-insights">      <div className="account-insight-section">
        <QuotaInfo insights={job.accountInsights} />
        <button type="button" className="text-action insight-check" onClick={checkInsights}
          disabled={!job.canCheckAccountInsights || submitting}
          title="使用现有授权和账号代理查询，不重新登录">
          {job.accountInsightsChecking ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
          {job.accountInsightsChecking ? "检测中" : "检测额度"}
        </button>
        {job.accountInsights?.checkedAt && <span className="insight-note" title={formatInsightDate(job.accountInsights.checkedAt)}>检测于 {formatDateTime(job.accountInsights.checkedAt)}</span>}
        {job.accountInsightsError && <span className="insight-error">{job.accountInsightsError}</span>}
      </div>
      <div className="account-insight-section"><span className="insight-label">订阅到期</span><SubscriptionInfo insights={job.accountInsights} /></div>
      <div className="account-insight-section">
        <span className="insight-label">剩余重置次数</span>
        <div>{!job.accountInsights ? <span className="insight-note">未检测</span>
          : job.accountInsights.resetCredits?.status === "ok"
            ? <><strong className="insight-count">{job.accountInsights.resetCredits.availableCount} <small>次</small></strong>{(job.accountInsights.resetCredits.stale || job.accountInsights.resetCredits.error) && <span className="insight-note">上次成功结果</span>}</>
            : <InsightError item={job.accountInsights.resetCredits} />}</div>
        <button type="button" className="text-action insight-check" onClick={checkInsights}
          disabled={!job.canCheckAccountInsights || submitting}
          aria-label="刷新剩余重置次数" title="使用现有授权和账号代理刷新剩余重置次数">
          {job.accountInsightsChecking ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
          {job.accountInsightsChecking ? "刷新中" : "刷新"}
        </button>
      </div>
</div>;
  const actionContent = <>
          {job.canStartPhoneBinding && (
            <button type="button" className="primary-button" onClick={startPhoneBinding} disabled={submitting || !smsProviderAvailable || !smsProvider.ready} title={smsProvider.ready ? "恢复登录状态并开始接码" : "请先完成接码平台配置"}>
              {submitting ? <LoaderCircle className="spin" size={16} /> : <PhoneIncoming size={16} />}开始接码
            </button>
          )}
          {job.canDownload && (
            <button type="button" className="download-button" onClick={download}>
              <Download size={16} />下载
            </button>
          )}
          {job.canDownload && sub2apiUploadAvailable && (
            <button type="button" className="secondary-button" onClick={onUpload} disabled={submitting} title="上传到已配置的 Sub2API 号池">
              <Send size={16} />上传
            </button>
          )}
          {job.canRegenerate && (
            <button type="button" className="regenerate-button" onClick={regenerate} disabled={submitting} title="重新授权：优先使用刷新令牌，失效后自动重新登录">
              {submitting ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
              重新授权
            </button>
          )}
          {forceReloginAvailable && job.canForceRelogin && (
            <button type="button" className="relogin-button" onClick={forceRelogin} disabled={submitting} title="跳过刷新令牌和旧检查点，完整重新登录后自动授权">
              {submitting ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}
              重新登录并授权
            </button>
          )}
          {detail && mfaChangeAvailable && (job.canChangeMfa || job.mfaBusy) && (
            <button type="button" className="secondary-button" onClick={changeMfa} disabled={submitting || job.mfaBusy} title="使用已有账号授权修改 MFA；过期时提示，成功后同步账号资料">
              <ShieldCheck size={16} />{job.mfaBusy ? "MFA 处理中" : "修改 MFA"}
            </button>
          )}
          {totpSetupAvailable && job.canSetupTotp && (
            <button type="button" className="icon-button" onClick={setupTotp} disabled={submitting} title="设置 2FA">
              {submitting ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}设置 2FA
            </button>
          )}
          {passwordAddAvailable && job.canAddPassword && (
            <button type="button" className="icon-button" onClick={addPassword} disabled={submitting} title="添加密码">
              {submitting ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}添加密码
            </button>
          )}
          {job.canRetry && (
            <button type="button" className="retry-button" onClick={retry} disabled={submitting}>
              {submitting ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
              {job.securityCheckRequired ? "手动重试" : job.status === "phone_skipped" ? "重试授权" : job.canResume ? "继续流程" : "重新授权"}
            </button>
          )}
          {!terminal && (
            <button type="button" className="icon-button danger" onClick={cancel} disabled={submitting} title="取消任务">
              <Ban size={17} />取消任务
            </button>
          )}</>;
  if (detail) return <div className="job-detail-content"><p className="detail-email">{job.email}</p><section className="detail-section"><h3>状态与当前操作</h3><StatusBadge status={job.status} />{stepContent}</section><section className="detail-section"><h3>额度与订阅</h3>{quotaContent}</section><section className="detail-section"><h3>接码与费用</h3><SmsSummary summary={job.smsSummary} billing={job.smsPoolBilling} />{job.smsSummary?.orders?.length > 0 && <div className="sms-order-history">{job.smsSummary.orders.map(order => <div key={order.id}><span>{order.providerName || "接码平台"}</span><span>{smsOrderStatusText(order.status)}</span><span>{order.amount && order.currency ? `${order.amount} ${order.currency}` : order.quote ? `报价 ${order.quote}` : "金额待确认"}</span></div>)}</div>}</section><section className="detail-section"><h3>时间</h3><dl className="detail-dates"><div><dt>创建时间</dt><dd>{formatInsightDate(job.createdAt)}</dd></div><div><dt>最近操作</dt><dd>{formatInsightDate(job.lastOperationAt || job.createdAt)}</dd></div></dl></section><section className="detail-section"><h3>任务操作</h3><div className="detail-actions">{actionContent}</div></section><section className="detail-section"><h3>执行日志</h3><JobLogs token={token} jobId={job.id} /></section></div>;
  return <tr className={`job-row status-${job.status} ${selected ? "selected-row" : ""}`}>
    <td className="select-cell"><input type="checkbox" checked={selected} onChange={onToggleSelected} disabled={!selectionSupported} aria-label={`选择 ${job.email}`} /></td>
    <td className="account-column"><div className="account-details"><strong title={job.email}>{job.email}</strong><span>{shortId(job.id)}</span></div><LoginMethodBadge job={job} /><div className="mobile-task-meta">{formatDateTime(job.createdAt)}</div></td>
    <td className="status-step-cell"><StatusBadge status={job.status} />{inputConfig ? <div className="task-inline-step">{stepContent}</div> : <><div className="prompt-line">{job.prompt}</div>{job.lastError && <div className="row-error">{extractResponseMessage(job.lastError)}</div>}</>}</td>
    <td className="insight-cell quota-column">{quotaContent}</td>
    <td className="sms-column"><SmsSummary summary={job.smsSummary} billing={job.smsPoolBilling} /></td>
    <td className="task-time-cell"><div><span>创建</span><time dateTime={job.createdAt} title={formatInsightDate(job.createdAt)}>{formatDateTime(job.createdAt)}</time></div><div><span>操作</span><time dateTime={job.lastOperationAt || job.createdAt} title={formatInsightDate(job.lastOperationAt || job.createdAt)}>{formatDateTime(job.lastOperationAt || job.createdAt)}</time></div><small>{operationLabel(job.lastOperationType)}</small></td>
    <td className="actions-cell"><div className="row-actions"><button type="button" className="text-action" onClick={onToggleLogs} aria-label={`查看 ${job.email} 的任务详情`}>查看</button>{job.canDownload && <button type="button" className="text-action" onClick={download}><Download size={14} />下载</button>}{mfaChangeAvailable && (job.canChangeMfa || job.mfaBusy) && <button type="button" className="text-action" onClick={changeMfa} disabled={submitting || job.mfaBusy} title="复用已有授权，成功后同步账号资料"><ShieldCheck size={14} />{job.mfaBusy ? "MFA 处理中" : "修改 MFA"}</button>}{job.canRetry && !job.canDownload && <button type="button" className="text-action" onClick={retry} disabled={submitting}>{job.canResume ? "继续" : "重试"}</button>}<MoreActions label="更多">{actionContent}</MoreActions></div></td>
  </tr>;
}

function JobLogs({ token, jobId }) {
  const [logs, setLogs] = useState("正在读取日志...");

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const data = await apiFetch(token, `/api/jobs/${jobId}/logs`);
        if (!stopped) setLogs(data.logs || "暂无日志");
      } catch (error) {
        if (!stopped) setLogs(`日志读取失败：${error.message}`);
      }
    };
    load();
    const timer = window.setInterval(load, 1_200);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [jobId, token]);

  return (
    <div className="log-panel">
      <div className="log-title"><FileText size={15} />协议日志</div>
      <pre>{logs}</pre>
    </div>
  );
}

function StatusBadge({ status }) {
  const config = {
    queued: ["排队中", <LoaderCircle size={14} />],
    starting: ["启动中", <LoaderCircle className="spin" size={14} />],
    working: ["处理中", <LoaderCircle className="spin" size={14} />],
    password: ["待密码", <KeyRound size={14} />],
    mfa_otp: ["待 2FA", <ShieldCheck size={14} />],
    totp_starting: ["准备 2FA", <LoaderCircle className="spin" size={14} />],
    password_add_starting: ["准备密码", <LoaderCircle className="spin" size={14} />],
    totp_setup_otp: ["激活 2FA", <ShieldCheck size={14} />],
    email_otp: ["待邮箱码", <Mail size={14} />],
    phone: ["待手机号", <Smartphone size={14} />],
    phone_otp: ["待手机码", <Smartphone size={14} />],
    finalizing: ["生成中", <LoaderCircle className="spin" size={14} />],
    refreshing: ["刷新授权", <RefreshCw className="spin" size={14} />],
    checking_account: ["检测额度", <LoaderCircle className="spin" size={14} />],
    completed: ["已完成", <Check size={14} />],
    failed: ["失败", <CircleAlert size={14} />],
    canceled: ["已取消", <Ban size={14} />],
    reauth_required: ["待重新授权", <RefreshCw size={14} />],
    resume_available: ["可继续", <RotateCcw size={14} />],
    phone_skipped: ["待接码", <PhoneIncoming size={14} />],
  }[status] || [status, null];
  return <span className={`status-badge ${status}`}>{config[1]}{config[0]}</span>;
}

function LoginMethodBadge({ job }) {
  if (job.loginMode === "password") {
    const methods = ["密码", job.autoEmailOtp ? "自动收码" : "", job.hasTotpKey ? "2FA" : ""].filter(Boolean);
    return (
      <span className="mail-mode password-mode">
        {job.hasTotpKey ? <ShieldCheck size={12} /> : <KeyRound size={12} />}
        {methods.join(" + ")}
      </span>
    );
  }
  if (job.autoEmailOtp) {
    return (
      <span className={`mail-mode ${["error", "timeout"].includes(job.mailStatus) ? "error" : ""}`}>
        {job.hasTotpKey ? <ShieldCheck size={12} /> : <MailCheck size={12} />}
        {job.hasTotpKey ? "自动收码 + 2FA" : "自动收码"}
      </span>
    );
  }
  if (job.loginMode === "manual") {
    return (
      <span className="mail-mode unknown-mode">
        <CircleAlert size={12} />旧任务资料未记录
      </span>
    );
  }
  if (!job.hasTotpKey) return null;
  return (
    <span className="mail-mode">
      <ShieldCheck size={12} />邮箱码 + 2FA
    </span>
  );
}

function getInputConfig(status, currentPhone) {
  if (status === "password") {
    return { action: "password", placeholder: "输入账号密码", submitLabel: "提交密码", inputMode: "text", type: "password", autoComplete: "current-password", icon: <KeyRound size={15} /> };
  }
  if (status === "mfa_otp") {
    return { action: "mfa_otp", placeholder: "6 位 2FA 验证码", submitLabel: "提交 2FA 验证码", inputMode: "numeric", icon: <ShieldCheck size={15} /> };
  }
  if (status === "totp_setup_otp") {
    return { action: "totp_setup_otp", placeholder: "新 2FA 的 6 位验证码", submitLabel: "激活新的 2FA", inputMode: "numeric", icon: <ShieldCheck size={15} /> };
  }
  if (status === "email_otp") {
    return { action: "email_otp", placeholder: "6 位邮箱验证码", submitLabel: "提交邮箱验证码", inputMode: "numeric", icon: <Mail size={15} /> };
  }
  if (status === "phone") {
    return { action: "phone", placeholder: "+60123456789", submitLabel: "发送手机验证码", inputMode: "tel", icon: <Smartphone size={15} /> };
  }
  if (status === "phone_otp") {
    return { action: "phone_otp", placeholder: currentPhone ? `${currentPhone} 的验证码` : "手机验证码", submitLabel: "提交手机验证码", inputMode: "numeric", icon: <Smartphone size={15} /> };
  }
  return null;
}

function smsStatusText(job) {
  const providerName = job.smsProviderName || "接码平台";
  const rotationProgress = job.smsAutoRetrying && job.smsNumberMaxAttempts
    ? `（${Math.max(1, Math.min(job.smsNumberAttempt || 1, job.smsNumberMaxAttempts))}/${job.smsNumberMaxAttempts}）`
    : "";
  if (job.smsError) return `${providerName}：${job.smsError}`;
  return {
    requesting: `${providerName}：正在获取手机号${rotationProgress}`,
    number_acquired: `${providerName}：已获取手机号，正在发送验证码`,
    waiting_sms: `${providerName}：验证码已发送，正在等待短信`,
    submitting: `${providerName}：已收到验证码，正在自动提交`,
    submitted: `${providerName}：验证码已自动提交`,
    manual_submitted: `${providerName}：已停止自动读取，正在验证手动输入的验证码`,
    completed: `${providerName}：手机验证已通过，订单已完成`,
  }[job.smsStatus] || `${providerName}：处理中`;
}

function formatTokenSummary(tokens = {}) {
  return [`未过期 ${tokens.valid || 0} 条`, `已过期 ${tokens.expiredWithRefresh || 0} 条（含刷新凭据，未验证）`,
    `已过期且无刷新凭据 ${tokens.expiredWithoutRefresh || 0} 条`, `期限未知 ${tokens.unknown || 0} 条`].join("；");
}

function downloadSummary(response) {
  let summary;
  try { summary = JSON.parse(response.headers.get("x-export-summary")); } catch { /* No summary from an older server. */ }
  return summary ? `已导出 ${summary.exported} 条，失败 ${summary.failed} 条，跳过 ${summary.skipped} 条。导入 Sub2API 后请设置目标分组。`
    : "文件已下载。导入 Sub2API 后请设置目标分组。";
}

function ExportReport({ report, onClose }) {
  const rows = report.result ? [
    ...(report.rows || []).filter((row) => row.status !== "ready"),
    ...(report.result.results || []),
  ] : report.rows || [];
  return <section className="export-report" aria-label="导出检查结果">
    <div className="export-report-heading"><strong>导出检查结果</strong><button type="button" className="icon-button" onClick={onClose} aria-label="关闭导出检查结果"><X size={16} /></button></div>
    <p role="status">{formatTokenSummary(report.tokens)}</p>
    <p>仅检查本地字段和期限；导出不会自动刷新令牌。文件导入 Sub2API 后请设置目标分组。</p>
    <details open={report.failed > 0 || report.unknown > 0}><summary>查看逐条结果（{rows.length}）</summary><ul>{rows.map((row, index) => <li key={`${row.id || row.jobId || index}-${index}`}>
      <strong>{row.email || row.name}</strong>：{row.message || (row.tokens ? formatTokenSummary(row.tokens) : "校验完成")}
    </li>)}</ul></details>
  </section>;
}

async function saveDownloadResponse(response, fallbackName) {
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = downloadFilename(response.headers.get("content-disposition")) || fallbackName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

function downloadFilename(contentDisposition) {
  if (!contentDisposition) return "";
  const encodedMatch = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(contentDisposition);
  const plainMatch = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(contentDisposition);
  const rawName = encodedMatch?.[1] || plainMatch?.[1] || plainMatch?.[2] || "";
  try {
    return decodeURIComponent(rawName.trim().replace(/^"|"$/g, "")).replace(/[\\/]/g, "_");
  } catch {
    return rawName.trim().replace(/^"|"$/g, "").replace(/[\\/]/g, "_");
  }
}

function localTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatMonitorResult(result) {
  if (!result || typeof result !== "object") return "号池巡检已完成";
  const parts = [`检查 ${Number(result.checked || 0)} 条异常记录`];
  if (result.started) parts.push(`已启动自动修复 ${result.started} 条`);
  if (result.updated) parts.push(`已更新 ${result.updated} 条`);
  if (result.blocked) parts.push(`永久跳过 ${result.blocked} 条`);
  if (result.ineligible) parts.push(`需人工 ${result.ineligible} 条`);
  if (result.missingTask) parts.push(`本地无任务 ${result.missingTask} 条`);
  if (result.busy) parts.push(`正在运行 ${result.busy} 条`);
  if (result.cooldown) parts.push(`冷却中 ${result.cooldown} 条`);
  return parts.join("，");
}

function formatRelativeMonitorTime(value) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "刚刚检查";
  if (elapsed < 60_000) return "刚刚检查";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前检查`;
  return `${Math.floor(elapsed / (60 * 60_000))} 小时前检查`;
}

async function apiFetch(token, url, options = {}) {
  const response = await cdkFetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-console-token": token,
      ...(options.headers || {}),
    },
  });
  return readResponse(response);
}

async function readResponse(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败：HTTP ${response.status}`);
  return data;
}

function shortId(id) {
  return `任务 ${id.slice(0, 8)}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const now = new Date();
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat("zh-CN", {
    ...(isToday ? {} : { month: "2-digit", day: "2-digit" }),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function operationLabel(type) {
  return ({
    initial_authorization: "首次授权",
    reauthorize: "重新授权",
    relogin: "重新登录并授权",
    automatic_relogin: "号池自动重登并授权",
    resume: "继续中断流程",
    setup_2fa: "设置 2FA",
    change_mfa: "修改 MFA",
    sync_mfa_authorization: "从 MFA 同步",
    email_rebind_import: "换绑后新账号导入",
    add_password: "添加密码",
    account_update: "更新账号资料",
    proxy_update: "更新代理 IP",
    check_account_insights: "检测额度和订阅",
  })[type] || "账号操作";
}

function countBatchLines(value) {
  return String(value || "").split(/\r?\n/).filter((line) => line.trim()).length;
}

function parseEmailFilter(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("----", 1)[0].trim().toLowerCase());
  if (!lines.length) throw new Error("请至少输入一个筛选邮箱");
  if (lines.length > 500) throw new Error("一次最多筛选 500 个邮箱");
  lines.forEach((email, index) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new Error(`第 ${index + 1} 行邮箱格式错误`);
    }
  });
  return [...new Set(lines)];
}

function extractResponseMessage(value) {
  const text = String(value || "").trim();
  const jsonAt = text.indexOf("{");
  if (jsonAt >= 0) {
    try {
      const payload = JSON.parse(text.slice(jsonAt));
      const message = payload?.error?.message || payload?.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    } catch {}
  }
  const match = text.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (match) {
    try {
      return JSON.parse(`"${match[1]}"`).trim();
    } catch {
      return match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").trim();
    }
  }
  return text;
}

function readLocalSetting(key) {
  try {
    return readWorkspaceValue(key) || "";
  } catch {
    return "";
  }
}

function readLocalTextSetting(key) {
  let value = readLocalSetting(key).trim();
  for (let attempt = 0; attempt < 4 && value; attempt += 1) {
    if (!(value.startsWith('"') && value.endsWith('"'))) return value;
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded !== "string") return value;
      value = decoded.trim();
    } catch {
      return value;
    }
  }
  return value;
}

function readSmsProviderSettings() {
  try {
    const stored = JSON.parse(readWorkspaceValue(SMS_PROVIDER_SETTINGS_KEY) || "null");
    if (stored && typeof stored === "object" && stored.configs && typeof stored.configs === "object") {
      return stored;
    }
  } catch {}
  return {
    selectedProviderId: "luban",
    configs: {
      luban: {
        apiKey: readLocalSetting(LUBAN_API_KEY_STORAGE_KEY),
        serviceId: readLocalSetting(LUBAN_SERVICE_ID_STORAGE_KEY),
      },
    },
  };
}

function normalizeMailRequestSettings(value) {
  const stored = value && typeof value === "object" ? value : {};
  let headersText = typeof stored.headersText === "string" ? stored.headersText : "";
  if (!headersText && stored.headers && typeof stored.headers === "object" && !Array.isArray(stored.headers)) {
    headersText = JSON.stringify(stored.headers, null, 2);
  }
  return {
    method: String(stored.method || "GET").toUpperCase() === "POST" ? "POST" : "GET",
    url: typeof stored.url === "string" ? stored.url.trim() : "",
    headersText: headersText.trim() || "{}",
  };
}

function readMailRequestSettings(value) {
  try {
    const stored = value || JSON.parse(readWorkspaceValue(MAIL_REQUEST_SETTINGS_KEY) || "null");
    return normalizeMailRequestSettings(stored);
  } catch {
    return normalizeMailRequestSettings({});
  }
}

function buildMailRequestConfig(settings) {
  const normalized = normalizeMailRequestSettings(settings);
  let headers;
  try {
    headers = JSON.parse(normalized.headersText || "{}");
  } catch {
    throw new Error("请求头必须是有效的 JSON 对象");
  }
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("请求头必须是 JSON 对象，例如 {\"Authorization\":\"Bearer ...\"}");
  }
  if (normalized.method === "POST") {
    try {
      const parsedUrl = new URL(normalized.url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error();
    } catch {
      throw new Error("POST 模式必须填写有效的 HTTP 或 HTTPS 请求 URL");
    }
  }
  return {
    method: normalized.method,
    url: normalized.method === "POST" ? normalized.url : "",
    headers,
  };
}

function formatMailRequestSummary(settings) {
  try {
    const config = buildMailRequestConfig(settings);
    const headerCount = Object.keys(config.headers).length;
    return `${config.method === "POST" ? "已配置统一 URL · " : ""}${headerCount} 个请求头`;
  } catch {
    return "配置需要检查";
  }
}

function normalizeSub2ApiSettings(value) {
  const stored = value && typeof value === "object" ? value : {};
  const rawGroupIds = Array.isArray(stored.groupIds)
    ? stored.groupIds
    : String(stored.groupId || "").trim()
      ? [stored.groupId]
      : [];
  return {
    baseUrl: String(stored.baseUrl || ""),
    adminApiKey: String(stored.adminApiKey || ""),
    groupIds: [...new Set(rawGroupIds.map((id) => String(id).trim()).filter(Boolean))],
    proxyId: String(stored.proxyId || ""),
    concurrency: String(stored.concurrency ?? ""),
    loadFactor: String(stored.loadFactor ?? ""),
    priority: String(stored.priority ?? ""),
    modelWhitelist: String(stored.modelWhitelist || ""),
    codexFingerprintMode: ["off", "device", "session", "full"].includes(stored.codexFingerprintMode)
      ? stored.codexFingerprintMode
      : "off",
    monitorEnabled: stored.monitorEnabled === true,
  };
}

function readSub2ApiSettings(value) {
  try {
    const stored = value || JSON.parse(readWorkspaceValue(SUB2API_UPLOAD_SETTINGS_KEY) || "null");
    if (stored && typeof stored === "object") return normalizeSub2ApiSettings(stored);
  } catch {}
  return normalizeSub2ApiSettings({});
}

function formatSub2ApiProxy(proxy) {
  const protocol = String(proxy.protocol || "http").replace(/:\/\/$/, "");
  const host = String(proxy.host || "");
  const port = proxy.port ? `:${proxy.port}` : "";
  const endpoint = host ? `${protocol}://${host}${port}` : "地址未知";
  const ip = String(proxy.ipAddress || "").trim();
  return `${proxy.name || `代理 ${proxy.id}`} | ${endpoint}${ip ? ` | 出口 IP：${ip}` : ""}`;
}

function withSmsProviderDefaults(definitions, settings) {
  const configs = { ...(settings?.configs || {}) };
  definitions.forEach((provider) => {
    const current = { ...(configs[provider.id] || {}) };
    provider.fields.forEach((field) => {
      if (!String(current[field.key] || "").trim() && field.defaultValue) current[field.key] = field.defaultValue;
    });
    configs[provider.id] = current;
  });
  const selectedProviderId = definitions.some((provider) => provider.id === settings?.selectedProviderId)
    ? settings.selectedProviderId
    : definitions[0]?.id || settings?.selectedProviderId || "luban";
  return { selectedProviderId, configs };
}

function resolveSmsProvider(definitions, settings) {
  const normalized = withSmsProviderDefaults(definitions, settings || {});
  const definition = definitions.find((provider) => provider.id === normalized.selectedProviderId) || null;
  const config = definition ? normalized.configs[definition.id] || {} : {};
  const requiredFieldsReady = Boolean(definition) && definition.fields.every((field) => (
    field.required === false || String(config[field.key] || "").trim()
  ));
  const customEntries = definition?.id === "custom" ? inspectCustomSmsEntries(config.entries) : null;
  const ready = requiredFieldsReady && !customEntries?.error;
  const summary = definition?.id === "pool" ? "验证成功后按池规则扣次" : definition?.id === "custom"
    ? (customEntries?.count ? `${customEntries.count} 个号码` : "")
    : definition
    ? definition.fields
      .filter((field) => field.summary || field.summaryKey)
      .map((field) => config[field.summaryKey || field.key])
      .filter(Boolean)
      .join(" / ")
    : "";
  return {
    id: definition?.id || "",
    name: definition?.name || "",
    definition,
    config,
    ready,
    summary,
  };
}

function inspectCustomSmsEntries(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { count: 0, error: "请粘贴至少一条手机号和接码 API" };
  if (lines.length > 500) return { count: 0, error: "自定义接码一次最多导入 500 条" };
  const phones = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const delimiterAt = lines[index].indexOf("----");
    if (delimiterAt < 0) return { count: 0, error: `第 ${index + 1} 行格式错误，请使用 手机号----接码API` };
    const phone = lines[index].slice(0, delimiterAt).trim();
    const apiUrl = lines[index].slice(delimiterAt + 4).trim();
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
      return { count: 0, error: `第 ${index + 1} 行手机号必须使用 +861871291167 这种国际格式` };
    }
    try {
      const parsed = new URL(apiUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid protocol");
    } catch {
      return { count: 0, error: `第 ${index + 1} 行接码 API 必须是有效的 HTTP 或 HTTPS 地址` };
    }
    phones.add(phone);
  }
  return { count: phones.size, error: "" };
}

function formatSmsCountryName(option) {
  if (option.iso && REGION_NAMES) {
    try {
      return REGION_NAMES.of(option.iso) || option.title;
    } catch {}
  }
  return option.title || `国家 ${option.country}`;
}

function writeLocalJson(key, value) {
  try {
    writeWorkspaceValue(key, JSON.stringify(value));
  } catch {
    // Private browsing modes may disable localStorage; the current tab still works.
  }
}

function writeLocalTextSetting(key, value) {
  try {
    writeWorkspaceValue(key, String(value || ""));
  } catch {
    // Private browsing modes may disable localStorage; the current tab still works.
  }
}

const appRoot = globalThis.__chatgptOnboardingRoot || createRoot(document.getElementById("root"));
globalThis.__chatgptOnboardingRoot = appRoot;
appRoot.render(<CdkGate>{(auth) => <App key={`${auth.workspace.id}:${auth.token}`} auth={auth} />}</CdkGate>);
