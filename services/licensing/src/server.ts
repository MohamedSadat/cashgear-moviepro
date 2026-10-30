import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Licensing } from './licensing.ts';

// The licence server's HTTP side: POST activate, refresh and deactivate with a
// JSON body, and GET health. Routes match the path's last segment, so the server
// may sit under a prefix. Apps call it from a browser or a webview, so every
// answer allows any origin: the API takes no cookies and answers only to keys.
// It speaks plain HTTP; the host in front of it ends TLS.

const MAX_BODY = 4096;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

function send(response: ServerResponse, status: number, body?: object) {
  response.writeHead(status, {
    ...CORS,
    'Cache-Control': 'no-store',
    ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
  });
  response.end(body ? JSON.stringify(body) : undefined);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function createLicenceServer(
  licensing: Licensing,
  info: { publicKey: string; log?: (line: string) => void },
): Server {
  return createServer(async (request, response) => {
    const route = new URL(request.url ?? '/', 'http://server').pathname.split('/').pop();
    try {
      if (request.method === 'OPTIONS') return send(response, 204);
      if (request.method === 'GET' && route === 'health') {
        return send(response, 200, { ok: true, publicKey: info.publicKey });
      }
      if (route !== 'activate' && route !== 'refresh' && route !== 'deactivate') {
        return send(response, 404, { error: 'Not found.' });
      }
      if (request.method !== 'POST') return send(response, 405, { error: 'Use POST.' });
      const body = await readBody(request);
      if (!body) {
        return send(response, 400, {
          error: 'The request is not valid.',
          code: 'bad-request',
          revoked: false,
        });
      }
      const answer =
        route === 'activate'
          ? await licensing.activate(body)
          : route === 'refresh'
            ? await licensing.refresh(body)
            : await licensing.deactivate(body);
      if ('status' in answer) {
        const { status, ...refusal } = answer;
        info.log?.(`${route} refused: ${refusal.code}`);
        return send(response, status, refusal);
      }
      return send(response, 200, answer);
    } catch (error) {
      info.log?.(`${route} failed: ${(error as Error).stack ?? error}`);
      if (!response.headersSent) send(response, 500, { error: 'The licence server failed.' });
    }
  });
}
