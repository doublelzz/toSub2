---
name: toSub2
description: 石墨与蓝色的本地账号工作台
colors:
  page: "#f3f5f8"
  surface: "#ffffff"
  surface-subtle: "#f3f5f8"
  ink: "#202a3b"
  muted: "#5f6c80"
  line: "#e1e6ef"
  green: "#365edb"
  green-strong: "#294dbb"
  green-soft: "#eaf0ff"
  success: "#1a7353"
  danger: "#b4404b"
  danger-soft: "#fff0f1"
  amber: "#916015"
  button-ink: "#ffffff"
  log-bg: "#f3f5f8"
  page-dark: "#131923"
  surface-dark: "#1b2331"
  surface-subtle-dark: "#222c3b"
  ink-dark: "#edf2f9"
  muted-dark: "#a4b0c3"
  line-dark: "#334156"
  green-dark: "#8daeff"
  green-strong-dark: "#abc3ff"
  green-soft-dark: "#293952"
  success-dark: "#75cfad"
  danger-dark: "#f899a1"
  danger-soft-dark: "#402831"
  amber-dark: "#e3bb72"
  button-ink-dark: "#172137"
  log-bg-dark: "#131923"
typography:
  title:
    fontFamily: '"IBM Plex Sans", "Noto Sans SC", "Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "24px"
    fontWeight: 600
    letterSpacing: "-.5px"
  body:
    fontFamily: '"IBM Plex Sans", "Noto Sans SC", "Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
  control:
    fontFamily: '"IBM Plex Sans", "Noto Sans SC", "Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "13px"
    fontWeight: 500
  label:
    fontFamily: '"IBM Plex Sans", "Noto Sans SC", "Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "12px"
  overview:
    fontFamily: '"IBM Plex Sans", "Noto Sans SC", "Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "34px"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "-.6px"
  log:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "12px"
    lineHeight: 1.7
rounded:
  preset: "6px"
  field: "7px"
  control: "8px"
  toolbar: "9px"
  menu: "10px"
  panel: "12px"
spacing:
  tight: "4px"
  small: "8px"
  control: "12px"
  section: "16px"
  wide: "24px"
  workspace: "28px"
  wide-workspace: "40px"
components:
  button-primary:
    backgroundColor: "{colors.green}"
    textColor: "{colors.button-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-primary-hover:
    backgroundColor: "{colors.green-strong}"
  button-primary-dark:
    backgroundColor: "{colors.green-dark}"
    textColor: "{colors.button-ink-dark}"
  button-primary-dark-hover:
    backgroundColor: "{colors.green-strong-dark}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-secondary-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.ink-dark}"
  input-search:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 11px"
    height: "38px"
  input-search-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.ink-dark}"
  navigation-active:
    backgroundColor: "{colors.green-soft}"
    textColor: "{colors.green}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  navigation-active-dark:
    backgroundColor: "{colors.green-soft-dark}"
    textColor: "{colors.green-dark}"
  date-preset-active:
    backgroundColor: "{colors.green-soft}"
    textColor: "{colors.green}"
    typography: "{typography.label}"
    rounded: "{rounded.preset}"
    padding: "5px 10px"
  date-preset-active-dark:
    backgroundColor: "{colors.green-soft-dark}"
    textColor: "{colors.green-dark}"
  table-container:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
  table-container-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.ink-dark}"
  overview-metric:
    textColor: "{colors.ink}"
    typography: "{typography.overview}"
  overview-metric-dark:
    textColor: "{colors.ink-dark}"
  actions-menu:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.menu}"
    padding: "6px"
    width: "228px"
  actions-menu-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.ink-dark}"
---

# Design System: toSub2

## Overview

**Creative North Star: "侧栏工作台"**

这是一个克制、紧凑、以任务为中心的工作台。石墨中性色组织文字、表面和边界，蓝色标记主要动作与当前选择。通过对齐、分隔线和文字层级建立秩序，让任务状态和下一步操作容易扫描。

