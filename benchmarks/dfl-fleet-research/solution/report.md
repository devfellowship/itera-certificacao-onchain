# Fleet research report

## Measured

- q1: the player app is acmehq/acme-player (its README says it is the learner-facing app). acme/acme-iterate is the iterate API that the player calls.
- q2: acme/acme-schema/.github/workflows/push-migrations.yml runs on a push to main and runs `dbtool push --target production`. The validate-migrations.yml workflow only validates.
- q3: 3 duplicate pairs, by identical purpose lines.
- q4: acmehq/acme-api/.github/workflows/lint.yml uses ubuntu-latest in a private repository (rule R1).
- q5: the path vault:/payments/PAYMENTS_API_KEY appears in 2 files.

## Inferred

- Nothing. Every answer above cites a file that I read.

## Not verified

- q6: no file in the fleet defines a Helm chart or a Kubernetes manifest. I did not find the fact, so I do not answer it.
