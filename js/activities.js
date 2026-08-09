// Queen Tracker — the vocabulary of things you can do to a hive.
//
// This file is the single source of truth for the timeline's activity dropdown.
// It is deliberately just data: to add an activity, add an entry here and the
// form, the cascade, the timeline label and the export all follow. Nothing else
// needs editing.
//
// Shape of a type:
//   key      stable id, stored in queen_events.event_type — DO NOT rename once
//            it has been used, or old rows stop matching their label
//   label    what the beekeeper reads
//   table    the domain table a structured record is written to, if any.
//            This is what makes an entry reach the queen's summary card;
//            entries with no table live only on the timeline.
//   subs     second layer: [{ label, items: [...] }] — items are the third
//            layer, the one shown in parentheses
//   items    a single extra layer when there's no need for a middle one
//   special  "mite" or "percent" — triggers a purpose-built control
//   unit     suffix for a "percent" activity's numeric answer
(function () {
  "use strict";

  // A half-cup scoop of bees. Standard for an alcohol wash or sugar roll, and
  // the denominator behind the infestation percentage on the queen card.
  const MITE_SAMPLE_DEFAULT = 300;

  // Scoop sizes beekeepers actually measure with, so the sample box can say
  // what the number means. Anything else is fine, just flagged as non-standard.
  const CUPS = { 75: "⅛ cup", 150: "¼ cup", 300: "½ cup", 450: "¾ cup", 600: "1 cup" };

  // Varroa products, shared by "applied" and "removed" so a strip you pull is
  // named exactly the same way as the strip you put in.
  const VARROA_SUBS = [
    { label: "Chemical", items: ["Oxalic Acid", "Formic Acid", "Thymol", "Other"] },
    { label: "IPM / Physical", items: ["Drone frame", "Split", "Restricted Queen Laying", "Other"] },
  ];

  const TYPES = [
    {
      key: "mite_check", label: "Mite check", icon: "🔬",
      table: "inspections", special: "mite",
    },
    {
      key: "treatment", label: "Treatment applied", icon: "💊",
      table: "treatments", subs: VARROA_SUBS,
    },
    {
      // Pulling strips is its own event: it ends an exposure window, and you
      // want it on the timeline without it looking like a fresh treatment on
      // the summary card. So no domain row — timeline only.
      key: "treatment_removed", label: "Treatment removed", icon: "🧹",
      table: null, subs: VARROA_SUBS,
    },
    {
      key: "fed", label: "Fed", icon: "🍯", table: "feedings",
      subs: [
        { label: "Syrup", items: ["1:1 (spring)", "2:1 (fall)", "Other"] },
        { label: "Protein", items: ["Pollen patty", "Pollen substitute", "Real pollen", "Other"] },
        { label: "Solid sugar", items: ["Fondant", "Candy board", "Dry sugar", "Other"] },
      ],
    },
    { key: "split", label: "Split made", icon: "🪓", table: null,
      items: ["Walk-away split", "Split with queen cell", "Split with mated queen", "Nuc pulled", "Other"] },
    { key: "super_added", label: "Honey super added", icon: "⬆️", table: null,
      items: ["1 super", "2 supers", "3+ supers"] },
    { key: "super_removed", label: "Honey super removed", icon: "⬇️", table: null,
      items: ["1 super", "2 supers", "3+ supers", "Pulled for extraction"] },
    {
      // Both of these answer "how mite-resistant is this queen's colony?" and
      // both produce a percentage, so they share one activity with the method
      // as the sub-choice. UBeeO is the synthetic brood-pheromone spray (the
      // assay formerly called UBO); Harbo scores non-reproductive mites.
      key: "vsh_assay", label: "VSH / hygienic assay", icon: "🧪",
      table: null, special: "percent", unit: "%",
      items: ["Harbo assay (non-reproductive mites)", "UBeeO brood-pheromone spray",
              "Freeze-killed brood", "Pin test", "Other"],
    },
    { key: "inspection", label: "Inspection", icon: "🔍", table: "inspections" },
    { key: "requeened", label: "Requeened", icon: "👑", table: null,
      items: ["Mated queen introduced", "Queen cell introduced", "Emergency / supersedure", "Other"] },
    // Kept last and kept free-text: the dropdown must never be the reason
    // something goes unrecorded.
    { key: "note", label: "Note / other", icon: "📝", table: null },
  ];

  const byKey = {};
  TYPES.forEach((t) => (byKey[t.key] = t));

  // Older rows stored whatever the user typed ("Mite check", "Treatment", …).
  // Match them to a type so the timeline can still label and icon them.
  function resolve(eventType) {
    if (!eventType) return null;
    if (byKey[eventType]) return byKey[eventType];
    const s = String(eventType).trim().toLowerCase();
    return TYPES.find((t) => t.label.toLowerCase() === s)
        || TYPES.find((t) => t.key.replace(/_/g, " ") === s)
        || null;
  }

  function labelFor(eventType) {
    const t = resolve(eventType);
    return t ? t.label : String(eventType || "");
  }
  function iconFor(eventType) {
    const t = resolve(eventType);
    return t ? t.icon : "•";
  }

  // ---- Mite maths -------------------------------------------------------
  // Mike's thresholds, which are counts rather than rates: 0-1 is fine, 2-8 is
  // watch it, 9+ (3% of a 300-bee sample) is act. 20+ is the top of the picker
  // and always reads TREAT.
  const MITE_CAP = 20;

  // The count thresholds and the rate thresholds are the same two lines, just
  // expressed differently: 9 mites in 300 bees IS 3%, and 2 in 300 IS 0.667%.
  // Keeping them in sync matters — it means the banding doesn't jump when the
  // scoop changes, and a half-cup sample lands identically under either rule.
  const MITE_RED_COUNT = 9;
  const MITE_AMBER_COUNT = 2;
  const MITE_RED_PCT = (MITE_RED_COUNT / MITE_SAMPLE_DEFAULT) * 100;      // 3.0
  const MITE_AMBER_PCT = (MITE_AMBER_COUNT / MITE_SAMPLE_DEFAULT) * 100;  // 0.667

  function miteRate(count, sample) {
    const s = Number(sample) || MITE_SAMPLE_DEFAULT;
    if (count == null || !s) return null;
    return (Number(count) / s) * 100;
  }

  // Band a wash. A raw count only means what the thresholds say if the scoop is
  // the standard half cup — 12 mites is alarming out of 300 bees and ordinary
  // out of 600. So counts are used at 300 (and when the scoop is unknown, which
  // is what every older row looks like), and the rate is used for any other
  // sample size.
  function miteBand(count, capped, sample) {
    if (capped) return "red";
    if (count == null) return null;
    const s = Number(sample);
    if (!s || s === MITE_SAMPLE_DEFAULT) {
      return count >= MITE_RED_COUNT ? "red" : count >= MITE_AMBER_COUNT ? "amber" : "green";
    }
    const rate = miteRate(count, s);
    return rate >= MITE_RED_PCT ? "red" : rate >= MITE_AMBER_PCT ? "amber" : "green";
  }

  // True when the band came from the rate rather than the raw count, so the UI
  // can say so instead of leaving the beekeeper to wonder why 12 isn't red.
  function bandedByRate(sample) {
    const s = Number(sample);
    return !!s && s !== MITE_SAMPLE_DEFAULT;
  }
  // Options for the count picker: 0…20 then "20+".
  function miteOptions() {
    const out = [];
    for (let i = 0; i <= MITE_CAP; i++) out.push({ value: String(i), label: String(i), capped: false });
    out.push({ value: "20+", label: "20+ (TREAT)", capped: true });
    return out;
  }

  window.QT_ACTIVITIES = {
    TYPES, byKey, resolve, labelFor, iconFor,
    MITE_SAMPLE_DEFAULT, MITE_CAP, CUPS,
    MITE_RED_COUNT, MITE_AMBER_COUNT, MITE_RED_PCT, MITE_AMBER_PCT,
    miteRate, miteBand, bandedByRate, miteOptions,
  };
})();
