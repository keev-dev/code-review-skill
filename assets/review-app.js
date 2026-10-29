/* ============================================================
   code-review app — IDE review console
   Data is injected by scripts/lib/render.mjs.
   Notes are stored by the local review server.
   ============================================================ */

const dataEl = document.getElementById("review-data");
let DATA = null;

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fatal(error) {
  const view = document.getElementById("view");
  if (!view) return;
  view.innerHTML = `<div class="load-error"><h2>Review could not load</h2><p>${esc(error?.message || String(error))}</p><pre>${esc(error?.stack || "")}</pre></div>`;
}

try {
  const raw = (dataEl?.textContent || "").trim();
  if (!raw || raw.startsWith("<!--")) throw new Error("No review data. Run render again.");
  DATA = JSON.parse(raw);
} catch (error) {
  fatal(error);
}

if (DATA) {
  const FILE_MAP = new Map((DATA.files || []).map((file) => [file.path, file]));
  const FINDING_MAP = new Map((DATA.findings || []).map((finding) => [finding.id, finding]));
  const DELTA_STATUS = DATA.iteration?.delta?.statusById || {};
  const REDUCED = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false;
  const SEVERITY = {
    blocker: { label: "Blocker", color: "var(--red)", soft: "var(--red-soft)" },
    high: { label: "High", color: "var(--orange)", soft: "var(--orange-soft)" },
    medium: { label: "Medium", color: "var(--accent)", soft: "var(--accent-soft)" },
    low: { label: "Low", color: "var(--blue)", soft: "var(--blue-soft)" },
    nit: { label: "Nit", color: "var(--purple)", soft: "var(--purple-soft)" },
    question: { label: "Question", color: "var(--pink)", soft: "var(--pink-soft)" },
    praise: { label: "Praise", color: "var(--green)", soft: "var(--green-soft)" },
  };
  const ASSESSMENT = {
    sound: { label: "Okay", color: "var(--green)" },
    concern: { label: "Concern", color: "var(--orange)" },
    "needs-work": { label: "Needs work", color: "var(--red)" },
    question: { label: "Question", color: "var(--blue)" },
    "not-reviewed": { label: "Not reviewed", color: "var(--faint)" },
  };
  const VERDICT = {
    ship: { label: "Ship", color: "var(--green)", icon: "check" },
    "ship-with-fixes": { label: "Ship with fixes", color: "var(--accent)", icon: "spark" },
    "needs-work": { label: "Needs work", color: "var(--orange)", icon: "alert" },
    blocked: { label: "Blocked", color: "var(--red)", icon: "x" },
  };
  const STATUS = {
    added: { label: "Added", color: "var(--green)" },
    modified: { label: "Modified", color: "var(--orange)" },
    deleted: { label: "Deleted", color: "var(--red)" },
    renamed: { label: "Renamed", color: "var(--blue)" },
    copied: { label: "Copied", color: "var(--purple)" },
    unmerged: { label: "Unmerged", color: "var(--red)" },
    unknown: { label: "Changed", color: "var(--faint)" },
  };
  const RISK = {
    low: { label: "Low risk", color: "var(--green)" },
    medium: { label: "Medium risk", color: "var(--orange)" },
    high: { label: "High risk", color: "var(--red)" },
  };
  const FLOW_KIND = {
    input: "INPUT", transform: "PROCESS", output: "OUTPUT", store: "STORE",
    external: "EXTERNAL", decision: "DECISION", event: "EVENT", ui: "UI",
  };
  const SEVERITY_ORDER = ["blocker", "high", "medium", "low", "question", "nit", "praise"];
  const ICONS = {
    check: '<path d="m5 12 4.5 4.5L19 6.5" stroke-linecap="round" stroke-linejoin="round"/>',
    alert: '<path d="M12 3 2.8 20h18.4L12 3Z" stroke-linejoin="round"/><path d="M12 9v5" stroke-linecap="round"/><circle cx="12" cy="17.3" r=".8" fill="currentColor" stroke="none"/>',
    x: '<path d="m6 6 12 12M18 6 6 18" stroke-linecap="round"/>',
    spark: '<path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" stroke-linejoin="round"/>',
    overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    file: '<path d="M6 3h8l4 4v14H6z" stroke-linejoin="round"/><path d="M14 3v5h5" stroke-linejoin="round"/>',
    code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/><path d="m13.5 5-3 14" stroke-linecap="round"/>',
    review: '<path d="M4 5h16v12H8l-4 4V5Z" stroke-linejoin="round"/><path d="M8 9h8M8 13h5" stroke-linecap="round"/>',
    locate: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke-linecap="round"/>',
    note: '<path d="M5 4h14v12l-4 4H5z" stroke-linejoin="round"/><path d="M15 20v-4h4M8 8h8M8 12h5" stroke-linecap="round"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4V4h11v1" stroke-linecap="round" stroke-linejoin="round"/>',
    chevron: '<path d="m9 6 6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke-linecap="round"/>',
    moon: '<path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z" stroke-linejoin="round"/>',
    external: '<path d="M14 4h6v6M20 4l-8 8" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 14v5H5V6h5" stroke-linecap="round"/>',
  };
  const serverToken = new URLSearchParams(location.search).get("token");
  const draftKey = `code-review:drafts:${DATA.meta.runId}`;
  const state = {
    route: null,
    theme: document.documentElement.dataset.theme || "dark",
    code: null,
    annotate: false,
    currentAnchor: null,
    drafts: loadDrafts(),
    notesOpen: false,
    server: {
      token: serverToken,
      connected: false,
      session: null,
      error: null,
      lastJSON: "",
    },
    activeBlock: null,
    libPromise: null,
    pollTimer: null,
    toastTimer: null,
    reloadShown: false,
  };

  /* ------------------------------------------------------------ helpers */
  function icon(name, size = 13) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  }
  function fmtInt(value) {
    return new Intl.NumberFormat("en-US").format(Number(value) || 0);
  }
  function fmtDate(value, { time = true } = {}) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString(undefined, {
      month: "short", day: "numeric",
      ...(time ? { hour: "2-digit", minute: "2-digit" } : {}),
    });
  }
  function severityMeta(id) { return SEVERITY[id] || SEVERITY.medium; }
  function assessmentMeta(id) { return ASSESSMENT[id] || ASSESSMENT["not-reviewed"]; }
  function verdictMeta(id) { return VERDICT[id] || VERDICT["needs-work"]; }
  function statusMeta(id) { return STATUS[id] || STATUS.unknown; }
  function riskMeta(id) { return RISK[id] || RISK.low; }
  function lensMeta(id) { return DATA.lensCatalog?.[id] || { label: id || "General", color: "var(--slate)" }; }
  function baseName(file) { const index = file.lastIndexOf("/"); return index >= 0 ? file.slice(index + 1) : file; }
  function dirName(file) { const index = file.lastIndexOf("/"); return index >= 0 ? file.slice(0, index + 1) : ""; }
  function fmtText(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    return text.split(/\n{2,}/).map((paragraph) => `<p>${esc(paragraph).replace(/\n/g, "<br>")}</p>`).join("");
  }
  function lineRef(finding) {
    if (!finding.startLine) return finding.file;
    const prefix = finding.side === "old" ? "old " : "";
    const end = finding.endLine && finding.endLine !== finding.startLine ? `–${finding.endLine}` : "";
    return `${finding.file}:${prefix}${finding.startLine}${end}`;
  }
  function shortRef(finding) {
    if (!finding.startLine) return "File";
    const prefix = finding.side === "old" ? "old " : "";
    const end = finding.endLine && finding.endLine !== finding.startLine ? `–${finding.endLine}` : "";
    return `${prefix}L${finding.startLine}${end}`;
  }
  function blockRange(block) {
    if (block.side === "old") return `old L${block.startLine}–${block.endLine}`;
    return `L${block.startLine}–${block.endLine}`;
  }
  function safeId(value) { return String(value ?? "").replace(/[^A-Za-z0-9_-]+/g, "-"); }
  function sortedFindings(findings) {
    return [...(findings || [])].sort((a, b) => {
      const severity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
      if (severity !== 0) return severity;
      return (a.startLine || 0) - (b.startLine || 0);
    });
  }
  function fileFindings(file) { return sortedFindings(file.findings || []); }
  function blockFindings(file, block) { return (file.findings || []).filter((finding) => finding.blockId === block.id); }
  function loadDrafts() {
    try {
      const raw = JSON.parse(localStorage.getItem(draftKey) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }
  function saveDrafts() {
    try { localStorage.setItem(draftKey, JSON.stringify(state.drafts)); } catch (_) {}
  }
  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  /* -------------------------------------------------------------- server */
  async function api(path, options = {}) {
    if (!state.server.token) throw new Error("No review server token.");
    const response = await fetch(path, {
      method: options.method || "GET",
      headers: {
        "X-Review-Token": state.server.token,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) throw new Error(data?.error || `Review server error (${response.status}).`);
    return data;
  }

  async function pollState({ quiet = false } = {}) {
    if (!state.server.token) {
      updateServerUI();
      return;
    }
    try {
      const next = await api("api/state");
      const key = JSON.stringify({ notes: next.notes, replies: next.replies, agent: next.agent, closed: next.closed, current: next.current });
      const changed = key !== state.server.lastJSON;
      state.server.connected = true;
      state.server.error = null;
      state.server.session = next;
      state.server.lastJSON = key;
      if (next.current?.runId && next.current.runId !== DATA.meta.runId && !state.reloadShown) {
        state.reloadShown = true;
        document.getElementById("reload-bar").hidden = false;
      }
      updateServerUI();
      updateNotesCount();
      if (changed && state.notesOpen) renderNotesDrawer({ preserve: true });
      if (changed && state.route?.view === "file") {
        const file = FILE_MAP.get(state.route.file);
        if (file) updateReviewHeader(file);
      }
    } catch (error) {
      state.server.connected = false;
      state.server.session = null;
      state.server.error = String(error.message || error);
      updateServerUI();
      updateNotesCount();
      if (!quiet) {
        if (state.notesOpen) renderNotesDrawer({ preserve: true });
      }
    }
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => pollState({ quiet: true }), 2000);
  }

  async function sendFeedback() {
    const notes = [...state.drafts];
    if (notes.length === 0) {
      toast("Write a note first.");
      return;
    }
    if (!state.server.connected) {
      copyFeedback(notes);
      return;
    }
    const send = document.getElementById("notes-send");
    if (send) send.disabled = true;
    try {
      await api("api/feedback", {
        method: "POST",
        body: { notes: notes.map((note) => ({ text: note.text, anchor: note.anchor })) },
      });
      state.drafts = [];
      saveDrafts();
      await pollState({ quiet: true });
      renderNotesDrawer({ preserve: false });
      updateNotesCount();
      toast("Sent to agent.");
    } catch (error) {
      toast(`Could not send: ${error.message}`);
    } finally {
      if (send) send.disabled = false;
    }
  }

  function copyFeedback(notes = state.drafts) {
    if (!notes.length) {
      toast("No notes to copy.");
      return;
    }
    const all = [...notes];
    const text = [
      `# Review notes · ${DATA.meta.repo.name} · iteration ${DATA.meta.iteration}`,
      "",
      ...all.map((note, index) => [
        `${index + 1}. ${anchorLabel(note.anchor)}`,
        note.text,
        "",
      ].join("\n")),
    ].join("\n");
    copyText(text);
  }

  async function closeReview() {
    if (!state.server.connected) {
      toast("The review server is not connected.");
      return;
    }
    if (!confirm("Close the review server?")) return;
    try {
      await api("api/close", { method: "POST" });
      toast("Review server closed.");
      state.server.session = { ...(state.server.session || {}), closed: true };
      updateServerUI();
      renderNotesDrawer({ preserve: true });
    } catch (error) {
      toast(`Could not close: ${error.message}`);
    }
  }

  function updateServerUI() {
    const status = agentStatus();
    const dot = document.querySelector("#agent-status .agent-dot");
    if (dot) {
      dot.className = `agent-dot ${status.className}`;
    }
    const label = document.getElementById("agent-label");
    if (label) label.textContent = status.label;
    const sideLabel = document.getElementById("side-agent-label");
    if (sideLabel) sideLabel.textContent = status.label;
    const sideDot = document.getElementById("side-agent-dot");
    if (sideDot) sideDot.className = `agent-dot ${status.className}`;
    const statusServer = document.getElementById("status-server");
    if (statusServer) statusServer.textContent = status.label;
  }

  function agentStatus() {
    if (!state.server.token) return { label: "Preview", className: "is-offline" };
    if (!state.server.connected) return { label: "Server off", className: "is-offline" };
    if (state.server.session?.closed) return { label: "Session closed", className: "is-offline" };
    if (state.server.session?.agent?.waiting) return { label: "Agent waiting", className: "is-waiting" };
    return { label: "Agent idle", className: "is-idle" };
  }

  function updateNotesCount() {
    const sentOpen = (state.server.session?.notes || []).filter((note) => ["sent", "seen"].includes(note.status)).length;
    const count = state.drafts.length + sentOpen;
    const el = document.getElementById("notes-count");
    if (el) el.textContent = String(count);
    renderStatusbar();
  }

  /* -------------------------------------------------------------- chrome */
  function renderChrome() {
    document.getElementById("brand-repo").textContent = DATA.meta.repo?.name || "repository";
    const verdict = verdictMeta(DATA.summary.verdict);
    const status = agentStatus();
    document.getElementById("topbar-center").innerHTML = [
      `<span class="chip" style="color:${verdict.color};border-color:color-mix(in srgb, ${verdict.color} 32%, var(--line));background:color-mix(in srgb, ${verdict.color} 7%, var(--panel))">${icon(verdict.icon, 10)}<strong>${esc(verdict.label)}</strong></span>`,
      `<span class="chip">iteration <strong>${DATA.meta.iteration}</strong></span>`,
      `<span class="chip">${fmtInt(DATA.stats.files)} files</span>`,
      `<span class="chip">${fmtInt(DATA.stats.findings)} findings</span>`,
      `<span class="chip" id="agent-status"><span class="agent-dot ${status.className}"></span><span id="agent-label">${esc(status.label)}</span></span>`,
    ].join("");
    updateThemeButton();
    renderStatusbar();
  }

  function renderStatusbar() {
    const route = state.route;
    const current = route?.view === "file" ? route.file : "Overview";
    const status = agentStatus();
    const notes = state.drafts.length + (state.server.session?.notes || []).filter((note) => ["sent", "seen"].includes(note.status)).length;
    document.getElementById("statusbar").innerHTML = [
      `<span class="st">${esc(DATA.meta.repo?.branch || "HEAD")}${DATA.meta.repo?.headShort ? ` · ${esc(DATA.meta.repo.headShort)}` : ""}</span>`,
      `<span class="st">${esc(DATA.meta.scope?.label || "working tree")}</span>`,
      `<span class="st">${esc(current)}</span>`,
      `<span class="spacer"></span>`,
      `<span class="st st-accent">${fmtInt(DATA.stats.coveragePct)}% reviewed</span>`,
      `<span class="st">${fmtInt(DATA.stats.findings)} findings</span>`,
      `<span class="st">${fmtInt(notes)} notes</span>`,
      `<span class="st" id="status-server">${esc(status.label)}</span>`,
    ].join("");
  }

  function renderSidebar() {
    const sidebar = document.getElementById("sidebar");
    const route = state.route;
    const files = DATA.files || [];
    const rows = files.map((file) => {
      const status = statusMeta(file.status);
      const findings = fileFindings(file).filter((finding) => finding.severity !== "praise");
      const active = route?.view === "file" && route.file === file.path;
      return `<button class="file-row${active ? " is-active" : ""}${findings.length ? " has-findings" : ""}" data-file="${esc(file.path)}" title="${esc(file.path)}">
        <span class="file-status" style="background:${status.color}"></span>
        <span class="file-name"><span class="base">${esc(baseName(file.path))}</span><span class="dir">${esc(dirName(file.path) || ".")}</span></span>
        <span class="file-delta">${file.binary ? "bin" : `<span class="add">+${fmtInt(file.additions)}</span> <span class="del">−${fmtInt(file.deletions)}</span>`}</span>
        <span class="file-count" title="${findings.length} findings">${findings.length || ""}</span>
      </button>`;
    }).join("");
    const status = agentStatus();
    sidebar.innerHTML = `
      <div class="side-head"><span>Changed files</span><span>${fmtInt(files.length)}</span></div>
      <button class="side-overview${route?.view === "overview" ? " is-active" : ""}" data-overview>${icon("overview", 12)} Overview</button>
      <div class="side-files">${rows}</div>
      <div class="side-foot">
        <div class="row"><span>scope</span><strong title="${esc(DATA.meta.scope?.label || "")}">${esc(DATA.meta.scope?.label || "working tree")}</strong></div>
        <div class="row"><span>iteration</span><strong>${DATA.meta.iteration} · ${esc(DATA.summary.verdict)}</strong></div>
        <div class="row agent-line"><span class="agent-dot ${status.className}" id="side-agent-dot"></span><span id="side-agent-label">${esc(status.label)}</span></div>
      </div>`;
    sidebar.querySelector("[data-overview]")?.addEventListener("click", () => navigate("overview"));
    sidebar.querySelectorAll("[data-file]").forEach((button) => {
      button.addEventListener("click", () => navigate("file", button.dataset.file));
    });
  }

  function updateThemeButton() {
    const button = document.getElementById("theme-btn");
    if (button) button.innerHTML = icon(state.theme === "dark" ? "moon" : "sun", 14);
  }

  function toggleTheme() {
    state.theme = state.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = state.theme;
    try { localStorage.setItem("code-review-theme", state.theme); } catch (_) {}
    updateThemeButton();
    if (state.code?.instance?.setThemeType) {
      try { state.code.instance.setThemeType(state.theme); } catch (_) {
        if (state.route?.view === "file") {
          const file = FILE_MAP.get(state.route.file);
          if (file) mountCode(file, state.code.mode || "diff");
        }
      }
    }
  }

  /* --------------------------------------------------------------- route */
  function parseRoute() {
    const raw = location.hash.replace(/^#/, "");
    if (!raw || raw === "overview") return { view: "overview" };
    try {
      const params = new URLSearchParams(raw);
      if (params.has("file")) return { view: "file", file: params.get("file"), finding: params.get("finding") || null };
    } catch (_) {}
    return { view: "overview" };
  }

  function navigate(view, file, finding) {
    const next = view === "file" ? { view, file, finding: finding || null } : { view: "overview" };
    const hash = view === "file"
      ? `#file=${encodeURIComponent(file)}${finding ? `&finding=${encodeURIComponent(finding)}` : ""}`
      : "#overview";
    if (location.hash === hash) renderRoute();
    else location.hash = hash;
  }

  function renderRoute() {
    let route = parseRoute();
    if (route.view === "file" && !FILE_MAP.has(route.file)) {
      route = { view: "overview" };
      history.replaceState(null, "", "#overview");
    }
    state.route = route;
    renderChrome();
    renderSidebar();
    const view = document.getElementById("view");
    if (route.view === "overview") {
      state.code = null;
      view.innerHTML = renderOverview();
      bindOverview();
      animateCounts();
    } else {
      const file = FILE_MAP.get(route.file);
      view.innerHTML = renderFile(file);
      bindFile(file);
      mountCode(file, "diff").then(() => {
        if (route.finding) scrollToFinding(route.finding, true);
      });
    }
    document.title = `Review · ${DATA.meta.repo?.name || ""} · ${route.view === "file" ? baseName(route.file) : "overview"}`;
    renderStatusbar();
  }

  /* ------------------------------------------------------------ overview */
  function renderOverview() {
    const verdict = verdictMeta(DATA.summary.verdict);
    return `<div class="overview"><div class="overview-inner">
      <header class="overview-head">
        <div class="verdict-badge" style="--verdict-color:${verdict.color}">
          ${icon(verdict.icon, 20)}
          <div><div class="v-label">Verdict</div><div class="v-state">${esc(verdict.label)}</div></div>
        </div>
        <div class="overview-title">
          <h1>${esc(DATA.summary.headline)}</h1>
          <div class="overview-summary">${fmtText(DATA.summary.overview)}</div>
          <div class="overview-meta">
            <span class="chip">iteration <strong>${DATA.meta.iteration}</strong></span>
            <span class="chip">${esc(DATA.meta.scope?.label || "working tree")}</span>
            <span class="chip">${fmtInt(DATA.stats.files)} files</span>
            <span class="chip">${fmtInt(DATA.stats.findings)} findings</span>
            <span class="chip ${DATA.stats.coveragePct === 100 ? "green" : "orange"}">${fmtInt(DATA.stats.coveragePct)}% reviewed</span>
          </div>
        </div>
      </header>
      ${renderMetrics()}
      ${renderFlowCard()}
      ${renderIterationCard()}
      <div class="overview-lower">
        ${renderTopFindings()}
        <div style="display:flex;flex-direction:column;gap:12px;min-width:0">
          ${renderActions()}
          ${renderRisks()}
        </div>
      </div>
    </div></div>`;
  }

  function renderMetrics() {
    const s = DATA.stats;
    const sev = s.severityCounts || {};
    return `<div class="metrics">
      <div class="metric"><div class="metric-label">Files</div><div class="metric-value">${fmtInt(s.files)}</div><div class="metric-sub">${fmtInt(s.binaryFiles)} binary</div></div>
      <div class="metric"><div class="metric-label">Lines</div><div class="metric-value">${fmtInt((s.additions || 0) + (s.deletions || 0))}</div><div class="metric-sub"><span class="add">+${fmtInt(s.additions)}</span> <span class="del">−${fmtInt(s.deletions)}</span></div></div>
      <div class="metric"><div class="metric-label">Blocks</div><div class="metric-value">${fmtInt(s.totalBlocks)}</div><div class="metric-sub">${fmtInt(s.reviewedBlocks)} reviewed</div></div>
      <div class="metric"><div class="metric-label">Findings</div><div class="metric-value">${fmtInt(s.findings)}</div><div class="metric-sub">${(sev.blocker || 0) + (sev.high || 0)} high signal</div></div>
      <div class="metric"><div class="metric-label">Coverage</div><div class="metric-value">${fmtInt(s.coveragePct)}%</div><div class="metric-sub">${fmtInt(s.reviewedBlocks)} / ${fmtInt(s.totalBlocks)} blocks</div></div>
    </div>`;
  }

  function renderSignalCard() {
    const s = DATA.stats;
    const total = SEVERITY_ORDER.reduce((sum, id) => sum + (s.severityCounts?.[id] || 0), 0);
    const bar = SEVERITY_ORDER.map((id) => {
      const count = s.severityCounts?.[id] || 0;
      return count ? `<span class="s-${id}" style="flex:${count} 0 0" title="${esc(severityMeta(id).label)}: ${count}"></span>` : "";
    }).join("");
    const circumference = 2 * Math.PI * 26;
    const offset = circumference * (1 - (s.coveragePct || 0) / 100);
    const lenses = Object.entries(s.lensCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
    return `<aside class="card signal-card">
      <div class="signal-top">
        <svg class="signal-ring" viewBox="0 0 62 62" role="img" aria-label="${fmtInt(s.coveragePct)} percent reviewed">
          <circle class="track" cx="31" cy="31" r="26"></circle>
          <circle class="value" cx="31" cy="31" r="26" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 31 31)"></circle>
          <text x="31" y="35" text-anchor="middle">${fmtInt(s.coveragePct)}%</text>
        </svg>
        <div><div class="signal-title">Review coverage</div><div class="signal-sub">${fmtInt(s.reviewedBlocks)} of ${fmtInt(s.totalBlocks)} blocks</div><div class="signal-sub">${fmtInt(s.files)} files</div></div>
      </div>
      <div class="signal-sep"></div>
      <div class="signal-row"><span>Findings</span><strong>${fmtInt(total)}</strong></div>
      <div class="sev-bar">${bar || `<span style="flex:1;background:var(--line-2)"></span>`}</div>
      <div class="sev-legend">${SEVERITY_ORDER.map((id) => `<span style="color:${severityMeta(id).color}"><i></i>${esc(severityMeta(id).label)} ${s.severityCounts?.[id] || 0}</span>`).join("")}</div>
      <div class="signal-sep"></div>
      <div class="signal-row"><span>Lenses used</span><strong>${Object.keys(s.lensCounts || {}).length}</strong></div>
      <div class="lens-chips">${lenses.map(([id, count]) => `<span class="pill" style="color:${lensMeta(id).color};border-color:color-mix(in srgb, ${lensMeta(id).color} 30%, var(--line))">${esc(lensMeta(id).label)} ${count}</span>`).join("") || `<span class="faint" style="font-size:10px">No lens findings.</span>`}</div>
    </aside>`;
  }

  function renderFlowCard() {
    const flow = DATA.flow || {};
    return `<article class="card flow-card">
      <div class="card-head">
        <div><h2>${esc(flow.title || "Change flow")}</h2><p>${esc(flow.subtitle || "How this change moves from input to outcome.")}</p></div>
        <span class="pill ${flow.source === "agent" ? "accent" : "slate"}">${flow.source === "agent" ? "authored" : "fallback"}</span>
      </div>
      <div class="flow-wrap">${renderFlowSvg(flow)}</div>
      <div class="flow-legend">${[...new Set((flow.nodes || []).map((node) => node.kind))].map((kind) => `<span class="l-${esc(kind)}"><i></i>${esc(FLOW_KIND[kind] || kind)}</span>`).join("")}</div>
    </article>`;
  }

  function renderFlowSvg(flow) {
    const nodes = flow.nodes || [];
    if (!nodes.length) return `<div class="review-empty">No flow.</div>`;
    const nodeW = 158;
    const nodeH = 52;
    const gapX = 56;
    const gapY = 18;
    const pad = 18;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edges = (flow.edges || []).filter((edge) => byId.has(edge.from) && byId.has(edge.to) && edge.from !== edge.to);
    const layers = new Map();
    for (const node of nodes) if (Number.isInteger(node.layer)) layers.set(node.id, node.layer);
    if (layers.size < nodes.length) {
      const indegree = new Map(nodes.map((node) => [node.id, 0]));
      const adj = new Map(nodes.map((node) => [node.id, []]));
      for (const edge of edges) {
        adj.get(edge.from)?.push(edge.to);
        indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
      }
      const queue = nodes.filter((node) => (indegree.get(node.id) || 0) === 0).map((node) => node.id);
      const order = [];
      while (queue.length) {
        const id = queue.shift();
        order.push(id);
        for (const target of adj.get(id) || []) {
          indegree.set(target, indegree.get(target) - 1);
          if (indegree.get(target) === 0) queue.push(target);
        }
      }
      const computed = new Map(nodes.map((node) => [node.id, Number.isInteger(node.layer) ? node.layer : 0]));
      for (const id of order) {
        for (const target of adj.get(id) || []) {
          computed.set(target, Math.max(computed.get(target) || 0, (computed.get(id) || 0) + 1));
        }
      }
      for (const node of nodes) layers.set(node.id, computed.get(node.id) || 0);
    }
    const maxLayer = Math.max(...layers.values(), 0);
    const grouped = new Map();
    for (const node of nodes) {
      const layer = layers.get(node.id) || 0;
      if (!grouped.has(layer)) grouped.set(layer, []);
      grouped.get(layer).push(node);
    }
    const heights = new Map();
    for (const [layer, group] of grouped) heights.set(layer, group.length * nodeH + Math.max(0, group.length - 1) * gapY);
    const maxHeight = Math.max(...heights.values(), nodeH);
    const positions = new Map();
    for (const [layer, group] of grouped) {
      const startY = pad + (maxHeight - (heights.get(layer) || nodeH)) / 2;
      group.forEach((node, index) => positions.set(node.id, {
        x: pad + layer * (nodeW + gapX),
        y: startY + index * (nodeH + gapY),
      }));
    }
    const width = pad * 2 + (maxLayer + 1) * nodeW + maxLayer * gapX;
    const height = pad * 2 + maxHeight;
    const edgeMarkup = edges.map((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return "";
      const x1 = from.x + nodeW;
      const y1 = from.y + nodeH / 2;
      const x2 = to.x;
      const y2 = to.y + nodeH / 2;
      const bend = Math.max(28, (x2 - x1) * 0.42);
      const path = x2 > x1 + 10
        ? `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
        : `M ${x1} ${y1} C ${x1 + 36} ${y1 - 28}, ${x2 - 36} ${y2 - 28}, ${x2} ${y2}`;
      return `<path class="flow-edge kind-${esc(edge.kind || "data")}" d="${path}" marker-end="url(#arrow-${esc(edge.kind || "data")})"></path>${edge.label ? `<text class="edge-label" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 5}" text-anchor="middle">${esc(edge.label)}</text>` : ""}`;
    }).join("");
    const nodeMarkup = nodes.map((node) => {
      const pos = positions.get(node.id);
      if (!pos) return "";
      const lines = wrapText(node.label || node.id, 21, 2);
      const label = lines.map((line, index) => `<tspan x="14" dy="${index === 0 ? 0 : 11}">${esc(line)}</tspan>`).join("");
      return `<g class="flow-node kind-${esc(node.kind || "transform")}" transform="translate(${pos.x} ${pos.y})" data-node-id="${esc(node.id)}">
        <title>${esc(node.label || node.id)}${node.detail ? `\n${esc(node.detail)}` : ""}</title>
        <rect width="${nodeW}" height="${nodeH}" rx="7"></rect>
        <circle class="node-dot" cx="14" cy="14" r="2.8"></circle>
        <text class="node-kind" x="22" y="17">${esc(FLOW_KIND[node.kind] || node.kind || "PROCESS")}</text>
        <text class="node-sub" x="14" y="30">${esc((node.files || []).length ? `${(node.files || []).length} file${(node.files || []).length === 1 ? "" : "s"}` : "system")}</text>
        <text class="node-label" x="14" y="42">${label}</text>
      </g>`;
    }).join("");
    return `<svg class="flow-svg" viewBox="0 0 ${width} ${height}" style="min-width:${Math.max(680, width)}px" role="img" aria-label="${esc(flow.title || "Change flow")}">
      <defs>${["data", "control", "event", "dependency"].map((kind) => `<marker id="arrow-${kind}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 8 4 0 8Z" fill="var(--line-2)"></path></marker>`).join("")}</defs>
      ${edgeMarkup}${nodeMarkup}
    </svg>`;
  }

  function wrapText(text, maxChars, maxLines) {
    const source = String(text || "");
    const words = source.split(/\s+/).filter(Boolean);
    const lines = [];
    let current = "";
    let used = 0;
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxChars || !current) {
        current = candidate;
        used += 1;
      } else {
        lines.push(current);
        current = word;
        used += 1;
        if (lines.length === maxLines) break;
      }
    }
    if (current && lines.length < maxLines) lines.push(current);
    if (!lines.length) lines.push(source);
    if (lines.length > maxLines) lines.length = maxLines;
    if (used < words.length) {
      const last = lines[lines.length - 1] || "";
      lines[lines.length - 1] = last.length >= maxChars ? `${last.slice(0, maxChars - 1)}…` : `${last}…`;
    }
    return lines;
  }

  function renderIterationCard() {
    const it = DATA.iteration || {};
    const delta = it.delta || {};
    const previous = it.previous;
    const chips = previous ? [
      `<span class="delta-chip new"><b>${fmtInt(delta.counts?.new || 0)}</b> new</span>`,
      `<span class="delta-chip resolved"><b>${fmtInt(delta.counts?.resolved || 0)}</b> resolved</span>`,
      `<span class="delta-chip"><b>${fmtInt(delta.counts?.carried || 0)}</b> carried</span>`,
      delta.counts?.unverified ? `<span class="delta-chip unverified"><b>${fmtInt(delta.counts.unverified)}</b> unverified</span>` : "",
    ].filter(Boolean).join("") : "";
    const code = previous && delta.code ? delta.code : null;
    const deltaFiles = code ? [...(code.files || [])].sort((a, b) => {
      const rank = { changed: 0, added: 1, removed: 2, unknown: 3, unchanged: 4 };
      return (rank[a.status] ?? 5) - (rank[b.status] ?? 5) || a.path.localeCompare(b.path);
    }).slice(0, 8) : [];
    return `<article class="card iteration-card">
      <div class="iteration-head">
        <div><h2>${previous ? `Iteration ${DATA.meta.iteration}` : "Baseline"}</h2><p>${previous ? `Compared with iteration ${previous.iteration}` : "First review of this change."}</p></div>
        <div style="margin-left:auto"><span class="pill ${DATA.stats.coveragePct === 100 ? "green" : "orange"}">${fmtInt(DATA.stats.coveragePct)}% reviewed</span></div>
      </div>
      ${previous ? `<div class="delta-chips">${chips}</div><div class="iteration-note">${fmtText(delta.note || "")}</div>` : `<div class="iteration-note">The next iteration shows new, resolved, and carried findings.</div>`}
      ${code ? `<div class="code-delta"><span><strong>${fmtInt(code.totals?.filesChanged || 0)}</strong> files changed since #${previous.iteration}</span><span class="add">+${fmtInt(code.totals?.additions || 0)}</span><span class="del">−${fmtInt(code.totals?.deletions || 0)}</span>${code.scopeChanged ? `<span class="pill orange">scope changed</span>` : ""}</div><div class="delta-files">${deltaFiles.map((file) => `<span class="delta-file" title="${esc(file.path)}">${esc(baseName(file.path))}${file.status === "changed" || file.status === "added" ? ` <span class="add">+${file.additions || 0}</span>` : file.status === "removed" ? ` <span class="del">removed</span>` : ""}</span>`).join("")}</div>` : ""}
      ${renderSparkline(it.sparkline || [])}
      ${renderTimeline(it.timeline || [])}
    </article>`;
  }

  function renderSparkline(points) {
    if (!points.length) return "";
    const width = 900;
    const height = 54;
    const padX = 12;
    const padY = 8;
    const max = Math.max(...points.map((point) => point.open || 0), 1);
    const flat = points.every((point) => (point.open || 0) === (points[0].open || 0));
    const step = points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0;
    const coords = points.map((point, index) => ({
      x: padX + index * step,
      y: flat ? height / 2 : height - padY - ((point.open || 0) / max) * (height - padY * 2),
      point,
    }));
    const line = coords.map((coord) => `${coord.x.toFixed(1)},${coord.y.toFixed(1)}`).join(" ");
    return `<div class="sparkline">
      <div class="sparkline-head"><span>Open findings</span><span>${fmtInt(points[points.length - 1]?.open || 0)} now</span></div>
      <svg viewBox="0 0 ${width} ${height}" aria-label="Open findings by iteration">
        <line class="grid" x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}"></line>
        ${points.length > 1 ? `<polyline class="line" points="${line}"></polyline>` : ""}
        ${coords.map((coord) => `<circle class="dot${coord.point.iteration === DATA.meta.iteration ? " current" : ""}" cx="${coord.x}" cy="${coord.y}" r="${coord.point.iteration === DATA.meta.iteration ? 3 : 2.2}"></circle><text class="label" x="${coord.x}" y="${height - 1}" text-anchor="middle">#${coord.point.iteration}</text>`).join("")}
      </svg>
    </div>`;
  }

  function renderTimeline(entries) {
    if (!entries.length) return "";
    return `<div class="timeline">${entries.map((entry) => {
      const verdict = verdictMeta(entry.verdict);
      const current = Boolean(entry.current) || entry.iteration === DATA.meta.iteration;
      const link = Boolean(entry.artifact) && !current;
      const content = `<span class="tl-iter">ITERATION ${String(entry.iteration).padStart(2, "0")}</span><span class="tl-verdict" style="--tl-color:${verdict.color}"><i></i>${esc(verdict.label)}</span><span class="tl-counts">${fmtInt(entry.findings?.open || 0)} open · ${fmtInt(entry.findings?.resolved || 0)} resolved</span>`;
      if (link) return `<button class="timeline-item is-link" data-open-artifact="${esc(entry.id)}" title="Open archived iteration">${content}</button>`;
      return `<div class="timeline-item${current ? " is-current" : ""}">${content}</div>`;
    }).join("")}</div>`;
  }

  function renderTopFindings() {
    const findings = sortedFindings(DATA.findings).filter((finding) => finding.severity !== "praise").slice(0, 7);
    return `<article class="card section-card">
      <div class="card-head"><div><h2>Needs attention</h2><p>Top open findings.</p></div><div class="card-tools"><span class="pill">${fmtInt(DATA.stats.findings)} open</span></div></div>
      ${findings.length ? `<div class="top-findings">${findings.map((finding) => {
        const meta = severityMeta(finding.severity);
        const file = FILE_MAP.get(finding.file);
        return `<div class="top-finding" data-finding-id="${esc(finding.id)}" data-file="${esc(finding.file)}" data-top-finding>
          <div class="tf-sev"><span class="pill" style="color:${meta.color};border-color:color-mix(in srgb, ${meta.color} 30%, var(--line))">${esc(meta.label)}</span></div>
          <div><div class="tf-title">${esc(finding.title)}</div><div class="tf-meta">${esc(finding.file)}:${esc(finding.startLine || "file")} · ${esc(lensMeta(finding.lens).label)}</div></div>
          <button class="btn sm" data-open-finding="${esc(finding.id)}" data-file="${esc(finding.file)}">Open</button>
        </div>`;
      }).join("")}</div>` : `<div class="empty-line">No findings.</div>`}
    </article>`;
  }

  function renderActions() {
    const actions = DATA.summary.nextActions || [];
    return `<article class="card section-card">
      <div class="card-head"><div><h2>Next steps</h2><p>Ordered actions.</p></div></div>
      ${actions.length ? `<div class="actions-list">${actions.map((action) => {
        const file = action.file ? FILE_MAP.get(action.file) : null;
        const finding = action.findingId ? FINDING_MAP.get(action.findingId) : null;
        return `<div class="action-row"><span class="action-num">${fmtInt(action.priority)}</span><div><div class="action-text">${fmtText(action.action)}</div><div style="margin-top:3px;display:flex;gap:4px;flex-wrap:wrap">${file ? `<button class="pill slate" data-open-file="${esc(file.path)}">${esc(baseName(file.path))}</button>` : ""}${finding ? `<span class="pill">${esc(finding.id)}</span>` : ""}</div></div><button class="btn sm" data-open-file="${esc(file?.path || "")}" ${file ? "" : "disabled"}>Open</button></div>`;
      }).join("")}</div>` : `<div class="empty-line">No next steps.</div>`}
    </article>`;
  }

  function renderRisks() {
    const risks = DATA.summary.risks || [];
    return `<article class="card section-card">
      <div class="card-head"><div><h2>Risks</h2><p>Cross-cutting risks.</p></div></div>
      ${risks.length ? risks.map((risk) => {
        const meta = severityMeta(risk.severity);
        return `<div class="risk-row"><div class="risk-title" style="--risk-color:${meta.color}"><i></i>${esc(risk.title)}</div><div class="risk-text">${fmtText(risk.detail)}</div></div>`;
      }).join("") : `<div class="empty-line">No risks listed.</div>`}
    </article>`;
  }

  /* ---------------------------------------------------------------- file */
  function renderFile(file) {
    const status = statusMeta(file.status);
    const risk = riskMeta(file.fileReview?.risk);
    const content = file.content;
    const lineCount = file.status === "deleted" ? (file.lineCount?.old || 0) : (file.lineCount?.new || 0);
    return `<div class="file-view">
      <div class="file-head">
        <div class="file-title" title="${esc(file.path)}"><span class="dir">${esc(dirName(file.path))}</span><span class="base">${esc(baseName(file.path))}</span></div>
        <div class="file-head-meta">
          <span>${esc(file.language)}</span><span class="sep">·</span>
          ${file.binary ? `<span>binary</span>` : `<span class="add">+${fmtInt(file.additions)}</span><span class="del">−${fmtInt(file.deletions)}</span>`}
          <span class="sep">·</span><span>${fmtInt(file.reviewedBlocks)}/${fmtInt(file.totalBlocks)} blocks</span>
          ${file.oldPath ? `<span class="sep">·</span><span>from ${esc(file.oldPath)}</span>` : ""}
        </div>
        <div class="file-badges">
          <span class="pill" style="color:${status.color};border-color:color-mix(in srgb, ${status.color} 30%, var(--line))">${esc(status.label)}</span>
          <span class="pill" style="color:${risk.color};border-color:color-mix(in srgb, ${risk.color} 30%, var(--line))">${esc(risk.label)}</span>
          ${(file.lenses || []).slice(0, 4).map((id) => `<span class="pill" style="color:${lensMeta(id).color};border-color:color-mix(in srgb, ${lensMeta(id).color} 28%, var(--line))">${esc(lensMeta(id).label)}</span>`).join("")}
          <button class="btn sm" data-copy-path="${esc(file.path)}">${icon("copy", 11)} Copy path</button>
        </div>
      </div>
      <div class="file-panes">
        <section class="code-panel" aria-label="Code">
          <div class="pane-head">
            <div class="pane-title">${icon("code", 12)} Code</div>
            <div class="pane-meta"><span id="code-mode-label">${file.binary ? "binary" : file.status === "deleted" ? "deleted file" : file.status === "added" ? "new file" : "unified diff"}</span><span class="sep">·</span><span>${fmtInt(lineCount)} lines</span></div>
            <div class="pane-actions">${content ? `<div class="segmented"><button data-code-mode="diff" class="is-active">Diff</button><button data-code-mode="file">${file.status === "deleted" ? "Old" : "File"}</button></div>` : ""}</div>
          </div>
          <div class="code-scroll" id="code-scroll"><div class="code-mount" id="code-mount"></div></div>
        </section>
        <section class="review-panel" aria-label="Agent review">
          <div class="pane-head">
            <div class="pane-title">${icon("review", 12)} Review</div>
            <div class="pane-meta" id="review-meta"><span>${fmtInt((file.findings || []).filter((finding) => finding.severity !== "praise").length)} findings</span><span class="sep">·</span><span>${fmtInt(file.totalBlocks)} blocks</span><span class="sep">·</span><span>${fmtInt(file.coveragePct)}%</span></div>
            <div class="pane-actions"><span class="pill ${risk.color === "var(--red)" ? "red" : risk.color === "var(--orange)" ? "orange" : "green"}">${esc(risk.label)}</span></div>
          </div>
          <div class="review-scroll" id="review-scroll">${renderReview(file)}</div>
        </section>
      </div>
    </div>`;
  }

  function renderReview(file) {
    const findings = fileFindings(file);
    const bad = findings.filter((finding) => finding.severity !== "praise");
    const praise = findings.filter((finding) => finding.severity === "praise");
    const blocks = file.blocks || [];
    return `
      <div class="agent-summary"><div class="eyebrow">Agent note</div>${fmtText(file.fileReview?.summary || "No file summary.")}</div>
      ${blocks.length ? `<section class="review-section">
        <div class="review-section-head"><h3>Reviewed blocks</h3><span class="count">${fmtInt(blocks.length)}</span><span class="line"></span></div>
        ${blocks.map((block) => blockRow(file, block)).join("")}
      </section>` : ""}
      <section class="review-section">
        <div class="review-section-head"><h3>Needs attention</h3><span class="count">${fmtInt(bad.length)}</span><span class="line"></span></div>
        ${bad.length ? bad.map((finding) => findingRow(finding)).join("") : `<div class="review-empty"><strong>No findings.</strong>All reviewed blocks look okay.</div>`}
      </section>
      ${praise.length ? `<section class="review-section">
        <div class="review-section-head"><h3>Praise</h3><span class="count">${fmtInt(praise.length)}</span><span class="line"></span></div>
        ${praise.map((finding) => findingRow(finding)).join("")}
      </section>` : ""}`;
  }

  function findingRow(finding) {
    const severity = severityMeta(finding.severity);
    const status = DELTA_STATUS[finding.id]?.status;
    const revision = status === "new" ? `<span class="pill accent">new</span>` : status === "changed" ? `<span class="pill orange">changed</span>` : "";
    const evidence = (finding.evidence || []).map((item) => `<span>${esc(item.path)}${item.line ? `:${item.line}` : ""}${item.note ? ` — ${esc(item.note)}` : ""}</span>`).join("");
    return `<div class="finding-row sev-${esc(finding.severity)}" id="finding-${safeId(finding.id)}" data-finding-id="${esc(finding.id)}" data-start-line="${finding.startLine || ""}" data-end-line="${finding.endLine || finding.startLine || ""}" data-side="${esc(finding.side || "new")}">
      <div class="finding-head">
        <span class="finding-sev">${esc(severity.label)}</span>
        <span class="finding-title">${esc(finding.title)}</span>
        ${revision}
        <span class="finding-ref">${esc(shortRef(finding))}</span>
      </div>
      <div class="finding-detail">${fmtText(finding.detail)}</div>
      ${finding.suggestion ? `<div class="finding-fix"><b>Fix:</b> ${fmtText(finding.suggestion)}</div>` : ""}
      ${evidence ? `<div class="finding-evidence">${evidence}</div>` : ""}
      <div class="finding-foot">
        <span>${esc(lensMeta(finding.lens).label)}</span><span>·</span><span>${esc(finding.confidence || "high")} confidence</span><span>·</span><span>${esc(finding.file)}</span>
        <button class="btn sm" data-locate-finding="${esc(finding.id)}">${icon("locate", 10)} Locate</button>
        <button class="btn sm" data-note-finding="${esc(finding.id)}" data-note-file="${esc(finding.file)}">${icon("note", 10)} Note</button>
      </div>
    </div>`;
  }

  function blockRow(file, block, { compact = false } = {}) {
    const meta = assessmentMeta(block.assessment);
    const count = blockFindings(file, block).filter((finding) => finding.severity !== "praise").length;
    return `<div class="block-row${state.activeBlock === block.id ? " is-active" : ""}" data-block-id="${esc(block.id)}" data-start-line="${block.startLine}" data-end-line="${block.endLine}" data-side="${esc(block.side || "new")}" title="${esc(block.assessmentSummary || "")}">
      <span class="block-id">${esc(block.id)}</span>
      <span class="block-range">${esc(blockRange(block))}</span>
      <span class="block-assess ${esc(block.assessment)}">${esc(meta.label)}</span>
      <span class="block-summary">${esc(block.assessmentSummary || (compact ? "No issue." : "No summary."))}</span>
      <span class="block-count">${count ? `${count} finding${count === 1 ? "" : "s"}` : ""}</span>
    </div>`;
  }

  function bindFile(file) {
    document.querySelectorAll("[data-code-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll("[data-code-mode]").forEach((item) => item.classList.toggle("is-active", item === button));
        const label = document.getElementById("code-mode-label");
        if (label) label.textContent = button.dataset.codeMode === "file" ? (file.status === "deleted" ? "old file" : "new file") : (file.status === "deleted" ? "deleted file" : file.status === "added" ? "new file" : "unified diff");
        mountCode(file, button.dataset.codeMode);
      });
    });
    bindReview(file);
  }

  function bindReview(file) {
    const review = document.getElementById("review-scroll");
    if (!review) return;
    review.addEventListener("click", (event) => {
      const locate = event.target.closest("[data-locate-finding]");
      if (locate) {
        event.preventDefault();
        scrollToFinding(locate.dataset.locateFinding, true);
        return;
      }
      const note = event.target.closest("[data-note-finding]");
      if (note) {
        event.preventDefault();
        const finding = FINDING_MAP.get(note.dataset.noteFinding);
        if (finding) openAnnotate(anchorForFinding(finding));
        return;
      }
      const row = event.target.closest(".block-row");
      if (row && !state.annotate) {
        const block = (file.blocks || []).find((entry) => entry.id === row.dataset.blockId);
        if (block) {
          setActiveBlock(block.id);
          scrollToLine(block.startLine, block.side || "new");
          highlightBlock(block, true);
        }
        return;
      }
      const findingEl = event.target.closest(".finding-row");
      if (findingEl && !state.annotate) {
        const finding = FINDING_MAP.get(findingEl.dataset.findingId);
        if (finding) scrollToFinding(finding.id);
      }
    });
    review.addEventListener("mouseover", (event) => {
      const findingEl = event.target.closest(".finding-row");
      if (findingEl) {
        const finding = FINDING_MAP.get(findingEl.dataset.findingId);
        if (finding) {
          highlightFinding(finding);
          return;
        }
      }
      const row = event.target.closest(".block-row");
      if (row) {
        const block = (file.blocks || []).find((entry) => entry.id === row.dataset.blockId);
        if (block) highlightBlock(block);
      }
    });
    review.addEventListener("mouseout", (event) => {
      if (event.relatedTarget && review.contains(event.relatedTarget)) return;
      clearCodeHit();
    });
  }

  function updateReviewHeader(file) {
    const meta = document.getElementById("review-meta");
    if (!meta) return;
    const count = (file.findings || []).filter((finding) => finding.severity !== "praise").length;
    meta.innerHTML = `<span>${fmtInt(count)} findings</span><span class="sep">·</span><span>${fmtInt(file.totalBlocks)} blocks</span><span class="sep">·</span><span>${fmtInt(file.coveragePct)}%</span>`;
  }

  /* ------------------------------------------------------------ code pane */
  async function loadDiffLib() {
    if (state.libPromise) return state.libPromise;
    if (window.PierreDiffs?.File && window.PierreDiffs?.FileDiff) {
      state.libPromise = Promise.resolve(window.PierreDiffs);
      return state.libPromise;
    }
    throw new Error("The local code renderer did not load. Re-run install or open the review through the skill server.");
  }

  async function mountCode(file, mode) {
    const host = document.getElementById("code-mount");
    const scroll = document.getElementById("code-scroll");
    if (!host || !scroll) return;
    if (!file.content) {
      host.innerHTML = `<div class="code-state"><div class="state-icon">${icon(file.binary ? "file" : "code", 18)}</div><h3>${file.binary ? "Binary file" : "Content omitted"}</h3><p>${file.binary ? "No text to show. Read the file note on the right." : "This file is larger than the review snapshot limit."}</p></div>`;
      state.code = null;
      return;
    }
    host.innerHTML = `<div class="code-loading"><div><div class="loader"></div>Loading code</div></div>`;
    state.code = { file, mode, instance: null, host, scroll, root: null, rows: [], onScroll: null };
    try {
      const lib = await loadDiffLib();
      if (!document.getElementById("code-mount") || state.route?.file !== file.path) return;
      host.innerHTML = "";
      const options = {
        theme: { light: "github-light", dark: "github-dark" },
        themeType: state.theme,
        overflow: "wrap",
        disableFileHeader: true,
        lineHoverHighlight: "line",
        onLineClick: ({ lineNumber, lineType }) => {
          if (state.annotate) return;
          const side = String(lineType || "").includes("deletion") ? "old" : "new";
          const block = findBlockForLine(file, lineNumber, side);
          if (block) {
            setActiveBlock(block.id);
            const row = document.getElementById(`block-${safeId(block.id)}`) || document.querySelector(`.block-row[data-block-id="${CSS.escape(block.id)}"]`);
            row?.scrollIntoView({ block: "nearest" });
            highlightBlock(block, true);
          }
        },
        onPostRender: () => setupCodeRoot(file).catch(() => {}),
      };
      if (mode === "file") {
        const contents = file.status === "deleted" ? (file.content.old || "") : (file.content.new || "");
        const instance = new lib.File(options);
        instance.render({ containerWrapper: host, file: { name: file.path, contents } });
        state.code.instance = instance;
      } else {
        const instance = new lib.FileDiff({ ...options, diffStyle: "unified", expandUnchanged: true });
        instance.render({
          containerWrapper: host,
          oldFile: { name: file.oldPath || file.path, contents: file.content.old || "" },
          newFile: { name: file.path, contents: file.content.new || "" },
        });
        state.code.instance = instance;
      }
      setupCodeRoot(file).catch(() => {});
    } catch (error) {
      host.innerHTML = `<div class="code-fallback"><strong>Code view is not available.</strong><div>${esc(error.message || error)}</div><pre>${esc((file.content.new || file.content.old || "").split("\n").slice(0, 500).join("\n"))}</pre></div>`;
    }
  }

  async function setupCodeRoot(file, attempt = 0) {
    const code = state.code;
    if (!code || attempt > 60) return;
    const host = code.host.querySelector("diffs-container");
    const root = host?.shadowRoot || host;
    if (!root || !root.querySelector("[data-line]")) {
      await sleep(80);
      if (state.code !== code || state.route?.file !== file.path) return;
      return setupCodeRoot(file, attempt + 1);
    }
    code.root = root;
    code.rows = [...root.querySelectorAll("[data-line]")];
    if (!root.__reviewBound) {
      root.__reviewBound = true;
      const style = document.createElement("style");
      style.textContent = `
        [data-review-hit="true"] { box-shadow: inset 3px 0 0 var(--accent, #c8f45a) !important; background-color: color-mix(in srgb, var(--accent, #c8f45a) 9%, transparent) !important; }
        :host-context(html[data-annotate="on"]) [data-line] { cursor: crosshair; }
        :host-context(html[data-annotate="on"]) [data-line]:hover { outline: 1px dashed var(--accent, #c8f45a); outline-offset: -1px; }
      `;
      root.appendChild(style);
      root.addEventListener("click", (event) => {
        if (!state.annotate) return;
        const row = event.target.closest?.("[data-line]");
        if (!row) return;
        event.preventDefault();
        event.stopPropagation();
        openLineAnnotate(file, row);
      }, true);
      root.addEventListener("mouseup", () => {
        if (!state.annotate) return;
        setTimeout(() => {
          const selection = window.getSelection?.();
          const text = selection?.toString().trim() || "";
          if (text.length < 2) return;
          openAnnotate({ kind: "text", file: file.path, excerpt: text.slice(0, 800), label: "Selected code" });
          selection.removeAllRanges();
        }, 0);
      });
    }
    bindCodeScroll(code);
    if (state.route?.finding) {
      const finding = FINDING_MAP.get(state.route.finding);
      if (finding?.file === file.path) setTimeout(() => scrollToFinding(finding.id, true), 80);
    }
  }

  function bindCodeScroll(code) {
    if (!code.scroll) return;
    if (code.onScroll) code.scroll.removeEventListener("scroll", code.onScroll);
    let raf = 0;
    code.onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        updateActiveFromScroll(code);
      });
    };
    code.scroll.addEventListener("scroll", code.onScroll, { passive: true });
  }

  function updateActiveFromScroll(code) {
    if (!code.root || !code.rows.length) return;
    const top = code.scroll.getBoundingClientRect().top + 6;
    let candidate = null;
    for (const row of code.rows) {
      if (row.getBoundingClientRect().bottom > top) { candidate = row; break; }
    }
    if (!candidate) return;
    const line = Number(candidate.getAttribute("data-line"));
    const type = candidate.getAttribute("data-line-type") || "";
    const side = type.includes("deletion") ? "old" : "new";
    const block = findBlockForLine(code.file, line, side);
    if (block) setActiveBlock(block.id);
  }

  function findBlockForLine(file, line, side) {
    const blocks = file.blocks || [];
    if (side === "old") {
      return blocks.find((block) => {
        const start = block.side === "old" ? block.startLine : block.oldStart;
        const end = block.side === "old" ? block.endLine : block.oldEnd;
        return line >= start && line <= end;
      }) || blocks.find((block) => line >= block.startLine && line <= block.endLine);
    }
    return blocks.find((block) => line >= block.startLine && line <= block.endLine);
  }

  function clearCodeHit() {
    state.code?.root?.querySelectorAll('[data-review-hit="true"]').forEach((row) => row.removeAttribute("data-review-hit"));
  }

  function applyHit(start, end, side) {
    const root = state.code?.root;
    if (!root) return;
    clearCodeHit();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    for (const row of root.querySelectorAll("[data-line]")) {
      const line = Number(row.getAttribute("data-line"));
      const type = row.getAttribute("data-line-type") || "";
      const relevant = side === "old" ? !type.includes("addition") : !type.includes("deletion");
      if (relevant && line >= start && line <= end) row.setAttribute("data-review-hit", "true");
    }
  }

  function highlightFinding(finding) {
    if (!finding) return;
    applyHit(finding.startLine, finding.endLine || finding.startLine, finding.side || "new");
    if (finding.blockId) setActiveBlock(finding.blockId);
  }

  function highlightBlock(block, flash = false) {
    if (!block) return;
    applyHit(block.startLine, block.endLine, block.side || "new");
    if (flash) setTimeout(clearCodeHit, 1200);
  }

  function setActiveBlock(id) {
    state.activeBlock = id;
    document.querySelectorAll(".block-row.is-active").forEach((row) => row.classList.remove("is-active"));
    document.querySelectorAll(".block-row").forEach((row) => {
      if (row.dataset.blockId === id) row.classList.add("is-active");
    });
  }

  function scrollToLine(line, side = "new") {
    const code = state.code;
    if (!code?.root || !line) return;
    const rows = [...code.root.querySelectorAll(`[data-line="${Number(line)}"]`)];
    const rank = (row) => {
      const type = row.getAttribute("data-line-type") || "";
      if (side === "old") return type.includes("deletion") ? 0 : type.includes("addition") ? 2 : 1;
      return type.includes("deletion") ? 2 : type.includes("addition") ? 0 : 1;
    };
    rows.sort((a, b) => rank(a) - rank(b))[0]?.scrollIntoView({ block: "center", behavior: REDUCED ? "auto" : "smooth" });
  }

  function scrollToFinding(id, focus = false) {
    const finding = FINDING_MAP.get(id);
    if (!finding) return;
    if (finding.file !== state.route?.file) navigate("file", finding.file, finding.id);
    scrollToLine(finding.startLine, finding.side || "new");
    highlightFinding(finding);
    if (focus) document.getElementById(`finding-${safeId(finding.id)}`)?.scrollIntoView({ block: "nearest" });
  }

  /* --------------------------------------------------------------- notes */
  function anchorForFinding(finding) {
    return { kind: "finding", file: finding.file, findingId: finding.id, line: finding.startLine, lineEnd: finding.endLine, side: finding.side || "new", label: finding.title, excerpt: finding.title };
  }
  function anchorForBlock(file, block) {
    return { kind: "block", file: file.path, blockId: block.id, line: block.startLine, lineEnd: block.endLine, side: block.side || "new", label: `Block ${block.id}`, excerpt: block.assessmentSummary || "" };
  }
  function anchorForFlow(node) {
    return { kind: "flow", nodeId: node.id, label: node.label, excerpt: node.detail || "" };
  }
  function anchorLabel(anchor) {
    if (!anchor) return "Note";
    if (anchor.kind === "message") return "Message";
    const parts = [];
    if (anchor.file) parts.push(anchor.line ? `${anchor.file}:${anchor.line}` : anchor.file);
    if (anchor.findingId) parts.push(anchor.findingId);
    if (anchor.blockId) parts.push(anchor.blockId);
    if (!parts.length && anchor.label) parts.push(anchor.label);
    return parts.join(" · ") || anchor.kind || "Note";
  }
  function anchorForElement(el) {
    const findingEl = el.closest("[data-finding-id]");
    if (findingEl) {
      const finding = FINDING_MAP.get(findingEl.dataset.findingId);
      if (finding) return anchorForFinding(finding);
    }
    const blockEl = el.closest("[data-block-id]");
    if (blockEl && state.route?.view === "file") {
      const file = FILE_MAP.get(state.route.file);
      const block = (file?.blocks || []).find((entry) => entry.id === blockEl.dataset.blockId);
      if (block) return anchorForBlock(file, block);
    }
    const nodeEl = el.closest(".flow-node");
    if (nodeEl) {
      const node = (DATA.flow?.nodes || []).find((entry) => entry.id === nodeEl.dataset.nodeId);
      if (node) return anchorForFlow(node);
    }
    if (state.route?.view === "file") {
      return { kind: "text", file: state.route.file, label: el.classList?.contains("agent-summary") ? "File summary" : "Element", excerpt: (el.innerText || "").trim().slice(0, 600) };
    }
    return { kind: "element", label: el.tagName?.toLowerCase() || "element", excerpt: (el.innerText || "").trim().slice(0, 600) };
  }

  function openAnnotate(anchor) {
    state.currentAnchor = anchor;
    const dialog = document.getElementById("note-dialog");
    if (!dialog) return;
    document.getElementById("note-anchor").textContent = anchorLabel(anchor);
    const text = document.getElementById("note-text");
    text.value = "";
    if (!dialog.open) dialog.showModal();
    setTimeout(() => text.focus(), 30);
  }

  function openLineAnnotate(file, row) {
    const line = Number(row.getAttribute("data-line"));
    const type = row.getAttribute("data-line-type") || "";
    const side = type.includes("deletion") ? "old" : "new";
    const block = findBlockForLine(file, line, side);
    openAnnotate({
      kind: "line",
      file: file.path,
      line,
      side,
      blockId: block?.id,
      label: `Line ${line}`,
      excerpt: (row.textContent || "").trim().slice(0, 600),
    });
  }

  function queueNote() {
    const text = document.getElementById("note-text").value.trim();
    if (!text) { toast("Write a note first."); return; }
    state.drafts.push({
      id: `local-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      text,
      anchor: state.currentAnchor || { kind: "message" },
      createdAt: new Date().toISOString(),
    });
    saveDrafts();
    updateNotesCount();
    document.getElementById("note-dialog").close();
    toast("Note queued. Open Notes to send.");
  }

  function removeDraft(id) {
    state.drafts = state.drafts.filter((draft) => draft.id !== id);
    saveDrafts();
    updateNotesCount();
    renderNotesDrawer({ preserve: false });
  }

  function toggleNotes(force) {
    const drawer = document.getElementById("notes-drawer");
    if (!drawer) return;
    state.notesOpen = force === undefined ? !state.notesOpen : force;
    drawer.hidden = !state.notesOpen;
    if (state.notesOpen) {
      renderNotesDrawer({ preserve: false });
      pollState({ quiet: true });
    }
  }

  function renderNotesDrawer({ preserve = true } = {}) {
    const drawer = document.getElementById("notes-drawer");
    if (!drawer || !state.notesOpen) return;
    const oldScroll = drawer.querySelector(".notes-body")?.scrollTop || 0;
    const status = agentStatus();
    const session = state.server.session;
    const serverNotes = (session?.notes || []).slice().reverse();
    const activeNotes = serverNotes.filter((note) => note.status !== "done");
    const doneNotes = serverNotes.filter((note) => note.status === "done").slice(0, 8);
    const replies = (session?.replies || []).slice().reverse();
    const canSend = state.server.connected && !session?.closed;
    const offline = !state.server.connected;
    const canSubmit = canSend && state.drafts.length > 0;
    drawer.innerHTML = `
      <div class="notes-head"><h2>Notes</h2><button class="btn sm" id="notes-new-message">+ Message</button><button class="icon-btn notes-close" data-close-notes aria-label="Close notes">${icon("x", 13)}</button></div>
      <div class="notes-status"><span class="agent-dot ${status.className}"></span><span>${esc(status.label)}</span>${session?.closed ? `<span style="margin-left:auto">Session closed</span>` : ""}</div>
      <div class="notes-body">
        ${state.drafts.length ? `<section class="notes-section"><div class="notes-section-head">Queued <span class="count">${state.drafts.length}</span></div>${state.drafts.map((draft) => `<div class="note-card"><div class="note-anchor">${esc(anchorLabel(draft.anchor))}</div><div class="note-text">${esc(draft.text)}</div><div class="note-actions"><button class="btn sm danger" data-remove-draft="${esc(draft.id)}">Remove</button><span class="note-status">queued</span></div></div>`).join("")}</section>` : `<div class="notes-empty">No queued notes. Click Annotate. Then click code or a finding.</div>`}
        ${offline ? `<div class="notes-empty">Preview only. Run <code>open</code> in the repository to start the review server.</div>` : ""}
        ${activeNotes.length ? `<section class="notes-section"><div class="notes-section-head">Open notes <span class="count">${activeNotes.length}</span></div>${activeNotes.map((note) => `<div class="note-card is-${esc(note.status)}"><div class="note-anchor">${esc(anchorLabel(note.anchor))}</div><div class="note-text">${esc(note.text)}</div><div class="note-actions"><span class="note-status">${esc(note.status)}</span></div></div>`).join("")}</section>` : ""}
        ${doneNotes.length ? `<details class="coverage-details"><summary>Closed notes (${doneNotes.length})</summary>${doneNotes.map((note) => `<div class="note-card is-done"><div class="note-anchor">${esc(anchorLabel(note.anchor))}</div><div class="note-text">${esc(note.text)}</div><div class="note-actions"><span class="note-status">done</span></div></div>`).join("")}</details>` : ""}
        ${replies.length ? `<section class="notes-section"><div class="notes-section-head">Agent replies</div>${replies.map((reply) => `<div class="reply-card"><div class="reply-meta">${esc(fmtDate(reply.createdAt))} ? ${esc(reply.id)}</div><div class="reply-text">${esc(reply.text)}</div></div>`).join("")}</section>` : ""}
      </div>
      <div class="notes-foot">
        ${offline ? `<span class="offline">Copy the notes and paste them into the agent chat.</span><button class="btn" id="notes-copy">Copy feedback</button>` : `<button class="btn btn-primary" id="notes-send"${canSubmit ? "" : " disabled"}>Send to agent</button>`}
        <button class="btn" id="notes-close">Close</button>
        <button class="btn danger" id="notes-end" title="Stop the review server">End</button>
      </div>`;
    drawer.querySelector("[data-close-notes]")?.addEventListener("click", () => toggleNotes(false));
    drawer.querySelector("#notes-close")?.addEventListener("click", () => toggleNotes(false));
    drawer.querySelector("#notes-end")?.addEventListener("click", closeReview);
    drawer.querySelector("#notes-new-message")?.addEventListener("click", () => openAnnotate({ kind: "message" }));
    drawer.querySelectorAll("[data-remove-draft]").forEach((button) => button.addEventListener("click", () => removeDraft(button.dataset.removeDraft)));
    drawer.querySelector("#notes-send")?.addEventListener("click", sendFeedback);
    drawer.querySelector("#notes-copy")?.addEventListener("click", () => copyFeedback());
    const body = drawer.querySelector(".notes-body");
    if (body) body.scrollTop = preserve ? oldScroll : 0;
  }

  function copyText(text) {
    const value = String(text || "");
    const done = () => toast("Copied.");
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).then(done).catch(() => fallbackCopy(value, done));
    } else fallbackCopy(value, done);
  }
  function fallbackCopy(value, done) {
    const area = document.createElement("textarea");
    area.value = value;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); done(); } catch { toast("Could not copy."); }
    area.remove();
  }

  function toast(message) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("is-visible");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.remove("is-visible"), 2200);
  }

  /* ------------------------------------------------------------- events */
  function bindGlobal() {
    document.getElementById("theme-btn")?.addEventListener("click", toggleTheme);
    document.getElementById("notes-btn")?.addEventListener("click", () => toggleNotes());
    document.getElementById("annotate-btn")?.addEventListener("click", () => setAnnotate(!state.annotate));
    document.getElementById("help-btn")?.addEventListener("click", () => document.getElementById("help-dialog")?.showModal());
    document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog")?.close()));
    document.querySelectorAll("[data-close-note]").forEach((button) => button.addEventListener("click", () => document.getElementById("note-dialog")?.close()));
    document.getElementById("note-save")?.addEventListener("click", queueNote);
    document.getElementById("reload-btn")?.addEventListener("click", () => location.reload());
    document.getElementById("help-dialog")?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) event.currentTarget.close();
    });
    document.getElementById("note-dialog")?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) event.currentTarget.close();
    });
    document.addEventListener("click", handleDocumentClick, true);
    document.addEventListener("mouseup", handleSelection, true);
    window.addEventListener("keydown", (event) => {
      const tag = event.target?.tagName?.toLowerCase();
      if (["input", "textarea", "select"].includes(tag)) return;
      if (event.key === "?" && !document.getElementById("help-dialog")?.open) {
        event.preventDefault();
        document.getElementById("help-dialog")?.showModal();
      }
      if (event.key === "Escape") {
        if (state.notesOpen) { toggleNotes(false); return; }
        if (state.annotate) setAnnotate(false);
      }
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        const files = DATA.files || [];
        if (!files.length) return;
        event.preventDefault();
        const current = state.route?.file ? files.findIndex((file) => file.path === state.route.file) : -1;
        const next = event.key === "ArrowDown" ? Math.min(files.length - 1, current + 1) : Math.max(0, current - 1);
        navigate("file", files[next].path);
      }
    });
    window.addEventListener("hashchange", renderRoute);
    document.addEventListener("click", (event) => {
      const openFile = event.target.closest("[data-open-file]");
      if (openFile && openFile.dataset.openFile) {
        event.preventDefault();
        navigate("file", openFile.dataset.openFile);
        return;
      }
      const openFinding = event.target.closest("[data-open-finding]");
      if (openFinding) {
        event.preventDefault();
        navigate("file", openFinding.dataset.file, openFinding.dataset.openFinding);
        return;
      }
      const openArtifact = event.target.closest("[data-open-artifact]");
      if (openArtifact) {
        event.preventDefault();
        const tokenQuery = state.server.token ? `?token=${encodeURIComponent(state.server.token)}` : "";
        window.open(`${DATA.artifactBase}${openArtifact.dataset.openArtifact}/review.html${tokenQuery}`, "_blank", "noopener");
        return;
      }
      const copyPath = event.target.closest("[data-copy-path]");
      if (copyPath) {
        event.preventDefault();
        copyText(copyPath.dataset.copyPath);
      }
    });
  }

  function setAnnotate(on) {
    state.annotate = Boolean(on);
    document.documentElement.dataset.annotate = state.annotate ? "on" : "off";
    const button = document.getElementById("annotate-btn");
    if (button) button.setAttribute("aria-pressed", state.annotate ? "true" : "false");
    toast(state.annotate ? "Annotate on. Click code or a finding." : "Annotate off.");
  }

  function handleDocumentClick(event) {
    if (!state.annotate) return;
    if (event.target.closest("button, a, input, textarea, select, label, .sidebar, .topbar, .statusbar, .notes-drawer, .dialog, .reload-bar")) return;
    const target = event.target.closest(".finding-row, .block-row, .agent-summary, .top-finding, .flow-node, .file-title, .card-head, .review-section-head");
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    openAnnotate(anchorForElement(target));
  }

  function handleSelection(event) {
    if (!state.annotate) return;
    if (event.target.closest("button, a, input, textarea, select, .notes-drawer, .dialog, .code-panel, .topbar, .statusbar, .sidebar")) return;
    setTimeout(() => {
      const selection = window.getSelection?.();
      const text = selection?.toString().trim() || "";
      if (text.length < 2) return;
      const anchor = anchorForElement(event.target);
      openAnnotate({ ...anchor, kind: "text", excerpt: text.slice(0, 800), label: "Selected text" });
      selection.removeAllRanges();
    }, 0);
  }

  function bindOverview() {
    document.querySelectorAll("[data-top-finding]").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (state.annotate) return;
        if (event.target.closest("button")) return;
        navigate("file", row.dataset.file, row.dataset.findingId);
      });
    });
    document.querySelectorAll(".flow-node").forEach((node) => {
      node.addEventListener("mouseenter", () => {
        const id = node.dataset.nodeId;
        document.querySelectorAll(".flow-node").forEach((item) => item.classList.toggle("is-hot", item === node));
      });
      node.addEventListener("mouseleave", () => document.querySelectorAll(".flow-node").forEach((item) => item.classList.remove("is-hot")));
    });
  }

  function animateCounts() {
    // Numbers settle immediately. This keeps screenshots and reviews stable.
  }

  function init() {
    renderChrome();
    bindGlobal();
    renderRoute();
    if (state.server.token) {
      pollState({ quiet: true });
      startPolling();
    }
    updateNotesCount();
  }

  init();
}
