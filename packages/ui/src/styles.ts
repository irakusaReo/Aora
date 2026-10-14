// One small stylesheet shared by the web apps, so no CSS framework is needed.
export const BASE_CSS = `
:root { color-scheme: light; --ink:#16181d; --muted:#5b6170; --line:#e3e5ea; --bg:#f7f8fa; --card:#fff;
  --accent:#0b6b4f; --warn-bg:#fff3cd; --warn-ink:#664d03; --bad:#a1281b; }
* { box-sizing: border-box; }
body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color:var(--ink); background:var(--bg); }
.aora-sandbox-banner { position:sticky; top:0; z-index:10; background:var(--warn-bg); color:var(--warn-ink);
  font-weight:600; padding:8px 16px; text-align:center; font-size:14px; border-bottom:1px solid #f0d78c; }
header.aora-top { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 16px;
  background:var(--card); border-bottom:1px solid var(--line); }
header.aora-top nav { display:flex; gap:16px; flex-wrap:wrap; }
header.aora-top a { color:var(--ink); text-decoration:none; }
main { max-width:1040px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:24px; margin:0 0 16px; } h2 { font-size:18px; margin:24px 0 12px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:16px; }
table { width:100%; border-collapse:collapse; font-size:14px; }
th, td { text-align:left; padding:8px; border-bottom:1px solid var(--line); vertical-align:top; }
td.num, th.num { text-align:right; font-variant-numeric: tabular-nums; }
form.stack { display:grid; gap:12px; max-width:480px; }
label { display:grid; gap:4px; font-size:14px; color:var(--muted); }
input, select, textarea { font:inherit; padding:8px 10px; border:1px solid var(--line); border-radius:6px; background:#fff; color:var(--ink); }
button { font:inherit; padding:8px 14px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
button.secondary { background:#fff; color:var(--accent); }
.muted { color:var(--muted); } .error { color:var(--bad); } .ok { color:var(--accent); }
.pill { display:inline-block; padding:2px 8px; border-radius:999px; background:#eef0f4; font-size:12px; }
@media (max-width: 640px) { table { font-size:13px; } th, td { padding:6px 4px; } }
`;
