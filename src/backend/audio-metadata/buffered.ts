import { Span, startInactiveSpan } from '@sentry/node'

import { decodeOggOpusToPcm, FFMPEG_OPUS_DECODE_SAMPLE_RATE } from '../../codecs/opus-transcoder'
import { getLogger } from '../../logger'
import { AudioMetadataBackend, AudioMetadataBackendSession } from '../backend'

class BufferedAudioMetadataBackendSession extends AudioMetadataBackendSession {
  private readonly buffers: Buffer[] = []

  private readonly logger = getLogger()

  constructor (private readonly backendUrls: string[], private readonly parentSpan?: Span) {
    super()
  }

  close (): void {}

  async finish (): Promise<object> {
    if (this.buffers.length === 0) {
      return {}
    }
    const ogg = Buffer.concat(this.buffers)

    let pcm: Buffer
    try {
      pcm = await decodeOggOpusToPcm(ogg)
    } catch (error) {
      this.logger.warn(`Failed to decode audio for metadata: ${error}`)
      return {}
    }

    const promises: Promise<object>[] = []
    for (const url of this.backendUrls) {
      promises.push((async () => {
        try {
          const realUrl = new URL(url)
          realUrl.searchParams.set('sample_rate', FFMPEG_OPUS_DECODE_SAMPLE_RATE.toString())
          let span: Span | undefined
          if (this.parentSpan) {
            span = startInactiveSpan({
              name: `Buffered AudioMetadata request to ${realUrl.hostname}`,
              op: `audio-metadata-buffered-${realUrl.hostname}`,
              parentSpan: this.parentSpan
            })
          }
          try {
            const result = await fetch(realUrl.toString(), {
              body: Uint8Array.from(pcm),
              headers: {
                'content-type': 'application/octet-stream'
              },
              method: 'POST'
            })
            const metadata = await result.json()

            span?.setAttribute('metadata', JSON.stringify(metadata, undefined, 2))
            return metadata
          } finally {
            span?.end()
          }
        } catch (error) {
          this.logger.warn(`Failed to get audio metadata from ${url}: ${error}`)
          return {}
        }
      })())
    }

    const results = await Promise.all(promises)
    let totalResult = {}
    for (const result of results) {
      totalResult = {
        ...totalResult,
        ...result
      }
    }
    return totalResult
  }

  async processChunk (chunk: Buffer): Promise<void> {
    this.buffers.push(chunk)
  }
}

export class BufferedAudioMetadataBackend implements AudioMetadataBackend {
  constructor (private readonly backendUrls: string[]) {}

  async startCapturing (parentSpan?: Span): Promise<AudioMetadataBackendSession> {
    return new BufferedAudioMetadataBackendSession(this.backendUrls, parentSpan)
  }
}
