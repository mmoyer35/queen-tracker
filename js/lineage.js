// ---------------------------------------------------------------------------
//  Queen Tracker — lineage visualisation (tree + list)
//  window.QT_LINEAGE.render(queens, opts)
// ---------------------------------------------------------------------------
(function () {
  const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));

  function childrenOf(queens, id) {
    return queens.filter((q) => q.mother_queen_id === id);
  }
  function isRoot(queens, q) {
    return !q.mother_queen_id || !queens.some((m) => m.id === q.mother_queen_id);
  }

  // ---- Assign each queen a generation depth (root = 0) --------------------
  function computeDepths(queens) {
    const byId = Object.fromEntries(queens.map((q) => [q.id, q]));
    const depth = {};
    function d(q, seen) {
      if (depth[q.id] != null) return depth[q.id];
      if (isRoot(queens, q)) return (depth[q.id] = 0);
      if (seen.has(q.id)) return 0; // cycle guard
      seen.add(q.id);
      const mom = byId[q.mother_queen_id];
      return (depth[q.id] = (mom ? d(mom, seen) : -1) + 1);
    }
    queens.forEach((q) => d(q, new Set()));
    return depth;
  }

  // =========================================================================
  //  TREE VIEW
  //  Every position below is COMPUTED, not measured: each queen gets an (x, y)
  //  in a virtual canvas and is placed with absolute positioning, so the SVG
  //  connectors can be drawn in the same pass instead of after a reflow.
  //
  //  The big idea is the "band": each root queen (one with no tracked mother)
  //  owns a vertical band of the canvas, and her whole family tree lives inside
  //  it. Bands sit SIDE BY SIDE, so unrelated lineages never interleave and a
  //  second family no longer gets shoved to the bottom of the page. Rows are
  //  still shared across bands, so 2025 lines up with 2025 everywhere.
  // =========================================================================
  const LINEAGE_COLORS = [
    "#22c55e", // green
    "#eab308", // yellow
    "#3b82f6", // blue
    "#f97316", // orange
    "#ec4899", // pink
    "#a855f7", // purple
    "#111827", // black
    "#9ca3af", // gray
    "#92400e", // brown
  ];

  // "#22c55e" -> "rgba(34,197,94,.06)" for the band wash behind a lineage.
  function tint(hex, a) {
    const n = parseInt(String(hex).slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function renderTree(queens, opts) {
    const { container, onSelect, fit } = opts;
    container.innerHTML = "";
    if (!queens.length) {
      container.innerHTML = `<p class="text-hive-800/50 text-center py-16">No queens yet — add some to see the family tree.</p>`;
      return;
    }

    // ---- Metrics (a little tighter on a phone) -----------------------------
    const narrow = (container.clientWidth || 900) < 560;
    const NODE_W = narrow ? 88 : 116;
    const NODE_H = narrow ? 30 : 34;
    const COL_GAP = narrow ? 10 : 14;   // between siblings
    const BAND_GAP = narrow ? 26 : 44;  // between whole lineages
    const ROW_GAP = narrow ? 42 : 54;   // between year rows
    const SUB_GAP = narrow ? 40 : 46;   // same-row mother -> daughter drop
    const GUTTER = narrow ? 40 : 58;    // left column holding the year labels
    const HEAD_H = 24;                  // strip along the top for band titles
    const PAD = 12;

    const byId = Object.fromEntries(queens.map((q) => [q.id, q]));
    const kidsOf = {};
    queens.forEach((q) => {
      const m = q.mother_queen_id;
      if (m && byId[m]) (kidsOf[m] = kidsOf[m] || []).push(q);
    });

    // ---- Rows: prefer year, fall back to generation depth -------------------
    const depths = computeDepths(queens);
    const haveYears = queens.some((q) => q.year);
    const rowKeyOf = (q) => String(haveYears ? (q.year || "Unknown") : depths[q.id]);
    const rowKeys = [...new Set(queens.map(rowKeyOf))].sort((a, b) => {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      if (isNaN(na) && isNaN(nb)) return a.localeCompare(b);
      if (isNaN(na)) return 1;
      if (isNaN(nb)) return -1;
      return na - nb;
    });
    const rowIndex = Object.fromEntries(rowKeys.map((k, i) => [k, i]));
    const rowOf = (q) => rowIndex[rowKeyOf(q)];

    // A mother and daughter can share a row (same calendar year). Drop the
    // daughter onto her own sub-line so the link reads as a short downward hop
    // rather than a flat sideways line. Cascades for same-year granddaughters.
    const subLevel = {};
    (function () {
      const lvl = (q, guard) => {
        if (subLevel[q.id] != null) return subLevel[q.id];
        const mom = byId[q.mother_queen_id];
        if (!mom || rowOf(mom) !== rowOf(q) || guard.has(q.id)) return (subLevel[q.id] = 0);
        guard.add(q.id);
        return (subLevel[q.id] = lvl(mom, guard) + 1);
      };
      queens.forEach((q) => lvl(q, new Set()));
    })();

    // Row tops, sized to however many sub-lines that row actually needs.
    const rowSubMax = rowKeys.map(() => 0);
    queens.forEach((q) => {
      const r = rowOf(q);
      rowSubMax[r] = Math.max(rowSubMax[r], subLevel[q.id] || 0);
    });
    const rowTop = [];
    let yCursor = 0;
    rowKeys.forEach((k, i) => {
      rowTop[i] = yCursor;
      yCursor += rowSubMax[i] * SUB_GAP + NODE_H + ROW_GAP;
    });
    const canvasH = Math.max(0, yCursor - ROW_GAP);
    const yOf = (q) => rowTop[rowOf(q)] + (subLevel[q.id] || 0) * SUB_GAP;
    // Every node sits on exactly one horizontal "line" (row + sub-line). Two
    // queens may only share an x-range if they are on different lines.
    const lineOf = (q) => rowOf(q) + ":" + (subLevel[q.id] || 0);

    // ---- Sibling order ------------------------------------------------------
    // Oldest daughter first, then by code the way a person reads it (B-2 before
    // B-10). The layout keeps every branch contiguous on its own, so there's no
    // need to hoist prolific branches to the left any more — plain chronological
    // order is easier to follow.
    const baseIdx = {};
    queens.forEach((q, i) => (baseIdx[q.id] = i)); // stable tie-break
    const codeCmp = (a, b) =>
      String(a.queen_code || "").localeCompare(String(b.queen_code || ""), undefined, { numeric: true });
    const sortSibs = (a, b) => (a.year || 9999) - (b.year || 9999) || codeCmp(a, b) || baseIdx[a.id] - baseIdx[b.id];

    // ---- Which lineage does each queen belong to? ---------------------------
    const rootId = {};
    const findRoot = (q, guard) => {
      if (rootId[q.id]) return rootId[q.id];
      if (isRoot(queens, q) || guard.has(q.id)) return (rootId[q.id] = q.id);
      guard.add(q.id);
      const mom = byId[q.mother_queen_id];
      return (rootId[q.id] = mom ? findRoot(mom, guard) : q.id);
    };
    queens.forEach((q) => findRoot(q, new Set()));

    // Oldest lineage first — same order for the palette and for the bands, so
    // the leftmost family is always the green one.
    const bandRoots = queens
      .filter((q) => rootId[q.id] === q.id)
      .sort((a, b) =>
        (a.year || 9999) - (b.year || 9999) ||
        String(a.created_at || "").localeCompare(String(b.created_at || "")) ||
        baseIdx[a.id] - baseIdx[b.id]);
    const rootColor = {};
    bandRoots.forEach((r, i) => (rootColor[r.id] = LINEAGE_COLORS[i % LINEAGE_COLORS.length]));
    const colorOf = (q) => rootColor[rootId[q.id]] || "#e5d3a8";

    // ---- Lay out one lineage at a time, left to right ------------------------
    // Within a band: children first (depth-first), then the mother is centred
    // over them. `lineNext` remembers the first free x on each horizontal line,
    // so a centred mother can never land on top of a queen already placed on
    // that line — if she would, she and her whole subtree slide right together.
    const X = {};
    const placed = new Set();
    const bands = [];
    let bandX = 0;

    function layoutBand(root) {
      const lineNext = {};
      const members = [];
      const bump = (q) => {
        const k = lineOf(q);
        lineNext[k] = Math.max(lineNext[k] || 0, X[q.id] + NODE_W + COL_GAP);
      };
      const slide = (q, dx) => {
        X[q.id] += dx;
        bump(q);
        (kidsOf[q.id] || []).forEach((c) => { if (placed.has(c.id)) slide(c, dx); });
      };
      const walk = (q) => {
        if (placed.has(q.id)) return;
        placed.add(q.id);
        members.push(q);
        const kids = (kidsOf[q.id] || []).slice().sort(sortSibs);
        kids.forEach(walk);
        const done = kids.filter((c) => X[c.id] != null);
        const floor = lineNext[lineOf(q)] || 0;
        if (done.length) {
          const xs = done.map((c) => X[c.id]);
          let x = (Math.min(...xs) + Math.max(...xs)) / 2;
          if (x < floor) { const dx = floor - x; done.forEach((c) => slide(c, dx)); x = floor; }
          X[q.id] = x;
        } else {
          X[q.id] = floor;
        }
        bump(q);
      };
      walk(root);

      // Slide the finished band into place beside the previous one.
      const minX = Math.min(...members.map((q) => X[q.id]));
      const maxX = Math.max(...members.map((q) => X[q.id]));
      const width = maxX - minX + NODE_W;
      members.forEach((q) => (X[q.id] += bandX - minX));
      bands.push({ root, x: bandX, w: width, n: members.length });
      bandX += width + BAND_GAP;
    }

    bandRoots.forEach(layoutBand);
    // Anything left over (only possible if the data contains a mother-cycle)
    // still deserves a spot rather than vanishing.
    queens.forEach((q) => { if (!placed.has(q.id)) layoutBand(q); });

    const canvasW = Math.max(0, bandX - BAND_GAP);

    // ---- Build the canvas ---------------------------------------------------
    const wrap = document.createElement("div");
    wrap.className = "lin-canvas";
    wrap.style.cssText = `position:relative;width:${GUTTER + canvasW + PAD}px;height:${HEAD_H + canvasH + PAD}px;`;

    // Year labels ride in a sticky layer so they stay put when the canvas is
    // scrolled sideways. Zero-sized, so it costs no layout space.
    const labels = document.createElement("div");
    labels.className = "lin-labels";
    labels.style.cssText = "position:sticky;left:0;top:0;width:0;height:0;z-index:6;";
    rowKeys.forEach((k, i) => {
      const l = document.createElement("div");
      l.style.cssText = `position:absolute;left:0;top:${HEAD_H + rowTop[i] + (NODE_H - 16) / 2}px;width:${GUTTER - 8}px;font-weight:700;color:#a85e12;font-size:.78rem;line-height:16px;background:#fff;`;
      l.textContent = k;
      labels.appendChild(l);
    });
    wrap.appendChild(labels);

    // Band washes + titles, behind everything else.
    bands.forEach((b) => {
      const color = rootColor[b.root.id] || "#e5d3a8";
      const wash = document.createElement("div");
      wash.className = "lin-band";
      wash.style.cssText = `position:absolute;top:0;left:${GUTTER + b.x - BAND_GAP / 2}px;width:${b.w + BAND_GAP}px;height:100%;background:${tint(color, 0.06)};border-radius:14px;z-index:0;`;
      wrap.appendChild(wash);

      const title = document.createElement("div");
      title.className = "lin-band-title";
      title.style.cssText = `position:absolute;top:0;left:${GUTTER + b.x}px;width:${b.w}px;height:${HEAD_H}px;line-height:${HEAD_H}px;text-align:center;font-size:.7rem;font-weight:700;color:${color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:1;`;
      title.textContent = b.n > 1 ? `${b.root.queen_code} · ${b.n} queens` : b.root.queen_code;
      title.title = `Lineage of ${b.root.queen_code}`;
      wrap.appendChild(title);
    });

    // Connectors.
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", GUTTER + canvasW + PAD);
    svg.setAttribute("height", HEAD_H + canvasH + PAD);
    svg.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;overflow:visible;z-index:2;";
    wrap.appendChild(svg);

    const cxOf = (q) => GUTTER + X[q.id] + NODE_W / 2;
    queens.forEach((q) => {
      const mom = byId[q.mother_queen_id];
      if (!mom || X[q.id] == null || X[mom.id] == null) return;
      const from = { x: cxOf(mom), y: HEAD_H + yOf(mom) + NODE_H };
      const to = { x: cxOf(q), y: HEAD_H + yOf(q) };
      const midY = (from.y + to.y) / 2;
      const color = colorOf(q); // a daughter inherits her lineage's color
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M ${from.x} ${from.y} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y}`);
      path.setAttribute("class", "tree-connector");
      path.style.stroke = color; // inline beats the CSS class stroke
      svg.appendChild(path);
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", to.x); dot.setAttribute("cy", to.y); dot.setAttribute("r", "3");
      dot.setAttribute("fill", color);
      svg.appendChild(dot);
    });

    // Nodes.
    queens.forEach((q) => {
      if (X[q.id] == null) return;
      const node = document.createElement("div");
      node.className = "tree-node bg-white rounded-lg border card-shadow cursor-pointer";
      node.style.cssText = `position:absolute;left:${GUTTER + X[q.id]}px;top:${HEAD_H + yOf(q)}px;width:${NODE_W}px;height:${NODE_H}px;box-sizing:border-box;padding:0 6px;display:flex;align-items:center;justify-content:center;border-color:${colorOf(q)};border-width:2px;z-index:3;`;
      node.dataset.id = q.id;
      node.title = [q.queen_code, q.name, q.year, q.current_hive ? "Hive " + q.current_hive : ""].filter(Boolean).join(" · ");
      node.innerHTML = `<div style="font-weight:700;color:#894b16;font-size:${narrow ? ".72rem" : ".8rem"};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(q.queen_code)}</div>`;
      node.addEventListener("click", () => onSelect(q.id));
      wrap.appendChild(node);
    });

    // ---- Fit-to-width -------------------------------------------------------
    // Side-by-side lineages get wide fast. Normally the canvas just scrolls;
    // with "Fit" on it is scaled down so the whole yard is visible at once.
    const totalW = GUTTER + canvasW + PAD;
    const totalH = HEAD_H + canvasH + PAD;
    const avail = (container.clientWidth || totalW) - 8;
    if (fit && totalW > avail) {
      const s = Math.max(0.35, avail / totalW);
      wrap.style.transformOrigin = "top left";
      wrap.style.transform = `scale(${s})`;
      const shell = document.createElement("div");
      shell.style.cssText = `width:${Math.round(totalW * s)}px;height:${Math.round(totalH * s)}px;`;
      shell.appendChild(wrap);
      container.appendChild(shell);
      return;
    }
    container.appendChild(wrap);
  }

  // =========================================================================
  //  LIST VIEW (collapsible indented outline)
  // =========================================================================
  function renderList(queens, opts) {
    const { container, onSelect, label, ratingDots } = opts;
    container.innerHTML = "";
    if (!queens.length) {
      container.innerHTML = `<p class="text-hive-800/50 text-center py-16">No queens yet.</p>`;
      return;
    }
    const roots = queens.filter((q) => isRoot(queens, q))
      .sort((a, b) => (a.year || 0) - (b.year || 0) || (a.queen_code || "").localeCompare(b.queen_code || ""));

    const ul = document.createElement("ul");
    ul.className = "space-y-1";

    function nodeEl(q, seen) {
      const li = document.createElement("li");
      const kids = childrenOf(queens, q.id).sort((a, b) => (a.year || 0) - (b.year || 0));
      const row = document.createElement("div");
      row.className = "flex items-center gap-2 py-1 px-2 rounded-lg hover:bg-honey-50";
      const hasKids = kids.length > 0 && !seen.has(q.id);
      row.innerHTML = `
        <button class="toggle w-5 text-honey-600 ${hasKids ? "" : "invisible"}">▾</button>
        <span class="text-lg">👑</span>
        <button class="link font-semibold text-honey-800 hover:underline">${esc(q.queen_code)}</button>
        ${q.name ? `<span class="text-sm text-hive-800/60">${esc(q.name)}</span>` : ""}
        ${q.year ? `<span class="text-xs text-hive-800/40">${q.year}</span>` : ""}
        ${q.race_line ? `<span class="text-xs bg-honey-100 text-honey-700 rounded px-1.5">${esc(q.race_line)}</span>` : ""}
        ${hasKids ? `<span class="text-xs text-hive-800/40">${kids.length} daughter${kids.length > 1 ? "s" : ""}</span>` : ""}`;
      row.querySelector(".link").addEventListener("click", () => onSelect(q.id));
      li.appendChild(row);

      if (hasKids) {
        const childUl = document.createElement("ul");
        childUl.className = "ml-6 border-l-2 border-honey-100 pl-3 mt-0.5 space-y-0.5";
        const seen2 = new Set(seen); seen2.add(q.id);
        kids.forEach((k) => childUl.appendChild(nodeEl(k, seen2)));
        li.appendChild(childUl);
        const tgl = row.querySelector(".toggle");
        tgl.addEventListener("click", () => {
          const hidden = childUl.style.display === "none";
          childUl.style.display = hidden ? "" : "none";
          tgl.textContent = hidden ? "▾" : "▸";
        });
      }
      return li;
    }

    roots.forEach((r) => ul.appendChild(nodeEl(r, new Set())));
    container.appendChild(ul);
  }

  window.QT_LINEAGE = {
    render(queens, opts) {
      if (opts.view === "list") renderList(queens, opts);
      else renderTree(queens, opts);
    },
  };
})();
