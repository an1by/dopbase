// The HTML report page. build.ts replaces the data and font placeholders.
// It follows the Admin UI (ui/src/style.css and components/ui): the same
// dark tokens, purple accent, 6px corners, 14px text floor, sidebar and
// tables, so a run reads like the rest of Dopbase.
// The page script avoids template literals so this file can hold it as one.
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>E2E report · Dopbase</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 54 64'%3E%3Cpath fill='%23c4a3fc' d='M6 0h14a20 20 0 0 1 20 20v4a20 20 0 0 1-20 20H6a6 6 0 0 1-6-6V6a6 6 0 0 1 6-6Z'/%3E%3Cpath fill='%23c4a3fc' d='M20 20h14a20 20 0 0 1 20 20v4a20 20 0 0 1-20 20H20a6 6 0 0 1-6-6V26a6 6 0 0 1 6-6Z'/%3E%3Cpath fill='%23af8ef0' d='M34 20a20 20 0 0 1 6 .92V24a20 20 0 0 1-20 20h-6V26a6 6 0 0 1 6-6Z'/%3E%3C/svg%3E">
<style>
/*__FONT_FACE__*/
:root {
  color-scheme: dark;
  --canvas: #1c1c1c;
  --panel: color-mix(in srgb, #1c1c1c, white 2%);
  --editor: color-mix(in srgb, #1c1c1c, white 4%);
  --raised: color-mix(in srgb, #1c1c1c, white 7%);
  --line: color-mix(in srgb, #1c1c1c, white 12%);
  --line-soft: color-mix(in srgb, #1c1c1c, white 7%);
  --line-strong: color-mix(in srgb, #1c1c1c, white 14%);
  --ink-strong: #ebebeb;
  --ink: color-mix(in srgb, #ebebeb, transparent 15%);
  --ink-muted: color-mix(in srgb, #ebebeb, transparent 45%);
  --ink-faint: color-mix(in srgb, #ebebeb, transparent 65%);
  --accent: #aa3bff;
  --accent-strong: #c084fc;
  --accent-soft: color-mix(in srgb, #aa3bff, transparent 86%);
  --brand-mark: #c4a3fc;
  --brand-mark-overlap: #af8ef0;
  --ok: #3fd68f;
  --warn: #f5b74e;
  --crit: #f26d6d;
  --radius-card: 6px;
  --radius-control: 5px;
  --sans: system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: "Fira Code Variable", ui-monospace, "SFMono-Regular", Consolas, monospace;
  scrollbar-gutter: stable;
}
* { box-sizing: border-box; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
body {
  margin: 0; min-height: 100svh; background: var(--canvas); color: var(--ink);
  font: 15px/1.6 var(--sans); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
h1, h2, h3 { color: var(--ink-strong); font-weight: 600; letter-spacing: -0.01em; margin: 0; }
h1 { font-size: 18px; line-height: 28px; }
h2 { font-size: 15px; line-height: 22px; }
p { margin: 0; }
a { color: var(--accent-strong); text-decoration: none; }
a:hover { text-decoration: underline; }
::selection { background: rgba(255, 255, 255, 0.22); color: var(--ink-strong); }
*:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
code, .mono { font-family: var(--mono); font-size: 14px; }
.muted { color: var(--ink-muted); }
.faint { color: var(--ink-faint); }
.ico { width: 16px; height: 16px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

/* Shell: a fixed sidebar from 1024px up, a top bar with tabs below it. */
.shell { display: flex; min-height: 100svh; }
.side {
  position: sticky; top: 0; height: 100svh; width: 240px; flex-shrink: 0; display: flex; flex-direction: column;
  border-right: 1px solid var(--line-soft); background: var(--panel);
}
.brand { display: flex; align-items: center; gap: 10px; padding: 16px 16px 12px; }
.brand svg { width: 30px; height: 30px; flex-shrink: 0; }
.brand-name { font-size: 15px; font-weight: 600; line-height: 20px; letter-spacing: -0.3px; color: var(--ink-strong); }
.brand-sub { font-family: var(--mono); font-size: 14px; line-height: 22px; color: var(--ink-faint); }
.nav { display: flex; flex-direction: column; gap: 2px; padding: 4px 12px; flex: 1; overflow-y: auto; }
.nav-label { padding: 12px 10px 4px; font-size: 14px; font-weight: 500; color: var(--ink-faint); }
.nav a {
  display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 10px; border-radius: var(--radius-control);
  font-size: 14px; font-weight: 500; color: var(--ink); text-decoration: none; transition: background-color 0.15s, color 0.15s;
}
.nav a .ico { color: var(--ink-muted); }
.nav a:hover { background: var(--raised); color: var(--ink-strong); }
.nav a:hover .ico { color: var(--ink-strong); }
.nav a.on { background: var(--accent-soft); color: var(--ink-strong); }
.nav a.on .ico { color: var(--accent-strong); }
.nav-count { margin-left: auto; font-family: var(--mono); font-size: 14px; color: var(--ink-muted); }
.nav-count.crit { color: var(--crit); }
.side-meta { margin: 0; padding: 12px 22px 16px; border-top: 1px solid var(--line-soft); display: grid; gap: 6px; font-size: 14px; }
.side-meta dt { color: var(--ink-faint); line-height: 20px; }
.side-meta dd { margin: 0 0 4px; font-family: var(--mono); color: var(--ink); overflow-wrap: anywhere; line-height: 20px; }
main { min-width: 0; flex: 1; }
.page { margin: 0 auto; width: 100%; max-width: 1440px; padding: 28px 32px 64px; display: flex; flex-direction: column; gap: 20px; }
.page-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px 16px; }
.page-head p { margin-top: 2px; font-size: 14px; color: var(--ink-muted); }
.panel { display: flex; flex-direction: column; gap: 20px; }
.panel[hidden] { display: none; }
section.block { display: flex; flex-direction: column; gap: 10px; }
.block-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; }
.block-head p { font-size: 14px; color: var(--ink-muted); }

@media (max-width: 1023px) {
  .shell { flex-direction: column; }
  .side { position: sticky; top: 0; z-index: 30; height: auto; width: 100%; border-right: 0; border-bottom: 1px solid var(--line); }
  .brand { padding: 10px 16px 0; }
  .brand svg { width: 24px; height: 24px; }
  .nav { flex-direction: row; gap: 16px; padding: 0 16px; overflow-x: auto; scrollbar-width: none; }
  .nav-label, .nav a .ico, .side-meta { display: none; }
  .nav a { position: relative; height: auto; padding: 10px 4px; border-radius: 0; background: none !important; color: var(--ink-muted); white-space: nowrap; }
  .nav a.on { color: var(--ink-strong); }
  .nav a.on::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--accent); }
  .nav-count { margin-left: 4px; }
  .page { padding: 20px 16px 48px; }
}
@media (min-width: 640px) and (max-width: 1023px) { .page { padding-inline: 24px; } }

/* Cards and tables, as in the Admin UI's list pages. */
.card { border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--panel); overflow-x: auto; }
table { min-width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; }
th { height: 44px; padding: 0 16px; font-weight: 500; color: var(--ink-muted); white-space: nowrap; }
td { height: 48px; padding: 8px 16px; color: var(--ink); vertical-align: middle; }
thead tr, tbody tr { border-bottom: 1px solid var(--line-soft); }
tbody tr:last-child { border-bottom: 0; }
td.num, th.num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
td.strong { color: var(--ink-strong); font-weight: 500; }
td.id { font-family: var(--mono); color: var(--ink-strong); overflow-wrap: anywhere; }

/* Badges: DbBadge's tones. */
.badge {
  display: inline-flex; align-items: center; min-height: 24px; padding: 2px 8px; border-radius: var(--radius-control);
  font-family: var(--mono); font-size: 14px; font-weight: 500; line-height: 1; white-space: nowrap;
  background: var(--line); color: var(--ink);
}
.badge.ok { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
.badge.warn { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
.badge.crit { background: color-mix(in srgb, var(--crit) 20%, transparent); color: var(--crit); }
.badge.accent { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent-strong); }
.badges { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.t-ok { color: var(--ok); } .t-warn { color: var(--warn); } .t-crit { color: var(--crit); }

/* Alerts: DbAlert. */
.alert { display: flex; align-items: flex-start; gap: 10px; border: 1px solid; border-radius: var(--radius-control); padding: 10px 14px; }
.alert .ico { margin-top: 2px; }
.alert-title { font-size: 14px; font-weight: 600; line-height: 20px; color: var(--ink-strong); }
.alert-body { margin-top: 2px; font-size: 14px; line-height: 20px; color: var(--ink); }
.alert.ok { border-color: color-mix(in srgb, var(--ok) 30%, transparent); background: color-mix(in srgb, var(--ok) 10%, transparent); color: var(--ok); }
.alert.warn { border-color: color-mix(in srgb, var(--warn) 30%, transparent); background: color-mix(in srgb, var(--warn) 10%, transparent); color: var(--warn); }
.alert.crit { border-color: color-mix(in srgb, var(--crit) 30%, transparent); background: color-mix(in srgb, var(--crit) 10%, transparent); color: var(--crit); }

/* Run totals. */
.stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--panel); }
.stat { padding: 14px 16px; border-left: 1px solid var(--line-soft); }
.stat:first-child { border-left: 0; }
.stat-label { font-size: 14px; color: var(--ink-muted); }
.stat-value { margin-top: 2px; font-family: var(--mono); font-size: 22px; line-height: 30px; font-weight: 600; color: var(--ink-strong); font-variant-numeric: tabular-nums; }
@media (max-width: 720px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat { border-left: 0; border-top: 1px solid var(--line-soft); }
  .stat:nth-child(-n+2) { border-top: 0; }
  .stat:nth-child(even) { border-left: 1px solid var(--line-soft); }
}

.bar { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; min-width: 80px; }
.bar > span { display: block; height: 100%; background: var(--ok); }
.bar.crit > span { background: var(--crit); }

/* Toolbar: DbSearchField and DbSelect. */
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.search {
  display: flex; align-items: center; gap: 8px; height: 36px; min-width: 220px; flex: 1; padding: 0 8px 0 10px;
  border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--panel); transition: border-color 0.15s;
}
.search:focus-within { border-color: color-mix(in srgb, var(--accent) 60%, transparent); }
.search .ico { color: var(--ink-faint); }
.search input { flex: 1; min-width: 0; border: 0; background: transparent; outline: none; font: inherit; font-size: 14px; color: var(--ink-strong); }
.search input::placeholder { color: var(--ink-faint); }
.search input::-webkit-search-cancel-button { display: none; }
.select { position: relative; display: flex; align-items: center; height: 36px; border-radius: var(--radius-control); background: var(--raised); transition: background-color 0.15s; }
.select:focus-within { background: var(--line); }
.select select { height: 100%; appearance: none; border: 0; background: transparent; outline: none; cursor: pointer; padding: 0 34px 0 12px; font: inherit; font-size: 14px; color: var(--ink-strong); }
.select select option { background: var(--panel); }
.select .ico { position: absolute; right: 10px; pointer-events: none; color: var(--ink-faint); }
.toolbar .count { margin-left: auto; font-size: 14px; color: var(--ink-muted); font-family: var(--mono); }

/* Scenario rows. */
.rows { border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--panel); }
details.scn { border-bottom: 1px solid var(--line-soft); }
details.scn:last-child { border-bottom: 0; }
details.scn > summary {
  list-style: none; cursor: pointer; display: grid; grid-template-columns: 16px 76px minmax(0, 1fr) auto; gap: 12px;
  align-items: center; padding: 10px 16px; min-height: 56px; transition: background-color 0.15s;
}
details.scn > summary::-webkit-details-marker { display: none; }
details.scn > summary:hover { background: var(--raised); }
details.scn > summary > .ico { color: var(--ink-faint); transition: transform 0.15s; }
details.scn[open] > summary > .ico { transform: rotate(90deg); }
details.scn[open] > summary { border-bottom: 1px solid var(--line-soft); }
.scn-title { color: var(--ink-strong); font-size: 14px; font-weight: 500; line-height: 20px; overflow-wrap: anywhere; }
.scn-file { font-family: var(--mono); font-size: 14px; line-height: 20px; color: var(--ink-faint); overflow-wrap: anywhere; }
.scn-right { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px; }
.dur { font-family: var(--mono); font-size: 14px; color: var(--ink-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.scn-body { padding: 16px 16px 18px 44px; display: flex; flex-direction: column; gap: 14px; background: var(--editor); }
details.scn:last-child .scn-body { border-radius: 0 0 var(--radius-card) var(--radius-card); }
.scn-desc { font-size: 14px; color: var(--ink); max-width: 80ch; }
.label { font-size: 14px; font-weight: 500; color: var(--ink-muted); margin-bottom: 6px; }
@media (max-width: 720px) {
  details.scn > summary { grid-template-columns: 16px minmax(0, 1fr); }
  details.scn > summary > .badge, details.scn > summary > .scn-right { grid-column: 2; justify-self: start; }
  .scn-body { padding-left: 16px; }
}

ol.steps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
ol.steps ol.steps { margin: 6px 0 0 26px; }
.step { display: flex; align-items: flex-start; gap: 10px; font-size: 14px; line-height: 20px; }
.step .ico { margin-top: 2px; }
.step-n { min-width: 20px; font-family: var(--mono); color: var(--ink-faint); text-align: right; }
.step-text { color: var(--ink); overflow-wrap: anywhere; }
.step-meta { display: inline-flex; gap: 10px; margin-left: 8px; }
.step.failed .step-text { color: var(--ink-strong); font-weight: 500; }

pre.err, pre.out { margin: 0; padding: 10px 12px; border-radius: var(--radius-control); font-family: var(--mono); font-size: 14px; line-height: 1.55; white-space: pre-wrap; overflow-x: auto; }
pre.err { border: 1px solid color-mix(in srgb, var(--crit) 30%, transparent); background: color-mix(in srgb, var(--crit) 10%, transparent); color: var(--crit); }
pre.out { background: var(--raised); color: var(--ink); max-height: 320px; overflow: auto; }
details.out > summary { cursor: pointer; font-size: 14px; color: var(--ink-muted); padding: 2px 0; }
details.out > summary:hover { color: var(--ink-strong); }
details.out[open] > summary { margin-bottom: 6px; }

.media { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.media figure, .videos figure { margin: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.media img { display: block; width: 100%; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--canvas); }
.media figcaption, .videos figcaption { font-size: 14px; line-height: 20px; color: var(--ink-muted); overflow-wrap: anywhere; }
.media figcaption b { font-family: var(--mono); font-weight: 500; color: var(--ink-faint); margin-right: 4px; }
.videos { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 480px), 1fr)); gap: 12px; }
.videos video { display: block; width: 100%; border: 1px solid var(--line); border-radius: var(--radius-card); background: #000; }

.files { display: flex; flex-wrap: wrap; gap: 8px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: var(--radius-control);
  background: var(--raised); font-family: var(--mono); font-size: 14px; color: var(--ink); text-decoration: none; transition: background-color 0.15s, color 0.15s;
}
.chip:hover { background: var(--line); color: var(--ink-strong); text-decoration: none; }
.chip .ico { width: 14px; height: 14px; }
button.chip { border: 0; cursor: pointer; font: inherit; font-family: var(--mono); font-size: 14px; }

.cmd { display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 12px; border-radius: var(--radius-control); background: var(--raised); }
.cmd code { flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; color: var(--ink-strong); }
.cmd button {
  display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex-shrink: 0; border: 0;
  border-radius: var(--radius-control); background: transparent; color: var(--ink-muted); cursor: pointer; transition: background-color 0.15s, color 0.15s;
}
.cmd button:hover { background: var(--line); color: var(--ink-strong); }
.cmd button.done { color: var(--ok); }

.empty {
  display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 56px 32px; text-align: center;
  border: 1px dashed var(--line); border-radius: var(--radius-card); background: color-mix(in srgb, var(--panel) 50%, transparent);
}
.empty-icon { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--raised); color: var(--ink-muted); }
.empty-icon .ico { width: 20px; height: 20px; }
.empty h3 { font-size: 16px; }
.empty p { max-width: 28rem; font-size: 14px; color: var(--ink-muted); }

.grid th, .grid td { text-align: center; }
.grid th:first-child, .grid td:first-child { text-align: left; font-family: var(--mono); }
.cell.ok { color: var(--ok); }
.cell.bad { background: color-mix(in srgb, var(--crit) 10%, transparent); color: var(--crit); font-weight: 600; }
</style>
</head>
<body>
<div class="shell">
  <aside class="side">
    <div class="brand">
      <svg viewBox="0 0 54 64" aria-hidden="true">
        <path fill="var(--brand-mark)" d="M6 0h14a20 20 0 0 1 20 20v4a20 20 0 0 1-20 20H6a6 6 0 0 1-6-6V6a6 6 0 0 1 6-6Z"/>
        <path fill="var(--brand-mark)" d="M20 20h14a20 20 0 0 1 20 20v4a20 20 0 0 1-20 20H20a6 6 0 0 1-6-6V26a6 6 0 0 1 6-6Z"/>
        <path fill="var(--brand-mark-overlap)" d="M34 20a20 20 0 0 1 6 .92V24a20 20 0 0 1-20 20h-6V26a6 6 0 0 1 6-6Z"/>
      </svg>
      <div>
        <p class="brand-name">Dopbase</p>
        <p class="brand-sub">e2e report</p>
      </div>
    </div>
    <nav class="nav" aria-label="Report" id="nav">
      <p class="nav-label">This run</p>
      <a href="#overview" data-tab="overview"><svg class="ico" viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg><span>Overview</span></a>
      <a href="#scenarios" data-tab="scenarios"><svg class="ico" viewBox="0 0 24 24"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></svg><span>Scenarios</span><span class="nav-count" id="count-scenarios"></span></a>
      <a href="#failures" data-tab="failures"><svg class="ico" viewBox="0 0 24 24"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg><span>Failures</span><span class="nav-count" id="count-failures"></span></a>
      <a href="#coverage" data-tab="coverage"><svg class="ico" viewBox="0 0 24 24"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg><span>Coverage</span></a>
    </nav>
    <dl class="side-meta" id="meta"></dl>
  </aside>
  <main>
    <div class="page">
      <header class="page-head">
        <div>
          <h1 id="page-title">Overview</h1>
          <p id="page-sub"></p>
        </div>
      </header>
      <section class="panel" id="panel-overview"></section>
      <section class="panel" id="panel-scenarios" hidden>
        <div class="toolbar">
          <label class="search">
            <svg class="ico" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input id="f-text" type="search" placeholder="Search titles, steps and files" aria-label="Search scenarios">
          </label>
          <div class="select"><select id="f-suite" aria-label="Suite"><option value="">All suites</option></select><svg class="ico" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></div>
          <div class="select"><select id="f-tag" aria-label="Tag"><option value="">All tags</option></select><svg class="ico" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></div>
          <div class="select"><select id="f-status" aria-label="Status"><option value="">Any result</option><option value="passed">Passed</option><option value="failed">Failed</option><option value="flaky">Flaky</option><option value="skipped">Skipped</option></select><svg class="ico" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></div>
          <span class="count" id="f-count"></span>
        </div>
        <div id="scenario-list"></div>
      </section>
      <section class="panel" id="panel-failures" hidden></section>
      <section class="panel" id="panel-coverage" hidden></section>
    </div>
  </main>
</div>
<script id="data" type="application/json">/*__DATA__*/null</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById("data").textContent) || {};
  var run = data.run || { meta: {}, tests: [], errors: [] };
  var tests = run.tests || [];
  var SUITES = ["cli", "api", "ui", "journeys"];
  var LABEL = { cli: "CLI", api: "API", ui: "Admin UI", journeys: "Journeys" };
  var TONE = { passed: "ok", failed: "crit", flaky: "warn", skipped: "" };
  var PAGES = {
    overview: ["Overview", "How each suite did and what the tests reach."],
    scenarios: ["Scenarios", "Every test as the steps it took. Open one to see its screens and output."],
    failures: ["Failures", "Tests that failed or passed only on retry, with where they broke and how to rerun them."],
    coverage: ["Coverage", "Each CLI command, API route and Admin UI page, and the tests in its own suite that reach it."]
  };

  var ICON = {
    check: '<svg class="ico t-ok" viewBox="0 0 24 24" aria-label="passed"><path d="M20 6 9 17l-5-5"/></svg>',
    x: '<svg class="ico t-crit" viewBox="0 0 24 24" aria-label="failed"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    chevron: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
    copy: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
    done: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    file: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
    alert: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    ok: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    layers: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/></svg>'
  };

  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function rich(s) { return esc(s).replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>"); }
  // Files under .e2e/ link relative to report/, so the CI artifact (which
  // holds .e2e/'s contents at its root) still opens them once extracted.
  function link(path) {
    var p = String(path);
    var rel = p.indexOf(".e2e/") === 0 ? "../" + p.slice(".e2e/".length) : "../../" + p;
    return rel.split("/").map(encodeURIComponent).join("/");
  }
  function time(ms) {
    if (ms == null) return "";
    if (ms < 1000) return ms + " ms";
    var s = ms / 1000;
    if (s < 60) return s.toFixed(1) + " s";
    return Math.floor(s / 60) + " min " + Math.round(s % 60) + " s";
  }
  function count(list, status) { return list.filter(function (t) { return t.status === status; }).length; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function $(id) { return document.getElementById(id); }
  function badge(text, tone) { return '<span class="badge ' + (tone || "") + '">' + esc(text) + "</span>"; }
  function statusBadge(status) { return badge(status, TONE[status]); }
  function empty(icon, title, body) {
    return '<div class="empty"><div class="empty-icon">' + icon + "</div><h3>" + esc(title) + "</h3>" + (body ? "<p>" + body + "</p>" : "") + "</div>";
  }
  function alertBox(tone, icon, title, body) {
    return '<div class="alert ' + tone + '" role="' + (tone === "crit" ? "alert" : "status") + '">' + icon +
      '<div><p class="alert-title">' + title + "</p>" + (body ? '<p class="alert-body">' + body + "</p>" : "") + "</div></div>";
  }
  function cmd(text) {
    return '<div class="cmd"><code>' + esc(text) + '</code><button type="button" data-copy="' + esc(text) + '" aria-label="Copy command" title="Copy command">' + ICON.copy + "</button></div>";
  }

  // Sidebar: what was run, from where.
  var m = run.meta || {};
  var metaRows = [
    ["Started", m.startedAt ? new Date(m.startedAt).toLocaleString() : "No run found"],
    ["Version", m.version ? "v" + m.version : ""],
    ["Branch", m.branch ? m.branch + (m.commit ? " @ " + m.commit : "") : ""],
    ["Binary", m.binary || ""],
    ["Filter", m.grep ? "--grep " + m.grep : ""]
  ];
  $("meta").innerHTML = metaRows.filter(function (r) { return r[1]; }).map(function (r) {
    return "<dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd>";
  }).join("");

  var failed = tests.filter(function (t) { return t.status === "failed"; });
  var flaky = tests.filter(function (t) { return t.status === "flaky"; });
  $("count-scenarios").textContent = tests.length || "";
  var fc = $("count-failures");
  fc.textContent = failed.length + flaky.length || "";
  if (failed.length) fc.classList.add("crit");

  // Overview
  function overviewPanel() {
    var html = "";
    if (!tests.length && !(run.errors || []).length) {
      $("panel-overview").innerHTML = empty(ICON.layers, "No results yet", "Run <code>bun run test:e2e</code> and this page fills in.");
      return;
    }
    var cov = data.coverage;
    var missing = cov ? cov.surfaces.reduce(function (n, s) { return n + s.missing; }, 0) : 0;
    if (failed.length) {
      html += alertBox("crit", ICON.alert, plural(failed.length, "test failed", "tests failed"),
        'Each one is in <a href="#failures" data-go="failures">Failures</a> with the step it broke on, its screens and a command to rerun it.');
    } else if ((run.errors || []).length) {
      html += alertBox("crit", ICON.alert, "The run hit an error outside a test", "See the end of this page.");
    } else if (cov && !cov.passed) {
      html += alertBox("crit", ICON.alert, "Every test passed, but coverage failed",
        plural(missing, "command, route or page has", "commands, routes or pages have") + ' no test. See <a href="#coverage" data-go="coverage">Coverage</a>.');
    } else if (flaky.length) {
      html += alertBox("warn", ICON.alert, "Every test passed, " + plural(flaky.length, "one", "some") + " only on retry",
        plural(flaky.length, "flaky test is", "flaky tests are") + ' in <a href="#failures" data-go="failures">Failures</a>.');
    } else {
      html += alertBox("ok", ICON.ok, "Every test passed", plural(tests.length, "test", "tests") + " in " + time(m.durationMs) + ".");
    }

    html += '<div class="stats">' +
      stat("Passed", count(tests, "passed"), "") +
      stat("Failed", failed.length, failed.length ? "t-crit" : "") +
      stat("Flaky", flaky.length, flaky.length ? "t-warn" : "") +
      stat("Skipped", count(tests, "skipped"), "") +
      stat("Duration", time(m.durationMs) || "–", "") + "</div>";

    var rows = "";
    (data.unit || []).forEach(function (l) {
      rows += '<tr><td class="strong">' + esc(l.name) + '</td><td><code class="muted">' + esc(l.command) + "</code></td>" +
        '<td class="num">–</td><td>' + statusBadge(l.status) + '</td><td class="num">' + time(l.durationMs) + "</td></tr>";
    });
    SUITES.forEach(function (s) {
      var list = tests.filter(function (t) { return t.project === s; });
      if (!list.length) return;
      var files = {}; list.forEach(function (t) { files[t.file] = 1; });
      var dur = list.reduce(function (n, t) { return n + (t.durationMs || 0); }, 0);
      var parts = [badge(count(list, "passed") + " passed", "ok")];
      ["failed", "flaky", "skipped"].forEach(function (st) { var n = count(list, st); if (n) parts.push(badge(n + " " + st, TONE[st])); });
      rows += '<tr><td class="strong">' + LABEL[s] + '</td><td><code class="muted">e2e/' + s + "/ · " + plural(Object.keys(files).length, "file", "files") + "</code></td>" +
        '<td class="num">' + list.length + '</td><td><span class="badges">' + parts.join("") + '</span></td><td class="num">' + time(dur) + "</td></tr>";
    });
    html += '<section class="block"><div class="block-head"><h2>Suites</h2>' +
      ((data.unit || []).length ? "<p>Run through <code>bun run test</code>, so the checks before e2e show too.</p>" : "") + "</div>" +
      '<div class="card"><table><thead><tr><th>Layer</th><th>Where</th><th class="num">Tests</th><th>Result</th><th class="num">Time</th></tr></thead><tbody>' +
      rows + "</tbody></table></div></section>";

    if (cov) {
      html += '<section class="block"><div class="block-head"><h2>Coverage</h2><p>' +
        (cov.fullRun ? "Mode " + esc(cov.mode) + "." : "A partial run, so coverage is only reported.") + "</p></div>" +
        '<div class="card"><table><tbody>' + cov.surfaces.map(function (s) {
          var done = s.covered + s.skipped, pct = s.total ? Math.round(done * 100 / s.total) : 100;
          // Hits only count in their own suite, so a suite that didn't run says nothing.
          if (s.ran === false) {
            return '<tr><td class="strong">' + esc(s.label) + '</td><td class="num">– / ' + s.total + '</td><td style="width:50%"><div class="bar"><span style="width:0"></span></div></td>' +
              "<td>" + badge("not run") + "</td></tr>";
          }
          return '<tr><td class="strong">' + esc(s.label) + '</td><td class="num">' + done + " / " + s.total + '</td><td style="width:50%"><div class="bar' + (s.missing && cov.fullRun ? " crit" : "") + '"><span style="width:' + pct + '%"></span></div></td>' +
            "<td>" + (s.missing ? badge(s.missing + (cov.fullRun ? " missing" : " not reached"), cov.fullRun ? "crit" : "") : badge("complete", "ok")) + "</td></tr>";
        }).join("") + "</tbody></table></div></section>";
    }

    tests.forEach(function (t) {
      (t.attachments || []).forEach(function (a) {
        if (a.name !== "access-matrix.json" || !a.text) return;
        try { html += matrixGrid(t, JSON.parse(a.text)); } catch (e) {}
      });
    });

    if ((run.errors || []).length) {
      html += '<section class="block"><div class="block-head"><h2>Errors outside a test</h2><p>Playwright reported these before or after the tests ran.</p></div>' +
        run.errors.map(function (e) { return '<pre class="err">' + esc(e) + "</pre>"; }).join("") + "</section>";
    }
    $("panel-overview").innerHTML = html;
  }
  function stat(label, value, cls) {
    return '<div class="stat"><p class="stat-label">' + esc(label) + '</p><p class="stat-value ' + cls + '">' + esc(value) + "</p></div>";
  }

  // matrix: { columns: [action], rows: [{ label, cells: [{ expected, actual }] }] }
  function matrixGrid(test, matrix) {
    var bad = [];
    var body = (matrix.rows || []).map(function (r) {
      return "<tr><td>" + esc(r.label) + "</td>" + (r.cells || []).map(function (c, i) {
        var ok = c.expected === c.actual;
        if (!ok) bad.push(r.label + " · " + matrix.columns[i] + ": expected " + c.expected + ", got " + c.actual);
        var mark = c.actual === "allow" ? ICON.check : c.actual === "deny" ? '<span class="faint">denied</span>' : esc(c.actual);
        return '<td class="cell ' + (ok ? "ok" : "bad") + '" title="Expected ' + esc(c.expected) + '">' + mark + "</td>";
      }).join("") + "</tr>";
    }).join("");
    return '<section class="block"><div class="block-head"><h2>Access matrix</h2><p>From <code>' + esc(test.file) + "</code>. A red cell got a different answer than expected.</p></div>" +
      '<div class="card grid"><table><thead><tr><th>Who</th>' + (matrix.columns || []).map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") +
      "</tr></thead><tbody>" + body + "</tbody></table></div>" +
      (bad.length ? '<pre class="err">' + esc(bad.join("\n")) + "</pre>" : "") + "</section>";
  }

  // A scenario: one test, as the steps it took.
  function stepsHtml(steps) {
    if (!steps || !steps.length) return "";
    return '<ol class="steps">' + steps.map(function (s, i) {
      var bad = s.status === "failed";
      return '<li><div class="step' + (bad ? " failed" : "") + '"><span class="step-n">' + (i + 1) + "</span>" + (bad ? ICON.x : ICON.check) +
        '<span class="step-text">' + rich(s.title) + '<span class="step-meta"><span class="dur">' + time(s.durationMs) + "</span>" +
        (s.screenshot ? '<a href="' + link(s.screenshot) + '" target="_blank" rel="noopener">Screen</a>' : "") + "</span></span></div>" +
        (s.error && bad && !(s.steps || []).length ? '<pre class="err" style="margin:6px 0 0 46px">' + esc(s.error) + "</pre>" : "") +
        stepsHtml(s.steps) + "</li>";
    }).join("") + "</ol>";
  }
  function rerun(t) {
    // Same escaping as e2e/run.ts: a regex for --grep, single-quoted for the shell.
    var pattern = t.title.slice(0, 60).replace(/[.*+?^$\{}()|[\]\\]/g, "\\$&").replace(/'/g, "'\\''");
    return "bun run test:e2e --project " + t.project + " --grep '" + pattern + "'";
  }
  function videoLabel(name, n, total) {
    var who = name.indexOf("video: ") === 0 ? name.slice(7) : "";
    if (who) return "Recording: " + who + "'s browser";
    // Playwright names the test's own page "video"; a second browser comes
    // from the newContext fixture with a name.
    return total > 1 ? "Recording: main browser" : "Recording";
  }
  function bodyHtml(t, failureView) {
    var att = t.attachments || [];
    var out = '<p class="scn-desc">' + (t.description ? rich(t.description) : '<span class="t-crit">This test has no description.</span>') + "</p>";
    if (t.status !== "passed" && t.status !== "skipped" && t.failedStep) {
      out += '<div><p class="label">Broke at</p><p class="step-text">' + rich(t.failedStep) + "</p></div>";
    }
    if (t.error && t.status !== "passed") {
      out += '<pre class="err">' + esc(t.error.message) + (t.error.location ? "\n  at " + esc(t.error.location) : "") + "</pre>";
    }
    if (t.status === "failed" || t.status === "flaky") out += '<div><p class="label">Rerun this test</p>' + cmd(rerun(t)) + "</div>";
    if ((t.steps || []).length) out += '<div><p class="label">Steps</p>' + stepsHtml(t.steps) + "</div>";

    var videos = att.filter(function (a) { return a.path && a.contentType && a.contentType.indexOf("video/") === 0; });
    if (videos.length) {
      out += '<div><p class="label">Video</p><div class="videos">' + videos.map(function (a, i) {
        return '<figure><video controls preload="none" src="' + link(a.path) + '"></video><figcaption>' + esc(videoLabel(a.name, i, videos.length)) + "</figcaption></figure>";
      }).join("") + "</div></div>";
    }

    // Step screens in order, so you can follow the test without rerunning it.
    var shots = att.filter(function (a) { return a.path && a.contentType === "image/png"; });
    if (shots.length) {
      if (failureView) shots = shots.slice(-4);
      out += '<div><p class="label">' + (failureView ? "Last screens" : "Screens") + '</p><div class="media">' + shots.map(function (a, i) {
        var caption = a.name.indexOf("screenshot: ") === 0 ? a.name.slice(12) : a.name;
        return '<figure><a href="' + link(a.path) + '" target="_blank" rel="noopener"><img loading="lazy" src="' + link(a.path) + '" alt="' + esc(caption) + '"></a>' +
          "<figcaption><b>" + (i + 1) + "</b>" + rich(caption) + "</figcaption></figure>";
      }).join("") + "</div></div>";
    }

    var files = att.filter(function (a) { return a.path && a.contentType !== "image/png" && (a.contentType || "").indexOf("video/") !== 0; });
    if (files.length) {
      out += '<div><p class="label">Files</p><div class="files">' + files.map(function (a) {
        return '<a class="chip" href="' + link(a.path) + '" target="_blank" rel="noopener">' + ICON.file + esc(a.name) + "</a>";
      }).join("") + "</div>" +
        (files.some(function (a) { return a.name === "trace"; }) ? '<p class="muted" style="font-size:14px;margin-top:6px">Open a trace with <code>e2e/node_modules/.bin/playwright show-trace</code> and the file path, or drop it on trace.playwright.dev.</p>' : "") +
        "</div>";
    }

    att.forEach(function (a) {
      if (!a.text || a.name === "access-matrix.json") return;
      if (!failureView && a.name.indexOf("cli: ") !== 0) return;
      var text = failureView && a.name === "server.log" ? a.text.split("\n").slice(-40).join("\n") : a.text;
      var label = a.name === "server.log" && failureView ? "server.log (last 40 lines)" : a.name;
      out += '<details class="out"><summary>' + esc(label) + '</summary><pre class="out">' + esc(text) + "</pre></details>";
    });
    return out;
  }
  function scenario(t, failureView) {
    return '<details class="scn"' + (failureView ? " open" : "") + ' data-id="' + esc(t.id) + '"><summary>' + ICON.chevron + statusBadge(t.status) +
      '<span><span class="scn-title">' + esc(t.title) + '</span><br><span class="scn-file">' + esc(LABEL[t.project] || t.project) + " · " + esc(t.file) + ":" + t.line + "</span></span>" +
      '<span class="scn-right">' + (t.tags || []).map(function (g) { return badge(g); }).join("") + '<span class="dur">' + time(t.durationMs) + "</span></span>" +
      '</summary><div class="scn-body"></div></details>';
  }
  // Bodies render when a row first opens, so a big run stays quick.
  var byId = {};
  tests.forEach(function (t) { byId[t.id] = t; });
  document.addEventListener("toggle", function (event) {
    var el = event.target;
    if (!el.classList || !el.classList.contains("scn") || !el.open) return;
    var body = el.querySelector(".scn-body");
    if (body.childElementCount) return;
    var t = byId[el.getAttribute("data-id")];
    if (t) body.innerHTML = bodyHtml(t, el.closest("#panel-failures") !== null);
  }, true);

  var suiteSel = $("f-suite"), tagSel = $("f-tag");
  SUITES.forEach(function (s) { if (tests.some(function (t) { return t.project === s; })) suiteSel.insertAdjacentHTML("beforeend", '<option value="' + s + '">' + LABEL[s] + "</option>"); });
  var tags = {}; tests.forEach(function (t) { (t.tags || []).forEach(function (g) { tags[g] = 1; }); });
  Object.keys(tags).sort().forEach(function (g) { tagSel.insertAdjacentHTML("beforeend", "<option>" + esc(g) + "</option>"); });
  function flat(steps) { return (steps || []).map(function (s) { return s.title + " " + flat(s.steps); }).join(" "); }
  function renderScenarios() {
    var suite = suiteSel.value, tag = tagSel.value, status = $("f-status").value, text = $("f-text").value.toLowerCase();
    var list = tests.filter(function (t) {
      if (suite && t.project !== suite) return false;
      if (tag && (t.tags || []).indexOf(tag) < 0) return false;
      if (status && t.status !== status) return false;
      if (text && (t.title + " " + (t.description || "") + " " + t.file + " " + flat(t.steps)).toLowerCase().indexOf(text) < 0) return false;
      return true;
    });
    $("f-count").textContent = list.length === tests.length ? plural(tests.length, "test", "tests") : list.length + " of " + tests.length;
    $("scenario-list").innerHTML = !tests.length
      ? empty(ICON.layers, "No results yet", "Run <code>bun run test:e2e</code> and every test shows here.")
      : list.length
        ? '<div class="rows">' + list.map(function (t) { return scenario(t, false); }).join("") + "</div>"
        : empty(ICON.layers, "Nothing matches", "Try another search or clear a filter.");
  }
  ["f-suite", "f-tag", "f-status", "f-text"].forEach(function (id) { $(id).addEventListener("input", renderScenarios); });

  // Failures
  function failuresPanel() {
    var list = failed.concat(flaky);
    $("panel-failures").innerHTML = list.length
      ? '<div class="rows">' + list.map(function (t) { return scenario(t, true); }).join("") + "</div>"
      : empty(ICON.ok, "No failures", tests.length ? "Every test passed on its first try." : "Nothing has run yet.");
    // Open bodies render now: the toggle event doesn't fire for rows that start open.
    Array.prototype.forEach.call($("panel-failures").querySelectorAll("details.scn"), function (el) {
      el.querySelector(".scn-body").innerHTML = bodyHtml(byId[el.getAttribute("data-id")], true);
    });
  }

  // Coverage
  function coveragePanel() {
    var c = data.coverage;
    if (!c) {
      $("panel-coverage").innerHTML = empty(ICON.layers, "No coverage data", "<code>bun run test:e2e</code> writes it after the tests run.");
      return;
    }
    var html = c.fullRun ? "" : alertBox("warn", ICON.alert, "Partial run", "Only some suites ran, so missing entries are listed but don't fail the run.");
    var order = { missing: 0, skipped: 1, covered: 2 };
    var tone = { missing: "crit", skipped: "warn", covered: "ok" };
    c.surfaces.forEach(function (s) {
      var done = s.covered + s.skipped;
      if (s.ran === false) {
        html += '<section class="block"><div class="block-head"><h2>' + esc(s.label) + "</h2><p>Not checked: the <code>" + esc(s.kind) +
          "</code> suite wasn't in this run. Run <code>bun run test:e2e:" + esc(s.kind) + "</code> to check it.</p></div></section>";
        return;
      }
      html += '<section class="block"><div class="block-head"><h2>' + esc(s.label) + '</h2><p class="mono">' + done + " / " + s.total +
        (s.missing ? ' · <span class="t-crit">' + s.missing + " missing</span>" : "") + "</p></div>" +
        '<div class="card"><table><thead><tr><th>Entry</th><th>Status</th><th>Tests, or why it is skipped</th></tr></thead><tbody>' +
        s.entries.slice().sort(function (a, b) { return order[a.status] - order[b.status] || (a.id < b.id ? -1 : 1); }).map(function (e) {
          return '<tr><td class="id">' + esc(e.id) + "</td><td>" + badge(e.status, tone[e.status]) + "</td><td>" +
            (e.reason ? '<span class="muted">' + esc(e.reason) + "</span>" : e.tests.map(esc).join("<br>")) + "</td></tr>";
        }).join("") + "</tbody></table></div></section>";
    });
    if (c.unexplained.length) {
      html += '<section class="block"><div class="block-head"><h2>Tests without a description or steps</h2><p>The report can only show a test as a scenario when it has both.</p></div>' +
        '<div class="card"><table><tbody>' + c.unexplained.map(function (u) {
          return '<tr><td class="id">' + esc(u.test) + '</td><td class="muted">No ' + esc(u.lacks.join(", no ")) + "</td></tr>";
        }).join("") + "</tbody></table></div></section>";
    }
    $("panel-coverage").innerHTML = html;
  }

  // Copy buttons, as DbCopyButton does it.
  document.addEventListener("click", function (event) {
    var btn = event.target.closest && event.target.closest("[data-copy]");
    if (!btn) return;
    var text = btn.getAttribute("data-copy");
    var done = function () {
      btn.innerHTML = ICON.done; btn.classList.add("done"); btn.setAttribute("aria-label", "Copied");
      setTimeout(function () { btn.innerHTML = ICON.copy; btn.classList.remove("done"); btn.setAttribute("aria-label", "Copy command"); }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    else {
      var area = document.createElement("textarea");
      area.value = text; document.body.appendChild(area); area.select();
      try { document.execCommand("copy"); done(); } catch (e) {}
      area.remove();
    }
  });

  function show(requested) {
    var name = requested || (location.hash || "#overview").slice(1);
    if (!PAGES[name]) name = "overview";
    Object.keys(PAGES).forEach(function (n) {
      $("panel-" + n).hidden = n !== name;
      var tab = document.querySelector('[data-tab="' + n + '"]');
      tab.classList.toggle("on", n === name);
      if (n === name) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current");
    });
    $("page-title").textContent = PAGES[name][0];
    $("page-sub").textContent = PAGES[name][1];
    document.title = PAGES[name][0] + " · E2E report · Dopbase";
  }
  overviewPanel(); renderScenarios(); failuresPanel(); coveragePanel();
  window.addEventListener("hashchange", function () { show(); });
  // Tabs switch on click too, for viewers where the hash can't change.
  document.addEventListener("click", function (event) {
    var el = event.target.closest && event.target.closest("[data-tab],[data-go]");
    if (!el) return;
    event.preventDefault();
    var name = el.getAttribute("data-tab") || el.getAttribute("data-go");
    try { history.replaceState(null, "", "#" + name); } catch (e) {}
    show(name);
    window.scrollTo(0, 0);
  });
  show(location.hash ? undefined : failed.length ? "failures" : "overview");
})();
</script>
</body>
</html>
`;
