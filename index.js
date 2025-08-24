// index.js
import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json());

/**
 * CONFIG
 */
const CARTOLA_API = 'https://api.cartola.globo.com';

// Autenticação (opcional, mas necessário p/ endpoints de ligas na maioria dos casos):
// - CARTOLA_BEARER: token Bearer ("Authorization: Bearer <token>")
// - GLB_TOKEN:      alguns endpoints/kernels aceitam "X-GLB-Token"
const CARTOLA_BEARER = process.env.CARTOLA_BEARER || '';
const GLB_TOKEN = process.env.GLB_TOKEN || '';

// Liga padrão (CartoDu)
const DEFAULT_LEAGUE_ID_OR_SLUG = '3602462'; // <- ID da Liga CartoDu

// Cabeçalhos padrão
const baseHeaders = {
  'User-Agent': 'Mozilla/5.0',
  'Accept': 'application/json',
  ...(CARTOLA_BEARER ? { 'Authorization': `Bearer ${CARTOLA_BEARER}` } : {}),
  ...(GLB_TOKEN ? { 'X-GLB-Token': GLB_TOKEN } : {}),
};

// Cache simples para escalação por time
const lineupCache = new Map(); // key: timeId, value: { ts, atletas: number[] }
const CACHE_MS = 5 * 60 * 1000;

/**
 * Helpers
 */
async function getStatus() {
  const url = `${CARTOLA_API}/mercado/status`;
  const { data } = await axios.get(url, { headers: baseHeaders });
  return data;
}

async function getPontuados() {
  // funciona apenas com mercado FECHADO / bola rolando
  const url = `${CARTOLA_API}/atletas/pontuados`;
  const { data } = await axios.get(url, { headers: baseHeaders });
  return data?.atletas || {};
}

async function getLeagueRaw(leagueIdOrSlug) {
  // Normalmente /ligas/{id_ou_slug} (plural) é o canônico
  const urlPlural = `${CARTOLA_API}/ligas/${leagueIdOrSlug}`;
  try {
    const { data } = await axios.get(urlPlural, { headers: baseHeaders });
    return data;
  } catch (err) {
    // Tenta o singular como fallback (algumas versões históricas usavam /liga/…)
    const urlSingular = `${CARTOLA_API}/liga/${leagueIdOrSlug}`;
    const { data } = await axios.get(urlSingular, { headers: baseHeaders });
    return data;
  }
}

/**
 * Extração de participantes da liga, lidando com variações de estrutura
 */
function extrairParticipantesLiga(ligaJson) {
  // Possíveis formatos observados em temporadas diferentes:
  // - { times: [...] }
  // - { times_participantes: [...] }
  // - { liga: { times: [...] } }
  // - { liga: { times_participantes: [...] } }
  // - { participantes: [...] } (mais raro)
  const raiz = ligaJson || {};
  const cand =
    raiz.times ||
    raiz.times_participantes ||
    raiz.participantes ||
    (raiz.liga && (raiz.liga.times || raiz.liga.times_participantes)) ||
    [];

  // Normaliza para objetos com pelo menos time_id e nome
  const normalizados = [];
  for (const t of cand) {
    const timeObj = t?.time || t; // alguns vêm aninhado em { time: { … } }
    const time_id =
      timeObj?.time_id ??
      timeObj?.id ??
      t?.time_id ??
      null;

    const nome =
      timeObj?.nome ??
      timeObj?.nome_time ??
      t?.nome ??
      t?.nome_time ??
      'Time';

    if (time_id) {
      normalizados.push({ time_id, nome, raw: t });
    }
  }
  return normalizados;
}

async function getTimeLineup(timeId) {
  const now = Date.now();
  const cached = lineupCache.get(timeId);
  if (cached && (now - cached.ts) < CACHE_MS) return cached.atletas;

  const url = `${CARTOLA_API}/time/id/${timeId}`;
  const { data } = await axios.get(url, { headers: baseHeaders });
  const atletas = (data?.atletas || []).map(a => a.atleta_id);
  lineupCache.set(timeId, { ts: now, atletas });
  return atletas;
}

