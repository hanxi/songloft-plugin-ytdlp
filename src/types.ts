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
  // 下载转码：''=原始(不转码，YouTube 源常为 .mkv/.webm 视频容器，部分设备如小爱音箱无法播放)；
  // mp3/m4a=下载时转成标准音频容器，只保留转码结果
  transcode_format: '' | 'mp3' | 'm4a';
  // 转码码率：0=默认最高质量；128/192/320=指定 CBR。transcode_format 为 '' 时忽略
  transcode_bitrate: 0 | 128 | 192 | 320;
}
