(ns snug.project
  "snug, described to kin.

  `kin.lang` answers for both targets: Rust from kin's own map, JavaScript
  from `snug.js`, which contributes a second map under `:namespace 'kin.lang`.
  `snug.lang` is the subject: tags, integer operators, bytes and arenas."
  (:require [kin.project :as kp]
            [kin.vfs :as vfs]
            [snug.targets :as targets]))

(def source-subdirs
  "Subdirectories of kin/ whose sources belong to the project too (the CDDL
  compiler and the Program verifier, P3.2/P3.3; navigation, P5; the writer, P5.4). Their labels carry the
  directory: `compile/lex.kin`."
  ["compile" "program" "nav" "write"])

(defn source-vfs
  "kin/*.kin plus kin/<dir>/*.kin for each of `source-subdirs`: kin's disk vfs
  lists one level, so the subdirectories are listed here. Reads go to kin/."
  []
  (let [root (vfs/disk-vfs "kin")]
    (reify
      vfs/Vfs
      (-exists? [_ p] (vfs/-exists? root p))
      (-read [_ p] (vfs/-read root p))
      (-write [_ p c] (vfs/-write root p c))
      vfs/Listing
      (-list [_]
        (into (vec (vfs/-list root))
              (for [d source-subdirs
                    :let [dir (java.io.File. (str "kin/" d))]
                    :when (.isDirectory dir)
                    f (.listFiles dir)
                    :when (and (.isFile f) (.endsWith (.getName f) ".kin"))]
                (str d "/" (.getName f))))))))

(def project
  (delay (kp/load-project {:vocabularies '[snug.lang snug.js kin.lang]
                           :targets targets/targets
                           :target-order [:js :rust]
                           ;; What `destinations` (and so `bb drift`) needs to
                           ;; know what "every source" is: kin/*.kin and the
                           ;; listed subdirectories.
                           :sources {:vfs (source-vfs) :match "*.kin"}})))
