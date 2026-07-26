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
  let RATING_FIELDS = ["laying_pattern", "brood_quality", "temperament", "honey_production", "hygienic_behavior", "mite_resistance"];
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
  let signupMode = false;

  // Reusable show/hide password toggle for a (button, input) pair
  function wirePwToggle(btnSel, inputSel) {
    const btn = $(btnSel), input = $(inputSel);
    if (!btn || !input) return;
    btn.addEventListener("click", () => {
      const revealing = input.type === "password";
      input.type = revealing ? "text" : "password";
      btn.textContent = revealing ? "🙈" : "👁️";
      const lbl = revealing ? "Hide password" : "Show password";
      btn.setAttribute("aria-label", lbl);
      btn.setAttribute("aria-pressed", String(revealing));
      input.focus();
    });
  }
  wirePwToggle("#auth-toggle-pw", "#auth-password");
  wirePwToggle("#auth-toggle-pw2", "#auth-password2");

  // Switch between "sign in" and "create account" — shows the confirm field on signup
  function setAuthMode(signup) {
    signupMode = signup;
    $("#auth-submit").textContent = signup ? "Create account" : "Sign in";
    $("#auth-toggle").textContent = signup ? "Have an account? Sign in" : "New here? Create an account";
    $("#auth-confirm-wrap").classList.toggle("hidden", !signup);
    const pw = $("#auth-password"), pw2 = $("#auth-password2");
    pw2.required = signup;
    pw.setAttribute("autocomplete", signup ? "new-password" : "current-password");
    if (!signup) pw2.value = "";
  }

  $("#auth-toggle").addEventListener("click", () => {
    setAuthMode(!signupMode);
    $("#auth-msg").textContent = "";
  });

  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;
    const msg = $("#auth-msg");
    const submitBtn = $("#auth-submit");

    // On account creation, require the two passwords to match before hitting the server
    if (signupMode && password !== $("#auth-password2").value) {
      msg.className = "text-sm mt-3 text-center text-red-600";
      msg.textContent = "Passwords don't match.";
      $("#auth-password2").focus();
      return;
    }

    msg.className = "text-sm mt-3 text-center text-hive-800/70";
    msg.textContent = "…";
    submitBtn.disabled = true;
    try {
      if (signupMode) {
        const { error } = await auth.signUp(email, password);
        if (error) throw error;
        msg.className = "text-sm mt-3 text-center text-green-700";
        msg.textContent = "Account created! If email confirmation is on, check your inbox, then sign in.";
        setAuthMode(false); // back to sign-in mode, hide + clear the confirm field
      } else {
        const { error } = await auth.signIn(email, password);
        if (error) throw error;
        // onChange handler will boot the app
      }
    } catch (err) {
      msg.className = "text-sm mt-3 text-center text-red-600";
      msg.textContent = err.message || "Something went wrong.";
    } finally {
      submitBtn.disabled = false;
    }
  });

  auth.onChange(async (session) => {
    if (session && session.user) {
      $("#auth-screen").classList.add("hidden");
      $("#menu-email").textContent = session.user.email;
      await startApp();
    } else {
      $("#app").classList.add("hidden");
      $("#auth-screen").classList.remove("hidden");
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
    handleDeepLink();
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
    if (currentTab === "hives") renderHives();
    if (currentTab === "lineage") renderLineage();
    if (currentTab === "stats") renderStats();
  }

  // ================= TABS =================
  let currentTab = "queens";
  function switchTab(name) {
    currentTab = name;
    $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    $("#tab-queens").classList.toggle("hidden", name !== "queens");
    $("#tab-hives").classList.toggle("hidden", name !== "hives");
    $("#tab-lineage").classList.toggle("hidden", name !== "lineage");
    $("#tab-stats").classList.toggle("hidden", name !== "stats");
    if (name === "hives") renderHives();
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
    "queen_code","name","source_method","graft_date","emergence_date","year","season","drone_source",
    "current_hive","mated_status","mating_date","productivity_notes",
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
      F("year").value = new Date().getFullYear();
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
      if (row.year) row.year = parseInt(row.year, 10);

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

    // QR button — only when this queen is assigned to a hive
    const dqr = $("#detail-qr");
    const hiveLabel = (q.current_hive || "").trim();
    if (hiveLabel) {
      dqr.classList.remove("hidden");
      dqr.onclick = () => openQrModal(hiveLabel);
    } else {
      dqr.classList.add("hidden");
      dqr.onclick = null;
    }

    // Voice-note button — available for any queen
    const dvoice = $("#detail-voice");
    dvoice.classList.remove("hidden");
    dvoice.onclick = () => openVoiceModal(q.id, hiveLabel);
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
          ${row("Mated status", [esc(q.mated_status), q.mating_date].filter(Boolean).join(" · "))}
          ${rate("Laying pattern", q.laying_pattern)}
          ${rate("Brood quality", q.brood_quality)}
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

  // ================= HIVES & QR CODES =================
  // Base URL the QR codes point at — works wherever the app is hosted (GitHub Pages, etc.)
  function appBase() { return location.origin + location.pathname; }
  function hiveUrl(label) { return appBase() + "?hive=" + encodeURIComponent(label); }

  // Build an SVG QR code (crisp at any print size) for `text`, sized ~sizePx.
  function qrSvg(text, sizePx) {
    const qr = qrcode(0, "M");        // auto version, medium error-correction
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const margin = 4;                 // quiet zone (modules)
    const cell = Math.max(2, Math.floor(sizePx / (count + margin * 2)));
    return qr.createSvgTag({ cellSize: cell, margin });
  }

  // Group queens into hives by their `current_hive` label (case-insensitive).
  function deriveHives() {
    const map = new Map();
    for (const q of QUEENS) {
      const h = (q.current_hive || "").trim();
      if (!h) continue;
      const key = h.toLowerCase();
      if (!map.has(key)) map.set(key, { label: h, queens: [] });
      map.get(key).queens.push(q);
    }
    const byNewest = (a, b) => new Date(b.created_at) - new Date(a.created_at);
    const hives = [...map.values()].map(({ label, queens }) => {
      const alive = queens.filter((q) => q.status === "alive").sort(byNewest);
      const any = [...queens].sort(byNewest);
      return { label, current: alive[0] || any[0], count: queens.length, aliveCount: alive.length };
    });
    hives.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
    return hives;
  }

  // The queen a scanned hive should open: the alive one (most recent), else most recent ever.
  function findHiveCurrentQueen(label) {
    const key = (label || "").trim().toLowerCase();
    const queens = QUEENS.filter((q) => (q.current_hive || "").trim().toLowerCase() === key);
    if (!queens.length) return null;
    const byNewest = (a, b) => new Date(b.created_at) - new Date(a.created_at);
    return queens.filter((q) => q.status === "alive").sort(byNewest)[0] || [...queens].sort(byNewest)[0];
  }

  function renderHives() {
    const grid = $("#hives-grid");
    const all = deriveHives();
    $("#hives-empty").classList.toggle("hidden", all.length !== 0);
    const term = ($("#hive-search").value || "").toLowerCase().trim();
    const hives = term
      ? all.filter((h) => (h.label + " " + (h.current ? h.current.queen_code + " " + (h.current.name || "") : "")).toLowerCase().includes(term))
      : all;
    grid.innerHTML = hives.map((h) => {
      const q = h.current;
      let svg = "";
      try { svg = qrSvg(hiveUrl(h.label), 104); } catch (e) { svg = "<span class='text-xs text-red-500'>QR error</span>"; }
      const sc = q ? (STATUS_COLORS[q.status] || "") : "";
      return `
      <div class="bg-white rounded-xl card-shadow p-4">
        <div class="flex items-start gap-3">
          <div class="hive-thumb w-16 h-16 rounded-lg bg-honey-100 flex items-center justify-center text-2xl shrink-0 bg-cover bg-center" ${q ? `data-hivethumb="${q.id}"` : ""}>🐝</div>
          <div class="min-w-0 flex-1">
            <div class="font-bold text-honey-800">🏠 ${esc(h.label)}</div>
            ${q
              ? `<div class="text-sm text-hive-800/70 truncate">${esc(q.queen_code)}${q.name ? " · " + esc(q.name) : ""}</div>
                 <div class="mt-1"><span class="text-xs px-2 py-0.5 rounded-full ${sc} capitalize">${esc(q.status || "")}</span></div>`
              : `<div class="text-sm text-hive-800/40">No queen assigned</div>`}
            <div class="text-xs text-hive-800/40 mt-1">${h.count} queen${h.count !== 1 ? "s" : ""} in history</div>
          </div>
          <div class="shrink-0">${svg}</div>
        </div>
        <div class="flex gap-2 mt-3">
          <button class="hive-open flex-1 text-sm border border-honey-200 hover:bg-honey-50 rounded-lg py-1.5" data-hive="${esc(h.label)}">Open</button>
          <button class="hive-qr flex-1 text-sm bg-honey-100 text-honey-700 hover:bg-honey-200 rounded-lg py-1.5" data-hive="${esc(h.label)}">▦ QR / Print</button>
        </div>
      </div>`;
    }).join("");
    $$(".hive-open", grid).forEach((b) => b.addEventListener("click", () => openHive(b.dataset.hive)));
    $$(".hive-qr", grid).forEach((b) => b.addEventListener("click", () => openQrModal(b.dataset.hive)));
    // Load each hive's photo (its current queen's primary photo) into the thumbnail.
    for (const h of hives) {
      if (h.current) loadPhotoInto(grid.querySelector(`[data-hivethumb="${h.current.id}"]`), h.current.id);
    }
  }

  // Fill an element's background with a queen's primary photo (used by hive cards).
  async function loadPhotoInto(el, queenId) {
    if (!el) return;
    try {
      const photos = await data.listPhotos(queenId);
      if (!photos.length) return;
      const primary = photos.find((p) => p.is_primary) || photos[0];
      const url = await data.photoUrl(primary.storage_path);
      if (url) { el.style.backgroundImage = `url('${url}')`; el.textContent = ""; }
    } catch (e) { /* keep the 🐝 fallback */ }
  }

  function openHive(label) {
    const q = findHiveCurrentQueen(label);
    if (!q) return toast(`No queen found in hive "${label}"`);
    openDetail(q.id);
  }

  // ---- QR modal ----
  let qrCurrentLabel = "";
  function openQrModal(label) {
    qrCurrentLabel = label;
    const url = hiveUrl(label);
    const q = findHiveCurrentQueen(label);
    $("#qr-hive-label").textContent = label;
    $("#qr-sub").textContent = q ? `Opens: ${q.queen_code}${q.name ? " · " + q.name : ""}` : "No queen assigned yet";
    $("#qr-url").textContent = url;
    let svg = "";
    try { svg = qrSvg(url, 224); } catch (e) { svg = "<span class='text-red-500 text-sm'>Couldn't render QR</span>"; }
    $("#qr-holder").innerHTML = svg;
    $("#qr-modal").classList.remove("hidden");
  }
  $("#qr-close").addEventListener("click", () => $("#qr-modal").classList.add("hidden"));
  $("#qr-modal").addEventListener("click", (e) => { if (e.target.id === "qr-modal") $("#qr-modal").classList.add("hidden"); });
  $("#qr-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(hiveUrl(qrCurrentLabel)); toast("Link copied"); }
    catch (e) { toast("Copy failed — long-press the link to copy"); }
  });
  $("#qr-print").addEventListener("click", () => printLabels([qrCurrentLabel], ($("#qr-print-size") || {}).value || "medium"));

  // ---- Printable label sheet ----
  // Sizes control how many labels fit per page. w = label width (px), qr = QR px, name = label font.
  const LABEL_SIZES = {
    small:  { w: 180, qr: 150, name: 18, hint: 10 },
    medium: { w: 264, qr: 220, name: 24, hint: 12 },
    large:  { w: 360, qr: 320, name: 30, hint: 14 },
  };
  function printLabels(labels, sizeKey) {
    const s = LABEL_SIZES[sizeKey] || LABEL_SIZES.medium;
    const items = labels.map((l) => {
      let svg = "";
      try { svg = qrSvg(hiveUrl(l), s.qr); } catch (e) { svg = ""; }
      return `<div class="label"><div class="qr">${svg}</div><div class="name">🏠 ${esc(l)}</div><div class="hint">Scan to open this hive</div></div>`;
    }).join("");
    const w = window.open("", "_blank");
    if (!w) return toast("Allow pop-ups to print labels");
    w.document.write(`<!doctype html><html><head><title>Hive QR labels</title><style>
      *{box-sizing:border-box} body{font-family:system-ui,Segoe UI,Roboto,sans-serif;margin:0;padding:16px;color:#2b220f}
      .sheet{display:flex;flex-wrap:wrap;gap:16px}
      .label{border:2px dashed #e0b96a;border-radius:12px;padding:14px;width:${s.w}px;text-align:center;page-break-inside:avoid}
      .qr svg{width:${s.qr}px;height:${s.qr}px}
      .name{font-size:${s.name}px;font-weight:800;margin-top:8px;color:#894b16}
      .hint{font-size:${s.hint}px;color:#999;margin-top:2px}
      @media print{.label{border-color:#bbb}}
    </style></head><body><div class="sheet">${items}</div>
    <script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script>
    </body></html>`);
    w.document.close();
  }

  $("#hive-search").addEventListener("input", renderHives);
  $("#hives-print-all").addEventListener("click", () => {
    const labels = deriveHives().map((h) => h.label);
    if (!labels.length) return toast("No hives to print yet");
    printLabels(labels, ($("#hives-print-size") || {}).value || "medium");
  });

  // ---- Deep link: open a hive/queen from a scanned QR (?hive= / ?queen=) ----
  function handleDeepLink() {
    const params = new URLSearchParams(location.search);
    const hive = params.get("hive");
    const queen = params.get("queen");
    if (!hive && !queen) return;
    if (queen) {
      const q = byId(queen);
      if (q) openDetail(q.id); else toast("That queen link wasn't found");
    } else if (hive) {
      const q = findHiveCurrentQueen(hive);
      if (q) { switchTab("queens"); openDetail(q.id); }
      else { switchTab("hives"); toast(`No queen is assigned to hive "${hive}" yet`); }
    }
    // Tidy the URL so a refresh doesn't re-trigger and it looks clean
    history.replaceState(null, "", appBase());
  }

  // ================= VOICE NOTES =================
  let mediaRecorder = null, recChunks = [], recTimer = null, recSeconds = 0, recStream = null;
  let voiceMeta = { queen_id: null, hive_label: null };

  function fmtTime(s) { return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
  function pickMime() {
    const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
    if (!window.MediaRecorder) return "";
    for (const c of cands) { try { if (MediaRecorder.isTypeSupported(c)) return c; } catch (e) {} }
    return "";
  }
  function setRecUI(recording) {
    const b = $("#voice-record");
    b.textContent = recording ? "■" : "●";
    b.classList.toggle("animate-pulse", recording);
  }

  function openVoiceModal(queenId, hiveLabel) {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      return toast("This browser can't record audio. Try Chrome or Safari on your phone.", 4000);
    }
    voiceMeta = { queen_id: queenId, hive_label: hiveLabel || null };
    const q = queenId ? byId(queenId) : null;
    $("#voice-hive").textContent = hiveLabel || (q ? q.queen_code : "");
    $("#voice-status").textContent = "Tap the red button and describe the hive out loud.";
    $("#voice-timer").textContent = "0:00";
    $("#voice-record").disabled = false;
    setRecUI(false);
    $("#voice-modal").classList.remove("hidden");
  }
  function closeVoiceModal() {
    if (mediaRecorder && mediaRecorder.state === "recording") stopRecording();
    $("#voice-modal").classList.add("hidden");
  }

  $("#voice-close").addEventListener("click", closeVoiceModal);
  $("#voice-modal").addEventListener("click", (e) => { if (e.target.id === "voice-modal") closeVoiceModal(); });

  $("#voice-record").addEventListener("click", async () => {
    if (mediaRecorder && mediaRecorder.state === "recording") { stopRecording(); return; }
    await startRecording();
  });

  async function startRecording() {
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      $("#voice-status").textContent = "Microphone permission was blocked — enable it and try again.";
      return;
    }
    const mime = pickMime();
    recChunks = [];
    try {
      mediaRecorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      mediaRecorder = new MediaRecorder(recStream);
    }
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    mediaRecorder.onstop = onRecordingStop;
    mediaRecorder.start();
    recSeconds = 0; $("#voice-timer").textContent = "0:00";
    recTimer = setInterval(() => { recSeconds++; $("#voice-timer").textContent = fmtTime(recSeconds); }, 1000);
    setRecUI(true);
    $("#voice-status").textContent = "Recording… tap again to stop.";
  }

  function stopRecording() {
    try { if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); } catch (e) {}
    clearInterval(recTimer);
    if (recStream) recStream.getTracks().forEach((t) => t.stop());
    setRecUI(false);
  }

  async function onRecordingStop() {
    const type = (mediaRecorder && mediaRecorder.mimeType) || "audio/webm";
    const blob = new Blob(recChunks, { type });
    if (!blob.size) { $("#voice-status").textContent = "Didn't catch anything — try again."; return; }
    $("#voice-status").textContent = "Uploading & transcribing… this can take a few seconds.";
    $("#voice-record").disabled = true;
    try {
      const ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm";
      const audio_path = await data.uploadAudio(voiceMeta.queen_id, voiceMeta.hive_label, blob, ext);
      const res = await data.transcribeVoice({ audio_path, queen_id: voiceMeta.queen_id, hive_label: voiceMeta.hive_label });
      $("#voice-modal").classList.add("hidden");
      openReviewCard(res.parsed || {}, res.transcript || "", { ...voiceMeta, audio_path });
    } catch (e) {
      $("#voice-status").textContent = "Failed: " + (e.message || e);
      $("#voice-record").disabled = false;
    }
  }

  // ---- Review & confirm card ----
  const REVIEW_FIELDS = {
    inspection: [
      ["inspection_date", "Date", "date"], ["queen_seen", "Queen seen", "bool"], ["eggs_seen", "Eggs seen", "bool"],
      ["brood_pattern", "Brood pattern (1-5)", "num"], ["temperament", "Temperament (1-5)", "num"],
      ["population", "Population", "text"], ["stores", "Stores", "text"], ["space", "Space", "text"],
      ["queen_cells", "Queen cells", "bool"], ["swarm_signs", "Swarm signs", "bool"],
      ["mites", "Mites", "text"], ["pests_disease", "Pests / disease", "text"],
      ["actions", "Actions taken", "text"], ["notes", "Notes", "text"],
    ],
    treatment: [
      ["treatment_date", "Date", "date"], ["product", "Product", "text"], ["target", "Target", "text"],
      ["dose", "Dose", "text"], ["method", "Method", "text"], ["notes", "Notes", "text"],
    ],
    feeding: [
      ["feed_date", "Date", "date"], ["feed_type", "Feed type", "text"], ["amount", "Amount", "text"], ["notes", "Notes", "text"],
    ],
  };
  const DATE_KEY = { inspection: "inspection_date", treatment: "treatment_date", feeding: "feed_date" };
  let reviewState = { kind: "inspection", meta: {}, transcript: "", parsed: {} };

  function openReviewCard(parsed, transcript, meta) {
    const kind = (parsed.category === "treatment" || parsed.category === "feeding") ? parsed.category : "inspection";
    reviewState = { kind, meta, transcript, parsed: parsed || {} };
    renderReviewCard();
    $("#review-modal").classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }
  function closeReview() { $("#review-modal").classList.add("hidden"); document.body.style.overflow = ""; }
  $("#review-close").addEventListener("click", closeReview);
  $("#review-modal").addEventListener("click", (e) => { if (e.target.id === "review-modal") closeReview(); });

  function renderReviewCard() {
    const kind = reviewState.kind;
    const dateKey = DATE_KEY[kind];
    const today = new Date().toISOString().slice(0, 10);
    const sub = reviewState.parsed[kind] || {};
    const meta = reviewState.meta;
    const q = meta.queen_id ? byId(meta.queen_id) : null;
    const catBtn = (k, lbl) => `<button data-cat="${k}" class="px-3 py-1.5 rounded-lg text-sm font-medium ${kind === k ? "bg-honey-500 text-white" : "bg-honey-100 text-honey-700"}">${lbl}</button>`;
    const fieldHtml = REVIEW_FIELDS[kind].map(([key, lbl, type]) => {
      const val = key === dateKey ? (sub[dateKey] || today) : sub[key];
      if (type === "bool") {
        const v = val === true ? "yes" : val === false ? "no" : "";
        return `<label class="block"><span class="lbl">${lbl}</span>
          <select class="inp" data-f="${key}" data-t="bool">
            <option value="" ${v === "" ? "selected" : ""}>—</option>
            <option value="yes" ${v === "yes" ? "selected" : ""}>Yes</option>
            <option value="no" ${v === "no" ? "selected" : ""}>No</option>
          </select></label>`;
      }
      const inputType = type === "date" ? "date" : type === "num" ? "number" : "text";
      const minmax = type === "num" ? 'min="1" max="5"' : "";
      return `<label class="block"><span class="lbl">${lbl}</span>
        <input class="inp" data-f="${key}" data-t="${type}" type="${inputType}" ${minmax} value="${val == null ? "" : esc(String(val))}" /></label>`;
    }).join("");
    $("#review-body").innerHTML = `
      <div class="flex gap-2 mb-4">${catBtn("inspection", "🔍 Inspection")}${catBtn("treatment", "💊 Treatment")}${catBtn("feeding", "🍯 Feeding")}</div>
      <p class="text-xs text-hive-800/50 mb-3">${q ? `Hive <b>${esc(meta.hive_label || "—")}</b> · ${esc(q.queen_code)}` : esc(meta.hive_label || "")} — AI-filled from your voice note. Edit anything before saving.</p>
      <div class="grid sm:grid-cols-2 gap-3">${fieldHtml}</div>
      <div class="mt-4">
        <div class="text-honey-700 font-semibold text-xs uppercase mb-1">What you said</div>
        <p class="text-sm text-hive-800/70 bg-honey-50 rounded-lg p-2 whitespace-pre-wrap">${esc(reviewState.transcript || "(no transcript)")}</p>
      </div>
      <div class="flex gap-2 justify-end mt-5 pt-3 border-t border-honey-100">
        <button id="review-discard" class="rounded-lg px-4 py-2 border border-honey-200 hover:bg-honey-50">Discard</button>
        <button id="review-save" class="bg-honey-500 hover:bg-honey-600 text-white font-semibold rounded-lg px-5 py-2 capitalize">Save ${kind}</button>
      </div>`;
    $$("#review-body [data-cat]").forEach((b) => b.addEventListener("click", () => {
      captureReviewEdits();
      reviewState.kind = b.dataset.cat;
      renderReviewCard();
    }));
    $("#review-discard").addEventListener("click", closeReview);
    $("#review-save").addEventListener("click", saveReview);
  }

  function captureReviewEdits() {
    const sub = (reviewState.parsed[reviewState.kind] = reviewState.parsed[reviewState.kind] || {});
    $$("#review-body [data-f]").forEach((el) => {
      const k = el.dataset.f, t = el.dataset.t, v = el.value;
      if (t === "bool") sub[k] = v === "" ? null : v === "yes";
      else if (t === "num") sub[k] = v === "" ? null : parseInt(v, 10);
      else sub[k] = v === "" ? null : v;
    });
  }

  async function saveReview() {
    captureReviewEdits();
    const btn = $("#review-save");
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const kind = reviewState.kind;
      const dateKey = DATE_KEY[kind];
      const row = { ...(reviewState.parsed[kind] || {}) };
      if (!row[dateKey]) row[dateKey] = new Date().toISOString().slice(0, 10);
      if (reviewState.parsed.summary && !row.summary) row.summary = reviewState.parsed.summary;
      await data.saveVoiceRecord(kind, row, {
        queen_id: reviewState.meta.queen_id, hive_label: reviewState.meta.hive_label,
        transcript: reviewState.transcript, audio_path: reviewState.meta.audio_path,
      });
      toast("Saved " + kind + " 🐝");
      closeReview();
      if (detailId) await renderEvents(detailId);
    } catch (e) {
      toast("Save failed: " + (e.message || e), 4000);
    } finally {
      btn.disabled = false; btn.textContent = "Save " + reviewState.kind;
    }
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

  // ================= IMPORT =================
  // Minimal RFC-4180-ish CSV parser (handles quotes, commas & newlines in fields).
  function parseCSV(text) {
    const rows = [];
    let field = "", row = [], inQ = false, i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === ",") { row.push(field); field = ""; i++; continue; }
      if (ch === "\r") { i++; continue; }
      if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += ch; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  function csvToObjects(text) {
    const rows = parseCSV(text).filter((r) => !(r.length === 1 && r[0] === ""));
    if (rows.length < 2) return [];
    const headers = rows[0].map((h) => h.trim());
    return rows.slice(1).map((r) => {
      const o = {}; headers.forEach((h, idx) => (o[h] = r[idx] == null ? "" : r[idx])); return o;
    });
  }

  $("#menu-import").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      let rows;
      const looksJson = /\.json$/i.test(file.name) || /^\s*[[{]/.test(text);
      if (looksJson) {
        const parsed = JSON.parse(text);
        rows = Array.isArray(parsed) ? parsed : (parsed.queens || [parsed]);
      } else {
        rows = csvToObjects(text);
      }
      if (!rows || !rows.length) return toast("Nothing to import from that file");
      if (!confirm(`Import ${rows.length} record(s) from "${file.name}"?\n\nRecords that share an ID with an existing queen will be updated; the rest are added new.`)) return;
      toast("Importing…");
      const res = await data.importQueens(rows);
      await refresh();
      toast(`Imported ✓  ${res.restored} restored, ${res.added} added${res.skipped ? ", " + res.skipped + " skipped" : ""}`, 3500);
    } catch (err) {
      toast("Import failed: " + (err.message || err), 5000);
    }
  });

  // close modals on backdrop click / escape
  [formModal, detailModal].forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) { m.classList.add("hidden"); document.body.style.overflow = ""; } }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      ["#form-modal", "#detail-modal", "#qr-modal", "#voice-modal", "#review-modal"].forEach((s) => $(s).classList.add("hidden"));
      document.body.style.overflow = "";
    }
  });
})();
