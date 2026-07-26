// Queen Tracker — voice-inspection Edge Function
// Downloads a beekeeper's audio note (from the user's private storage, under RLS),
// transcribes it with OpenAI Whisper, then parses it into a structured
// inspection / treatment / feeding record. Returns the parsed result for the
// user to review & confirm in the app (it does NOT write to the DB itself).
//
// Deploy:  supabase functions deploy voice-inspection
// Requires secret:  OPENAI_API_KEY  (Supabase → Edge Functions → Secrets)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM_PROMPT = `You are a beekeeping field assistant. A beekeeper dictated a spoken note about a single hive during an inspection. Convert it into structured JSON.

First decide the primary category:
- "inspection": general check of the colony (brood, eggs, queen, temperament, stores, space, mites, pests, swarm signs).
- "treatment": applying a mite/disease treatment (e.g. Apivar, Formic Pro, oxalic acid, Vaporized OA).
- "feeding": feeding syrup, fondant, or pollen substitute.

Extract ONLY facts that were actually said. Use null for anything not mentioned. Do not invent values. Ratings are integers 1-5. Booleans are true/false. Keep text fields short.

Return ONLY a JSON object with this exact shape:
{
  "category": "inspection" | "treatment" | "feeding",
  "summary": "one short plain-language sentence summarizing the note",
  "inspection": { "queen_seen": bool|null, "eggs_seen": bool|null, "brood_pattern": int|null, "temperament": int|null, "population": string|null, "stores": string|null, "space": string|null, "queen_cells": bool|null, "swarm_signs": bool|null, "mites": string|null, "pests_disease": string|null, "actions": string|null, "notes": string|null },
  "treatment": { "product": string|null, "target": string|null, "dose": string|null, "method": string|null, "notes": string|null },
  "feeding": { "feed_type": string|null, "amount": string|null, "notes": string|null }
}
Include all three sub-objects but only fill the one matching the category; leave the others with null fields.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  try {
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) return json({ error: "OPENAI_API_KEY is not set as a Supabase secret" }, 500);

    const authHeader = req.headers.get("Authorization") || "";
    const body = await req.json().catch(() => ({}));
    const audio_path = body?.audio_path as string | undefined;
    if (!audio_path) return json({ error: "missing audio_path" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    // Act as the calling user so storage RLS applies (they can only read their own audio).
    const supa = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });

    const { data: file, error: dlErr } = await supa.storage.from("hive-audio").download(audio_path);
    if (dlErr || !file) return json({ error: "could not read audio: " + (dlErr?.message || "not found") }, 400);

    // ---- 1) Transcribe with Whisper ----
    const fd = new FormData();
    fd.append("file", file, "note.webm");
    fd.append("model", "whisper-1");
    fd.append("language", "en");
    const trRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: fd,
    });
    if (!trRes.ok) return json({ error: "transcription failed: " + (await trRes.text()) }, 502);
    const trJson = await trRes.json();
    const transcript: string = (trJson.text || "").trim();
    if (!transcript) return json({ error: "empty transcript — no speech detected" }, 422);

    // ---- 2) Parse into structured fields ----
    const chatRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: transcript },
        ],
      }),
    });
    if (!chatRes.ok) return json({ error: "parsing failed: " + (await chatRes.text()) }, 502);
    const chatJson = await chatRes.json();
    let parsed: any = {};
    try { parsed = JSON.parse(chatJson.choices?.[0]?.message?.content || "{}"); } catch { parsed = {}; }
    if (!parsed.category) parsed.category = "inspection";

    return json({ transcript, parsed });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
