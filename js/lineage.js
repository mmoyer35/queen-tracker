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

    // order nodes within a row roughly by their mother's order (keeps lines tidy)
    let orderIndex = {};
    let counter = 0;
    // seed: roots first in reading order
    queens.filter((q) => isRoot(queens, q)).forEach((q) => (orderIndex[q.id] = counter++));
    // BFS from roots
    const queue = queens.filter((q) => isRoot(queens, q)).slice();
    const seen = new Set(queue.map((q) => q.id));
    while (queue.length) {
      const q = queue.shift();
      childrenOf(queens, q.id).forEach((c) => {
        if (!seen.has(c.id)) { orderIndex[c.id] = counter++; seen.add(c.id); queue.push(c); }
      });
    }
    queens.forEach((q) => { if (orderIndex[q.id] == null) orderIndex[q.id] = counter++; });
    rowKeys.forEach((k) => rowsMap[k].sort((a, b) => orderIndex[a.id] - orderIndex[b.id]));

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

    const statusRing = {
      alive: "#22c55e", dead: "#9ca3af", superseded: "#f59e0b",
      requeened: "#3b82f6", sold: "#a855f7", lost: "#ef4444", banked: "#14b8a6",
    };

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
        node.style.cssText = `min-width:52px;max-width:120px;padding:5px 8px;border-color:${statusRing[q.status] || "#e5d3a8"};border-width:2px;`;
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
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", `M ${from.x} ${from.y} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y}`);
        path.setAttribute("class", "tree-connector");
        svg.appendChild(path);
        // small arrowhead
        const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        dot.setAttribute("cx", to.x); dot.setAttribute("cy", to.y); dot.setAttribute("r", "3");
        dot.setAttribute("fill", "#cc7c12");
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
