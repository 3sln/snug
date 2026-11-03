// These are options for the CURRENT codec/Writer, not D081's future presets.
// The default wire policy still uses the Bindle restrictions. Never silently alias
// the planned general deterministic preset to the current narrower language.
export const profiles = Object.freeze({ bindle: Object.freeze({ top: 'map', cose: false, strictArrays: true }) });