/**
 * ROTAS
 */
app.get('/health', (_req, res) => {
  res.json({ ok: true, hasBearer: !!CARTOLA_BEARER, hasGlbToken: !!GLB_TOKEN });
});

app.get('/status', async (_req, res) => {
  try {
    const s = await getStatus();
    res.json(s);
  } catch (e) {
    console.error('STATUS FAIL', e?.response?.status, e?.response?.data || e.message);
    res.status(500).json({ error: 'Falha ao obter status do jogo.' });
  }
});

// Debug: traz a liga padrão bruta (para inspecionar campos/participantes)
// Útil para checar se sua autenticação está funcionando.
app.get('/debug/league', async (_req, res) => {
  try {
    const liga = await getLeagueRaw(DEFAULT_LEAGUE_ID_OR_SLUG);
    res.json(liga);
  } catch (e) {
    const status = e?.response?.status || 500;
    const data = e?.response?.data || { message: e.message };
    console.error('LEAGUE DEBUG FAIL', status, data);
    res.status(500).json({ error: 'LEAGUE DEBUG FAIL', status, data });
  }
});

// /live -> usa a liga CartoDu fixa (3602462)
app.get('/live', async (_req, res) => {
  await liveForLeague(DEFAULT_LEAGUE_ID_OR_SLUG, res);
});

// /live/:leagueId -> aceita ID ou slug (sobrepõe a fixa)
app.get('/live/:leagueId', async (req, res) => {
  const leagueId = req.params.leagueId;
  await liveForLeague(leagueId, res);
});

async function liveForLeague(leagueIdOrSlug, res) {
  try {
    // 1) Liga (participantes)
    const liga = await getLeagueRaw(leagueIdOrSlug);
    const participantes = extrairParticipantesLiga(liga);

    if (!participantes.length) {
      return res.status(404).json({
        error: 'Liga encontrada, mas sem participantes visíveis.',
        dica: 'Verifique se a liga exige autenticação ou se sua conta tem acesso.',
      });
    }

    // 2) Pontuados
    const pontuados = await getPontuados();

    // 3) Soma parciais por time da liga
    const resultados = [];
    for (const p of participantes) {
      const atletas = await getTimeLineup(p.time_id);
      let total = 0;
      for (const id of atletas) {
        const reg = pontuados[String(id)];
        if (reg && typeof reg.pontuacao === 'number') total += reg.pontuacao;
      }
      resultados.push({
        time_id: p.time_id,
        nome: p.nome,
        parcial: Number(total.toFixed(2)),
      });
    }

    resultados.sort((a, b) => b.parcial - a.parcial);

    res.json({
      liga: {
        id: liga?.liga_id || liga?.liga?.liga_id || leagueIdOrSlug,
        nome: liga?.nome || liga?.liga?.nome || liga?.slug || leagueIdOrSlug,
        slug: liga?.slug || liga?.liga?.slug || null,
      },
      atualizacao: new Date().toISOString(),
      resultados,
    });
  } catch (e) {
    const status = e?.response?.status || 500;
    const data = e?.response?.data || { message: e.message };
    console.error('LIVE FAIL', status, data);
    // Erro clássico sem Bearer: { mensagem: "Usuário não autorizado" }
    res.status(500).json({
      error: 'Falha ao calcular parciais da liga.',
      status,
      data,
      dica: !CARTOLA_BEARER
        ? 'Parece que você está sem token. Defina CARTOLA_BEARER no Railway (Environment).'
        : undefined,
    });
  }
}

/**
 * START
 */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Cartola Proxy online na porta ${PORT}`);
  if (!CARTOLA_BEARER) {
    console.log('Aviso: Sem CARTOLA_BEARER. Endpoints de liga podem exigir autenticação.');
  }
});
