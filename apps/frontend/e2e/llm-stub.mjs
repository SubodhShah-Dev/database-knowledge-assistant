import { createServer } from 'node:http';

const port = Number(process.env.LLM_STUB_PORT || 4010);

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function lastUserMessage(messages) {
  return [...messages].reverse().find(message => message.role === 'user')?.content ?? '';
}

function questionFrom(messages) {
  const content = lastUserMessage(messages);
  const match = /QUESTION:\s*([\s\S]*?)(?:\n\n|$)/.exec(content);
  return (match?.[1] ?? content).trim();
}

function planFor(question) {
  if (/column|schema|relationship/i.test(question)) {
    return { mode: 'schema', focus: 'public.orders' };
  }
  return {
    mode: 'data',
    query: 'SELECT COUNT(*)::int AS order_count FROM public.orders'
  };
}

function answerFor(messages) {
  const content = lastUserMessage(messages);
  if (content.includes('SCHEMA METADATA:')) {
    return 'The **orders** table has 5 columns: id, customer_id, status, ordered_at, and total.';
  }
  if (content.includes('ROWS:')) {
    return 'There are **8 orders** in the demo database.';
  }
  return 'I can answer that from the selected tables.';
}

function streamAnswer(res, answer) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  const chunks = answer.match(/.{1,14}/g) ?? [answer];
  let index = 0;

  const timer = setInterval(() => {
    if (index >= chunks.length) {
      clearInterval(timer);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: chunks[index] } }] })}\n\n`
    );
    index += 1;
  }, 10);

  res.on('close', () => clearInterval(timer));
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    return sendJson(res, 404, { error: 'Not found.' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON.' });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];

  if (body.stream) {
    return streamAnswer(res, answerFor(messages));
  }

  const content = JSON.stringify(planFor(questionFrom(messages)));
  return sendJson(res, 200, {
    id: 'e2e-stub',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }
    ]
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`E2E LLM stub listening on http://127.0.0.1:${port}`);
});
