import { spawn } from 'node:child_process'

const FFMPEG_TIMEOUT_MS = 30_000

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
