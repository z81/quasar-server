import { spawn } from 'node:child_process'

const FFMPEG_TRANSCODE_TIMEOUT_MS = 30_000

/**
 * Transcodes signed 16-bit little-endian mono PCM into a complete OGG/Opus
 * file via ffmpeg — the format the station expects for TTS responses
 */
export function transcodePcmToOggOpus (pcm: Buffer, sampleRate: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
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
      '-f', 'ogg',
      'pipe:1'
    ])

    const output: Buffer[] = []
    let stderr = ''
    let settled = false

    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGKILL')
    }, FFMPEG_TRANSCODE_TIMEOUT_MS)

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
        ? new Error('ffmpeg is not installed, but it is required for TTS audio transcoding')
        : error)
    })
    ffmpeg.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (code === 0) {
        resolve(Buffer.concat(output))
      } else {
        reject(new Error(`ffmpeg transcode failed with code ${code}: ${stderr.trim()}`))
      }
    })

    ffmpeg.stdin.on('error', error => {
      fail(new Error(`Failed to write PCM to ffmpeg: ${String(error)}`))
    })
    ffmpeg.stdin.end(pcm)
  })
}
