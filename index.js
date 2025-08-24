import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json());

// ===== CONFIG =====
const CARTOLA_API = 'https://api.cartola.globo.com'; // <- base corrigida
const GLB_TOKEN = process.env.GLB_TOKEN || ''; // opcional (p/ rotas que exigirem login)

const headers = {
  'User-Agent': 'Mozilla/5.0',
  'Accept': 'application/json',
  ...(GLB_TOKEN ? { 'X-GLB-Token': GLB_TOKEN } : {}),
};

// Cache simples p/ escalações
const lineupCache = new Map(); // key: timeId, value: { ts, atletas }
const CACHE_MS = 5 * 60 * 1000; // 5min

// ===== Helpers =====
async function getStatus() {
  const url = `${CARTOLA_API}/status`;
  const { data } = await axios.get(url, { headers });
  return data;
}

async function getLeague(idOrSlug) {
  const url = `${CARTOLA_API}/ligas/${idOrSlug}`;
  const { data } = await axios.get(url, { headers });
  return data; // contém info da liga + lista de participantes (formato varia)
}

async function getPontuados() {
  const url = `${CARTOLA_API}/atletas/pontuados`;
  const { data } = await axios.get(url, { headers });
  return data.atletas || {}; // {"1234": {atleta_id, pontuacao, ...}, ...}
}

async function getTimeLineup(timeId) {
  const now = Date.now();
  const cached = lineupCache.get(timeId);
  if (cached && (now - cached.ts) < CACHE_MS) return cached.atletas;

  const url = `${CARTOLA_API}/time/id/${timeId}`;
  const { data } = await axios.get(url, { headers });

  // Alguns anos a API retorna { atletas: [...] }, em outros outra chave
  const atletas = Array.isArray(data?.atletas)
    ? data.atletas.map(a => a.atleta_id)
    : [];

  lineupCache.set(timeId, { ts: now, atletas });
  return atletas;
}

/**
 * Normaliza os participantes da liga em um array de objetos:
 * { time_id, nome }
 * A API varia entre:
 * - data.times: [{ time_id, nome, ... }]
 * - data.times: [{ time: { time_id, nome, ... } }]
 * - data.times_participantes: idem
 */
function normalizaParticipantesLiga(liga) {
  const candidatos =
    liga?.times ??
    liga?.times_participantes ??
    liga?.times_dono ?? // outros campos que já apareceram
    [];

  const norm = [];
  for (const t of candidatos) {
    if (!t) continue;
    const time_id = t.time_id ?? t?.time?.time_id ?? t?.time?.time_id;
    const nome =
      t.nome ??
      t?.time?.nome ??
      t?.nome_time ??
      t?.time?.nome_cartola ??
      'Time';
    if (time_id) norm.push({ time_id, nome });
  }
  return norm;
}

// ===== Rotas =====
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/status', async (_req, res) => {
  try {
    const st = await getStatus();
    res.json(st);
  } catch (e) {
    console.error('STATUS FAIL', e?.response?.status, e?.response?.data || e.message);
    res.status(500).json({ error: 'STATUS FAIL' });
  }
});

// Debug liga (para inspecionar formato real da sua liga)
app.get('/debug/league/:league', async (req, res) => {
  try {
    const liga = await getLeague(req.params.league);
    res.json(liga);
  } catch (e) {
    console.error('LEAGUE DEBUG FAIL', e?.response?.status, e?.response?.data || e.message);
    res.status(500).json({ error: 'LEAGUE DEBUG FAIL' });
  }
});

// Debug time (para ver se escalação chega sem login)
app.get('/debug/team/:id', async (req, res) => {
  try {
    const url = `${CARTOLA_API}/time/id/${req.params.id}`;
    const { data } = await axios.get(url, { headers });
    res.json(data);
  } catch (e) {
    console.error('TEAM DEBUG FAIL', e?.response?.status, e?.response?.data || e.message);
    res.status(500).json({ error: 'TEAM DEBUG FAIL' });
  }
});

// Live da liga (parciais)
app.get('/live/:league', async (req, res) => {
  const league = req.params.league;
  try {
    const status = await getStatus();
    // 2 = mercado fechado / bola rolando
    if (Number(status?.status_mercado) !== 2) {
      return res.status(503).json({ error: 'Mercado não está fechado/bola não rolando.' });
    }

    const liga = await getLeague(league);
    const participantes = normalizaParticipantesLiga(liga);
    if (!participantes.length) {
      console.error('PARTICIPANTES VAZIO - estrutura inesperada:', Object.keys(liga || {}));
      return res.status(404).json({ error: 'Liga sem participantes visíveis (pode exigir login).' });
    }

    const pontuados = await getPontuados(); // só responde quando bola rolando
    const resultados = [];

    for (const p of participantes) {
      const atletas = await getTimeLineup(p.time_id);
      let total = 0;
      for (const id of atletas) {
        const up = pontuados[String(id)];
        if (up && typeof up.pontuacao === 'number') total += up.pontuacao;
      }
      resultados.push({
        time_id: p.time_id,
        nome: p.nome,
        parcial: Number(total.toFixed(2)),
      });
    }

    resultados.sort((a, b) => b.parcial - a.parcial);

    res.json({
      liga: liga?.liga ?? { id_or_slug: league },
      atualizacao: new Date().toISOString(),
      resultados,
    });
  } catch (e) {
    console.error('LIVE FAIL', e?.response?.status, e?.response?.data || e.message);
    res.status(500).json({ error: 'Falha ao obter parciais da liga.' });
  }
});

// ===== Start =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Proxy Cartola rodando na porta ${PORT}`));
