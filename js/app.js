// ---------------------------------------------------------------------------
//  Queen Tracker — main application logic
// ---------------------------------------------------------------------------
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const boot = $("#boot");

  // Guard: not configured -> show setup screen
  if (!window.QT || !window.QT.configured) {
    boot.classList.add("hidden");
    $("#setup-screen").classList.remove("hidden");
    return;
  }

  const { auth, data } = window.QT;

  // Local cache of queens for fast rendering / lineage / dropdowns
  let QUEENS = [];
  let RATING_FIELDS = ["laying_pattern", "temperament", "honey_production", "hygienic_behavior", "mite_resistance"];
  let pendingPhotos = []; // File[] staged in the form

  // ---------- utilities ----------
  const toast = (msg, ms = 2200) => {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.add("hidden"), ms);
  };
  const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const byId = (id) => QUEENS.find((q) => q.id === id);
  const label = (q) => (q ? esc(q.queen_code) + (q.name ? " · " + esc(q.name) : "") : "");

  const STATUS_COLORS = {
    alive: "bg-green-100 text-green-700", dead: "bg-gray-200 text-gray-600",
    superseded: "bg-amber-100 text-amber-700", requeened: "bg-blue-100 text-blue-700",
    sold: "bg-purple-100 text-purple-700", lost: "bg-red-100 text-red-600", banked: "bg-teal-100 text-teal-700",
  };

  function ratingDots(v) {
    v = v || 0;
    let h = '<span class="inline-flex gap-0.5 align-middle">';
    for (let i = 1; i <= 5; i++)
      h += `<span class="rating-dot" style="background:${i <= v ? "#e89a1c" : "#f0dcae"}"></span>`;
    return h + "</span>";
  }

  // ================= AUTH FLOW =================
  const REMEMBER_KEY = "qt_remember_email";

  // Prefill remembered email
  try {
    const savedEmail = localStorage.getItem(REMEMBER_KEY);
    if (savedEmail) {
      $("#auth-email").value = savedEmail;
      $("#auth-remember").checked = true;
      // focus the password field for a returning user
      setTimeout(() => $("#auth-password").focus(), 50);
    }
  } catch (e) { /* localStorage unavailable */ }

  // Password visibility toggle
  $("#auth-toggle-pw").addEventListener("click", () => {
    const p = $("#auth-password");
    const btn = $("#auth-toggle-pw");
    const showing = p.type === "text";
    p.type = showing ? "password" : "text";
    btn.textContent = showing ? "👁️" : "🙈";
    btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    p.focus();
  });

  let signupMode = false;
  $("#auth-toggle").addEventListener("click", () => {
    signupMode = !signupMode;
    $("#auth-submit").textContent = signupMode ? "Create account" : "Sign in";
    $("#auth-toggle").textContent = signupMode ? "Have an account? Sign in" : "New here? Create an account";
    $("#auth-msg").textContent = "";
  });

  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;
    const msg = $("#auth-msg");
    msg.className = "text-sm mt-3 text-center text-hive-800/70";
    msg.textContent = "…";
    // remember (or forget) the email on this device
    try {
      if ($("#auth-remember").checked) localStorage.setItem(REMEMBER_KEY, email);
      else localStorage.removeItem(REMEMBER_KEY);
    } catch (e) { /* localStorage unavailable */ }
    try {
      if (signupMode) {
        const { error } = await auth.signUp(email, password);
        if (error) throw error;
        msg.className = "text-sm mt-3 text-center text-green-700";
        msg.textContent = "Account created! If email confirmation is on, check your inbox, then sign in.";
        signupMode = false;
        $("#auth-submit").textContent = "Sign in";
      } else {
        const { error } = await auth.signIn(email, password);
        if (error) throw error;
        // onChange handler will boot the app
      }
    } catch (err) {
      msg.className = "text-sm mt-3 text-center text-red-600";
      msg.textContent = err.message || "Something went wrong.";
    }
  });

  // ---------- idle auto-logout ----------
  // Sign the user out after this many ms with no interaction.
  const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  const IDLE_EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "click"];
  const IDLE_OPTS = { passive: true, capture: true }; // capture: also catch scrolls inside modals/lists
  let idleLast = Date.now();
  let idleInterval = null;
  let idleWatching = false;
  let idleLoggedOut = false; // set when logout was triggered by inactivity (vs. manual sign-out)
  const bumpIdle = () => { idleLast = Date.now(); };

  function startIdleWatch() {
    if (idleWatching) return;
    idleWatching = true;
    idleLast = Date.now();
    IDLE_EVENTS.forEach((ev) => window.addEventListener(ev, bumpIdle, IDLE_OPTS));
    // Poll instead of one long timer so sleep/background-tab throttling can't skip the logout.
    idleInterval = setInterval(() => {
      if (Date.now() - idleLast >= IDLE_TIMEOUT_MS) {
        idleLoggedOut = true;
        stopIdleWatch();
        auth.signOut(); // onChange handler shows the sign-in screen
      }
    }, 15000);
  }
  function stopIdleWatch() {
    if (!idleWatching) return;
    idleWatching = false;
    clearInterval(idleInterval);
    idleInterval = null;
    IDLE_EVENTS.forEach((ev) => window.removeEventListener(ev, bumpIdle, IDLE_OPTS));
  }

  auth.onChange(async (session) => {
    if (session && session.user) {
      $("#auth-screen").classList.add("hidden");
      $("#menu-email").textContent = session.user.email;
      startIdleWatch();
      await startApp();
    } else {
      stopIdleWatch();
      $("#app").classList.add("hidden");
      $("#auth-screen").classList.remove("hidden");
      if (idleLoggedOut) {
        idleLoggedOut = false;
        const msg = $("#auth-msg");
        if (msg) {
          msg.className = "text-sm mt-3 text-center text-hive-800/70";
          msg.textContent = "Signed out after 30 minutes of inactivity.";
        }
      }
    }
    boot.classList.add("hidden");
  });

  // Fallback: if no auth event within a moment, decide screen
  (async () => {
    const user = await auth.getUser();
    if (!user) {
      boot.classList.add("hidden");
      $("#auth-screen").classList.remove("hidden");
    }
  })();

  // ================= APP START =================
  async function startApp() {
    $("#app").classList.remove("hidden");
    await refresh();
    switchTab("queens");
  }

  async function refresh() {
    try {
      QUEENS = await data.listQueens();
    } catch (e) {
      toast("Load error: " + e.message);
      QUEENS = [];
    }
    buildYearFilter();
    renderQueens();
    if (currentTab === "lineage") renderLineage();
    if (currentTab === "stats") renderStats();
  }

  // ================= TABS =================
  let currentTab = "queens";
  function switchTab(name) {
    currentTab = name;
    $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    $("#tab-queens").classList.toggle("hidden", name !== "queens");
    $("#tab-lineage").classList.toggle("hidden", name !== "lineage");
    $("#tab-stats").classList.toggle("hidden", name !== "stats");
    if (name === "lineage") renderLineage();
    if (name === "stats") renderStats();
  }
  $$(".tab-btn").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  // ================= HEADER MENU =================
  $("#btn-menu").addEventListener("click", (e) => { e.stopPropagation(); $("#menu").classList.toggle("hidden"); });
  document.addEventListener("click", () => $("#menu").classList.add("hidden"));
  $("#menu").addEventListener("click", (e) => e.stopPropagation());
  $("#menu-signout").addEventListener("click", () => auth.signOut());
  $("#menu-export").addEventListener("click", exportJSON);
  $("#menu-export-csv").addEventListener("click", exportCSV);

  // ================= QUEENS LIST =================
  const buildYearFilter = () => {
    const years = [...new Set(QUEENS.map((q) => q.year).filter(Boolean))].sort((a, b) => b - a);
    const sel = $("#filter-year");
    const cur = sel.value;
    sel.innerHTML = '<option value="">All years</option>' + years.map((y) => `<option>${y}</option>`).join("");
    sel.value = cur;
  };

  ["#search", "#filter-year", "#filter-status", "#sort-by"].forEach((s) =>
    $(s).addEventListener("input", renderQueens)
  );

  function filteredSorted() {
    const term = $("#search").value.toLowerCase().trim();
    const fy = $("#filter-year").value;
    const fs = $("#filter-status").value;
    let list = QUEENS.filter((q) => {
      if (fy && String(q.year) !== fy) return false;
      if (fs && q.status !== fs) return false;
      if (term) {
        const hay = [q.queen_code, q.name, q.current_hive, q.race_line, q.notable_traits, q.notes].join(" ").toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
    const sort = $("#sort-by").value;
    list.sort((a, b) => {
      if (sort === "code") return (a.queen_code || "").localeCompare(b.queen_code || "");
      if (sort === "year_desc") return (b.year || 0) - (a.year || 0);
      if (sort === "laying_desc") return (b.laying_pattern || 0) - (a.laying_pattern || 0);
      return new Date(b.created_at) - new Date(a.created_at);
    });
    return list;
  }

  async function renderQueens() {
    const grid = $("#queens-grid");
    const list = filteredSorted();
    $("#queens-empty").classList.toggle("hidden", QUEENS.length !== 0);
    grid.innerHTML = list
      .map((q) => {
        const mom = q.mother_queen_id ? byId(q.mother_queen_id) : null;
        const sc = STATUS_COLORS[q.status] || "bg-gray-100 text-gray-600";
        return `
        <div class="queen-card bg-white rounded-xl card-shadow overflow-hidden cursor-pointer hover:ring-2 hover:ring-honey-300" data-id="${q.id}">
          <div class="h-32 bg-honey-100 flex items-center justify-center text-4xl thumb" data-thumb="${q.id}">🐝</div>
          <div class="p-3">
            <div class="flex items-center gap-2">
              <h3 class="font-bold text-honey-800 truncate">${esc(q.queen_code)}</h3>
              <span class="text-xs px-2 py-0.5 rounded-full ${sc} ml-auto capitalize">${esc(q.status || "")}</span>
            </div>
            ${q.name ? `<p class="text-sm text-hive-800/70 -mt-0.5">${esc(q.name)}</p>` : ""}
            <div class="mt-2 text-xs text-hive-800/70 space-y-1">
              <div>${q.year ? "📅 " + q.year : ""} ${q.race_line ? " · 🧬 " + esc(q.race_line) : ""}</div>
              <div>${q.current_hive ? "🏠 " + esc(q.current_hive) : ""}</div>
              ${mom ? `<div>👑 mother: ${label(mom)}</div>` : ""}
              <div class="flex items-center gap-1 pt-1">laying ${ratingDots(q.laying_pattern)}</div>
            </div>
          </div>
        </div>`;
      })
      .join("");
    $$(".queen-card", grid).forEach((c) => c.addEventListener("click", () => openDetail(c.dataset.id)));
    // async load thumbnails
    for (const q of list) loadThumb(q.id);
  }

  async function loadThumb(queenId) {
    try {
      const photos = await data.listPhotos(queenId);
      if (!photos.length) return;
      const primary = photos.find((p) => p.is_primary) || photos[0];
      const url = await data.photoUrl(primary.storage_path);
      const el = document.querySelector(`.thumb[data-thumb="${queenId}"]`);
      if (el && url) {
        el.style.backgroundImage = `url('${url}')`;
        el.style.backgroundSize = "cover";
        el.style.backgroundPosition = "center";
        el.textContent = "";
      }
    } catch (e) { /* ignore */ }
  }

  // ================= FORM (add / edit) =================
  const formModal = $("#form-modal");
  const F = (k) => $("#f-" + k);
  const CORE_FIELDS = [
    "queen_code","name","source_method","graft_date","emergence_date","season","drone_source",
    "current_hive","mated_status","productivity_notes",
    "race_line","marking_color","notable_traits",
    "status","status_date","notes",
  ];

  function buildRatingWidgets() {
    $$(".rating").forEach((box) => {
      if (box.dataset.built) return;
      const field = box.dataset.field;
      const wrap = document.createElement("div");
      wrap.className = "flex gap-1 mt-1";
      for (let i = 1; i <= 5; i++) {
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = "w-7 h-7 rounded-full border border-honey-300 text-xs font-semibold";
        dot.textContent = i;
        dot.addEventListener("click", () => setRating(field, i));
        wrap.appendChild(dot);
      }
      const clear = document.createElement("button");
      clear.type = "button"; clear.className = "text-xs text-hive-800/40 ml-1"; clear.textContent = "clear";
      clear.addEventListener("click", () => setRating(field, null));
      wrap.appendChild(clear);
      box.appendChild(wrap);
      box.dataset.built = "1";
    });
  }
  const ratingState = {};
  function setRating(field, val) {
    ratingState[field] = val;
    const box = document.querySelector(`.rating[data-field="${field}"]`);
    $$("button", box).forEach((b, idx) => {
      if (b.textContent === "clear") return;
      const n = idx + 1;
      b.style.background = val && n <= val ? "#e89a1c" : "white";
      b.style.color = val && n <= val ? "white" : "#894b16";
    });
  }

  function populateMotherDropdowns(excludeId) {
    const opts = '<option value="">— none —</option>' +
      QUEENS.filter((q) => q.id !== excludeId)
        .sort((a, b) => (b.year || 0) - (a.year || 0) || (a.queen_code || "").localeCompare(b.queen_code || ""))
        .map((q) => `<option value="${q.id}">${label(q)}${q.year ? " (" + q.year + ")" : ""}</option>`).join("");
    F("mother_queen_id").innerHTML = opts;
    F("replaced_by_id").innerHTML = opts;
  }

  function openForm(queen) {
    buildRatingWidgets();
    pendingPhotos = [];
    $("#photo-preview").innerHTML = "";
    $("#f-photos").value = "";
    $("#queen-form").reset();
    Object.keys(ratingState).forEach((k) => (ratingState[k] = null));
    RATING_FIELDS.forEach((f) => setRating(f, null));

    populateMotherDropdowns(queen ? queen.id : null);

    if (queen) {
      $("#form-title").textContent = "Edit Queen — " + queen.queen_code;
      $("#f-id").value = queen.id;
      CORE_FIELDS.forEach((f) => { if (F(f)) F(f).value = queen[f] == null ? "" : queen[f]; });
      F("mother_queen_id").value = queen.mother_queen_id || "";
      F("replaced_by_id").value = queen.replaced_by_id || "";
      RATING_FIELDS.forEach((f) => setRating(f, queen[f]));
      $("#form-delete").classList.remove("hidden");
      renderExistingPhotos(queen.id);
    } else {
      $("#form-title").textContent = "New Queen";
      $("#f-id").value = "";
      F("status").value = "alive";
      const today = new Date().toISOString().slice(0, 10);
      ["graft_date", "emergence_date", "status_date"].forEach((f) => {
        if (F(f)) F(f).value = today;
      });
      $("#form-delete").classList.add("hidden");
    }
    formModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }
  function closeForm() {
    formModal.classList.add("hidden");
    document.body.style.overflow = "";
  }
  $("#btn-add").addEventListener("click", () => openForm(null));
  $("#form-close").addEventListener("click", closeForm);
  $("#form-cancel").addEventListener("click", closeForm);

  // photo staging
  $("#f-photos").addEventListener("change", (e) => {
    for (const file of e.target.files) {
      pendingPhotos.push(file);
      const url = URL.createObjectURL(file);
      const chip = document.createElement("div");
      chip.className = "relative";
      chip.innerHTML = `<img src="${url}" class="w-16 h-16 object-cover rounded-lg border border-honey-200" />`;
      $("#photo-preview").appendChild(chip);
    }
    e.target.value = "";
  });

  async function renderExistingPhotos(queenId) {
    const box = $("#photo-preview");
    const photos = await data.listPhotos(queenId);
    for (const p of photos) {
      const url = await data.photoUrl(p.storage_path);
      const chip = document.createElement("div");
      chip.className = "relative group";
      chip.innerHTML = `
        <img src="${url}" class="w-16 h-16 object-cover rounded-lg border border-honey-200" />
        <button type="button" title="Remove" class="absolute -top-2 -right-2 bg-red-600 text-white rounded-full w-5 h-5 text-xs">×</button>`;
      chip.querySelector("button").addEventListener("click", async () => {
        if (!confirm("Delete this photo?")) return;
        await data.deletePhoto(p);
        chip.remove();
        toast("Photo deleted");
      });
      box.appendChild(chip);
    }
  }

  $("#queen-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const saveBtn = $("#form-save");
    saveBtn.disabled = true; saveBtn.textContent = "Saving…";
    try {
      const row = { id: $("#f-id").value || undefined };
      CORE_FIELDS.forEach((f) => { if (F(f)) row[f] = F(f).value; });
      row.mother_queen_id = F("mother_queen_id").value || null;
      row.replaced_by_id = F("replaced_by_id").value || null;
      RATING_FIELDS.forEach((f) => (row[f] = ratingState[f] ?? null));
      // Year is no longer entered manually — derive it from a date so the
      // year filter, "reared by year" chart, and lineage grouping keep working.
      const dateForYear = row.emergence_date || row.graft_date || row.status_date;
      if (dateForYear) {
        row.year = parseInt(String(dateForYear).slice(0, 4), 10);
      } else if (row.id) {
        const existing = byId(row.id);
        row.year = existing ? existing.year : new Date().getFullYear();
      } else {
        row.year = new Date().getFullYear();
      }

      const saved = await data.saveQueen(row);

      if (pendingPhotos.length) {
        saveBtn.textContent = "Uploading photos…";
        for (const file of pendingPhotos) await data.uploadPhoto(saved.id, file);
      }
      toast("Queen saved 🐝");
      closeForm();
      await refresh();
    } catch (err) {
      toast("Save failed: " + err.message, 4000);
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = "Save queen";
    }
  });

  $("#form-delete").addEventListener("click", async () => {
    const id = $("#f-id").value;
    const q = byId(id);
    if (!q) return;
    if (!confirm(`Delete queen "${q.queen_code}"? This also removes her photos and events. This cannot be undone.`)) return;
    try {
      await data.deleteQueen(id);
      toast("Queen deleted");
      closeForm();
      await refresh();
    } catch (err) { toast("Delete failed: " + err.message, 4000); }
  });

  // ================= DETAIL VIEW =================
  const detailModal = $("#detail-modal");
  let detailId = null;
  $("#detail-close").addEventListener("click", () => { detailModal.classList.add("hidden"); document.body.style.overflow = ""; });
  $("#detail-edit").addEventListener("click", () => {
    detailModal.classList.add("hidden");
    openForm(byId(detailId));
  });

  async function openDetail(id) {
    detailId = id;
    const q = byId(id);
    if (!q) return;
    $("#detail-title").textContent = q.queen_code + (q.name ? " · " + q.name : "");
    const body = $("#detail-body");
    const mom = q.mother_queen_id ? byId(q.mother_queen_id) : null;
    const kids = QUEENS.filter((k) => k.mother_queen_id === q.id);
    const repl = q.replaced_by_id ? byId(q.replaced_by_id) : null;

    const row = (lbl, val) => (val || val === 0 ? `<div class="flex gap-2 py-1 border-b border-honey-50"><dt class="w-40 shrink-0 text-hive-800/50 text-sm">${lbl}</dt><dd class="text-sm">${val}</dd></div>` : "");
    const rate = (lbl, v) => (v ? `<div class="flex gap-2 py-1 border-b border-honey-50 items-center"><dt class="w-40 shrink-0 text-hive-800/50 text-sm">${lbl}</dt><dd>${ratingDots(v)} <span class="text-xs text-hive-800/50">${v}/5</span></dd></div>` : "");

    body.innerHTML = `
      <div id="detail-photos" class="flex flex-wrap gap-2 mb-4"></div>
      <div class="grid sm:grid-cols-2 gap-x-6">
        <dl>
          <div class="text-honey-700 font-semibold text-xs uppercase mt-1 mb-1">Core</div>
          ${row("Status", `<span class="capitalize px-2 py-0.5 rounded-full text-xs ${STATUS_COLORS[q.status]||''}">${esc(q.status||"")}</span> ${q.status_date? " · "+q.status_date:""}`)}
          ${row("Source method", esc(q.source_method))}
          ${row("Year / season", [q.year, q.season].filter(Boolean).join(" · "))}
          ${row("Graft date", q.graft_date)}
          ${row("Emergence date", q.emergence_date)}
          ${row("Mother", mom ? `<a href="#" class="text-honey-700 underline" data-goto="${mom.id}">${label(mom)}</a>` : "—")}
          ${row("Drone source", esc(q.drone_source))}
          ${row("Daughters", kids.length ? kids.map(k=>`<a href="#" class="text-honey-700 underline mr-2" data-goto="${k.id}">${label(k)}</a>`).join("") : "—")}
          ${repl ? row("Replaced by", `<a href="#" class="text-honey-700 underline" data-goto="${repl.id}">${label(repl)}</a>`) : ""}
        </dl>
        <dl>
          <div class="text-honey-700 font-semibold text-xs uppercase mt-1 mb-1">Hive &amp; performance</div>
          ${row("Current hive", esc(q.current_hive))}
          ${row("Mated status", esc(q.mated_status || ""))}
          ${rate("Laying pattern", q.laying_pattern)}
          ${rate("Temperament", q.temperament)}
          ${rate("Honey production", q.honey_production)}
          <div class="text-honey-700 font-semibold text-xs uppercase mt-3 mb-1">Genetics</div>
          ${row("Race / line", esc(q.race_line))}
          ${row("Marking", esc(q.marking_color))}
          ${rate("Hygienic behavior", q.hygienic_behavior)}
          ${rate("Mite resistance", q.mite_resistance)}
        </dl>
      </div>
      ${q.notable_traits ? `<div class="mt-3"><div class="text-honey-700 font-semibold text-xs uppercase mb-1">Notable traits</div><p class="text-sm whitespace-pre-wrap">${esc(q.notable_traits)}</p></div>` : ""}
      ${q.productivity_notes ? `<div class="mt-3"><div class="text-honey-700 font-semibold text-xs uppercase mb-1">Productivity notes</div><p class="text-sm whitespace-pre-wrap">${esc(q.productivity_notes)}</p></div>` : ""}
      ${q.notes ? `<div class="mt-3"><div class="text-honey-700 font-semibold text-xs uppercase mb-1">Notes</div><p class="text-sm whitespace-pre-wrap">${esc(q.notes)}</p></div>` : ""}

      <!-- Events timeline -->
      <div class="mt-5 pt-4 border-t border-honey-100">
        <div class="flex items-center gap-2 mb-2">
          <h3 class="text-honey-700 font-semibold text-sm uppercase">Timeline</h3>
          <button id="add-event-btn" class="ml-auto text-xs bg-honey-100 text-honey-700 rounded px-2 py-1 font-medium">+ Add entry</button>
        </div>
        <form id="event-form" class="hidden gap-2 mb-3 flex-wrap sm:flex-nowrap flex">
          <input id="ev-date" type="date" class="inp" style="max-width:150px" />
          <input id="ev-type" class="inp" placeholder="type (inspection…)" style="max-width:160px" />
          <input id="ev-note" class="inp" placeholder="note" />
          <button class="bg-honey-500 text-white rounded-lg px-3 text-sm">Add</button>
        </form>
        <ul id="events-list" class="space-y-1 text-sm"></ul>
      </div>`;

    // wire cross-links
    $$("[data-goto]", body).forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); openDetail(a.dataset.goto); }));

    detailModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";

    // photos
    const pbox = $("#detail-photos");
    const photos = await data.listPhotos(id);
    if (!photos.length) pbox.innerHTML = `<div class="w-full h-40 bg-honey-100 rounded-xl flex items-center justify-center text-5xl">🐝</div>`;
    for (const p of photos) {
      const url = await data.photoUrl(p.storage_path);
      const im = document.createElement("img");
      im.src = url; im.className = "h-40 rounded-xl object-cover cursor-zoom-in";
      im.title = p.caption || "";
      im.addEventListener("click", () => window.open(url, "_blank"));
      pbox.appendChild(im);
    }

    // events
    await renderEvents(id);
    $("#add-event-btn").addEventListener("click", () => {
      $("#event-form").classList.toggle("hidden");
      $("#ev-date").value = new Date().toISOString().slice(0, 10);
    });
    $("#event-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = $("#ev-date").value;
      if (!d) return;
      await data.addEvent(id, d, $("#ev-type").value, $("#ev-note").value);
      $("#event-form").reset();
      $("#event-form").classList.add("hidden");
      await renderEvents(id);
      toast("Timeline entry added");
    });
  }

  async function renderEvents(id) {
    const ul = $("#events-list");
    const events = await data.listEvents(id);
    if (!events.length) { ul.innerHTML = `<li class="text-hive-800/40">No timeline entries yet.</li>`; return; }
    ul.innerHTML = events.map((ev) => `
      <li class="flex gap-2 items-start group">
        <span class="text-honey-600 font-mono text-xs mt-0.5 w-24 shrink-0">${ev.event_date}</span>
        <span class="flex-1">${ev.event_type ? `<b class="text-honey-800">${esc(ev.event_type)}:</b> ` : ""}${esc(ev.note||"")}</span>
        <button data-ev="${ev.id}" class="text-red-500 opacity-0 group-hover:opacity-100 text-xs">delete</button>
      </li>`).join("");
    $$("[data-ev]", ul).forEach((b) => b.addEventListener("click", async () => {
      await data.deleteEvent(b.dataset.ev); await renderEvents(id);
    }));
  }

  // ================= LINEAGE =================
  function renderLineage() {
    window.QT_LINEAGE.render(QUEENS, {
      container: currentLineageView === "tree" ? $("#lineage-tree") : $("#lineage-list"),
      view: currentLineageView,
      onSelect: (id) => openDetail(id),
      label,
      ratingDots,
    });
  }
  let currentLineageView = "tree";
  $("#lin-view-tree").addEventListener("click", () => setLineageView("tree"));
  $("#lin-view-list").addEventListener("click", () => setLineageView("list"));
  function setLineageView(v) {
    currentLineageView = v;
    $("#lineage-tree").classList.toggle("hidden", v !== "tree");
    $("#lineage-list").classList.toggle("hidden", v !== "list");
    $("#lin-view-tree").className = "px-4 py-2 text-sm font-medium " + (v === "tree" ? "bg-honey-500 text-white" : "bg-white text-honey-700");
    $("#lin-view-list").className = "px-4 py-2 text-sm font-medium " + (v === "list" ? "bg-honey-500 text-white" : "bg-white text-honey-700");
    renderLineage();
  }

  // ================= STATS =================
  function renderStats() {
    const total = QUEENS.length;
    const alive = QUEENS.filter((q) => q.status === "alive").length;
    const laying = QUEENS.filter((q) => q.mated_status === "laying").length;
    const avgLay = (() => {
      const v = QUEENS.map((q) => q.laying_pattern).filter(Boolean);
      return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : "—";
    })();
    const cards = [
      ["Total queens", total, "🐝"],
      ["Alive", alive, "💚"],
      ["Currently laying", laying, "🥚"],
      ["Avg laying pattern", avgLay, "⭐"],
    ];
    $("#stats-grid").innerHTML = cards.map(([l, v, e]) => `
      <div class="bg-white card-shadow rounded-xl p-5">
        <div class="text-3xl">${e}</div>
        <div class="text-3xl font-bold text-honey-800 mt-1">${v}</div>
        <div class="text-sm text-hive-800/60">${l}</div>
      </div>`).join("");

    const byYear = {};
    QUEENS.forEach((q) => { const y = q.year || "Unknown"; byYear[y] = (byYear[y] || 0) + 1; });
    const years = Object.keys(byYear).sort();
    const max = Math.max(1, ...Object.values(byYear));
    $("#stats-byyear").innerHTML = `<h3 class="font-semibold text-honey-800 mb-3">Queens reared by year</h3>` +
      years.map((y) => `
        <div class="flex items-center gap-3 mb-2">
          <span class="w-16 text-sm text-hive-800/60">${y}</span>
          <div class="flex-1 bg-honey-100 rounded-full h-5 overflow-hidden">
            <div class="bg-honey-500 h-5" style="width:${(byYear[y]/max)*100}%"></div>
          </div>
          <span class="w-8 text-sm font-semibold text-honey-700">${byYear[y]}</span>
        </div>`).join("") || "<p class='text-hive-800/50'>No data yet.</p>";
  }

  // ================= EXPORT =================
  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
  }
  function exportJSON() {
    download(`queen-tracker-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(QUEENS, null, 2), "application/json");
    toast("Exported JSON");
  }
  function exportCSV() {
    if (!QUEENS.length) return toast("Nothing to export");
    const cols = Object.keys(QUEENS[0]).filter((c) => c !== "user_id");
    const rows = QUEENS.map((q) => cols.map((c) => {
      const v = q[c] == null ? "" : String(q[c]).replace(/"/g, '""');
      return `"${v}"`;
    }).join(","));
    download(`queen-tracker-${new Date().toISOString().slice(0,10)}.csv`, [cols.join(","), ...rows].join("\n"), "text/csv");
    toast("Exported CSV");
  }

  // close modals on backdrop click / escape
  [formModal, detailModal].forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) { m.classList.add("hidden"); document.body.style.overflow = ""; } }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { formModal.classList.add("hidden"); detailModal.classList.add("hidden"); document.body.style.overflow = ""; } });
})();
