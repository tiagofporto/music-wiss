// Assistente musical do Music Wiss (Supabase Edge Function, Deno).
//
// Recebe um resumo da partitura (texto com os eventos numerados) e devolve, em JSON:
//   - "harmonizar": cifras sugeridas para eventos da melodia
//   - "revisar": problemas encontrados (extensão do instrumento, compassos, condução)
// ou imagens de páginas (PDF/foto) e devolve:
//   - "transcrever": a partitura em texto (o app transforma em partitura editável)
//     e uma análise para edição
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

const INSTRUMENT_IDS = ['piano', 'flute', 'violin', 'voice', 'viola', 'cello', 'trombone', 'clarinet', 'organ', 'trumpet', 'sax-alto', 'bass', 'guitar'];

const TRANSCRIBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'title', 'composer', 'tempo', 'beats', 'beatType', 'keyFifths', 'parts', 'issues', 'suggestions'],
  properties: {
    summary: { type: 'string', description: 'Análise curta em português: tonalidade, forma, caráter, dificuldade e o quanto da página foi possível ler.' },
    title: { type: 'string' },
    composer: { type: 'string' },
    tempo: { type: 'integer', description: 'Semínimas por minuto (estime pela indicação; 96 se não houver).' },
    beats: { type: 'integer' },
    beatType: { type: 'integer' },
    keyFifths: { type: 'integer', description: 'Armadura: sustenidos positivos, bemóis negativos.' },
    parts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'instrument', 'staves'],
        properties: {
          name: { type: 'string' },
          instrument: { type: 'string', enum: INSTRUMENT_IDS },
          staves: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['clef', 'voices'],
              properties: {
                clef: { type: 'string', enum: ['treble', 'bass', 'alto', 'tenor'] },
                voices: { type: 'array', items: { type: 'string' }, description: 'Uma linha por voz, no formato combinado.' },
              },
            },
          },
        },
      },
    },
    issues: {
      type: 'array',
      description: 'Trechos ilegíveis ou duvidosos e possíveis erros da partitura original.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['measure', 'message'],
        properties: { measure: { type: 'integer' }, message: { type: 'string' } },
      },
    },
    suggestions: { type: 'array', items: { type: 'string' }, description: 'Sugestões práticas de edição (até 6).' },
  },
};

const TRANSCRIBE_SYSTEM = `Você é o leitor de partituras do Music Wiss. Recebe fotos ou páginas de PDF de partitura e transcreve o que está escrito, com fidelidade, para um formato de texto. Responda em português do Brasil.

Formato de cada voz (uma string por voz, por pauta):
- compassos separados por " | ", eventos separados por espaço
- nota: letra + acidente + oitava (Dó central = C4): C4, F#4, Bb3, E##5, Abb4
- figura depois de "/": w (semibreve) h (mínima) q (semínima) 8 (colcheia) 16 (semicolcheia) 32 (fusa); pontos com "." ou ".."
- acorde: notas unidas por "+", ex.: C4+E4+G4/h
- pausa: r/q, r/h, r/w ...
- ligadura de prolongamento para a próxima: "~" no fim, ex.: G4/h~
- tercina: 3[C5/8 D5/8 E5/8]
Escreva a altura real escrita (com a armadura aplicada: em Sol maior, um Fá sem acidente na pauta é F#). Cada compasso deve somar exatamente a fórmula de compasso, exceto uma anacruse no primeiro.
Piano/órgão: duas pautas (treble e bass). Se houver mais de uma voz numa pauta (hastes para cima e para baixo), use duas strings.
Não invente: se um trecho estiver ilegível, use pausas e registre em issues. Ignore letra, dinâmicas e cifras.
Se as imagens não forem partitura, devolva parts vazio e explique no summary.`;

const SYSTEM = `Você é o assistente musical do Music Wiss, um editor de partituras.
Responda sempre em português do Brasil, de forma curta e prática.
A partitura chega como texto: cada compasso numerado, e cada evento como "#n nota(s) figura", com a armadura e a fórmula de compasso.
Tarefa "harmonizar": sugira cifras para a voz indicada, normalmente uma por tempo forte ou por mudança de harmonia, coerentes com a tonalidade e com o estilo pedido. Use só índices (#n) que existem. No summary, explique a ideia harmônica em uma ou duas frases.
Tarefa "revisar": aponte notas fora da extensão confortável do instrumento, saltos difíceis, compassos incompletos, quintas/oitavas paralelas evidentes e grafias estranhas (ex.: Mi# onde Fá seria mais simples). Se estiver tudo bem, diga isso no summary e deixe issues vazio.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  let body: { task?: string; score?: string; style?: string; images?: unknown; hint?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'JSON inválido' }, 400);
  }
  if (body.task === 'transcrever') return transcribe(body.images, body.hint);
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

const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64 = 5_000_000; // ~3,7 MB por página

async function transcribe(images: unknown, hint: unknown): Promise<Response> {
  if (!Array.isArray(images) || !images.length) return json({ error: 'Envie as páginas (imagens)' }, 400);
  if (images.length > MAX_IMAGES) return json({ error: `Envie no máximo ${MAX_IMAGES} páginas por vez` }, 413);
  if (images.some((i) => typeof i !== 'string' || !i || i.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(i))) {
    return json({ error: 'Imagem inválida ou grande demais' }, 400);
  }
  const note = typeof hint === 'string' ? hint.slice(0, 300) : '';
  try {
    const params = {
      model: 'claude-opus-5-5',
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema', schema: TRANSCRIBE_SCHEMA } },
      system: TRANSCRIBE_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            ...(images as string[]).map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
            { type: 'text', text: `Transcreva esta partitura${images.length > 1 ? ` (${images.length} páginas, em ordem)` : ''} e analise para edição.${note ? `\nObservação do músico: ${note}` : ''}` },
          ],
        },
      ],
    };
    // resposta longa: em streaming para não estourar o tempo da requisição
    // deno-lint-ignore no-explicit-any
    const response = await client.beta.messages.stream(params as any).finalMessage();
    if (response.stop_reason === 'refusal') return json({ error: 'O assistente não pôde ler estas páginas.' }, 422);
    if (response.stop_reason === 'max_tokens') return json({ error: 'A partitura é longa demais para uma vez. Mande menos páginas.' }, 422);
    const text = response.content.find((b: { type: string }) => b.type === 'text') as { text: string } | undefined;
    if (!text) return json({ error: 'Resposta vazia' }, 502);
    return json(JSON.parse(text.text), 200);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: 'Muitos pedidos agora. Tente de novo em instantes.' }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: 'A chave da API do assistente não está configurada.' }, 500);
    if (err instanceof Anthropic.APIError) return json({ error: `Erro no assistente (${err.status})` }, 502);
    return json({ error: 'Erro inesperado no assistente' }, 500);
  }
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
