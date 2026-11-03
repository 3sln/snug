# Work in progress (not emitted, not gated)

`vm-session.kin.wip` — the resumable session driver of the validator VM
(DEVLOG P6.2, D027/D030), 2,224 lines, interrupted mid-implementation on
2026-10-29 when its agent hit an API usage limit. It builds on the shared
refactors of `kin/vm-{api,dead,leaf}.kin` (committed, gated). It is kept here
with a `.wip` suffix so kin's source listing (`kin/*.kin`) does not pick it
up. Finish it or delete it; do not emit it as is.
