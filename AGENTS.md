# Working in snug

snug is an experimental kin project (CDDL validator + strict CBOR codec).
Read `SPEC.md`, `docs/architecture.md` and `DEVLOG.md` before changing
anything.

Rules for every contributor, human or agent:

* Work only inside this directory (and, for scratch files, the scratch
  directory you were given). Never modify `../kin`, `../emon`, `../nome` or
  `../3sln.me`; they are read-only references. If kin itself needs a change,
  stop and report it under DEVLOG "Found in kin".
* Behaviour that decides accept/refuse lives in `kin/*.kin`; hosts only build
  values, encode and expose the API. Run `bb emit` and commit `gen/` with the
  source that produced it.
* Errors never contain payload values, input bytes, or data map keys the
  schema does not name.
* No secrets, no network publishing, no deploys, no git remotes or pushes.
  Commit only when your task says so, by explicit path.
* Record decisions as `D###` in DEVLOG (Decision / Why / Alternatives /
  sign-off line, never pre-ticked). Record what was learnt in the item you
  finished. Never claim a check passed that you did not run.
* Measurements go in `bench/README.md` with machine, OS, runtime versions and
  method.