授权与 MFA 使用同一套外壳和交互语言。概览是连续的信息带；筛选先于任务列表；偶尔使用的配置和详情进入抽屉。此方向来自已批准的 UI 方案，具体数值以当前实现为准。

**Key Characteristics:**

- 紧凑概览带、任务表和有条件出现的批量工具栏。
- 桌面稳定侧栏，窄屏顶部导航；次要数据仍能从详情访问。
- 统一浅色、深色和跟随系统主题；文字与颜色共同表达状态。

## Colors

主色是清晰的工作台蓝，中性色在浅色主题呈冷灰，在深色主题呈石墨色。前置 YAML 为颜色数值的规范来源；带 `-dark` 后缀的条目来自深色覆盖。

### Primary

`green`、`green-strong`、`green-soft` 沿用源码变量名，实际表达蓝色主动作、悬停强调和选择底色。`blue` 在源码中是同值别名。主要按钮、选中导航、日期快捷项和选中行共同使用这组色彩。

### Neutral

`page` 是工作区背景；`surface` 是侧栏、表格和抽屉表面；`surface-subtle` 区分输入、表头和悬停。`ink` 用于正文，`muted` 用于说明和时间标签，`line` 用于分隔。按钮文字单独使用 `button-ink`，日志使用 `log-bg`。

### Status

`success` 表示成功，`danger` 表示失败和危险操作，`amber` 表示需要处理的输入或配置状态；进行中使用主蓝，排队使用辅助中性色。错误提示使用 `danger-soft`；任务状态本身为文字和小标记，不是填满底色的胶囊。

**The Status Text Rule.** 状态必须同时保留文字；颜色不能承担唯一的状态解释。

## Typography

字体栈按顺序查询本机字体：IBM Plex Sans、Noto Sans SC、Segoe UI、Microsoft YaHei、sans-serif。当前样式没有字体下载或 `@font-face` 声明；不保证前两种字体已安装。实际使用的字体由操作系统和字符覆盖决定。

标题、正文和控制文字共享字体栈，靠尺寸和字重区分层级。正文使用 body，工作区标题使用 title，按钮使用 control，标签使用 label；概览主数量使用 overview。抽屉标题稍小（21px，600），手机工作区标题稍小（22px）。

数量、额度和时间使用 `tabular-nums`。日志采用等宽栈，保留换行并允许长文本断行。不要把系统字体回退写成已打包的品牌字体资产。

## Layout

桌面外壳是侧栏加弹性内容列，侧栏（176px）固定可视高度，内容允许收缩。顶部工具带最小高度（66px）；工作区最大宽度（1920px），居中，默认内边距（28px 28px 44px）。

响应规则来自实际媒体查询：

- 宽屏（至少 1600px）：工作区左右留白增加至 wide-workspace。
- 中屏（不超过 1100px）：侧栏收窄（152px），授权表时间列折叠，创建时间移入账号摘要。
- 窄屏（不超过 900px）：侧栏转为顶部导航，页脚隐藏，MFA 时间移入账号摘要。
- 手机（不超过 640px）：工作区左右留白（13px），筛选换行；授权额度及 MFA 次要列进入详情，保留状态和主要入口。
- 粗指针设备：主要按钮、导航、日期项、菜单和搜索框点击高度至少（44px），输入文字（16px）。

原有表单另有（760px）与（430px）规则；全局外壳以上述工作区覆盖为准。页面最小宽度（320px）。表格行高由内容决定：默认单元格内边距（15px 12px），紧凑密度将上下内边距收至（9px）。不要将预览中的近似行高写成固定尺寸。

## Elevation & Depth

静态内容以表面色和细分隔线组织，表格容器没有抬升阴影。层级阴影用于更多操作菜单、配置、任务详情和导入面板；焦点环表达交互状态。精确阴影定义在 sidecar 的 `extensions.shadows`，引用源码主题变量。

**The Flat Surface Rule.** 表格和概览在静态状态保持平面；菜单及抽屉使用现有层级阴影。

