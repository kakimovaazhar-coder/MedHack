import { describe, expect, it, vi } from 'vitest'
import { createMedHubClient } from './api'
import { beginAudioUpload, validateAudio } from './audioUpload'

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })
describe('audio upload flow', () => {
  it('rejects empty, oversized and non-audio files before sending data', () => {
    expect(() =>
      validateAudio({ name: 'note.mp3', size: 0, type: 'audio/mpeg' }),
    ).toThrow('пуст')
    expect(() =>
      validateAudio({
        name: 'note.mp3',
        size: 31 * 1024 * 1024,
        type: 'audio/mpeg',
      }),
    ).toThrow('30 МБ')
    expect(() =>
      validateAudio({ name: 'note.docx', size: 400, type: '' }),
    ).toThrow('аудиофайл')
    expect(() =>
      validateAudio({ name: 'NOTE.M4A', size: 400, type: '' }),
    ).not.toThrow()
  })
  it('submits one full file with automatic language detection', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: 'workspace', revision: 0 }))
      .mockResolvedValueOnce(response({ id: 'job' }, 202))
    const client = createMedHubClient('/api', { fetcher })
    const file = new File(['audio'], 'test.wav', { type: 'audio/wav' })
    await expect(
      beginAudioUpload(client, file, new AbortController().signal),
    ).resolves.toEqual({ workspaceId: 'workspace', jobId: 'job' })
    expect(fetcher.mock.calls[1][0]).toContain('language=auto')
    expect(fetcher.mock.calls[1][1]?.body).toBe(file)
  })
  it('recovers an accepted job if the upload response is lost', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: 'workspace', revision: 0 }))
      .mockRejectedValueOnce(new TypeError('Connection closed'))
      .mockResolvedValueOnce(
        response({ jobs: [{ id: 'accepted', title: 'test.wav' }] }),
      )
    const client = createMedHubClient('/api', { fetcher })
    await expect(
      beginAudioUpload(
        client,
        new File(['audio'], 'test.wav'),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ workspaceId: 'workspace', jobId: 'accepted' })
    expect(
      fetcher.mock.calls.filter(([, options]) => options?.body instanceof Blob),
    ).toHaveLength(1)
  })
  it('removes a temporary workspace on a rejected upload and preserves the server error', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: 'workspace', revision: 0 }))
      .mockResolvedValueOnce(
        response(
          { error: { code: 'INVALID_AUDIO', message: 'Файл повреждён.' } },
          422,
        ),
      )
      .mockResolvedValueOnce(response({ jobs: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const client = createMedHubClient('/api', { fetcher })
    await expect(
      beginAudioUpload(
        client,
        new File(['audio'], 'test.wav'),
        new AbortController().signal,
      ),
    ).rejects.toThrow('Файл повреждён.')
    expect(fetcher.mock.calls.at(-1)?.[1]?.method).toBe('DELETE')
  })
})
