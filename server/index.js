import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3001);
const openaiApiKey = (process.env.OPENAI_API_KEY || '').trim();
const apiKeyConfigured = Boolean(
  openaiApiKey && openaiApiKey !== 'replace_with_your_key_here'
);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
  })
);

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'realtime-translator-server',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    provider: apiKeyConfigured ? 'openai' : 'not-configured',
    apiKeyConfigured,
    model: 'gpt-realtime-translate',
    direction: 'ja -> en',
    message: apiKeyConfigured
      ? 'OpenAI realtime translation is ready to use.'
      : 'OPENAI_API_KEY is not set. Add it to the local server environment and restart the app.'
  });
});

app.post('/api/realtime/session', async (req, res) => {
  const targetLanguage = req.body?.targetLanguage || 'en';

  if (!['en', 'ja'].includes(targetLanguage)) {
    res.status(400).json({
      error: 'Unsupported target language.',
    });
    return;
  }

  if (!apiKeyConfigured) {
    res.status(503).json({
      error: 'OPENAI_API_KEY is not configured on the local Node server.',
      guidance: 'Set OPENAI_API_KEY in your .env file and restart the server.'
    });
    return;
  }

  try {
    const response = await fetch('https://api.openai.com/v1/realtime/translations/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          model: 'gpt-realtime-translate',
          audio: {
            output: {
              language: targetLanguage,
            },
          },
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const openaiError = data?.error || {};

      if (response.status >= 400 && response.status < 500) {
        console.error('OpenAI Translation client secret request rejected:', {
          status: response.status,
          message: openaiError.message || 'Unknown OpenAI error',
          param: openaiError.param ?? null,
        });
      }

      res.status(response.status).json({
        error: 'Failed to create the OpenAI realtime session.',
      });
      return;
    }

    const clientSecret = data?.value || null;

    if (!clientSecret) {
      throw new Error('OpenAI did not return a client secret for the realtime session.');
    }

    res.json({
      clientSecret,
    });
  } catch (error) {
    console.error('Failed to create OpenAI realtime session:', error);
    res.status(500).json({
      error: 'Failed to create the OpenAI realtime session.',
      details: error?.message || 'Unknown error',
    });
  }
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
  if (!apiKeyConfigured) {
    console.warn('OPENAI_API_KEY is not set. Realtime translation will be unavailable until it is added to the local environment.');
  }
});
