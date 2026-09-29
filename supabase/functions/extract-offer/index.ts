// extract-offer — read supplier offers (PDF, photos, WhatsApp screenshots) with Claude and return
// the offer lines as structured JSON (PLAN §10.2). Admin only. Stores nothing.
//
// POST { files: [{ name, media_type, data }] }      data = base64 without the "data:...;base64," prefix
//   -> { lines: [...], model, usage }
//
// Secrets (Edge Functions -> Secrets):
//   ANTHROPIC_API_KEY  required
//   ANTHROPIC_MODEL    optional, default "claude-opus-5" (change without a code edit)
//   LV_SECRET_KEY      optional, like admin-users
// Deploy with JWT verification OFF; the caller is checked here with auth.getUser().
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('LV_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MODEL = Deno.env.get('ANTHROPIC_MODEL') || 'claude-opus-5';
const MAX_FILES = 10;
const MAX_TOTAL_BASE64 = 28 * 1024 * 1024;          // ~21 MB of files; the API request limit is 32 MB
const MEDIA_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (message: string, status = 400) => json({ error: message }, status);

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const anthropic = new Anthropic();   // reads ANTHROPIC_API_KEY from the environment

// One object per offer line. Every field is present; unknown values are null.
const nullable = (type: string) => ({ type: [type, 'null'] });
const LINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lines'],
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['barcode', 'supplier_code', 'description', 'old_price', 'promo_price', 'discount_pct',
                   'pack_note', 'confidence', 'source_file', 'source_page'],
        properties: {
          barcode: nullable('string'),
          supplier_code: nullable('string'),
          description: { type: 'string' },
          old_price: nullable('number'),
          promo_price: nullable('number'),
          discount_pct: nullable('number'),
          pack_note: nullable('string'),
          confidence: { type: 'number' },
          source_file: { type: 'integer' },
          source_page: nullable('integer'),
        },
      },
    },
  },
};

const INSTRUCTIONS = `These files are supplier offers sent to a supermarket in Lebanon (PDF price lists, photos of
printed offers, WhatsApp screenshots). Extract every product line that has an offer or a price.

For each line return:
- barcode: the EAN/UPC barcode exactly as printed, digits only, as text (keep leading zeros). null if none.
- supplier_code: the supplier's own item code or reference, as text. null if none.
- description: the product name as written (brand, product, size).
- old_price: the regular / before price, as a number. null if not shown.
- promo_price: the offer / promotion / net price, as a number. null if not shown.
- discount_pct: the discount percentage as a number (20 for 20%). Only if printed; do not compute it. null otherwise.
- pack_note: free-goods or pack deals such as "5+1", "buy 2 get 1", "carton of 12". null if none.
- confidence: 0 to 1, how sure you are that this line was read correctly (lower it for blurry, cut-off or
  handwritten values).
- source_file: the number of the file the line comes from (File 1, File 2, ...).
- source_page: the page number inside that file for PDFs, 1 for images.

Prices are usually in USD; keep the numbers exactly as printed, without currency symbols. Do not invent lines
or values that are not in the files. If a line lists several barcodes, return one line per barcode.
If the files contain no offer lines, return an empty list.`;

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Method not allowed', 405);

  // 1. Only an active admin.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return fail('Not signed in', 401);
  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) return fail('Not signed in', 401);
  const { data: me } = await admin.from('profiles').select('role, active').eq('id', user.id).maybeSingle();
  if (!me || !me.active || me.role !== 'admin') return fail('Only an admin can import offers', 403);
  if (!Deno.env.get('ANTHROPIC_API_KEY')) return fail('The AI service is not set up yet (ANTHROPIC_API_KEY is missing).', 503);

  // 2. Files.
  let body: { files?: { name?: string; media_type?: string; data?: string }[] };
  try { body = await req.json(); } catch { return fail('Bad request'); }
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) return fail('Choose at least one file.');
  if (files.length > MAX_FILES) return fail(`At most ${MAX_FILES} files at a time.`);
  let total = 0;
  for (const f of files) {
    if (!f.data || !MEDIA_TYPES.includes(String(f.media_type))) return fail(`"${f.name ?? 'file'}" is not a PDF, JPG, PNG or WEBP.`);
    total += f.data.length;
  }
  if (total > MAX_TOTAL_BASE64) return fail('The files are too large together. Send fewer or smaller files at a time.');

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  files.forEach((f, i) => {
    content.push({ type: 'text', text: `File ${i + 1}: ${f.name ?? 'file'}` });
    if (f.media_type === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data! } });
    } else {
      content.push({ type: 'image', source: { type: 'base64', media_type: f.media_type as 'image/jpeg' | 'image/png' | 'image/webp', data: f.data! } });
    }
  });
  content.push({ type: 'text', text: INSTRUCTIONS });

  // 3. Claude. Streaming (long files, many lines); server-side refusal fallback on the default model.
  try {
    const useFallbacks = MODEL === 'claude-opus-5';
    const stream = anthropic.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      output_config: { format: { type: 'json_schema', schema: LINE_SCHEMA } },
      messages: [{ role: 'user', content }],
    } as Anthropic.Beta.MessageCreateParams);
    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') return fail('The AI declined to read these files. Try other files.', 422);
    if (message.stop_reason === 'max_tokens') return fail('Too many lines in one go. Send fewer files at a time.', 422);

    const text = message.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
    let parsed: { lines?: unknown[] };
    try { parsed = JSON.parse(text); } catch { return fail('The AI answer could not be read. Try again.', 502); }
    const lines = (Array.isArray(parsed.lines) ? parsed.lines : []).map((l: Record<string, unknown>) => ({
      barcode: l.barcode == null ? null : String(l.barcode).replace(/\D/g, '') || null,
      supplier_code: l.supplier_code == null ? null : String(l.supplier_code).trim() || null,
      description: String(l.description ?? '').trim(),
      old_price: typeof l.old_price === 'number' ? l.old_price : null,
      promo_price: typeof l.promo_price === 'number' ? l.promo_price : null,
      discount_pct: typeof l.discount_pct === 'number' ? l.discount_pct : null,
      pack_note: l.pack_note == null ? null : String(l.pack_note).trim() || null,
      confidence: typeof l.confidence === 'number' ? Math.max(0, Math.min(1, l.confidence)) : 0,
      source_file: Number.isInteger(l.source_file) ? (l.source_file as number) : null,
      source_page: Number.isInteger(l.source_page) ? (l.source_page as number) : null,
    }));
    return json({ lines, model: message.model, usage: { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens } });
  } catch (e) {
    console.error(e);
    if (e instanceof Anthropic.AuthenticationError) return fail('The AI service key is not valid.', 503);
    if (e instanceof Anthropic.RateLimitError) return fail('The AI service is busy. Try again in a minute.', 429);
    if (e instanceof Anthropic.BadRequestError) return fail('The AI service could not read these files: ' + e.message, 400);
    if (e instanceof Anthropic.APIError) return fail('The AI service had a problem. Try again.', 502);
    return fail('Something went wrong. Try again.', 500);
  }
});
