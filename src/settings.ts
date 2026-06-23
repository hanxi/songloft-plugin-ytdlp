/// <reference types="@songloft/plugin-sdk" />

import { callHostAPI } from './utils/http';
import type { Settings } from './types';

const DEFAULTS: Settings = {
  audio_quality: 'bestaudio',
  cookies_browser: '',
  cookies_file: '',
  github_proxy: '',
  proxy: '',
  path_template: 'ytdlp/{artist}/{title}',
  embed_metadata: true,
  download_interval: 3,
};

export async function getSettings(): Promise<Settings> {
  const stored = await songloft.storage.get('settings') as Partial<Settings> | null;
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(partial: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const updated = { ...current, ...partial };
  await songloft.storage.set('settings', updated);
  return updated;
}

export async function getProxy(): Promise<string> {
  const settings = await getSettings();
  if (settings.proxy) return settings.proxy;
  try {
    const resp = await callHostAPI<{ proxy: string }>('GET', '/api/v1/settings/http-proxy');
    return resp?.proxy || '';
  } catch {
    return '';
  }
}

export function buildCookiesArgs(settings: Settings): string[] {
  const args: string[] = [];
  if (settings.cookies_browser) {
    args.push('--cookies-from-browser', settings.cookies_browser);
  } else if (settings.cookies_file) {
    args.push('--cookies', settings.cookies_file);
  }
  return args;
}

export async function buildCommonArgs(): Promise<string[]> {
  const settings = await getSettings();
  const args: string[] = ['--no-warnings'];

  const proxy = await getProxy();
  if (proxy) {
    args.push('--proxy', proxy);
  }

  args.push(...buildCookiesArgs(settings));
  return args;
}