实际动效只有加载图标旋转（.9s linear infinite）和减少动态效果覆盖（.01ms，一次）。当前源码没有主题切换或抽屉进入的常规 `transition`；后续实现动效时须同步更新记录。

## Shapes

控制按钮和搜索框使用 control，普通表单使用 field，日期项使用 preset，选择工具栏使用 toolbar，操作菜单使用 menu，表格容器使用 panel。表格内部以分隔线连接，不把每一行做成独立卡片。抽屉和导入面板贴右侧、无外圆角。

## Components

### Buttons

主要按钮使用主色与专用按钮文字；次要按钮使用表面色、正文色及细边框。默认最小高度（36px），共同内边距见前置 token。主要按钮悬停加深；次要按钮悬停使用轻表面色，并继承原有强调文字。禁用状态降低不透明度（.48）。

交互控件保留可见键盘焦点：主色轮廓（2px），外偏移（3px）。沿用业务代码的启用条件。

### Inputs and Date Presets

搜索框带图标、细边框及透明内层输入。状态与日期字段使用同样的表面和边界；自定义日期错误显示文字并设置 `aria-invalid`。日期快捷项默认透明，选中后使用主色的轻底色，不添加装饰阴影。

### Navigation

桌面导航竖排，按钮默认辅助文字，激活后使用蓝色文字和轻蓝背景。窄屏导航横排并允许换行。工作区切换使用真实按钮和 `aria-pressed`；配置仍有可发现入口。

### Task Overview

两项主数量使用较大数字，辅助状态较小；整条概览用上下分隔线组织。数量和状态可点击筛选。未读到主统计时显示破折号；MFA 历史记录创建时间未知时显示说明，不补造数量。

### Tables and Selection

授权与 MFA 共用表面、表头、分隔线、选择底色和密度。列表标题显示匹配数量，分页显示结果范围，批量工具栏仅在有选择时出现。过滤变化清空选择；翻页保留跨页选择。

授权列表的接码分类使用文字 Tab 与底部蓝色选中线，显示全量分类数量。Tab 支持方向键、Home/End 切换，手机允许自然换行。导入面板中「登录后自动接码」默认关闭，说明登录后先检测额度；需要手机号时从列表点击开始接码。列表增加接码与费用摘要，详情抽屉展示订单历史；金额使用等宽数字，未知金额保留文字，不用零值占位。

### Menus and Drawers

更多操作用原生 `details/summary` 展开，菜单宽度（228px），末尾危险操作用 danger；外部点击和 Escape 可关闭。标准抽屉宽度上限（460px），详情宽抽屉（660px），导入面板（680px），均不超过视口宽度。默认内边距（25px），手机（20px）。

抽屉提供语义化标题、焦点限制、Escape 关闭与关闭后焦点恢复。日志保持等宽文字、可滚动区域和自动更新，不在截图或文档中写入真实账号凭据。

MFA 导出使用居中预览弹窗，宽度上限（760px），内边距（24px），窄屏与视口边缘保持（16px）。只读等宽文本区支持局部选择，主要按钮复制全部内容，次要按钮显式下载原文件。复制失败时选中内容并提示手动复制；关闭后释放预览内容，沿用焦点限制与 Escape 行为。

接码平台配置的报价按国家合并，每页 5 个国家，提供国家搜索；选中国家后显示该国的价格档位和库存。Hero SMS 显示官方近 24 小时的平台成功率，并支持高、中、低及暂无数据筛选；缺失统计保持未知。SMSBower 默认展示全部报价，可筛选 Gold 或其他（未标级）供应商；国家起价和价格档位均由当前筛选计算，切换时同步更新所选报价及供应商路由。未标级不等同于已确认的 Silver 或 Bronze。列表使用细分隔线和现有选中色，不为每条报价添加卡片；搜索框与价格档位沿用现有表单样式，粗指针控件高度至少 44px。

## Do's and Don'ts

