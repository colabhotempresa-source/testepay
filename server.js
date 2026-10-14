import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(express.json({ limit: '1mb' }));

// Configure secrets through environment variables; never commit credentials.
const CONFIG = {
  baseUrl: (process.env.SIGILOPAY_BASE_URL || 'https://api.sigilopay.com.br').replace(/\/+$/, ''),
  clientId: process.env.SIGILOPAY_CLIENT_ID || '',
  clientSecret: process.env.SIGILOPAY_CLIENT_SECRET || '',
  pixCreatePath: process.env.SIGILOPAY_PIX_PATH || '/v1/pix/charge',
  pixStatusPath: process.env.SIGILOPAY_STATUS_PATH || '/v1/pix/charge',
  authMode: process.env.SIGILOPAY_AUTH_MODE || 'basic'
};

function buildHeaders() {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (CONFIG.authMode === 'basic') {
    if (!CONFIG.clientId || !CONFIG.clientSecret) throw new Error('Configure SIGILOPAY_CLIENT_ID e SIGILOPAY_CLIENT_SECRET nas variáveis de ambiente.');
    headers.Authorization = 'Basic ' + Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString('base64');
  }
  return headers;
}

let cachedToken = null;
let cachedTokenExp = 0;

async function getBearerToken() {
  if (cachedToken && Date.now() < cachedTokenExp) return cachedToken;
  if (!CONFIG.clientId || !CONFIG.clientSecret) throw new Error('Configure as credenciais SigiloPay nas variáveis de ambiente.');
  const response = await fetch(`${CONFIG.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret
    })
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`Falha ao obter token (${response.status}): ${JSON.stringify(data)}`);
  cachedToken = data.access_token || data.token;
  if (!cachedToken) throw new Error('Resposta OAuth não contém access_token/token.');
  cachedTokenExp = Date.now() + (Math.max(60, Number(data.expires_in || 3600) - 60) * 1000);
  return cachedToken;
}

async function authHeaders() {
  const headers = buildHeaders();
  if (CONFIG.authMode === 'bearer') {
    headers.Authorization = `Bearer ${await getBearerToken()}`;
  } else if (CONFIG.authMode !== 'basic' && CONFIG.authMode !== 'none') {
    throw new Error('SIGILOPAY_AUTH_MODE deve ser basic, bearer ou none.');
  }
  return headers;
}

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/debug', async (_req, res) => {
  const out = { baseUrl: CONFIG.baseUrl, authMode: CONFIG.authMode, tests: [] };
  try {
    const response = await fetch(`${CONFIG.baseUrl}/`, { headers: await authHeaders() });
    out.tests.push({ step: 'root', status: response.status, body: (await response.text()).slice(0, 400) });
  } catch (error) {
    out.tests.push({ step: 'root', error: String(error) });
  }
  res.json(out);
});

// Generic proxy. Restrict methods and paths to reduce SSRF/abuse risk.
app.post('/api/sigilopay', async (req, res) => {
  try {
    const { method = 'GET', path: apiPath, body } = req.body || {};
    const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    if (typeof apiPath !== 'string' || !apiPath.startsWith('/') || apiPath.startsWith('//') || apiPath.includes('://')) {
      return res.status(400).json({ error: 'path inválido' });
    }
    if (!allowedMethods.has(String(method).toUpperCase())) {
      return res.status(400).json({ error: 'method inválido' });
    }
    const url = new URL(apiPath, CONFIG.baseUrl);
    if (url.origin !== new URL(CONFIG.baseUrl).origin) return res.status(400).json({ error: 'destino inválido' });

    const upstream = await fetch(url, {
      method: String(method).toUpperCase(),
      headers: await authHeaders(),
      body: ['GET', 'HEAD'].includes(String(method).toUpperCase()) ? undefined : JSON.stringify(body ?? {})
    });
    const raw = await upstream.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }
    return res.status(upstream.status).json(data);
  } catch (error) {
    console.error('[/api/sigilopay]', error);
    return res.status(502).json({ error: 'Proxy error', detail: String(error) });
  }
});

app.post('/api/pix/create', async (req, res) => {
  try {
    const { amount, description, client, identifier } = req.body || {};
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0 || !client?.name || !client?.document) {
      return res.status(400).json({ error: 'Dados incompletos ou inválidos (amount positivo, client.name e client.document são obrigatórios).' });
    }

    const payload = {
      identifier: identifier || `ID_${Date.now()}`,
      amount: numericAmount,
      description: description || 'Compra',
      payment_method: 'pix',
      customer: {
        name: client.name,
        ...(client.email ? { email: client.email } : {}),
        document: client.document,
        ...(client.phone ? { phone: client.phone } : {})
      }
    };

    const url = new URL(CONFIG.pixCreatePath, CONFIG.baseUrl);
    if (url.origin !== new URL(CONFIG.baseUrl).origin) {
      return res.status(400).json({ error: 'SIGILOPAY_PIX_PATH inválido.' });
    }
    const upstream = await fetch(url, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(payload)
    });
    const raw = await upstream.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: 'SigiloPay recusou a requisição',
        status: upstream.status,
        sent_to: url.toString(),
        response: data
      });
    }

    const root = data?.data || data;
    const qrBase64 = root.qr_code_image || root.qrCodeImage || root.qr_code_base64 ||
      root.qrCodeBase64 || root.qr_code || root.qrCode || null;
    const copyPaste = root.pix_copia_e_cola || root.pixCopiaECola || root.qr_code_text ||
      root.emv || root.payload || root.copy_paste || null;

    return res.json({
      ok: true,
      transactionId: root.transactionId || root.id || root.txid || root.identifier || null,
      qrBase64,
      copyPaste,
      raw: data
    });
  } catch (error) {
    console.error('[/api/pix/create]', error);
    return res.status(502).json({ error: 'Erro ao criar PIX', detail: String(error) });
  }
});

app.get('/api/pix/status/:id', async (req, res) => {
  try {
    const basePath = CONFIG.pixStatusPath.replace(/\/+$/, '');
    const url = new URL(`${basePath}/${encodeURIComponent(req.params.id)}`, CONFIG.baseUrl);
    if (url.origin !== new URL(CONFIG.baseUrl).origin) return res.status(400).json({ error: 'SIGILOPAY_STATUS_PATH inválido.' });
    const upstream = await fetch(url, { headers: await authHeaders() });
    const raw = await upstream.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }
    return res.status(upstream.status).json(data);
  } catch (error) {
    return res.status(502).json({ error: String(error) });
  }
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SigiloPay integration running on port ${PORT}`));
