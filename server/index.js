import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3001);
const isProduction = process.env.NODE_ENV === 'production';

if (!isProduction) {
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
}

app.use(express.json({ limit: '16kb' }));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'realtime-translator-server',
    mode: 'byok',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    provider: 'openai',
    model: 'gpt-realtime-translate',
    byok: true,
    message: 'Enter your own OpenAI API key in the app to create a realtime translation session.',
  });
});

app.post('/api/realtime/session', async (req, res) => {
  const targetLanguage = req.body?.targetLanguage || 'en';
  const apiKey = String(req.body?.apiKey || '').trim();

  if (!['en', 'ja'].includes(targetLanguage)) {
    res.status(400).json({
      error: 'Unsupported target language.',
    });
    return;
  }

  if (!apiKey) {
    res.status(400).json({
      error: 'OpenAI API key is required.',
    });
    return;
  }

  try {
    const response = await fetch('https://api.openai.com/v1/realtime/translations/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          model: 'gpt-realtime-translate',
          instructions:
            'Translate only the words and meaning actually spoken by the speaker. Never add filler words, hesitation sounds, discourse markers, greetings, explanations, or other content that was not present in the source audio. Do not embellish or paraphrase unnecessarily. If the speaker says a single word or a very short phrase, output only its direct natural translation. Preserve the speaker\'s intended meaning as faithfully and concisely as possible.',
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
      console.error('OpenAI Translation client secret request rejected:', {
        status: response.status,
        message: openaiError.message || 'Unknown OpenAI error',
        param: openaiError.param ?? null,
      });

      res.status(response.status).json({
        error: openaiError.message || 'Failed to create the OpenAI realtime session.',
      });
      return;
    }

    const clientSecret = data?.value || null;

    if (!clientSecret) {
      throw new Error('OpenAI did not return a client secret for the realtime session.');
    }

    res.set('Cache-Control', 'no-store');
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

if (isProduction) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const distPath = path.resolve(__dirname, '../dist');

  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
  console.log('Realtime Translator running in BYOK mode.');
});
