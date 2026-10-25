import openapi from '@elysia/openapi'
import node from '@elysiajs/node'
import Sentry from '@sentry/node'
import bodyParser from 'body-parser'
import Elysia, { t } from 'elysia'
import express from 'express'
import { OpenAI } from 'openai'
import z from 'zod'

import { BufferedAudioMetadataBackend } from './backend/audio-metadata/buffered'
import { BasicMusicBackend } from './backend/music/basic'
import { StubMusicBackend } from './backend/music/stub'
import { OpenRouterProcessorBackend } from './backend/processors/openrouter'
import { OpenRouterSTTBackend } from './backend/stt/openrouter'
import { OpenRouterTTSBackend } from './backend/tts/openrouter'
import { getEnvironment } from './environment'
import { getLogger } from './logger'
import { MusicManager } from './music/manager'
import proto from './protos/protos'
import { pushUpdateConfigDirective } from './routers/alice/directives'
import { registerClckYandexNetRouter } from './routers/clck.yandex.net'
import { registerMobileproxyPassportYandexNetRouter } from './routers/mobileproxy.passport.yandex.net'
import { registerOAuthYandexRuRouter } from './routers/oauth.yandex.ru'
import { registerQuasarYandexNetRouter } from './routers/quasar.yandex.net'
import { registerReportAppMetricaYandexNetRouter } from './routers/report.appmetrica.yandex.net'
import { registerRpcAliceYandexNetRouter } from './routers/rpc.alice.yandex.net'
import { registerScbhYandexNetRouter } from './routers/scbh.yandex.net'
import { registerStartupMobileYandexNetRouter } from './routers/startup.mobile.yandex.net'
import { registerUniproxyAliceYandexNetRouter } from './routers/uniproxy.alice.yandex.net'
import { UniProxyConnection } from './routers/uniproxy/uniproxy-connection'
import { PostgresDatabaseStationInfoStorage } from './storage/database'
import { quasarConfig } from './storage/types'
import { loadUpdatesConfig } from './updates'

const logger = getLogger()
const environment = getEnvironment()

const updatesConfig = environment.ALLOW_UPDATES && environment.UPDATES_CONFIG_PATH
  ? loadUpdatesConfig(environment.UPDATES_CONFIG_PATH)
  : { updates: {} }

Sentry.init({
  defaultIntegrations: false,
  dsn: environment.SENTRY_DSN,
  sampleRate: 1,
  tracesSampleRate: 1
})

const storage = new PostgresDatabaseStationInfoStorage(environment.POSTGRES_URL)

// eslint-disable-next-line unicorn/prefer-top-level-await
storage.initialize().catch(error => logger.fatal(error))

const app = express()

// fuck Yandex
app.use('/quasar.yandex.net/glagol/check_token', (request, _response, next) => {
  request.headers['content-type'] = 'text/yandex-token'
  next()
})
app.use('/quasar.yandex.net/glagol/v2.0/check_token', (request, _response, next) => {
  request.headers['content-type'] = 'text/yandex-token'
  next()
})
// unfuck Yandex

app.use(bodyParser.json())
app.use(bodyParser.raw({
  inflate: true,
  type: 'text/yandex-token'
}))

const server = app.listen(environment.PORT, error => {
  if (error) {
    logger.error(`Quasar failed to start on :${environment.PORT}: ${error}`)
    return
  }
  logger.info(`Started quasar on :${environment.PORT}`)
})

registerClckYandexNetRouter(app)
registerReportAppMetricaYandexNetRouter(app)
registerQuasarYandexNetRouter(app, {
  glagolJwtKey: environment.GLAGOL_JWT_KEY,
  infoProvider: storage,
  updatesConfig
})
registerOAuthYandexRuRouter(app)
registerMobileproxyPassportYandexNetRouter(app)
registerStartupMobileYandexNetRouter(app)
registerScbhYandexNetRouter(app)
registerRpcAliceYandexNetRouter(app)

const openRouterClient = new OpenAI({
  apiKey: environment.OPENROUTER_API_KEY,
  baseURL: environment.OPENROUTER_BASE_URL,
  defaultHeaders: {
    'X-Title': 'quasar-server'
  },
  maxRetries: 0,
  timeout: environment.OPENROUTER_TIMEOUT_MS
})

const uniProxyRouter = registerUniproxyAliceYandexNetRouter({
  audioMetadata: new BufferedAudioMetadataBackend(environment.AUDIO_METADATA_URLS),
  musicManager: new MusicManager(environment.MUSIC_SERVICE_BASIC_URL
    ? new BasicMusicBackend(environment.MUSIC_SERVICE_BASIC_URL)
    : new StubMusicBackend()),
  processor: new OpenRouterProcessorBackend(openRouterClient, {
    model: environment.OPENROUTER_PROCESSOR_MODEL,
    systemPrompt: environment.OPENROUTER_PROCESSOR_SYSTEM_PROMPT
  }),
  stt: new OpenRouterSTTBackend(openRouterClient, {
    language: environment.OPENROUTER_STT_LANGUAGE,
    model: environment.OPENROUTER_STT_MODEL,
    partialIntervalMs: environment.OPENROUTER_STT_PARTIAL_INTERVAL_MS
  }),
  tts: new OpenRouterTTSBackend(openRouterClient, {
    instructions: environment.OPENROUTER_TTS_INSTRUCTIONS,
    model: environment.OPENROUTER_TTS_MODEL,
    pcmSampleRate: environment.OPENROUTER_TTS_PCM_SAMPLE_RATE,
    speed: environment.OPENROUTER_TTS_SPEED,
    voice: environment.OPENROUTER_TTS_VOICE
  }),
  ttsStreaming: environment.OPENROUTER_TTS_STREAMING
}, server)

