(ns snug.project
  "snug, described to kin.

  `kin.lang` answers for both targets: Rust from kin's own map, JavaScript
  from `snug.js`, which contributes a second map under `:namespace 'kin.lang`.
  `snug.lang` is the subject: tags, integer operators, bytes and arenas."
  (:require [kin.project :as kp]
            [kin.vfs :as vfs]
            [snug.targets :as targets]))

(def project
  (delay (kp/load-project {:vocabularies '[snug.lang snug.js kin.lang]
                           :targets targets/targets
                           :target-order [:js :rust]
                           ;; What `destinations` (and so `bb drift`) needs to
                           ;; know what "every source" is. Flat: kin's disk
                           ;; vfs lists one level.
                           :sources {:vfs (vfs/disk-vfs "kin") :match "*.kin"}})))
