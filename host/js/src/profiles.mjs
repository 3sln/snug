// These are options for the CURRENT scanner, not D081's future presets.
// The default codec still uses the Bindle restrictions. Never silently alias
// the planned general deterministic preset to the current narrower language.
export const profiles = Object.freeze({ bindle: Object.freeze({ top: 'map', cose: false }) });
