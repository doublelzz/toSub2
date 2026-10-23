---
version: 1
slug: "web-src-main-jsx"
primary_target: "web/src/main.jsx"
related_targets: ["web/src/CdkGate.jsx","web/src/CdkWorkspace.jsx","web/src/cdk.css"]
---

# CDK production workbench extension

Mode: Operate. Targets: web/src/main.jsx, CdkGate.jsx, CdkWorkspace.jsx and cdk.css. This extends the established workbench; root DESIGN.md and existing sidebar, task, settings and MFA behavior remain authoritative.

The user approved the business and prototype design, then requested real implementation, administrator switching between management and ordinary workspace views, and preservation of the original system settings. The ordinary view of an administrator operates that administrator's own unlimited workspace; an explicit administrator action can enter a selected CDK workspace with a visible scope notice.

## Direction contract

THESIS: Keep familiar task operations and configuration intact while making identity, account ownership and import cost explicit. Account actions and management are different destinations in one workbench.

OWN-WORLD: Inherit graphite text, blue actions, cool gray ground, local UI fonts, flat tables and 176px sidebar. New controls use the existing focus, drawer and theme system.

STORY: Validate a CDK, enter an isolated workspace, preview the charge, then operate the account without repeated charges. Administrators distribute credits, switch views, inspect scope and respond to failed validation.

FIRST VIEWPORT: Login shows a compact identity form and import rule explanation. The administrator opens CDK management with a real accounting strip and table; the top bar exposes current workspace, Switch to user view, theme, System configuration and logout. Ordinary workspace retains original authorization and MFA navigation plus My CDK. Cost previews are three aligned before/change/after values.

FORM: Code-led local extension of the approved prototype and existing world; composition fixed by the accepted business brief. Seed assignment does not apply to this extension.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Critical checks: administrator view switch with existing configuration accessible; proxy, SMS, mail and personal Sub2API configuration retained; joint (CDK,email) isolation including credentials and MFA; live API debit and merging; security endpoints; desktop/mobile/dark theme; no production-account operation during verification. Only isolated synthetic fixtures are authorized for execution evidence.

Current-CDK extension: preserve the masked identity button and append an eye control. Opening shows a scoped nonmodal panel with the full current key and Copy, closing removes plaintext; Escape, outside click, page hiding and one minute close it. Use current server workspace and authenticated POST rather than fetching a client-supplied ID. New or verified keys are retained encrypted; historical hash-only keys require a one-time successful verification. The panel stays within mobile width and introduces no new visual tokens.
