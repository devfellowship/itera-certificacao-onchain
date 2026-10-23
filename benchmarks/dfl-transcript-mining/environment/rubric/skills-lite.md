# Skill routing surface (SYNTHETIC, open variant; name: what it covers)
- ci-check: Report the status of every check of one pull request, by its head commit. Use it before a merge.
- safe-merge: Squash-merge a pull request after it verifies that every check is green on the head commit.
- deploy-staging: Deploy one acme service to staging and verify that the new version answers.
- runner-disk-clean: Free disk space on a fleet-x runner when a job fails with "no space left on device".
