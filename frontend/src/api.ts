import type { components } from '../../contracts/api';

export type Workspace = components['schemas']['Workspace'];
export type RecordItem = components['schemas']['Record'];
export type Utterance = components['schemas']['Utterance-Output'];
export type Fields = components['schemas']['ConsultationFields'];
export type Evidence = components['schemas']['Evidence'];
export type Capabilities = {
  enabled: boolean; speech: 'configured_unverified' | 'not_configured';
  engine: 'local_rules' | 'openai'; cloud_llm: boolean; max_audio_bytes: number;
};
const base = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(base + path, {
    method, cache: 'no-store',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error?.message || `Ошибка сервера (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export async function upload(id: string, file: File, query: URLSearchParams) {
  const response = await fetch(`${base}/workspaces/${id}/audio?${query}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error?.message || `Ошибка загрузки (${response.status})`);
  }
  return response.json();
}
