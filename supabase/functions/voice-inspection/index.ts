// Queen Tracker — voice-inspection Edge Function
//
// Downloads a beekeeper's audio note (from the user's private storage, under RLS),
// transcribes it with Whisper, then parses it into a structured inspection /
// treatment / feeding record. Returns the parsed result for the user to review &
// confirm in the app (it does NOT write to the DB itself).
//
// PROVIDERS
// Groq and OpenAI both speak the same API shape, so the only thing that changes
// between them is the base URL and two model names. Groq is tried first because
// its free tier covers roughly two hours of audio an hour at no cost; OpenAI is
// the fallback and is used automatically if only that key is present. If the
// first provider fails (rate limit, outage) and the other is configured, we
// retry there rather than losing the beekeeper's note.
//
// Keys are read from Supabase secrets and never appear in this file:
//   supabase secrets set GROQ_API_KEY=...      (free key at console.groq.com)
//   supabase secrets set OPENAI_API_KEY=...    (optional fallback)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Provider = {
  name: string;
  key: string;
  base: string;
  stt: string;
  chat: string;
  maxBytes: number;
};

// Order matters: the first one with a key set is tried first.
function providers(): Provider[] {
  const out: Provider[] = [];
  const groq = Deno.env.get("GROQ_API_KEY");
  if (groq) {
    out.push({
      name: "groq",
      key: groq,
      base: "https://api.groq.com/openai/v1",
      stt: "whisper-large-v3-turbo",
      chat: "llama-3.3-70b-versatile",
      maxBytes: 25 * 1024 * 1024,     // free-tier upload ceiling
    });
  }
  const openai = Deno.env.get("OPENAI_API_KEY") || Deno.env.get("OPENAI_TEST_KEY");
  if (openai) {
    out.push({
      name: "openai",
      key: openai,
      base: "https://api.openai.com/v1",
      stt: "whisper-1",
      chat: "gpt-4o-mini",
      maxBytes: 25 * 1024 * 1024,
    });
  }
  return out;
}

// Nudge Whisper toward beekeeping vocabulary it otherwise garbles.
const AUDIO_HINT =
  "Beekeeping inspection note. Terms: queen, brood pattern, supersedure, varroa mite wash, " +
  "alcohol wash, sugar roll, mite count, half cup of bees, Apivar, Formic Pro, oxalic acid, " +
  "nuc, deep, medium super, requeen.";

const SYSTEM_PROMPT = `You are a beekeeping field assistant. A beekeeper dictated a spoken note about a single hive during an inspection. Convert it into structured JSON.

First decide the primary category:
- "inspection": general check of the colony (brood, eggs, queen, temperament, stores, space, mite wash, pests, swarm signs).
- "treatment": applying a mite/disease treatment (e.g. Apivar, Formic Pro, oxalic acid, Vaporized OA).
- "feeding": feeding syrup, fondant, or pollen substitute.

Extract ONLY facts that were actually said. Use null for anything not mentioned. Do not invent values. Ratings are integers 1-5. Booleans are true/false. Keep text fields short.

MITE WASH RULES (inspection only):
- A "mite wash", "alcohol wash", "sugar roll", "sugar shake", "mite check", "sticky board" or "CO2 / CO2 wash" is a mite test. Put its results in mite_count, mite_sample_size and mite_wash_method.
- mite_count is the raw NUMBER of mites found (integer). "Six mites", "count of 6", "I got 6" -> 6. "Zero" / "clean" / "none" -> 0. If they only speak vaguely ("mites looked high") leave mite_count null and put the words in "mites".
- mite_sample_size is the number of BEES sampled. "Half cup" or "half a cup of bees" -> 300. "Quarter cup" -> 150. "Full cup" -> 600. "300 bees" -> 300. Otherwise null.
- If they state a RATE instead ("3 percent", "6 per hundred"), leave mite_count null unless they also gave a raw count, and record the rate text in "mites".
- mite_wash_method is one of: "alcohol wash", "sugar roll", "sticky board", "CO2", "other". Null if not stated.
- mite_check_date: only fill if they explicitly name a different day for the wash (YYYY-MM-DD). Normally leave null — the app assumes the wash happened on the inspection date.
- "mites" stays a short free-text note for anything the numbers don't capture.
- If NO mite test was mentioned at all, leave mite_count, mite_sample_size, mite_wash_method and mite_check_date null.

Return ONLY a JSON object with this exact shape:
{
  "category": "inspection" | "treatment" | "feeding",
  "summary": "one short plain-language sentence summarizing the note",
  "inspection": { "queen_seen": bool|null, "eggs_seen": bool|null, "brood_pattern": int|null, "temperament": int|null, "population": string|null, "stores": string|null, "space": string|null, "queen_cells": bool|null, "swarm_signs": bool|null, "mite_check_date": string|null, "mite_count": int|null, "mite_sample_size": int|null, "mite_wash_method": string|null, "mites": string|null, "pests_disease": string|null, "actions": string|null, "notes": string|null },
  "treatment": { "product": string|null, "target": string|null, "dose": string|null, "method": string|null, "notes": string|null },
  "feeding": { "feed_type": string|null, "amount": string|null, "notes": string|null }
}
Include all three sub-objects but only fill the one matching the category; leave the others with null fields.`;

