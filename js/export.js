// ---------------------------------------------------------------------------
//  Queen Tracker — guided export
//  Step 1: what (Queens / All data)  ->  Step 2: which records  ->  Step 3: format
//  Formats: JSON, CSV, Excel (.xlsx), Google Sheets.
//
//  Deliberately dependency-free: the .xlsx and .zip writers below are small
//  enough to hand-roll, which keeps the app working offline in the bee yard
//  (a CDN script would fail exactly when there's no signal).
// ---------------------------------------------------------------------------
(function () {
  "use strict";

  const esc = (s) =>
    s == null ? "" : String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ===================== ZIP (store-only) =====================
  // .xlsx files are ZIP archives. We store entries uncompressed, which every
  // spreadsheet app accepts and lets us skip a DEFLATE implementation.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const utf8 = (s) => new TextEncoder().encode(s);

  function zipBlob(files, mime) {
    // files: [{ name, data: Uint8Array }]
    const chunks = [];
    const central = [];
    let offset = 0;
    const push = (arr) => { chunks.push(arr); offset += arr.length; };
    const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
    const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

    for (const f of files) {
      const nameBytes = utf8(f.name);
      const crc = crc32(f.data);
      const localOffset = offset;
      push(new Uint8Array([
        ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), // UTF-8 flag
        ...u16(0), ...u16(0),                                      // no time/date
        ...u32(crc), ...u32(f.data.length), ...u32(f.data.length),
        ...u16(nameBytes.length), ...u16(0),
      ]));
      push(nameBytes);
      push(f.data);
      central.push({ nameBytes, crc, size: f.data.length, localOffset });
    }

    const centralStart = offset;
    for (const c of central) {
      push(new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
        ...u16(0), ...u16(0),
        ...u32(c.crc), ...u32(c.size), ...u32(c.size),
        ...u16(c.nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
        ...u32(c.localOffset),
      ]));
      push(c.nameBytes);
    }
    const centralSize = offset - centralStart;
    push(new Uint8Array([
      ...u32(0x06054b50), ...u16(0), ...u16(0),
      ...u16(central.length), ...u16(central.length),
      ...u32(centralSize), ...u32(centralStart), ...u16(0),
    ]));
    return new Blob(chunks, { type: mime || "application/zip" });
  }

  // ===================== XLSX =====================
  const COL_A1 = (n) => {                       // 0 -> A, 26 -> AA
    let s = "";
    n += 1;
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T|$)/;

  function sheetXml(rows) {
    // rows: array of arrays. Numbers are written as numeric cells; everything
    // else as an inline string (no shared-string table needed).
    const body = rows.map((row, r) => {
      const cells = row.map((v, c) => {
        const ref = COL_A1(c) + (r + 1);
        if (v == null || v === "") return "";
        if (typeof v === "number" && isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
        if (typeof v === "boolean") return `<c r="${ref}" t="inlineStr"><is><t>${v ? "TRUE" : "FALSE"}</t></is></c>`;
        const s = String(v);
        // Keep bare numeric-looking strings numeric, but never mangle dates,
        // hive codes like "O-2", or long ids.
        if (r > 0 && /^-?\d+(\.\d+)?$/.test(s) && s.length < 15 && !ISO_DATE.test(s)) {
          return `<c r="${ref}"><v>${s}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(s)}</t></is></c>`;
      }).join("");
      return `<row r="${r + 1}">${cells}</row>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  }

  // Excel sheet names: <=31 chars, no : \ / ? * [ ]
  function safeSheetName(name, taken) {
    let n = String(name).replace(/[:\\\/\?\*\[\]]/g, "-").slice(0, 31) || "Sheet";
    let i = 2;
    while (taken.has(n.toLowerCase())) n = (n.slice(0, 28) + "_" + i++).slice(0, 31);
    taken.add(n.toLowerCase());
    return n;
  }

  function xlsxBlob(tables) {
    // tables: [{ name, rows }]
    const taken = new Set();
    const named = tables.map((t) => ({ name: safeSheetName(t.name, taken), rows: t.rows }));
    const files = [];
    files.push({ name: "[Content_Types].xml", data: utf8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
</Types>`) });
    files.push({ name: "_rels/.rels", data: utf8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`) });
    files.push({ name: "xl/workbook.xml", data: utf8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${named.map((t, i) => `<sheet name="${esc(t.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>`) });
    files.push({ name: "xl/_rels/workbook.xml.rels", data: utf8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}
</Relationships>`) });
    named.forEach((t, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(sheetXml(t.rows)) }));
    return zipBlob(files, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }

  // ===================== table helpers =====================
  function toRows(objects, preferredCols) {
    if (!objects.length) return [preferredCols && preferredCols.length ? preferredCols : ["(no rows)"]];
    const seen = new Set();
    const cols = [];
    for (const c of preferredCols || []) if (!seen.has(c)) { seen.add(c); cols.push(c); }
    for (const o of objects) for (const k of Object.keys(o)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    return [cols, ...objects.map((o) => cols.map((c) => {
      const v = o[c];
      if (v == null) return "";
      if (typeof v === "object") return JSON.stringify(v);
      return v;
    }))];
  }
  function rowsToCsv(rows) {
    return rows.map((r) => r.map((v) => {
      const s = v == null ? "" : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")).join("\r\n");
  }
  function rowsToTsv(rows) {
    // Tabs + newlines stripped so a paste into Sheets lands in the right cells.
    return rows.map((r) => r.map((v) => (v == null ? "" : String(v).replace(/[\t\r\n]+/g, " "))).join("\t")).join("\n");
  }

  function saveBlob(name, blob) {
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ===================== wizard state =====================
  const QUEEN_COLS = [
    "queen_code", "name", "status", "year", "season", "current_hive", "race_line", "marking_color",
    "source_method", "graft_date", "emergence_date", "mated_status", "mating_date", "drone_source",
    "mother_queen_id", "replaced_by_id", "laying_pattern", "brood_quality", "temperament",
    "honey_production", "hygienic_behavior", "mite_resistance", "harbo_assay",
    "notable_traits", "productivity_notes", "notes", "status_date", "id", "created_at",
  ];

  const S = {
    open: false,
    step: 1,
    scope: "queens",         // "queens" | "all"
    format: "xlsx",
    queenIds: new Set(),
    hiveLabels: new Set(),
    search: "",
    list: "queens",          // which sub-list the search box filters in "all" scope
  };

  let ctx = null;            // { queens, hives, toast }

  function el(id) { return document.getElementById(id); }

  function hivesOf(queens) {
    const map = new Map();
    for (const q of queens) {
      const raw = (q.current_hive || "").trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      if (!map.has(key)) map.set(key, { label: raw, count: 0 });
      map.get(key).count++;
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }

  function open(context) {
    ctx = context;
    S.open = true;
    S.step = 1;
    S.search = "";
    S.list = "queens";
    S.queenIds = new Set(ctx.queens.map((q) => q.id));          // default: everything
    S.hiveLabels = new Set(hivesOf(ctx.queens).map((h) => h.label));
    el("export-modal").classList.remove("hidden");
    document.body.style.overflow = "hidden";
    render();
  }
  function close() {
    S.open = false;
    el("export-modal").classList.add("hidden");
    document.body.style.overflow = "";
  }

  // ---- selection resolution ----
  // Selecting a hive means "everything that lives in that hive", so in All-data
  // scope a queen is included if she's ticked OR her hive is ticked.
  // True when this queen rides along because her hive is ticked (All-data only).
  function viaHive(q) {
    if (S.scope !== "all") return false;
    const h = (q.current_hive || "").trim();
    return !!h && S.hiveLabels.has(h);
  }
  function selectedQueens() {
    if (S.scope === "queens") return ctx.queens.filter((q) => S.queenIds.has(q.id));
    return ctx.queens.filter((q) => S.queenIds.has(q.id) || viaHive(q));
  }
  function selectedHives() {
    return hivesOf(ctx.queens).filter((h) => S.hiveLabels.has(h.label));
  }

  // ===================== rendering =====================
  function render() {
    if (!S.open) return;
    el("export-body").innerHTML = S.step === 1 ? step1() : S.step === 2 ? step2() : step3();
    wire();
  }

  function stepDots() {
    const names = ["What", "Which", "Format"];
    return `<div class="flex items-center gap-2 mb-4">${names.map((n, i) => {
      const k = i + 1;
      const on = S.step === k, done = S.step > k;
      return `<div class="flex items-center gap-2">
        <span class="w-6 h-6 rounded-full grid place-items-center text-xs font-bold ${
          on ? "bg-honey-500 text-white" : done ? "bg-honey-200 text-honey-800" : "bg-honey-50 text-hive-800/40"}">${done ? "✓" : k}</span>
        <span class="text-xs ${on ? "font-semibold text-honey-800" : "text-hive-800/50"}">${n}</span>
        ${k < 3 ? '<span class="w-6 h-px bg-honey-200"></span>' : ""}
      </div>`;
    }).join("")}</div>`;
  }

  function card(id, icon, title, sub, active) {
    return `<button data-pick="${id}" class="text-left w-full border-2 rounded-xl p-4 transition ${
      active ? "border-honey-500 bg-honey-50" : "border-honey-100 hover:border-honey-300"}">
      <div class="text-2xl">${icon}</div>
      <div class="font-semibold text-honey-800 mt-1">${title}</div>
      <div class="text-xs text-hive-800/60 mt-0.5">${sub}</div>
    </button>`;
  }

  function step1() {
    const nQ = ctx.queens.length;
    const nH = hivesOf(ctx.queens).length;
    return `${stepDots()}
      <p class="text-sm text-hive-800/60 mb-3">What would you like to export?</p>
      <div class="grid sm:grid-cols-2 gap-3">
        ${card("queens", "👑", "Queens", `Just the queen records — ${nQ} total`, S.scope === "queens")}
        ${card("all", "📦", "All data", `Hives &amp; queens, plus inspections, treatments, feedings and the event log — ${nH} hive${nH !== 1 ? "s" : ""}, ${nQ} queen${nQ !== 1 ? "s" : ""}`, S.scope === "all")}
      </div>
      <div class="flex justify-end gap-2 mt-5 pt-3 border-t border-honey-100">
        <button data-act="cancel" class="rounded-lg px-4 py-2 border border-honey-200 hover:bg-honey-50">Cancel</button>
        <button data-act="next" class="bg-honey-500 hover:bg-honey-600 text-white font-semibold rounded-lg px-5 py-2">Next</button>
      </div>`;
  }

  function step2() {
    const term = S.search.toLowerCase().trim();
    const showHives = S.scope === "all";
    const allHives = hivesOf(ctx.queens);

    const hiveMatches = allHives.filter((h) => !term || h.label.toLowerCase().includes(term));
    const queenMatches = ctx.queens.filter((q) => {
      if (!term) return true;
      return [q.queen_code, q.name, q.current_hive, q.race_line, q.year].join(" ").toLowerCase().includes(term);
    });

    const hiveRows = hiveMatches.map((h) => `
      <label class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-honey-50 cursor-pointer">
        <input type="checkbox" data-hive="${esc(h.label)}" ${S.hiveLabels.has(h.label) ? "checked" : ""}
               class="w-4 h-4 accent-amber-500 shrink-0" />
        <span class="text-sm truncate">Hive: <b>${esc(h.label)}</b></span>
        <span class="ml-auto text-xs text-hive-800/40 shrink-0">${h.count} queen${h.count !== 1 ? "s" : ""}</span>
      </label>`).join("") || `<p class="text-xs text-hive-800/40 px-2 py-3">No hives match "${esc(S.search)}".</p>`;

    // A queen can be included two ways: ticked directly, or swept in because her
    // hive is ticked. Show the second case explicitly — otherwise "Deselect all"
    // looks broken, because the total refuses to move while the hives are on.
    const queenRows = queenMatches.map((q) => {
      const picked = S.queenIds.has(q.id);
      const auto = !picked && viaHive(q);
      return `
      <label class="flex items-center gap-2 px-2 py-1.5 rounded-lg ${auto ? "" : "hover:bg-honey-50 cursor-pointer"}">
        <input type="checkbox" data-queen="${esc(q.id)}" ${picked || auto ? "checked" : ""} ${auto ? "disabled" : ""}
               title="${auto ? "Included because hive " + esc(q.current_hive) + " is selected — untick that hive to drop her" : ""}"
               class="w-4 h-4 accent-amber-500 shrink-0 ${auto ? "opacity-50" : ""}" />
        <span class="text-sm truncate ${auto ? "text-hive-800/60" : ""}">${esc(q.queen_code)}${q.name ? ' <span class="text-hive-800/50">· ' + esc(q.name) + "</span>" : ""}</span>
        ${auto ? '<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-honey-100 text-honey-700 shrink-0">via hive</span>' : ""}
        <span class="ml-auto text-xs text-hive-800/40 shrink-0">${q.current_hive ? esc(q.current_hive) : "—"}</span>
      </label>`;
    }).join("") || `<p class="text-xs text-hive-800/40 px-2 py-3">No queens match "${esc(S.search)}".</p>`;

    const tabs = showHives
      ? `<div class="flex gap-1 mb-2">
           <button data-list="queens" class="px-3 py-1 rounded-lg text-sm ${S.list === "queens" ? "bg-honey-500 text-white" : "bg-honey-100 text-honey-700"}">Queens (${selectedQueens().length})</button>
           <button data-list="hives" class="px-3 py-1 rounded-lg text-sm ${S.list === "hives" ? "bg-honey-500 text-white" : "bg-honey-100 text-honey-700"}">Hives (${S.hiveLabels.size})</button>
         </div>`
      : "";

    const visible = showHives && S.list === "hives" ? hiveRows : queenRows;
    const chosen = selectedQueens();
    const nSel = chosen.length;
    const nAuto = chosen.filter((q) => !S.queenIds.has(q.id)).length;
    const breakdown = nAuto
      ? ` (${nSel - nAuto} picked + ${nAuto} via hive)`
      : "";

    return `${stepDots()}
      <div class="flex gap-2 mb-2">
        <input id="export-search" placeholder="🔎 Filter…" value="${esc(S.search)}"
               class="flex-1 border border-honey-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-honey-400" />
        <button data-act="all" class="text-sm border border-honey-200 hover:bg-honey-50 rounded-lg px-3">Select all</button>
        <button data-act="none" class="text-sm border border-honey-200 hover:bg-honey-50 rounded-lg px-3">Deselect all</button>
      </div>
      ${tabs}
      <div class="border border-honey-100 rounded-xl max-h-64 overflow-y-auto p-1">${visible}</div>
      <p class="text-xs text-hive-800/50 mt-2">
        ${nSel} queen${nSel !== 1 ? "s" : ""}${breakdown} will be exported${
          showHives ? ` · ${selectedHives().length} hive${selectedHives().length !== 1 ? "s" : ""}` : ""}.
        ${showHives ? "<br/>Ticking a hive includes every queen recorded in it — untick the hive to drop them." : ""}
      </p>
      <div class="flex justify-between gap-2 mt-5 pt-3 border-t border-honey-100">
        <button data-act="back" class="rounded-lg px-4 py-2 border border-honey-200 hover:bg-honey-50">Back</button>
        <div class="flex gap-2">
          <button data-act="cancel" class="rounded-lg px-4 py-2 border border-honey-200 hover:bg-honey-50">Cancel</button>
          <button data-act="next" class="bg-honey-500 hover:bg-honey-600 text-white font-semibold rounded-lg px-5 py-2">Next</button>
        </div>
      </div>`;
  }

  function step3() {
    const multi = S.scope === "all";
    return `${stepDots()}
      <p class="text-sm text-hive-800/60 mb-3">Choose a format.</p>
      <div class="grid sm:grid-cols-2 gap-3">
        ${card("json", "{ }", "JSON", "Full fidelity — this is the one to use for a backup you can re-import.", S.format === "json")}
        ${card("csv", "📄", "CSV", multi ? "A .zip with one .csv per table." : "One plain .csv file.", S.format === "csv")}
        ${card("xlsx", "📊", "Excel", multi ? "One .xlsx workbook, one tab per table." : "One .xlsx workbook.", S.format === "xlsx")}
        ${card("sheets", "🟩", "Google Sheets", "Copies the queens table to your clipboard and opens a new sheet — then just paste.", S.format === "sheets")}
      </div>
      <div class="flex justify-between gap-2 mt-5 pt-3 border-t border-honey-100">
        <button data-act="back" class="rounded-lg px-4 py-2 border border-honey-200 hover:bg-honey-50">Back</button>
        <div class="flex gap-2">
          <button data-act="cancel" class="rounded-lg px-4 py-2 border border-honey-200 hover:bg-honey-50">Cancel</button>
          <button data-act="go" class="bg-honey-500 hover:bg-honey-600 text-white font-semibold rounded-lg px-5 py-2">Export</button>
        </div>
      </div>`;
  }

  function wire() {
    const body = el("export-body");
    body.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
      if (S.step === 1) S.scope = b.dataset.pick; else S.format = b.dataset.pick;
      render();
    }));
    body.querySelectorAll("[data-list]").forEach((b) => b.addEventListener("click", () => {
      S.list = b.dataset.list; render();
    }));
    body.querySelectorAll("[data-queen]").forEach((c) => c.addEventListener("change", () => {
      if (c.checked) S.queenIds.add(c.dataset.queen); else S.queenIds.delete(c.dataset.queen);
      render();
    }));
    body.querySelectorAll("[data-hive]").forEach((c) => c.addEventListener("change", () => {
      if (c.checked) S.hiveLabels.add(c.dataset.hive); else S.hiveLabels.delete(c.dataset.hive);
      render();
    }));
    const search = el("export-search");
    if (search) {
      search.addEventListener("input", () => {
        S.search = search.value;
        render();
        const s2 = el("export-search");
        if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); }
      });
    }
    body.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act)));
  }

  // Select all / deselect all applies to whatever list is on screen, and only
  // to the rows the current filter is showing — "select all" on a filtered list
  // meaning "select everything, including what I can't see" would be a trap.
  function act(a) {
    const term = S.search.toLowerCase().trim();
    if (a === "cancel") return close();
    if (a === "back") { S.step = Math.max(1, S.step - 1); return render(); }
    if (a === "next") {
      if (S.step === 2 && selectedQueens().length === 0 && S.scope === "queens") {
        return ctx.toast("Pick at least one queen to export");
      }
      S.step = Math.min(3, S.step + 1);
      return render();
    }
    if (a === "all" || a === "none") {
      const on = a === "all";
      if (S.scope === "all" && S.list === "hives") {
        for (const h of hivesOf(ctx.queens)) {
          if (term && !h.label.toLowerCase().includes(term)) continue;
          on ? S.hiveLabels.add(h.label) : S.hiveLabels.delete(h.label);
        }
      } else {
        let heldByHive = 0;
        for (const q of ctx.queens) {
          if (term && ![q.queen_code, q.name, q.current_hive, q.race_line, q.year].join(" ").toLowerCase().includes(term)) continue;
          if (on) { S.queenIds.add(q.id); continue; }
          S.queenIds.delete(q.id);
          if (viaHive(q)) heldByHive++;
        }
        // Without this, unticking every queen while hives are still ticked looks
        // like the button did nothing — the total legitimately doesn't move.
        if (!on && heldByHive) {
          ctx.toast(`${heldByHive} queen${heldByHive !== 1 ? "s are" : " is"} still included via ${heldByHive !== 1 ? "their hives" : "its hive"} — clear those on the Hives tab`);
        }
      }
      return render();
    }
    if (a === "go") return run();
  }

  // ===================== running the export =====================
  async function buildTables() {
    const queens = selectedQueens();
    const ids = new Set(queens.map((q) => q.id));
    const strip = (rows) => rows.map((r) => { const { user_id, ...rest } = r; return rest; });
    const tables = [{ name: "Queens", rows: toRows(strip(queens), QUEEN_COLS), objects: strip(queens) }];

    if (S.scope === "all") {
      const hives = selectedHives().map((h) => ({
        hive: h.label,
        queens_in_history: h.count,
        current_queen: (queens.find((q) => (q.current_hive || "").trim() === h.label && q.status === "alive") || {}).queen_code || "",
        qr_url: location.origin + location.pathname + "?hive=" + encodeURIComponent(h.label),
      }));
      tables.unshift({ name: "Hives", rows: toRows(hives, ["hive", "current_queen", "queens_in_history", "qr_url"]), objects: hives });

      for (const [table, sheet] of [["inspections", "Inspections"], ["treatments", "Treatments"], ["feedings", "Feedings"], ["queen_events", "Event log"]]) {
        let rows = [];
        try { rows = await ctx.listAll(table); } catch (e) { rows = []; }   // table may not exist yet
        const kept = strip(rows.filter((r) => !r.queen_id || ids.has(r.queen_id)));
        tables.push({ name: sheet, rows: toRows(kept), objects: kept });
      }
    }
    return tables;
  }

  async function run() {
    const btn = el("export-body").querySelector('[data-act="go"]');
    if (btn) { btn.disabled = true; btn.textContent = "Working…"; }
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `queen-tracker-${S.scope === "all" ? "all-data" : "queens"}-${stamp}`;
    try {
      const tables = await buildTables();
      const nQ = selectedQueens().length;

      if (S.format === "json") {
        const payload = S.scope === "all"
          ? Object.fromEntries(tables.map((t) => [t.name.toLowerCase().replace(/\s+/g, "_"), t.objects]))
          : tables[0].objects;
        saveBlob(base + ".json", new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
        ctx.toast(`Exported ${nQ} queen${nQ !== 1 ? "s" : ""} as JSON`);

      } else if (S.format === "csv") {
        if (tables.length === 1) {
          saveBlob(base + ".csv", new Blob(["﻿" + rowsToCsv(tables[0].rows)], { type: "text/csv;charset=utf-8" }));
        } else {
          const files = tables.map((t) => ({
            name: t.name.toLowerCase().replace(/\s+/g, "-") + ".csv",
            data: utf8("﻿" + rowsToCsv(t.rows)),
          }));
          saveBlob(base + ".zip", zipBlob(files));
        }
        ctx.toast(`Exported ${nQ} queen${nQ !== 1 ? "s" : ""} as CSV`);

      } else if (S.format === "xlsx") {
        saveBlob(base + ".xlsx", xlsxBlob(tables));
        ctx.toast(`Exported ${tables.length} sheet${tables.length !== 1 ? "s" : ""} to Excel`);

      } else if (S.format === "sheets") {
        const queensTable = tables.find((t) => t.name === "Queens") || tables[0];
        const tsv = rowsToTsv(queensTable.rows);
        let copied = false;
        try { await navigator.clipboard.writeText(tsv); copied = true; } catch (e) { copied = false; }
        // Always leave a file behind too, in case the clipboard was blocked or
        // they'd rather use File > Import in Sheets.
        saveBlob(base + ".xlsx", xlsxBlob(tables));
        window.open("https://sheets.new", "_blank", "noopener");
        ctx.toast(copied
          ? "Copied — click cell A1 in the new sheet and paste (Ctrl/Cmd+V)"
          : "Couldn't reach the clipboard — use File ▸ Import on the downloaded .xlsx", 5000);
      }
      close();
    } catch (e) {
      ctx.toast("Export failed: " + (e.message || e), 4000);
      if (btn) { btn.disabled = false; btn.textContent = "Export"; }
    }
  }

  window.QT_EXPORT = { open, close, _xlsxBlob: xlsxBlob, _rowsToCsv: rowsToCsv, _toRows: toRows, _zipBlob: zipBlob };
})();
