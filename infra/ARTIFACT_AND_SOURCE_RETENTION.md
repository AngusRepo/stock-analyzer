# GCP Build Artifact Retention

## Artifact Registry

Repository `cloud-run-source-deploy`:

- keep the latest 3 versions per package;
- delete untagged images older than 7 days;
- deploy by immutable digest when promoting the same build;
- do not add a traffic tag solely for candidate validation.

## Cloud Run source bucket

Bucket `run-sources-gen-lang-client-0602998820-asia-east1` contains Cloud Run
build source archives, not runtime evidence. `infra/run-sources-lifecycle.json`
deletes archives after 30 days. Deployed revisions continue to use Artifact
Registry image digests.

Canonical execution, market, model, paper-shadow, and lineage evidence are not
stored under this bucket and are governed separately by R2/D1 retention.
