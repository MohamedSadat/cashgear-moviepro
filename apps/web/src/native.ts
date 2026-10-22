import { invoke, isTauri } from '@tauri-apps/api/core';
import type { NativeInfo } from '@cgv/ui';

/** The desktop app's native side, through the `native_info` Tauri command. */
export async function loadNativeInfo(): Promise<NativeInfo | undefined> {
  if (!isTauri()) return undefined;
  return invoke<NativeInfo>('native_info');
}
