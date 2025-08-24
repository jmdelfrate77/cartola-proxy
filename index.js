// index.js
import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json());

const CARTOLA_API = 'https://api.cartolafc.globo.com';
const GLB_TOKEN = process.env.GLB_TOKEN || ''; // cole no Railway → Variables

// monta headers (usa Authorization: Bearer ...)
function buildHeaders() {
  const h = {
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json',
  };
  if (GLB_TOKEN) h['Authorization'] = `Bearer ${GLB_TOKEN}`;
  return h;
}

// cache simples do lineup por time_id
const lineupCache = new Map(); // { timeId: { ts, atletas: number[] } }
const CACHE_MS = 5 * 60 * 1000;

// -------- helpers de API --------
async function getStatus() {
  const url = `${CARTOLA_API}/mercado/status`;
  const { data } = await axios.get(url, { headers: buildHeaders() });
  return data;
}

async function getPontuados() {
  const url = `${CARTOLA_API}/atletas/pontuados`;
  const { data } = await axios.get(url, { headers: buildHeaders() });
  return data?.atletas || {};
}

// Liga pode estar em /ligas/:slug (plural) ou /liga/:slug (singular).
// Tentamos ambos e retornamos o que vier primeiro.
async function getLeague(leagueIdOrSlug) {
  const headers = buildHeaders();

  // 1) plural
  try {
    const { data } = await axios.get(`${CARTOLA_API}/ligas/${leagueIdOrSlug}`, { headers });
    return { data, tried: { plural: true, singular: false } };
  } catch (_) {}

  // 2) singular
  try {
    const { data } = await axios.get(`${CARTOLA_API}/liga/${leagueIdOrSlug}`, { headers });
    return { data, tried: { plural: false, singular: true } };
  } catch (e) {
    const status = e?.response?.status || 500;
    const body = e?.response?.data || e.message;
    throw { status, data: body, tried: { plural: true, singular: true } };
  }
}

async function getTimeLineup(timeId) {
  const now = Date.now();
  const cached = lineupCache.get(timeId);
  if (cached && (now - cached.ts) < CACHE_MS) return cached.atletas;

  const url = `${CARTOLA_API}/time/id/${timeId}`;
  const { data } = await axios.get(url, { headers: buildHeaders() });

  // estruturas variam por temporada; tentamos mapear de forma defensiva
  const atletasArr = Array.isArray(data?.atletas) ? data.atletas : [];
  const atletas = atletasArr
    .map(a => a?.atleta_id)
    .filter(id => typeof id === 'number');

  lineupCache.set(timeId, { ts: now, atletas });
  return atletas;
}

// -------- rotas --------
app.get('/health', (_, res) => res.json({ ok: true }));

app.get('/status', async (_, res) => {
  try {
    const st = await getStatus();
    res.json(st);
  } catch (e) {
    res.status(500).json({ error: 'Falha ao obter status.' });
  }
});

// debug: ver se o token está presente
app.get('/debug/token', (_, res) => {
  res.json({ hasToken: Boolean(GLB_TOKEN) });
});

// debug: tentar obter liga e mostrar em qual endpoint funcionou
app.get('/debug/league/:slug', async (req, res) => {
  try {
    const { data, tried } = await getLeague(req.params.slug);
    res.json({ ok: true, tried, keys: Object.keys(data || {}) });
  } catch (e) {
    res.status(e.status || 500).json({
      error: 'LEAGUE DEBUG FAIL',
      status: e.status || 500,
      data: e.data || null,
      tried: e.tried || null,
    });
  }
});

// live de uma liga (parciais) — mercado precisa estar fechado (bola_rolando true)
app.get('/live/:leagueId', async (req, res) => {
  try {
    const leagueId = req.params.leagueId;

    // status p/ saber se o mercado está fechado / bola_rolando
    const status = await getStatus();
    const bolaRolando = Boolean(status?.bola_rolando);

    // pega dados da liga
    const { data: liga } = await getLeague(leagueId);

    // possíveis campos onde vêm os times/participantes
    const participantes =
      liga?.times ||
      liga?.times_participantes ||
      liga?.timesParticipantes ||
      [];

    if (!Array.isArray(participantes) || participantes.length === 0) {
      return res.status(404).json({ error: 'Liga sem participantes encontrada.' });
    }

    // se não estiver rolando, ainda retornamos a estrutura, mas sem pontuação
    let pontuados = {};
    if (bolaRolando) {
      pontuados = await getPontuados(); // { "123456": { pontuacao: 5.2, ... }, ... }
    }

    const resultados = [];
    for (const t of participantes) {
      // tentamos ler de formas diferentes (dependendo de como a API devolve)
      const timeId = t?.time_id || t?.time?.time_id || t?.timeId || t?.time?.id;
      const nomeTime = t?.nome || t?.time?.nome || t?.nome_time || t?.timeName || 'Time';
      if (!timeId) continue;

      const atletas = await getTimeLineup(timeId);
      let total = 0;
      if (bolaRolando) {
        for (const id of atletas) {
          const p = pontuados[String(id)];
          if (p && typeof p.pontuacao === 'number') total += p.pontuacao;
        }
      }

      resultados.push({
        time_id: timeId,
        nome: nomeTime,
        parcial: Number(total.toFixed(2)),
      });
    }

    resultados.sort((a, b) => b.parcial - a.parcial);

    res.json({
      liga: liga?.liga || liga?.time || { id_ou_slug: leagueId },
      rodada_atual: status?.rodada_atual,
      bola_rolando: bolaRolando,
      atualizacao: new Date().toISOString(),
      resultados,
    });
  } catch (e) {
    console.error('LIVE ERROR:', e?.response?.status, e?.response?.data || e.message);
    res.status(500).json({ error: 'Falha ao obter parciais da liga.' });
  }
});

// raiz
app.get('/', (_, res) => {
  res.send('Cartola Proxy está de pé. Use /health, /status, /debug/token, /debug/league/:slug, /live/:liga');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Proxy Cartola rodando na porta ${PORT}`));
