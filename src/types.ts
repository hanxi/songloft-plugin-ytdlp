/// <reference types="@songloft/plugin-sdk" />

export interface YtdlpSourceData {
  platform: string;
  id: string;
  url: string;
}

export interface ExtractedItem {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  thumbnail: string;
  platform: string;
  url: string;
}

export interface ExtractResult {
  items: ExtractedItem[];
  playlist_title: string;
  platform: string;
}

export interface ImportRequest {
  items: ExtractedItem[];
  playlist_name?: string;
  playlist_id?: number;
}

export interface ImportDownloadRequest extends ImportRequest {
  // inherits all from ImportRequest, triggers download after import
}

export interface BatchResult {
  song_id: number;
  path?: string;
  status: string;
  error?: string;
}

export interface BatchTask {
  results: BatchResult[];
  current: number;
  total: number;
  done: boolean;
}

export interface Settings {
  audio_quality: string;
  cookies_browser: string;
  github_proxy: string;
  proxy: string;
  path_template: string;
  embed_metadata: boolean;
  download_interval: number;
  search_platform: string;
}
