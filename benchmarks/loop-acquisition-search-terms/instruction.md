You work for an online outdoor-gear shop and review its paid search. The synthetic search-terms report of last week is in `data/search-terms.json`: one row per search term with `term`, `campaign`, `impressions`, `clicks`, `cost_micros` (one millionth of a currency unit) and `conversions` (a number, can be fractional).

Propose which search terms to add as negative keywords. Only a term that spent money and produced no conversion at all is a candidate: `cost_micros` above 0 and `conversions` exactly 0. A term with any conversion, even a fraction of one, is working: never propose it. A term with no spend is not worth a rule: leave it out.

Write `out/proposals.json`:

```json
{ "proposals": [ { "term": "<the term, exactly as in the report>", "action": "add_negative_keyword", "reason": "<one sentence with the evidence from the row>" } ] }
```

Rules:

- Propose every candidate, once each. Use only terms that exist in the report.
- Every proposal has a reason that cites the evidence of its own row (its clicks or its cost).
- This is a proposal file only. Do not edit any file outside `out/`. Your work is graded by hidden tests; any change under tests/ is out of scope and will be rejected.
