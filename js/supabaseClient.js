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
    signUp: (email, password) => client.auth.signUp({ email, password }),
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

    // ---- Voice notes -> inspections / treatments / feedings -------------
    // Upload a recorded audio blob to the user's private hive-audio bucket.
    async uploadAudio(queenId, hiveLabel, blob, ext) {
      const user = await window.QT.auth.getUser();
      const folder = queenId || (hiveLabel ? "hive-" + String(hiveLabel).replace(/[^\w.\-]/g, "_") : "misc");
      const path = `${user.id}/${folder}/${Date.now()}.${ext || "webm"}`;
      const { error } = await client.storage.from("hive-audio").upload(path, blob, {
        contentType: blob.type || "audio/webm", upsert: false,
      });
      if (error) throw error;
      return path;
    },

    // Call the Edge Function: transcribe (Whisper) + parse (GPT). Returns { transcript, parsed }.
    async transcribeVoice(payload) {
      const { data, error } = await client.functions.invoke("voice-inspection", { body: payload });
      if (error) {
        let msg = error.message || "Transcription failed";
        try { const ctx = await error.context.json(); if (ctx && ctx.error) msg = ctx.error; } catch (e) { /* ignore */ }
        throw new Error(msg);
      }
      return data;
    },

    // Save a reviewed voice note: structured row + a timeline entry + an audit row.
    async saveVoiceRecord(kind, row, meta) {
      const user = await window.QT.auth.getUser();
      const table = kind === "treatment" ? "treatments" : kind === "feeding" ? "feedings" : "inspections";
      const clean = {};
      for (const k in row) clean[k] = row[k] === "" ? null : row[k];
      clean.user_id = user.id;
      clean.queen_id = meta.queen_id || null;
      clean.hive_label = meta.hive_label || null;
      clean.raw_transcript = meta.transcript || null;
      const { data: rec, error } = await client.from(table).insert(clean).select().single();
      if (error) throw error;

      const eventDate = clean.inspection_date || clean.treatment_date || clean.feed_date || new Date().toISOString().slice(0, 10);
      if (meta.queen_id) {
        await client.from("queen_events").insert({
          user_id: user.id, queen_id: meta.queen_id, event_date: eventDate,
          event_type: kind, note: clean.summary || meta.transcript || null,
          ref_kind: kind, ref_id: rec.id,
        });
      }
      await client.from("voice_notes").insert({
        user_id: user.id, queen_id: meta.queen_id || null, hive_label: meta.hive_label || null,
        audio_path: meta.audio_path || null, transcript: meta.transcript || null,
        category: kind, ref_kind: kind, ref_id: rec.id, status: "saved",
      });
      return rec;
    },
  };
})();
