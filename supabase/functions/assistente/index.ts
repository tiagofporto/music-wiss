// Assistente musical do Music Wiss (Supabase Edge Function, Deno).
//
// Recebe um resumo da partitura (texto com os eventos numerados) e devolve, em JSON:
//   - "harmonizar": cifras sugeridas para eventos da melodia
//   - "revisar": problemas encontrados (extensão do instrumento, compassos, condução)
//
// A chave da API fica só no servidor (segredo ANTHROPIC_API_KEY). A função exige
// login (JWT do Supabase verificado pela plataforma), então só usuários do app a usam.

import Anthropic from 'npm:@anthropic-ai/sdk@1.1.0';

const client = new Anthropic(); // lê ANTHROPIC_API_KEY do ambiente

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'chords', 'issues'],
  properties: {
    summary: { type: 'string', description: 'Resposta curta em português do Brasil para o músico.' },
    chords: {
      type: 'array',
      description: 'Cifras sugeridas (só na tarefa harmonizar; senão, lista vazia).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'symbol'],
        properties: {
          index: { type: 'integer', description: 'Número do evento (#n) que recebe a cifra.' },
          symbol: { type: 'string', description: 'Cifra em notação americana, ex.: C, Am7, G/B, F#m7b5.' },
        },
      },
    },
    issues: {
      type: 'array',
      description: 'Problemas encontrados (só na tarefa revisar; senão, lista vazia).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['measure', 'message'],
        properties: {
          measure: { type: 'integer', description: 'Número do compasso (1 = primeiro).' },
          message: { type: 'string' },
        },
      },
    },
  },
};

const SYSTEM = `Você é o assistente musical do Music Wiss, um editor de partituras.
Responda sempre em português do Brasil, de forma curta e prática.
A partitura chega como texto: cada compasso numerado, e cada evento como "#n nota(s) figura", com a armadura e a fórmula de compasso.
Tarefa "harmonizar": sugira cifras para a voz indicada, normalmente uma por tempo forte ou por mudança de harmonia, coerentes com a tonalidade e com o estilo pedido. Use só índices (#n) que existem. No summary, explique a ideia harmônica em uma ou duas frases.
Tarefa "revisar": aponte notas fora da extensão confortável do instrumento, saltos difíceis, compassos incompletos, quintas/oitavas paralelas evidentes e grafias estranhas (ex.: Mi# onde Fá seria mais simples). Se estiver tudo bem, diga isso no summary e deixe issues vazio.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  let body: { task?: string; score?: string; style?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'JSON inválido' }, 400);
  }
  const task = body.task === 'revisar' ? 'revisar' : body.task === 'harmonizar' ? 'harmonizar' : null;
  if (!task || typeof body.score !== 'string' || !body.score.trim()) return json({ error: 'Envie task e score' }, 400);
  if (body.score.length > 60_000) return json({ error: 'Partitura grande demais para o assistente' }, 413);

  const style = typeof body.style === 'string' ? body.style.slice(0, 200) : '';
  try {
    const params = {
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      // se o modelo recusar por política, a API tenta outro modelo automaticamente
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Tarefa: ${task}${style ? `\nEstilo desejado: ${style}` : ''}\n\nPartitura:\n${body.score}`,
        },
      ],
    };
    // deno-lint-ignore no-explicit-any
    const response = await client.beta.messages.create(params as any);
    if (response.stop_reason === 'refusal') return json({ error: 'O assistente não pôde responder a este pedido.' }, 422);
    if (response.stop_reason === 'max_tokens') return json({ error: 'A resposta ficou longa demais. Tente um trecho menor.' }, 422);
    const text = response.content.find((b: { type: string }) => b.type === 'text') as { text: string } | undefined;
    if (!text) return json({ error: 'Resposta vazia' }, 502);
    return json(JSON.parse(text.text), 200);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: 'Muitos pedidos agora. Tente de novo em instantes.' }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: 'A chave da API do assistente não está configurada.' }, 500);
    if (err instanceof Anthropic.APIError) return json({ error: `Erro no assistente (${err.status})` }, 502);
    return json({ error: 'Erro inesperado no assistente' }, 500);
  }
});

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