async function transcribe(p: Provider, file: Blob): Promise<string> {
  const fd = new FormData();
  fd.append("file", file, "note.webm");
  fd.append("model", p.stt);
  fd.append("language", "en");
  fd.append("prompt", AUDIO_HINT);
  const res = await fetch(`${p.base}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.key}` },
    body: fd,
  });
  if (!res.ok) throw new Error(`${p.name} transcription failed (${res.status}): ${await res.text()}`);
  const body = await res.json();
  return String(body.text || "").trim();
}

// Llama occasionally wraps its JSON in a ```json fence even in JSON mode.
function parseLoose(text: string): Record<string, unknown> {
  const cleaned = String(text || "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try { return JSON.parse(cleaned.slice(first, last + 1)); } catch { /* fall through */ }
    }
    return {};
  }
}

async function structure(p: Provider, transcript: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${p.base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: p.chat,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${p.name} parsing failed (${res.status}): ${await res.text()}`);
  const body = await res.json();
  return parseLoose(body.choices?.[0]?.message?.content || "{}");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  try {
    const chain = providers();
    if (!chain.length) {
      return json({ error: "No transcription key found — set GROQ_API_KEY (free at console.groq.com) or OPENAI_API_KEY as a Supabase secret" }, 500);
    }

    const authHeader = req.headers.get("Authorization") || "";
    const body = await req.json().catch(() => ({}));
    const audio_path = body?.audio_path as string | undefined;
    if (!audio_path) return json({ error: "missing audio_path" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    // Act as the calling user so storage RLS applies (they can only read audio
    // belonging to an apiary they're a member of).
    const supa = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });

    const { data: file, error: dlErr } = await supa.storage.from("hive-audio").download(audio_path);
    if (dlErr || !file) return json({ error: "could not read audio: " + (dlErr?.message || "not found") }, 400);

    const ceiling = Math.min(...chain.map((p) => p.maxBytes));
    if (file.size > ceiling) {
      return json({ error: `That note is ${(file.size / 1048576).toFixed(1)} MB — the limit is ${Math.floor(ceiling / 1048576)} MB. Try a shorter recording.` }, 413);
    }

    // Try each configured provider in turn; a rate limit on the free tier
    // shouldn't lose the beekeeper's note if another key is available.
    const failures: string[] = [];
    for (const p of chain) {
      try {
        const transcript = await transcribe(p, file);
        if (!transcript) return json({ error: "empty transcript — no speech detected" }, 422);
        const parsed = await structure(p, transcript);
        if (!parsed.category) parsed.category = "inspection";
        return json({ transcript, parsed, provider: p.name });
      } catch (e) {
        failures.push(String((e as Error).message || e));
      }
    }
    return json({ error: failures.join(" | ") }, 502);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
