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
  // =========================================================================
  function renderTree(queens, opts) {
    const { container, onSelect, label, ratingDots } = opts;
    container.innerHTML = "";
    if (!queens.length) {
      container.innerHTML = `<p class="text-hive-800/50 text-center py-16">No queens yet — add some to see the family tree.</p>`;
      return;
    }

    // rows: prefer year; fall back to generation depth
    const depths = computeDepths(queens);
    const haveYears = queens.some((q) => q.year);
    const rowKey = (q) => (haveYears ? (q.year || "Unknown") : depths[q.id]);

    const rowsMap = {};
    queens.forEach((q) => {
      const k = rowKey(q);
      (rowsMap[k] = rowsMap[k] || []).push(q);
    });
    const rowKeys = Object.keys(rowsMap).sort((a, b) => {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      if (isNaN(na) && isNaN(nb)) return 0;
      if (isNaN(na)) return 1;
      if (isNaN(nb)) return -1;
      return na - nb;
    });

    // Horizontal order within each row. Walk the lineage depth-first so every queen's
    // whole branch stays contiguous, and visit siblings (and roots) with the MOST
    // descendants first — so a prolific mother's branch sits on the left while childless
    // or newly-added queens drift to the right.
    const kidsOf = {};
    queens.forEach((q) => { const m = q.mother_queen_id; if (m) (kidsOf[m] = kidsOf[m] || []).push(q); });
    const descCount = {};
    function countDesc(id) {
      if (descCount[id] != null) return descCount[id];
      descCount[id] = 0; // set first so an accidental cycle can't recurse forever
      let n = 0;
      for (const c of (kidsOf[id] || [])) n += 1 + countDesc(c.id);
      return (descCount[id] = n);
    }
    queens.forEach((q) => countDesc(q.id));
    const baseIdx = {};
    queens.forEach((q, i) => (baseIdx[q.id] = i)); // stable tie-break (original list order)
    const sortSibs = (a, b) => (descCount[b.id] - descCount[a.id]) || (baseIdx[a.id] - baseIdx[b.id]);
    const orderIndex = {};
    let counter = 0;
    const visit = (q, guard) => {
      if (orderIndex[q.id] != null || guard.has(q.id)) return;
      guard.add(q.id);
      orderIndex[q.id] = counter++;
      (kidsOf[q.id] || []).slice().sort(sortSibs).forEach((c) => visit(c, guard));
    };
    queens.filter((q) => isRoot(queens, q)).sort(sortSibs).forEach((r) => visit(r, new Set()));
    queens.forEach((q) => { if (orderIndex[q.id] == null) orderIndex[q.id] = counter++; });
    rowKeys.forEach((k) => rowsMap[k].sort((a, b) => orderIndex[a.id] - orderIndex[b.id]));

    // Within a row, nudge each queen slightly lower than her mother when both share
    // the same row (e.g. a mother and her daughters in the same calendar year), so the
    // parent→daughter link reads as a short downward drop instead of a flat side-by-side
    // line. Cascades for same-year granddaughters. Mothers whose daughters fall in a later
    // year are unaffected (offset 0).
    const SAME_ROW_OFFSET = 62; // px of vertical stagger per same-row generation
    const subLevel = {};
    rowKeys.forEach((k) => {
      const rowIds = new Set(rowsMap[k].map((q) => q.id));
      const byIdRow = Object.fromEntries(rowsMap[k].map((q) => [q.id, q]));
      const level = (q, guard) => {
        if (subLevel[q.id] != null) return subLevel[q.id];
        const momId = q.mother_queen_id;
        if (!momId || !rowIds.has(momId) || guard.has(q.id)) return (subLevel[q.id] = 0);
        guard.add(q.id);
        return (subLevel[q.id] = level(byIdRow[momId], guard) + 1);
      };
      rowsMap[k].forEach((q) => level(q, new Set()));
    });

    // build DOM
    const wrap = document.createElement("div");
    wrap.style.position = "relative";
    wrap.style.width = "100%";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.position = "absolute";
    svg.style.left = "0"; svg.style.top = "0";
    svg.style.width = "100%"; svg.style.height = "100%";
    svg.style.pointerEvents = "none";
    svg.style.overflow = "visible";
    wrap.appendChild(svg);

    // ---- Lineage colors ----------------------------------------------------
    // Each root queen (no tracked mother) gets a color; every descendant inherits it,
    // so a whole family tree is one color. Roots are colored oldest-first and the palette
    // cycles, so the 10th distinct lineage reuses the 1st color (green).
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
    const byIdAll = Object.fromEntries(queens.map((q) => [q.id, q]));
    const rootId = {};
    const findRoot = (q, guard) => {
      if (rootId[q.id]) return rootId[q.id];
      if (isRoot(queens, q) || guard.has(q.id)) return (rootId[q.id] = q.id);
      guard.add(q.id);
      const mom = byIdAll[q.mother_queen_id];
      return (rootId[q.id] = mom ? findRoot(mom, guard) : q.id);
    };
    queens.forEach((q) => findRoot(q, new Set()));
    const rootColor = {};
    queens
      .filter((q) => rootId[q.id] === q.id) // the root queens themselves
      .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
      .forEach((r, i) => (rootColor[r.id] = LINEAGE_COLORS[i % LINEAGE_COLORS.length]));
    const colorOf = (q) => rootColor[rootId[q.id]] || "#e5d3a8";

    rowKeys.forEach((k) => {
      const rowEl = document.createElement("div");
      rowEl.className = "lin-row";
      rowEl.style.display = "flex";
      rowEl.style.flexWrap = "wrap";
      rowEl.style.gap = "10px";
      rowEl.style.alignItems = "flex-start";
      rowEl.style.margin = "0 0 40px 0";
      rowEl.style.position = "relative";

      const lbl = document.createElement("div");
      lbl.textContent = k;
      lbl.style.cssText = "position:sticky;left:0;min-width:56px;font-weight:700;color:#a85e12;font-size:.8rem;padding-top:20px;";
      rowEl.appendChild(lbl);

      rowsMap[k].forEach((q) => {
        const node = document.createElement("div");
        node.className = "tree-node bg-white rounded-lg border card-shadow cursor-pointer";
        node.style.cssText = `min-width:52px;max-width:120px;padding:5px 8px;border-color:${colorOf(q)};border-width:2px;`;
        node.style.marginTop = (subLevel[q.id] || 0) * SAME_ROW_OFFSET + "px";
        node.dataset.id = q.id;
        node.innerHTML = `<div style="font-weight:700;color:#894b16;font-size:.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(q.queen_code)}</div>`;
        node.addEventListener("click", () => onSelect(q.id));
        rowEl.appendChild(node);
      });
      wrap.appendChild(rowEl);
    });

    container.appendChild(wrap);

    // draw connectors after layout
    requestAnimationFrame(() => {
      const wrapBox = wrap.getBoundingClientRect();
      svg.setAttribute("width", wrap.scrollWidth);
      svg.setAttribute("height", wrap.scrollHeight);
      const centerOf = (id, edge) => {
        const el = wrap.querySelector(`.tree-node[data-id="${id}"]`);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return {
          x: b.left - wrapBox.left + b.width / 2,
          y: (edge === "top" ? b.top : b.bottom) - wrapBox.top,
        };
      };
      queens.forEach((q) => {
        if (!q.mother_queen_id) return;
        const from = centerOf(q.mother_queen_id, "bottom");
        const to = centerOf(q.id, "top");
        if (!from || !to) return;
        const midY = (from.y + to.y) / 2;
        const lineColor = colorOf(q); // child inherits its lineage color
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", `M ${from.x} ${from.y} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y}`);
        path.setAttribute("class", "tree-connector");
        path.style.stroke = lineColor; // inline beats the CSS class stroke
        svg.appendChild(path);
        // small arrowhead
        const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        dot.setAttribute("cx", to.x); dot.setAttribute("cy", to.y); dot.setAttribute("r", "3");
        dot.setAttribute("fill", lineColor);
        svg.appendChild(dot);
      });
    });
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
