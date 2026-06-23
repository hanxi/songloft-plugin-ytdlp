/// <reference types="@songloft/plugin-sdk" />

import { callHostAPI } from './utils/http';
import type { ExtractedItem } from './types';

interface ImportedSong {
  id: number;
  title: string;
}

interface ImportResult {
  songs: ImportedSong[];
  playlist_id?: number;
}

export async function importSongs(
  items: ExtractedItem[],
  playlistName?: string,
  playlistId?: number,
): Promise<ImportResult> {
  if (items.length === 0) {
    throw new Error('No items to import');
  }

  const allSongs: ImportedSong[] = [];
  const batchSize = 50;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const body = batch.map(item => ({
      title: item.title,
      artist: item.artist,
      album: item.album,
      cover_url: item.thumbnail,
      duration: item.duration,
      plugin_entry_path: 'ytdlp',
      source_data: JSON.stringify({
        platform: item.platform,
        id: item.id,
        url: item.url,
      }),
      dedup_key: `${item.platform}:${item.id}`,
    }));

    const resp = await callHostAPI<{ songs: ImportedSong[]; count: number }>(
      'POST', '/api/v1/songs/remote', body,
    );
    allSongs.push(...resp.songs);
  }

  let finalPlaylistId = playlistId;

  if (playlistName && !finalPlaylistId) {
    const resp = await callHostAPI<{ id: number }>(
      'POST', '/api/v1/playlists', { name: playlistName, type: 'normal' },
    );
    finalPlaylistId = resp.id;
  }

  if (finalPlaylistId && allSongs.length > 0) {
    const songIds = allSongs.map(s => s.id);
    for (let i = 0; i < songIds.length; i += batchSize) {
      const batch = songIds.slice(i, i + batchSize);
      await callHostAPI('POST', `/api/v1/playlists/${finalPlaylistId}/songs`, { song_ids: batch });
    }
  }

  return { songs: allSongs, playlist_id: finalPlaylistId };
}
