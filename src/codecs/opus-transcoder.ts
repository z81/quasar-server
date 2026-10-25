import { spawn } from 'node:child_process'
import { once } from 'node:events'

const FFMPEG_TIMEOUT_MS = 30_000

class ChunkQueue {
  stderr = ''
  private readonly chunks: Buffer[] = []
  private done = false
  private failure: Error | null = null
  private readonly waiters: Array<(result: IteratorResult<Buffer>) => void> = []

  captureStderr (chunk: string): void {
    this.stderr += chunk
  }

  finish (failure: Error | null): void {
    if (this.done) return
    this.done = true
    this.failure = failure
    for (const waiter of this.waiters.splice(0)) {
      this.deliver(waiter)
    }
  }

  next (): Promise<IteratorResult<Buffer>> {
    if (this.chunks.length > 0) {
      return Promise.resolve({ done: false, value: this.chunks.shift()! })
    }
    if (this.done) {
      return this.failure
        ? Promise.reject(this.failure)
        : Promise.resolve({ done: true, value: undefined })
    }
    return new Promise(resolve => {
      this.waiters.push(resolve)
    })
  }

  push (chunk: Buffer): void {
    if (this.done) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ done: false, value: chunk })
    } else {
      this.chunks.push(chunk)
    }
  }

  private deliver (waiter: (result: IteratorResult<Buffer>) => void): void {
    if (this.failure) {
      waiter(Promise.reject(this.failure) as unknown as IteratorResult<Buffer>)
    } else {
      waiter({ done: true, value: undefined })
    }
  }
}

/**
 * Streaming variant of transcodePcmToOggOpus: PCM chunks are piped into
 * ffmpeg as they arrive and OGG/Opus chunks are yielded as soon as they are
 * encoded, so audio playback can start before synthesis finishes. Abandoning
 * the iteration kills ffmpeg
 */
export async function * transcodePcmStreamToOggOpus (pcmChunks: AsyncIterable<Buffer>,
  sampleRate: number): AsyncGenerator<Buffer> {
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 's16le',
    '-ar', String(sampleRate),
    '-ac', '1',
    '-i', 'pipe:0',
    '-c:a', 'libopus',
    '-b:a', '32k',
    '-vbr', 'on',
    '-application', 'voip',
    '-flush_packets', '1',
    '-f', 'ogg',
    'pipe:1'
  ])

  const queue = new ChunkQueue()

  ffmpeg.stdout.on('data', chunk => {
    queue.push(Buffer.from(chunk))
  })
  ffmpeg.stderr.on('data', chunk => {
    queue.captureStderr(chunk.toString('utf8'))
  })
  ffmpeg.on('error', (error: NodeJS.ErrnoException) => {
    queue.finish(error.code === 'ENOENT'
      ? new Error('ffmpeg is not installed, but it is required for TTS audio transcoding')
      : error)
  })
  ffmpeg.on('close', code => {
    queue.finish(code === 0
      ? null
      : new Error(`ffmpeg transcode failed with code ${code}: ${queue.stderr.trim()}`))
  })

  void (async () => {
    for await (const chunk of pcmChunks) {
      if (!ffmpeg.stdin.write(chunk)) {
        await once(ffmpeg.stdin, 'drain')
      }
    }
    ffmpeg.stdin.end()
  })().catch(error => {
    queue.finish(new Error(`Failed to write PCM to ffmpeg: ${String(error)}`))
    ffmpeg.kill()
  })

  try {
    while (true) {
      const result = await queue.next()
      if (result.done) break
      yield result.value
    }
  } finally {
    if (ffmpeg.exitCode === null) {
      ffmpeg.kill('SIGKILL')
    }
  }
}

/**
 * Transcodes signed 16-bit little-endian mono PCM into a complete OGG/Opus
 * file via ffmpeg — the format the station expects for TTS responses
 */
export function transcodePcmToOggOpus (pcm: Buffer, sampleRate: number): Promise<Buffer> {
  return runFfmpeg([
    '-f', 's16le',
    '-ar', String(sampleRate),
    '-ac', '1',
    '-i', 'pipe:0',
    '-c:a', 'libopus',
    '-b:a', '32k',
    '-vbr', 'on',
    '-application', 'voip',
    '-f', 'ogg',
    'pipe:1'
  ], pcm, 'transcode')
}

// ffmpeg's opus decoder always outputs 48 kHz
export const FFMPEG_OPUS_DECODE_SAMPLE_RATE = 48_000

/**
 * Decodes an OGG/Opus stream into signed 16-bit little-endian mono PCM at
 * 48 kHz via ffmpeg
 */
export function decodeOggOpusToPcm (ogg: Buffer): Promise<Buffer> {
  return runFfmpeg([
    '-i', 'pipe:0',
    '-f', 's16le',
    '-ac', '1',
    'pipe:1'
  ], ogg, 'decode')
}

/**
 * Transcodes an OGG/Opus stream into a 16-bit mono WAV file — the input every
 * speech recognition provider accepts, unlike Opus in OGG. The header is built
 * here because ffmpeg cannot fill in WAV sizes when writing to a pipe
 */
export async function transcodeOggOpusToWav (ogg: Buffer, sampleRate = 16_000): Promise<Buffer> {
  const pcm = await runFfmpeg([
    '-i', 'pipe:0',
    '-f', 's16le',
    '-ar', String(sampleRate),
    '-ac', '1',
    'pipe:1'
  ], ogg, 'decode')

  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function runFfmpeg (ffmpegArguments: string[], input: Buffer, operation: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...ffmpegArguments])

    const output: Buffer[] = []
    let stderr = ''
    let settled = false

    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGKILL')
    }, FFMPEG_TIMEOUT_MS)

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    }

    ffmpeg.stdout.on('data', chunk => {
      output.push(Buffer.from(chunk))
    })
    ffmpeg.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8')
    })
    ffmpeg.on('error', (error: NodeJS.ErrnoException) => {
      fail(error.code === 'ENOENT'
        ? new Error(`ffmpeg is not installed, but it is required for audio ${operation} (${operation === 'transcode' ? 'TTS' : 'audio metadata'})`)
        : error)
    })
    ffmpeg.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (code === 0) {
        resolve(Buffer.concat(output))
      } else {
        reject(new Error(`ffmpeg ${operation} failed with code ${code}: ${stderr.trim()}`))
      }
    })

    ffmpeg.stdin.on('error', error => {
      fail(new Error(`Failed to write audio to ffmpeg: ${String(error)}`))
    })
    ffmpeg.stdin.end(input)
  })
}
