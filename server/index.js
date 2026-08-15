import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3001);
const isProduction = process.env.NODE_ENV === 'production';
const openaiApiKey = (process.env.OPENAI_API_KEY || '').trim();
const apiKeyConfigured = Boolean(
  openaiApiKey && openaiApiKey !== 'replace_with_your_key_here'
);

const appUsername = (process.env.APP_USERNAME || '').trim();
const appPassword = (process.env.APP_PASSWORD || '').trim();

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const requireAppAccess = (req, res, next) => {
  if (!isProduction || req.path === '/api/health') {
    next();
    return;
  }

  if (!appUsername || !appPassword) {
    res.status(503).send('App access credentials are not configured.');
    return;
  }

  const authorization = req.headers.authorization || '';

  if (!authorization.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Realtime Translator"');
    res.status(401).send('Authentication required.');
    return;
  }

  try {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    const username = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : '';
    const password = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : '';

    if (safeEqual(username, appUsername) && safeEqual(password, appPassword)) {
      next();
      return;
    }
  } catch {
    // Fall through to the authentication challenge.
  }

  res.set('WWW-Authenticate', 'Basic realm="Realtime Translator"');
  res.status(401).send('Authentication required.');
};

app.use(requireAppAccess);

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
  if (!apiKeyConfigured) {
    console.warn('OPENAI_API_KEY is not set. Realtime translation will be unavailable until it is added to the local environment.');
  }
  if (isProduction && (!appUsername || !appPassword)) {
    console.warn('APP_USERNAME and APP_PASSWORD must be set before the production app can be used.');
  }
});
