const logger = require('../utils/logger')

const AI_PROD_1GPU_API_URL =
  process.env.AI_PROD_1GPU_API_URL || 'https://ia.arasaac.org/v1'
const AI_PROD_1GPU_API_KEY =
  process.env.AI_PROD_1GPU_API_KEY || 'sk--vnukD3Br0NkY-zy74UJxg'

const AI_2GPU_API_URL =
  process.env.AI_2GPU_API_URL || 'https://ia2.arasaac.org/v1'
const AI_2GPU_API_KEY =
  process.env.AI_2GPU_API_KEY || 'sk-WgyAEnAK_WnTgXTpYlOGlw'

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://qwitenmzhbjyhdqjnrwq.supabase.co'
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'tu_anon_key_publica'

/**
 * Resolves the destination machine and secret API key based on requested model or machineId.
 */
const resolveMachineTarget = (model = '', machineId = '') => {
  let cleanModel = model
  let resolvedMachine = machineId

  // Parse if model arrives as "machineId:modelId"
  if (cleanModel && cleanModel.includes(':')) {
    const colonIdx = cleanModel.indexOf(':')
    resolvedMachine = cleanModel.substring(0, colonIdx)
    cleanModel = cleanModel.substring(colonIdx + 1)
  }

  // Machine resolution logic
  if (
    resolvedMachine === 'ia-prod-1GPU' ||
    (cleanModel === 'gemma-4-31b' && resolvedMachine !== 'ia-2GPU')
  ) {
    return {
      machineId: 'ia-prod-1GPU',
      cleanModel: cleanModel || 'gemma-4-31b',
      baseUrl: AI_PROD_1GPU_API_URL,
      apiUrl: `${AI_PROD_1GPU_API_URL}/chat/completions`,
      apiKey: AI_PROD_1GPU_API_KEY,
    }
  }

  return {
    machineId: 'ia-2GPU',
    cleanModel: cleanModel || 'gemma-4-e4b-arasaac',
    baseUrl: AI_2GPU_API_URL,
    apiUrl: `${AI_2GPU_API_URL}/chat/completions`,
    apiKey: AI_2GPU_API_KEY,
  }
}

/**
 * Proxies chat completions to the appropriate backend AI machine using secure server keys.
 */
const chatCompletions = async (req, res) => {
  logger.debug('EXEC chatCompletions aiController')

  const { model, messages, temperature, machineId } = req.body

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Field "messages" must be an array' })
  }

  const target = resolveMachineTarget(model, machineId)

  try {
    const headers = {
      'Content-Type': 'application/json',
    }
    if (target.apiKey) {
      headers['Authorization'] = `Bearer ${target.apiKey}`
    }

    const payload = {
      model: target.cleanModel,
      messages,
      temperature: temperature !== undefined ? temperature : 0.1,
    }

    const response = await fetch(target.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const errorText = await response.text()
      logger.error(
        `AI Machine ${target.machineId} returned HTTP ${response.status}: ${errorText}`,
      )
      return res.status(response.status).json({
        error: `AI gateway error: ${response.statusText}`,
        details: errorText,
      })
    }

    const data = await response.json()
    return res.status(200).json(data)
  } catch (err) {
    logger.error(`Error in chatCompletions proxy: ${err.message}`)
    return res
      .status(502)
      .json({ error: `AI Gateway unreachable: ${err.message}` })
  }
}

/**
 * Checks connectivity and models of all configured AI machines.
 */
const getModels = async (req, res) => {
  logger.debug('EXEC getModels aiController')

  const machines = [
    {
      id: 'ia-prod-1GPU',
      url: `${AI_PROD_1GPU_API_URL}/models`,
      apiKey: AI_PROD_1GPU_API_KEY,
      defaultModels: ['gemma-4-31b'],
    },
    {
      id: 'ia-2GPU',
      url: `${AI_2GPU_API_URL}/models`,
      apiKey: AI_2GPU_API_KEY,
      defaultModels: [
        'gemma-4-31b',
        'gemma-4-12b',
        'gemma-4-e4b',
        'gemma-4-e4b-arasaac',
      ],
    },
  ]

  const status = {}

  await Promise.all(
    machines.map(async (machine) => {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 4000)

        const headers = {}
        if (machine.apiKey) {
          headers['Authorization'] = `Bearer ${machine.apiKey}`
        }

        const response = await fetch(machine.url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        })
        clearTimeout(timeoutId)

        if (response.ok) {
          const data = await response.json()
          const modelList = Array.isArray(data?.data)
            ? data.data.map((m) => m.id)
            : machine.defaultModels
          status[machine.id] = { online: true, models: modelList }
        } else {
          status[machine.id] = {
            online: false,
            error: `HTTP ${response.status}`,
          }
        }
      } catch (err) {
        status[machine.id] = {
          online: false,
          error: err.name === 'AbortError' ? 'Timeout' : err.message,
        }
      }
    }),
  )

  return res.status(200).json(status)
}

/**
 * Internal helper to forward a training record to Supabase.
 */
const forwardTrainingRecord = async ({ req, trainingData }) => {
  const output = trainingData?.llmOutput || trainingData || {}
  const source = output.source || trainingData.source || ''
  const outcome = output.outcome || trainingData.outcome || ''
  const outcomeDev = output.outcomeDev || trainingData.outcomeDev || ''
  const detectedLanguage =
    output.detectedLanguage || trainingData.detectedLanguage || 'es'
  const wordMapping = output.wordMapping || trainingData.wordMapping || []
  const testType =
    trainingData.test_type || trainingData.testType || output.test_type || ''
  const rawResponse = output.raw_response || output

  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_ANON_KEY,
  }

  // Forward authorization header if available
  if (req?.headers?.authorization) {
    headers['Authorization'] = req.headers.authorization
  }

  const response = await fetch(`${SUPABASE_URL}/functions/v1/submit-record`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source,
      outcome,
      outcomeDev,
      detectedLanguage,
      wordMapping,
      test_type: testType,
      raw_response: rawResponse,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Supabase submit-record HTTP ${response.status}: ${errorText}`,
    )
  }

  return await response.json()
}

/**
 * Endpoint to submit phrase training records.
 */
const submitTraining = async (req, res) => {
  logger.debug('EXEC submitTraining aiController')

  try {
    const data = await forwardTrainingRecord({ req, trainingData: req.body })
    return res.status(200).json({ success: true, data })
  } catch (err) {
    logger.error(`Error in submitTraining: ${err.message}`)
    return res.status(500).json({ error: err.message })
  }
}

module.exports = {
  chatCompletions,
  getModels,
  submitTraining,
  forwardTrainingRecord,
  resolveMachineTarget,
}
