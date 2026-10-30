interface ImportMetaEnv {
  /** '1' in builds made for release (the release and web deploy workflows). */
  readonly VITE_CGV_RELEASE?: string;
  /** The licence server's address. */
  readonly VITE_CGV_LICENCE_SERVER?: string;
  /** Public keys (SubjectPublicKeyInfo, base64) licences are signed with, comma-separated. */
  readonly VITE_CGV_LICENCE_KEYS?: string;
  /** The app's version, from the root package.json (apps/web/vite.config.ts). */
  readonly VITE_CGV_VERSION?: string;
}
