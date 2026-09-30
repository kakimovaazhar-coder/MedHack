import { createMedHubClient, isAbortError } from './api'

export const AUDIO_ACCEPT = 'audio/*,.wav,.mp3,.m4a,.webm,.ogg,.flac,.aac,.mp4'
export function validateAudio(file: Pick<File, 'name' | 'size' | 'type'>) {
  if (!file.size) throw new Error('Файл пуст. Выберите другую аудиозапись.')
  if (file.size > 30 * 1024 * 1024)
    throw new Error('Максимальный размер аудио — 30 МБ.')
  if (!/\.(wav|mp3|m4a|webm|ogg|flac|aac|mp4)$/i.test(file.name))
    throw new Error(
      'Выберите аудиофайл: WAV, MP3, M4A, WebM, OGG, FLAC или AAC.',
    )
}

/** Recover an accepted upload after a lost response; never upload the same audio twice. */
export async function beginAudioUpload(
  client: ReturnType<typeof createMedHubClient>,
  file: File,
  signal: AbortSignal,
) {
  validateAudio(file)
  const workspace = await client.create({ signal })
  try {
    const job = await client.uploadAudio(
      workspace,
      file,
      {
        title: file.name.slice(0, 150),
        kind: 'current',
        language: 'auto',
      },
      { signal },
    )
    return { workspaceId: workspace.id, jobId: job.id }
  } catch (reason) {
    if (!isAbortError(reason) && !signal.aborted) {
      try {
        const recovered = await client.get(workspace.id, { signal })
        const job = recovered.jobs.find(
          (item) => item.title === file.name.slice(0, 150),
        )
        if (job) return { workspaceId: workspace.id, jobId: job.id }
      } catch {
        /* Keep the original upload error. */
      }
    }
    await client.remove(workspace.id, { timeoutMs: 3000 }).catch(() => {})
    throw reason
  }
}
