// ---------------------------------------------------------------------------
//  Supabase client bootstrap + tiny data-access layer
// ---------------------------------------------------------------------------
(function () {
  const cfg = window.QUEEN_TRACKER_CONFIG || {};
  const configured =
    cfg.SUPABASE_URL &&
    cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_URL.includes("YOUR-PROJECT") &&
    !cfg.SUPABASE_ANON_KEY.includes("YOUR-ANON");

  window.QT = window.QT || {};
  window.QT.configured = configured;

  if (!configured) {
    // app.js will show the setup screen
    return;
  }

  const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  window.QT.client = client;
  const BUCKET = "queen-photos";

  // ---- Auth -------------------------------------------------------------
  window.QT.auth = {
    signIn: (email, password) => client.auth.signInWithPassword({ email, password }),
    signUp: (email, password) =>
      client.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.href.split("#")[0].split("?")[0] },
      }),
    signOut: () => client.auth.signOut(),
    getUser: async () => (await client.auth.getUser()).data.user,
    onChange: (cb) => client.auth.onAuthStateChange((_e, session) => cb(session)),
  };

  // ---- Queens -----------------------------------------------------------
  window.QT.data = {
    async listQueens() {
      const { data, error } = await client.from("queens").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
    async saveQueen(row) {
      const user = await window.QT.auth.getUser();
      row.user_id = user.id;
      // strip empty strings -> null so numeric/date columns don't choke
      const clean = {};
      for (const k in row) clean[k] = row[k] === "" ? null : row[k];
      if (clean.id) {
        const { data, error } = await client.from("queens").update(clean).eq("id", clean.id).select().single();
        if (error) throw error;
        return data;
      } else {
        delete clean.id;
        const { data, error } = await client.from("queens").insert(clean).select().single();
        if (error) throw error;
        return data;
      }
    },
    async deleteQueen(id) {
      // remove photos from storage first
      const photos = await this.listPhotos(id);
      if (photos.length) {
        await client.storage.from(BUCKET).remove(photos.map((p) => p.storage_path));
      }
      const { error } = await client.from("queens").delete().eq("id", id);
      if (error) throw error;
    },

    // ---- Photos ---------------------------------------------------------
    async listPhotos(queenId) {
      const { data, error } = await client.from("queen_photos").select("*").eq("queen_id", queenId).order("created_at");
      if (error) throw error;
      return data;
    },
    async uploadPhoto(queenId, file, caption) {
      const user = await window.QT.auth.getUser();
      const safe = file.name.replace(/[^\w.\-]/g, "_");
      const path = `${user.id}/${queenId}/${Date.now()}_${safe}`;
      const { error: upErr } = await client.storage.from(BUCKET).upload(path, file, { upsert: false });
      if (upErr) throw upErr;
      const { data, error } = await client
        .from("queen_photos")
        .insert({ user_id: user.id, queen_id: queenId, storage_path: path, caption: caption || null })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    async deletePhoto(photo) {
      await client.storage.from(BUCKET).remove([photo.storage_path]);
      const { error } = await client.from("queen_photos").delete().eq("id", photo.id);
      if (error) throw error;
    },
    async setPrimaryPhoto(photo) {
      // one primary per queen: clear the rest, then mark this one
      const { error: e1 } = await client
        .from("queen_photos").update({ is_primary: false }).eq("queen_id", photo.queen_id);
      if (e1) throw e1;
      const { data, error } = await client
        .from("queen_photos").update({ is_primary: true }).eq("id", photo.id).select().single();
      if (error) throw error;
      return data;
    },
    async photoUrl(path) {
      const { data, error } = await client.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
      if (error) return null;
      return data.signedUrl;
    },

    // ---- Events ---------------------------------------------------------
    async listEvents(queenId) {
      const { data, error } = await client.from("queen_events").select("*").eq("queen_id", queenId).order("event_date", { ascending: false });
      if (error) throw error;
      return data;
    },
    async addEvent(queenId, event_date, event_type, note) {
      const user = await window.QT.auth.getUser();
      const { data, error } = await client
        .from("queen_events")
        .insert({ user_id: user.id, queen_id: queenId, event_date, event_type: event_type || null, note: note || null })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    async deleteEvent(id) {
      const { error } = await client.from("queen_events").delete().eq("id", id);
      if (error) throw error;
    },
  };
})();
