// Vite resolves `?worker&url` imports to the URL of the bundled worker script.
declare module '*?worker&url' {
  const url: string;
  export default url;
}