### 邮箱换绑工作区

沿用石墨与蓝色主题、现有字体和表面层级。可换绑账号与换绑记录通过文字 Tab 分开，主操作紧贴跨页选择数量。配置弹窗以固定序号的“原账号—新邮箱—收码方式”对应关系为视觉重点；桌面左右分栏输入与核对，手机上下排列。原账号顺序在弹窗内固定，输入变化后撤销已核对状态。等待验证码的记录显示独立表单，结果待核实使用 amber 与明确文字，成功使用 success；不以颜色代替结果说明。详情承载重发、转手动、恢复与同步操作。进度使用简洁文本与数值，不增加装饰统计卡片。页面与弹窗保留键盘焦点、窄屏换行和大指针点击尺寸。

### 优惠检测工作区

延续现有 IBM Plex Sans / Noto Sans SC、石墨蓝调色与 workspace 边距。主视觉是当前批次的完成数和横向进度；优惠分类使用带数量的可多选文字筛选，不用装饰卡片。明确分开批次总体统计与列表匹配数量。导入弹窗组合账号文本、文件读取、批次名、并发及额外重试设置；导出弹窗始终先显示内容，底部并列复制与下载 TXT。余额门槛以单一空状态解释，不展示可操作的历史资料。手机端表格转为带标签的账号行，保留验证码输入与检测时间；浅深色共用主题变量。

### Do:

- **Do** 共用现有主题变量，并按后加载的 workspace.css 判断最终样式。
- **Do** 为状态、未知值和错误保留可读文字。
- **Do** 把手机折叠的数据保留在详情中，并维持粗指针点击尺寸。
- **Do** 把新增的真实颜色、组件状态和动效同步到本文与 sidecar。

### Don't:

- **Don't** 用装饰性渐变替代已批准的石墨与蓝色方向。
- **Don't** 为无来源的数据增加趋势图、成功率或统计卡片。
- **Don't** 声称本地字体已打包，或把尚未实现的抽屉过渡写成现有能力。
- **Don't** 把样式示例和测试账号当作真实业务结果。

<!-- Source of truth: web/src/styles.css; web/src/workspace.css; web/src/WorkspaceUi.jsx; web/src/main.jsx; web/src/MfaWorkspace.jsx. Date semantics: web/src/task-filters.mjs. Approved direction: tosub2-ui-plan.md. -->

### 接码池工作区

继承石墨蓝调色、IBM Plex Sans / Noto Sans SC、既有导航与浅深主题。国家报价表为主体，右侧放置扣次与冷却规则，窄屏按阅读顺序叠放。报价可多选同国不同价格档位；凭据编辑不回显密钥。冷却、停用、待核实使用文字表达原因，不仅靠颜色。普通 CDK 配置显示每成功一次的费用，开始前核对费率与批量上限。次数视图分开显示可用、预留和累计消耗；读取中或失败不补造默认费用与可用状态。`web/sms-pool-preview.html` 为隔离的交互设计预览，显示演示数据，不触发真实取号或扣次。

“号码库存”为管理员默认页签，以完整可复制号码、购号国家快照、价格、状态与剩余时间为主。顶部提供自动补满、目标数量，以及立即补满、暂停补号、回收未分配号码；补货进度为紧凑文字行，重复失败汇总进可展开详情。库存区分当前与历史，过滤先于服务端分页；复杂设置与凭据进入设置页签，日常不展示水位、单报价库存等关联参数。手机库存改为带字段标签的行，操作与长号码自然换行，不增加装饰卡片。普通 CDK 使用电话图标与简单可用状态，只展示号码供应情况和费用，隐藏国家及内部库存数量。

CDK 管理详情和生成表单提供接码方式复选项，自定义接码固定选中，其余平台逐项开放；列表详情以文字显示已有权限。普通工作区的平台选择只展示服务端授权项，权限变化后撤销失效选择并回到自定义接码，保留其他配置草稿，沿用现有抽屉、焦点及错误反馈样式。
