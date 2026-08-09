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

  // ---- Where the session lives ------------------------------------------
  // On a phone the app should be signed out the moment it's closed — a hive
  // yard is a good place to drop a handset. sessionStorage is exactly that
  // lifetime: the OS discards it when the tab or the native WebView goes away,
  // but it survives backgrounding, screen-off and page navigation while you're
  // actually working. Desktop keeps the normal persistent localStorage session.
  //
  // Quick unlock (js/biometric.js) is what makes this bearable: the refresh
  // token is kept separately, sealed behind Face ID / Touch ID / fingerprint.
  const isTouchFirst = (() => {
    try {
      if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return true;
      if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "")) return true;
      return window.matchMedia("(pointer: coarse)").matches && window.matchMedia("(max-width: 900px)").matches;
    } catch (e) {
      return false;
    }
  })();

  function ephemeralStore() {
    try {
      const probe = "__qt_probe__";
      sessionStorage.setItem(probe, "1");
      sessionStorage.removeItem(probe);
      return sessionStorage;
    } catch (e) {
      // Private mode / blocked storage — memory only, which is even stricter.
      const mem = new Map();
      return {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => { mem.set(k, v); },
        removeItem: (k) => { mem.delete(k); },
      };
    }
  }

  const authOpts = { persistSession: true, autoRefreshToken: true };
  if (isTouchFirst) {
    authOpts.storage = ephemeralStore();
    authOpts.storageKey = "qt-auth-session";
    // detectSessionInUrl stays ON — it only reacts to #access_token fragments
    // from confirmation/recovery emails, never to our ?hive=… deep links.
  }

  const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: authOpts });
  window.QT.client = client;
  window.QT.ephemeralSession = isTouchFirst;
  const BUCKET = "queen-photos";

  // ---- Apiary scope -----------------------------------------------------
  // js/apiaries.js decides which apiary is live; every read is filtered to it
  // and every write is stamped with it, so switching apiaries genuinely
  // changes what the app is looking at rather than blending two yards.
  //
  // Before that module has loaded — first paint, or a signed-out screen — the
  // filter is simply omitted. That is safe: RLS already restricts every table
  // to apiaries this account belongs to, so the worst case is showing a little
  // more than intended for a moment, never someone else's bees.
  const apiaryId = () => {
    try { return (window.QT.apiaries && window.QT.apiaries.currentId()) || null; } catch (e) { return null; }
  };
  const scope = (q) => { const a = apiaryId(); return a ? q.eq("apiary_id", a) : q; };
  const stamp = (row) => { const a = apiaryId(); if (a) row.apiary_id = a; return row; };
  window.QT.apiaryId = apiaryId;

  // ---- Auth -------------------------------------------------------------
  window.QT.auth = {
    signIn: (email, password) => client.auth.signInWithPassword({ email, password }),
    signUp: (email, password) => client.auth.signUp({ email, password }),
    signOut: () => client.auth.signOut(),
    getUser: async () => (await client.auth.getUser()).data.user,
    getSession: async () => (await client.auth.getSession()).data.session,
    // Trade a biometrically-unsealed refresh token for a live session.
    resume: (refresh_token) => client.auth.refreshSession({ refresh_token }),
    onChange: (cb) => client.auth.onAuthStateChange((event, session) => cb(session, event)),
  };

  // ---- Queens -----------------------------------------------------------
  window.QT.data = {
    async listQueens() {
      const { data, error } = await scope(client.from("queens").select("*")).order("created_at", { ascending: false });
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
        // apiary_id is never rewritten on edit — a queen stays where she is.
        delete clean.apiary_id;
        const { data, error } = await client.from("queens").update(clean).eq("id", clean.id).select().single();
        if (error) throw error;
        return data;
      } else {
        delete clean.id;
        const { data, error } = await client.from("queens").insert(stamp(clean)).select().single();
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
        .insert(stamp({ user_id: user.id, queen_id: queenId, storage_path: path, caption: caption || null }))
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
    // Pick which photo represents the queen on her card and on her hive's tile.
    // Clearing first keeps "exactly one primary per queen" true even if an older
    // row was already flagged; both statements are scoped to this queen, so a
    // reader elsewhere in the apiary never sees a queen with no primary at all.
    async setPrimaryPhoto(queenId, photoId) {
      const { error: clearErr } = await client
        .from("queen_photos").update({ is_primary: false })
        .eq("queen_id", queenId).eq("is_primary", true);
      if (clearErr) throw clearErr;
      if (!photoId) return;                       // caller just wanted it cleared
      const { error } = await client
        .from("queen_photos").update({ is_primary: true })
        .eq("id", photoId).eq("queen_id", queenId);
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
    // Kept for any caller that just wants a plain dated note. It delegates
    // rather than inserting directly: a second, simpler write path into
    // queen_events is exactly how the summary card came to disagree with the
    // timeline in the first place, and there should only be one way in.
    async addEvent(queenId, event_date, event_type, note) {
      return this.addTimelineEntry(queenId, { event_date, event_type, note });
    },
    // Add a structured timeline entry.
    //
    // The bug this replaces: the old form wrote a queen_events row and nothing
    // else, but the queen's summary card reads mite counts from `inspections`
    // and treatments from `treatments`. So a timeline "mite check" could never
    // reach the card — it said "none recorded" forever, no matter how many you
    // logged. Voice notes already did this correctly (domain row + a mirror
    // queen_events row linked by ref_kind/ref_id); manual entries now take the
    // same path, so both routes produce identical data.
    //
    // The domain row goes first. If it fails there is no timeline row either,
    // which is the honest outcome — better a visible error than an entry that
    // looks saved but will never show up on the card.
    async addTimelineEntry(queenId, entry) {
      const user = await window.QT.auth.getUser();
      const {
        event_date, event_type, event_subtype = null, event_detail = null,
        value_num = null, note = null, table = null, record = null,
      } = entry;

      let ref_kind = null, ref_id = null;
      if (table && record) {
        const clean = { ...record, user_id: user.id, queen_id: queenId };
        for (const k in clean) if (clean[k] === "") clean[k] = null;
        const { data: rec, error } = await client.from(table).insert(stamp(clean)).select().single();
        if (error) throw error;
        // ref_kind matches the singular vocabulary voice notes already use, so
        // one timeline renderer handles both.
        ref_kind = table === "treatments" ? "treatment" : table === "feedings" ? "feeding" : "inspection";
        ref_id = rec.id;
      }

      const { data, error } = await client
        .from("queen_events")
        .insert(stamp({
          user_id: user.id, queen_id: queenId, event_date,
          event_type: event_type || null, event_subtype, event_detail,
          value_num, note: note || null, ref_kind, ref_id,
        }))
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    // Deleting a timeline entry deletes the record behind it too, otherwise
    // removing a mis-entered mite check would clear it from the timeline while
    // the queen's card kept reporting it — the same split that caused the
    // original bug, just in the other direction.
    async deleteEvent(id) {
      const { data: ev } = await client
        .from("queen_events").select("ref_kind, ref_id").eq("id", id).maybeSingle();
      const { error } = await client.from("queen_events").delete().eq("id", id);
      if (error) throw error;
      if (ev && ev.ref_kind && ev.ref_id) {
        const table = ev.ref_kind === "treatment" ? "treatments"
                    : ev.ref_kind === "feeding" ? "feedings" : "inspections";
        // Non-fatal: the timeline entry is already gone, and a read-only-ish
        // failure here shouldn't look like the delete didn't work.
        await client.from(table).delete().eq("id", ev.ref_id);
      }
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
      const { data: rec, error } = await client.from(table).insert(stamp(clean)).select().single();
      if (error) throw error;

      const eventDate = clean.inspection_date || clean.treatment_date || clean.feed_date || new Date().toISOString().slice(0, 10);
      if (meta.queen_id) {
        await client.from("queen_events").insert(stamp({
          user_id: user.id, queen_id: meta.queen_id, event_date: eventDate,
          event_type: kind, note: clean.summary || meta.transcript || null,
          ref_kind: kind, ref_id: rec.id,
        }));
      }
      await client.from("voice_notes").insert(stamp({
        user_id: user.id, queen_id: meta.queen_id || null, hive_label: meta.hive_label || null,
        audio_path: meta.audio_path || null, transcript: meta.transcript || null,
        category: kind, ref_kind: kind, ref_id: rec.id, status: "saved",
      }));
      return rec;
    },

    // ---- Card summaries: latest mite wash + latest treatment ------------
    // One query each, newest-first, reduced client-side to the most recent
    // row per queen. Both tables are small (a few rows per hive per season)
    // and RLS already scopes them to this user.
    async latestMiteChecks() {
      const { data, error } = await scope(client
        .from("inspections")
        .select("queen_id, mite_check_date, inspection_date, mite_count, mite_count_capped, mite_sample_size, mite_wash_method"))
        .not("mite_count", "is", null)
        .order("mite_check_date", { ascending: false, nullsFirst: false })
        .order("inspection_date", { ascending: false, nullsFirst: false });
      if (error) throw error;
      const map = {};
      for (const r of data || []) {
        if (!r.queen_id || map[r.queen_id]) continue; // first hit is the newest
        map[r.queen_id] = { ...r, date: r.mite_check_date || r.inspection_date };
      }
      return map;
    },
    async latestTreatments() {
      const { data, error } = await scope(client
        .from("treatments")
        .select("queen_id, treatment_date, category, product, target, method"))
        .order("treatment_date", { ascending: false, nullsFirst: false });
      if (error) throw error;
      const map = {};
      for (const r of data || []) {
        if (!r.queen_id || map[r.queen_id]) continue;
        map[r.queen_id] = r;
      }
      return map;
    },

    // Everything needed for a full "All data" export — one apiary at a time,
    // so an export is always of the yard you were looking at.
    async listAll(table) {
      const { data, error } = await scope(client.from(table).select("*"));
      if (error) throw error;
      return data || [];
    },

    // ---- Import (restore from JSON, or add from CSV) --------------------
    // Rows WITH an id are upserted (restore — keeps lineage links intact);
    // rows WITHOUT an id are inserted as new. Only real columns are kept.
    async importQueens(rows) {
      const user = await window.QT.auth.getUser();
      const COLS = [
        "id","queen_code","name","source_method","graft_date","emergence_date","year","season",
        "mother_queen_id","drone_source","current_hive","mated_status","mating_date",
        "laying_pattern","brood_quality","temperament","honey_production","productivity_notes",
        "race_line","marking_color","hygienic_behavior","mite_resistance","harbo_assay","notable_traits",
        "status","status_date","replaced_by_id","notes","created_at",
      ];
      const INTS = new Set(["year","laying_pattern","brood_quality","temperament","honey_production","hygienic_behavior","mite_resistance","harbo_assay"]);
      const clean = rows.map((r) => {
        const c = stamp({ user_id: user.id });
        for (const k of COLS) {
          if (!(k in r)) continue;
          let v = r[k];
          if (v === "" || v === undefined) v = null;
          if (v !== null && INTS.has(k)) { const n = parseInt(v, 10); v = isNaN(n) ? null : n; }
          c[k] = v;
        }
        return c;
      }).filter((c) => c.queen_code); // a queen must at least have a code

      const withId = clean.filter((c) => c.id);
      const noId = clean.filter((c) => !c.id).map((c) => { const { id, ...rest } = c; return rest; });
      if (withId.length) {
        const { error } = await client.from("queens").upsert(withId, { onConflict: "id" });
        if (error) throw error;
      }
      if (noId.length) {
        const { error } = await client.from("queens").insert(noId);
        if (error) throw error;
      }
      return { restored: withId.length, added: noId.length, skipped: rows.length - clean.length };
    },
  };
})();