const apiServer = new Elysia({
  adapter: node()
}).use(openapi({
  documentation: {
    info: {
      title: 'Quasar API',
      version: '1.4.6'
    }
  },
  mapJsonSchema: {
    zod: z.toJSONSchema
  }
}))

function runForConnections (duidOrAll: string, action: (connection: UniProxyConnection) => void) {
  for (const [duid, connections] of uniProxyRouter.connections) {
    if (duidOrAll === 'all' || duidOrAll === duid) {
      for (const connection of connections) {
        action(connection)
      }
    }
  }
}

apiServer.get('/devices', async () => {
  const infos = await storage.getStationInfos()
  return infos.map(info => ({
    duid: info.duid,
    name: info.name,
    quasarConfig: info.quasarConfig
  }))
}, {
  detail: {
    summary: 'Get list of devices',
    tags: ['device']
  },
  response: z.array(z.object({
    duid: z.string().describe('DUID'),
    name: z.string().describe('Name'),
    quasarConfig: quasarConfig.describe('Quasar\'s maind config')
  }))
})

apiServer.post('/devices/:duid/push', async ({ body, params: { duid } }) => {
  runForConnections(duid, connection => {
    connection.pushEvent(body.eventText).catch(error => logger.warn(`Failed to push event to UniProxy connection: ${error}`))
  })

  return {}
}, {
  body: t.Object({
    eventText: t.String({
      description: 'Event text to be pushed to LLM'
    })
  }),
  detail: {
    summary: 'Push event to LLM to be processed',
    tags: ['device']
  },
  params: t.Object({
    duid: t.String({
      description: "DUID or 'all' for all devices"
    })
  }),
  response: t.Object({})
})

apiServer.post('/devices/:duid/push-raw', async ({ body, params: { duid } }) => {
  runForConnections(duid, connection => {
    connection.pushTts(body.eventText).catch(error => logger.warn(`Failed to push raw event to UniProxy connection: ${error}`))
  })

  return {}
}, {
  body: t.Object({
    eventText: t.String({
      description: 'Event text to be pushed to TTS'
    })
  }),
  detail: {
    summary: 'Push event text to be TTSed',
    tags: ['device']
  },
  params: t.Object({
    duid: t.String({
      description: "DUID or 'all' for all devices"
    })
  }),
  response: t.Object({})
})

apiServer.post('/devices/:duid/push-directive', async ({ body, params: { duid } }) => {
  runForConnections(duid, connection => {
    connection.pushRawDirectives(proto.NAlice.NAliceApi.TDirective.fromObject(body as { [k: string]: unknown }))
      .catch(error => logger.warn(`Failed to push raw directive to UniProxy connection: ${error}`))
  })

  return {}
}, {
  body: t.Unknown({
    description: 'Raw Quasar directive'
  }),
  detail: {
    summary: 'Push directive to the device',
    tags: ['device']
  },
  params: t.Object({
    duid: t.String({
      description: "DUID or 'all' for all devices"
    })
  }),
  response: t.Object({})
})

apiServer.patch('/devices/:duid', async ({ body, params: { duid } }) => {
  const info = await storage.updateNameAndQuasarConfig(duid, body.name, body.quasarConfig)

  runForConnections(duid, connection => {
    connection.pushDirectives(pushUpdateConfigDirective).catch(error =>
      logger.warn(`Failed to push config update directive to UniProxy connection: ${error}`))
  })

  return {
    duid: info.duid,
    name: info.name,
    quasarConfig: info.quasarConfig
  }
}, {
  body: z.object({
    name: z.string().optional().describe('Name'),
    quasarConfig: quasarConfig.optional().describe('Quasar\'s maind config')
  }),
  detail: {
    summary: 'Update device config',
    tags: ['device']
  },
  params: t.Object({
    duid: t.String({
      description: 'DUID'
    })
  }),
  response: z.object({
    duid: z.string().describe('DUID'),
    name: z.string().describe('Name'),
    quasarConfig: quasarConfig.describe('Quasar\'s maind config')
  })
})

try {
  apiServer.listen(environment.API_PORT, () => {
    logger.info(`Started API on :${environment.API_PORT}`)
  })
} catch (error) {
  logger.error(`API failed to start on :${environment.API_PORT}: ${error}`)
}

app.use((request, response) => {
  logger.debug(`Got unknown request: ${request.method} ${request.url}`)
  response.status(500).end()
})

process.on('SIGINT', () => {
  logger.info('Stopping...')
  apiServer.stop()
  server.close()
  logger.info('Stopped')
})
