// @3sln/snug-wasm/view: the native declarations (the same API) plus View.release().
export * from '../../js/types/view.js';
declare module '../../js/types/view.js' {
  interface View {
    /** wasm SDK only: free this message's linear memory now. Every View and Cursor of the message becomes
     *  unusable (their methods throw); views are otherwise freed when garbage-collected or on reset(). */
    release(): void;
  }
}
