// ---------------------------------------------------------------------------
//  In-app confirm / prompt
// ---------------------------------------------------------------------------
//  The browser's own confirm() and prompt() stamp the origin across the top —
//  "mmoyer35.github.io says". There is no API to change that text, so the only
//  way to show the app's name instead is not to use them. These are drop-in
//  replacements that return a Promise instead of blocking.
//
//  Deliberately kept to one shared overlay element rather than one per call:
//  two dialogs racing each other is a bug, not a feature, so a second request
//  while one is open is queued behind it.
//
//  Note the one place this CAN'T reach: the Face ID / fingerprint sheet is
//  drawn by the operating system and always names the domain. That's a
//  security property — it's how you know which site is asking for your
//  passkey — and no site can override it.
// ---------------------------------------------------------------------------
(function () {
  "use strict";

  const APP_NAME = "Queen Tracker";
  let el = null;          // the single overlay, built on first use
  let chain = Promise.resolve();

  function build() {
    if (el) return el;
    el = document.createElement("div");
    el.id = "qt-dialog";
    // Every other overlay in the app tops out at z-50, and this one has to sit
    // above all of them — the scanner opens the hive-name prompt from inside its
    // own modal. Inline rather than a Tailwind class so it can't depend on the
    // CDN's JIT picking up an arbitrary value.
    el.className = "hidden fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center p-3";
    el.style.zIndex = "60";
    el.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="qt-dialog-title"
           class="bg-white rounded-2xl w-full max-w-sm shadow-xl overflow-hidden">
        <div class="px-4 pt-4 pb-3">
          <h2 id="qt-dialog-title" class="font-bold text-honey-800 text-base">🐝 ${APP_NAME}</h2>
          <p id="qt-dialog-msg" class="text-sm text-hive-800/80 mt-2 whitespace-pre-line"></p>
          <input id="qt-dialog-input" class="inp mt-3 hidden" />
        </div>
        <div class="flex gap-2 justify-end px-4 pb-4">
          <button type="button" id="qt-dialog-cancel"
                  class="rounded-lg px-4 py-2 text-sm border border-honey-200 hover:bg-honey-50">Cancel</button>
          <button type="button" id="qt-dialog-ok"
                  class="rounded-lg px-4 py-2 text-sm font-semibold text-white bg-honey-500 hover:bg-honey-600">OK</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    return el;
  }

  function open(opts) {
    return new Promise((resolve) => {
      const box = build();
      const msg = box.querySelector("#qt-dialog-msg");
      const input = box.querySelector("#qt-dialog-input");
      const ok = box.querySelector("#qt-dialog-ok");
      const cancel = box.querySelector("#qt-dialog-cancel");
      const title = box.querySelector("#qt-dialog-title");

      title.textContent = `🐝 ${opts.title || APP_NAME}`;
      msg.textContent = opts.message || "";
      ok.textContent = opts.confirmText || "OK";
      cancel.textContent = opts.cancelText || "Cancel";
      // Destructive actions shouldn't wear the same friendly amber as "save".
      ok.className = "rounded-lg px-4 py-2 text-sm font-semibold text-white " +
        (opts.danger ? "bg-red-600 hover:bg-red-700" : "bg-honey-500 hover:bg-honey-600");

      const wantsInput = opts.type === "prompt";
      input.classList.toggle("hidden", !wantsInput);
      if (wantsInput) {
        input.value = opts.value || "";
        input.placeholder = opts.placeholder || "";
      }

      const previouslyFocused = document.activeElement;
      let done = false;
      function finish(result) {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey, true);
        box.classList.add("hidden");
        // Give focus back so a keyboard user isn't dumped at the top of the page.
        try { if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus(); } catch (e) {}
        resolve(result);
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); finish(wantsInput ? null : false); }
        else if (e.key === "Enter" && (wantsInput || document.activeElement !== cancel)) {
          e.preventDefault(); accept();
        }
      }
      function accept() { finish(wantsInput ? input.value : true); }

      ok.onclick = accept;
      cancel.onclick = () => finish(wantsInput ? null : false);
      box.onclick = (e) => { if (e.target === box) finish(wantsInput ? null : false); };
      document.addEventListener("keydown", onKey, true);

      box.classList.remove("hidden");
      // Focus the input for a prompt, the safe button for a destructive confirm.
      setTimeout(() => { try { (wantsInput ? input : (opts.danger ? cancel : ok)).focus(); } catch (e) {} }, 0);
    });
  }

  // Serialise: a second call waits for the first to close rather than
  // overwriting its contents mid-question.
  function queue(opts) {
    const run = chain.then(() => open(opts));
    chain = run.catch(() => {});
    return run;
  }

  window.QT_DIALOG = {
    confirm: (message, opts) => queue({ ...(opts || {}), message, type: "confirm" }),
    prompt: (message, opts) => queue({ ...(opts || {}), message, type: "prompt" }),
    APP_NAME,
  };
})();
