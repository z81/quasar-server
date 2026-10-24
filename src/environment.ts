import { config } from 'dotenv'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'

config({
  path: '.env.local'
})

config()

const environmentType = z.object({
  ALLOW_UPDATES: z.string().transform(value => value.toLowerCase().trim() === 'true'),

  API_PORT: z.string().default('31116').transform(value => Number.parseInt(value)),

  AUDIO_METADATA_URLS: z.string().default('').transform(urls => urls.split(',').filter(Boolean)),

  GLAGOL_JWT_KEY: z.string().default(randomBytes(16).toString('hex')),

  MUSIC_SERVICE_BASIC_URL: z.url().optional(),

  OPENROUTER_API_KEY: z.string().min(1, 'OPENROUTER_API_KEY is required: STT, TTS and dialog processor all go through OpenRouter'),

  OPENROUTER_BASE_URL: z.url().default('https://openrouter.ai/api/v1'),

  OPENROUTER_PROCESSOR_MODEL: z.string().default('google/gemini-3.8-flash'),
  OPENROUTER_PROCESSOR_SYSTEM_PROMPT: z.string().optional(),

  OPENROUTER_STT_LANGUAGE: z.string().default('ru'),
  OPENROUTER_STT_MODEL: z.string().default('openai/whisper-large-v3'),
  OPENROUTER_STT_PARTIAL_INTERVAL_MS: z.string().default('0').transform(value => Number.parseInt(value)),

  OPENROUTER_TIMEOUT_MS: z.string().default('10000').transform(value => Number.parseInt(value)),

  OPENROUTER_TTS_INSTRUCTIONS: z.string().optional(),
  OPENROUTER_TTS_MODEL: z.string().default('google/gemini-3.8-flash-lite-tts'),
  OPENROUTER_TTS_PCM_SAMPLE_RATE: z.string().default('24000').transform(value => Number.parseInt(value)),
  OPENROUTER_TTS_SPEED: z.string().default('1').transform(Number),
  OPENROUTER_TTS_VOICE: z.string().default('Kore'),

  PORT: z.string().default('31115').transform(value => Number.parseInt(value)),

  POSTGRES_URL: z.url().default('postgres://quasar:quasar@localhost/quasar'),

  SENTRY_DSN: z.url().default('https://test@o0.ingest.sentry.io/0'),
  UPDATES_CONFIG_PATH: z.string().optional()
})

export type Environment = z.infer<typeof environmentType>

export function getEnvironment (): Environment {
  return environmentType.parse(process.env)
}
