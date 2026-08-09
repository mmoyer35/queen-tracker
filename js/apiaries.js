// ---------------------------------------------------------------------------
//  Apiaries: whose bees am I looking at?
//
//  Every row in the database belongs to exactly one apiary. You always own a
//  personal one ("My apiary"); anyone who invites you adds another to the list.
//  The switcher in the header picks which one is live, and every query in
//  supabaseClient.js is filtered to it — so counts, exports and the lineage
//  tree never mix two people's bees together.
//
//  Nothing here is trusted by the server: the database enforces membership and
//  roles in RLS. This module only decides what to *ask* for and what to show.
// ---------------------------------------------------------------------------
(function () {
  if (!window.QT || !window.QT.client) return;
  const client = window.QT.client;

  let list = [];        // [{ id, name, is_personal, role, owner_id, owner_email, members, pending }]
  let currentId = null;
  let userId = null;
  const subs = [];      // change listeners (the header + Sharing screen)

  const KEY = (uid) => "qt-apiary:" + uid;

  function remember(id) {
    try { if (userId) localStorage.setItem(KEY(userId), id || ""); } catch (e) { /* private mode */ }
  }
  function recall() {
    try { return userId ? localStorage.getItem(KEY(userId)) : null; } catch (e) { return null; }
  }

  function notify() {
    subs.forEach((fn) => { try { fn(api.current(), list); } catch (e) { console.error(e); } });
  }

  // Supabase returns a Postgres error object; its `message` is the RAISE text.
  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args || {});
    if (error) throw new Error(error.message || ("Could not " + name));
    return data;
  }

  const api = {
    // ---- state ----------------------------------------------------------
    all: () => list.slice(),
    current: () => list.find((a) => a.id === currentId) || null,
    currentId: () => currentId,
    // Personal apiaries are just "My apiary"; a shared one is easier to spot
    // by whose it is, since everyone's personal apiary has the same name.
    label(a) {
      if (!a) return "";
      if (a.is_personal && a.role === "owner") return "My apiary";
      if (a.role === "owner") return a.name;
      const who = (a.owner_email || "").split("@")[0];
      return a.is_personal && who ? who + "'s apiary" : a.name + (who ? " (" + who + ")" : "");
    },
    isOwner: () => (api.current() || {}).role === "owner",
    canWrite: () => ["owner", "edit"].includes((api.current() || {}).role),
    readOnly: () => list.length > 0 && !api.canWrite(),
    onChange(fn) { subs.push(fn); return () => subs.splice(subs.indexOf(fn), 1); },

    // ---- lifecycle ------------------------------------------------------
    // Called once after sign-in, and again after joining/leaving an apiary.
    async refresh(uid) {
      if (uid) userId = uid;
      list = (await rpc("qt_my_apiaries")) || [];
      const saved = recall();
      if (!list.some((a) => a.id === currentId)) currentId = null;
      if (!currentId && saved && list.some((a) => a.id === saved)) currentId = saved;
      if (!currentId) {
        const mine = list.find((a) => a.is_personal && a.role === "owner");
        currentId = (mine || list[0] || {}).id || null;
      }
      remember(currentId);
      notify();
      return list;
    },
    reset() { list = []; currentId = null; userId = null; },

    switchTo(id) {
      if (id === currentId || !list.some((a) => a.id === id)) return false;
      currentId = id;
      remember(id);
      notify();
      return true;
    },

    // ---- owning ---------------------------------------------------------
    async create(name) {
      const id = await rpc("qt_create_apiary", { p_name: name || "New apiary" });
      await api.refresh();
      api.switchTo(id);
      return id;
    },
    async rename(id, name) {
      const { error } = await client.from("apiaries").update({ name: name }).eq("id", id);
      if (error) throw new Error(error.message);
      await api.refresh();
    },
    // Only allowed on a shared apiary you own; deleting it removes its data.
    async destroy(id) {
      const { error } = await client.from("apiaries").delete().eq("id", id);
      if (error) throw new Error(error.message);
      if (currentId === id) currentId = null;
      await api.refresh();
    },
    async leave(id) {
      await rpc("qt_leave_apiary", { p_apiary: id });
      if (currentId === id) currentId = null;
      await api.refresh();
    },

    // ---- people ---------------------------------------------------------
    members: (id) => rpc("qt_members", { p_apiary: id || currentId }),
    setRole: (id, user, role) => rpc("qt_set_role", { p_apiary: id || currentId, p_user: user, p_role: role }),
    async removeMember(id, user) {
      await rpc("qt_remove_member", { p_apiary: id || currentId, p_user: user });
      await api.refresh();
    },

    // ---- invites --------------------------------------------------------
    // No mail is sent: the invite is waiting the next time that address signs
    // in. The share code below is the "just text it to them" path.
    invite: (id, email, role) =>
      rpc("qt_invite", { p_apiary: id || currentId, p_email: email, p_role: role || "view" }),
    pendingInvites: (id) =>
      client.from("apiary_invites")
        .select("id,email,role,created_at")
        .eq("apiary_id", id || currentId).eq("status", "pending")
        .order("created_at")
        .then(({ data, error }) => { if (error) throw new Error(error.message); return data || []; }),
    async revokeInvite(inviteId) {
      const { error } = await client.from("apiary_invites").update({ status: "revoked" }).eq("id", inviteId);
      if (error) throw new Error(error.message);
    },

    // Invites addressed to *me*, shown as a prompt after sign-in.
    myInvites: () => rpc("qt_my_invites"),
    async acceptInvite(inviteId) {
      const id = await rpc("qt_accept_invite", { p_invite: inviteId });
      await api.refresh();
      api.switchTo(id);
      return id;
    },
    declineInvite: (inviteId) => rpc("qt_decline_invite", { p_invite: inviteId }),

    // ---- share codes ----------------------------------------------------
    // Read what already exists without minting anything — qt_share_code()
    // creates a code when none is live, so it must only run on a deliberate tap.
    codes: (id) =>
      client.from("apiary_codes")
        .select("code,role,created_at")
        .eq("apiary_id", id || currentId).eq("revoked", false)
        .order("created_at", { ascending: false })
        .then(({ data, error }) => { if (error) throw new Error(error.message); return data || []; }),
    async revokeCode(code) {
      const { error } = await client.from("apiary_codes").update({ revoked: true }).eq("code", code);
      if (error) throw new Error(error.message);
    },
    shareCode: (id, role, rotate) =>
      rpc("qt_share_code", { p_apiary: id || currentId, p_role: role || "view", p_rotate: !!rotate }),
    async redeem(code) {
      const rows = await rpc("qt_redeem_code", { p_code: String(code || "").trim().toUpperCase() });
      const row = Array.isArray(rows) ? rows[0] : rows;
      await api.refresh();
      if (row && row.apiary_id) api.switchTo(row.apiary_id);
      return row;
    },
  };

  window.QT.apiaries = api;
})();
