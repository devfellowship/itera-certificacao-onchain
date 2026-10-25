# Session decision trajectory extraction workspace

- `item.txt` — the condensed view of ONE unit of agent work (data only).
- `layer1.json` — the layer-1 facts of the unit (a script extracted them; context, not graded).
- `shapes.json` — the shapes that you label in `intent_labels`.
- `rubric/schema.json` — the JSON Schema of the answer. `rubric/taxonomy.md`, `rubric/risk-anchors.md`, `rubric/intents.md` — the closed lists, the risk anchors and floors, the intent list.
- `out/judgment.json` — your answer (you create it). One JSON object, exactly the 9 top-level keys of the schema.

A correction quote is copied character for character from the HUMAN turn it points at. An empty array is a
correct answer when nothing applies.
