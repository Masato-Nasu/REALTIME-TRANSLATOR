const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(init.headers || {}),
    },
  });

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return json({
        status: 'ok',
        service: 'realtime-translator-worker',
        mode: 'byok',
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === '/api/config' && request.method === 'GET') {
      return json({
        provider: 'openai',
        model: 'gpt-realtime-translate',
        byok: true,
        message: 'Enter your own OpenAI API key in the app to create a realtime translation session.',
      });
    }

    if (url.pathname === '/api/realtime/session' && request.method === 'POST') {
      let body;

      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON body.' }, { status: 400 });
      }

      const targetLanguage = body?.targetLanguage || 'en';
      const apiKey = String(body?.apiKey || '').trim();

      if (!['en', 'ja'].includes(targetLanguage)) {
        return json({ error: 'Unsupported target language.' }, { status: 400 });
      }

      if (!apiKey) {
        return json({ error: 'OpenAI API key is required.' }, { status: 400 });
      }

      try {
        const response = await fetch(
          'https://api.openai.com/v1/realtime/translations/client_secrets',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
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
          }
        );

        const data = await response.json();

        if (!response.ok) {
          return json(
            {
              error:
                data?.error?.message ||
                'Failed to create the OpenAI realtime session.',
            },
            { status: response.status }
          );
        }

        const clientSecret = data?.value || null;

        if (!clientSecret) {
          return json(
            { error: 'OpenAI did not return a client secret.' },
            { status: 502 }
          );
        }

        return json({ clientSecret });
      } catch (error) {
        return json(
          {
            error: 'Failed to create the OpenAI realtime session.',
            details: error?.message || 'Unknown error',
          },
          { status: 500 }
        );
      }
    }

    return json({ error: 'Not found.' }, { status: 404 });
  },
};
