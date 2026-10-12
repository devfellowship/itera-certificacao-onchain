---
name: inspect-test-patch
description: Generic loop for a bug fix: inspect the code, run the tests, patch, re-test, check edge cases.
---

# inspect-test-patch

1. Inspect: list `src/` and `tests/`, read every file that the task names.
2. Test: run the test command and write down which tests fail.
3. Patch: change the least code that fixes the cause, not the symptom.
4. Re-test: run the tests again. All tests that passed before must still pass.
5. Edge cases: list inputs that the tests do not try (repeats, bad input, wrong order) and make the code handle each one.
