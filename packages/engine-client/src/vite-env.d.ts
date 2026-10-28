// Vite resolves `?url` imports to the URL of the file as built.
declare module '*?url' {
  const url: string;
  export default url;
}

// Vite resolves `?worker&url` imports to the URL of the bundled worker script.
declare module '*?worker&url' {
  const url: string;
  export default url;
}

// Vite's glob imports: eager ones map paths to `T`, lazy ones to loaders of `T`.
interface ImportMeta {
  glob<T = unknown>(
    pattern: string | string[],
    options?: { query?: string; import?: string; eager?: boolean },
  ): Record<string, T>;
}
