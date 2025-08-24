// index.js
import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json());

/* ==================== CONFIG ==================== */
const CARTOLA_API = 'https://api.cartola.globo.com';

// Env vars (configure no Railway)
const CARTOLA_BEARER = process.env.CARTOLA_BEARER || '';
const GLB_TOKEN      = process.env.GLB_TOKEN || '';
const DEFAULT_LEAGUE_ID_OR_SLUG = process.env.LIGA_SLUG || '3602462'; // CartoDu

// Cabeçalhos padrão
const baseHeaders = {
  'User-Agent': 'Mozilla/5.0',
  'Accept': 'application/json',
  ...(CARTOLA_BEARER ? { Authorization: `Bearer ${CARTOLA_BEARER}` } : {}),
  ...(GLB_TOKEN ? { 'X-GLB-Token': GLB_TOKEN } : {}),
};

// Cache simples para escalações
const lineupCache = new Map(); // key: timeId, value: { ts, atletas: number[] }
const CACHE_MS = 5 * 60 * 1000;

/* ==================== HELPERS ==================== */
async function getStatus() {
  const url = `${CARTOLA_API}/mercado/status`;
  const { data } = await axios.get(url, { headers: baseHeaders });
  return data;
}

async function getPontuados() {
  const url = `${CARTOLA_API}/atletas/pontuados`;
  const { data } = await axios.get(url, { headers: baseHeaders });
  return data?.atletas || {};
}

// Resolve liga por slug ou id:
// 1) tenta /ligas/{id|slug}
// 2) tenta /liga/{id|slug}
// 3) se foi slug e falhou, usa /ligas?q=slug -> pega o ID -> volta no passo 1
async function getLeagueRaw(leagueIdOrSlug) {
  const tryPlural = () =>
    axios.get(`${CARTOLA_API}/ligas/${leagueIdOrSlug}`, { headers: baseHeaders }).then(r => r.data);
  const trySingular = () =>
    axios.get(`${CARTOLA_API}/liga/${leagueIdOrSlug}`, { headers: baseHeaders }).then(r => r.data);

  // 1 & 2
  try {
    return await tryPlural();
  } catch (_) {
    try {
      return await trySingular();
    } catch (err2) {
      // 3) resolver slug -> id via busca
      const isNumeric = /^\d+$/.test(String(leagueIdOrSlug));
      if (!isNumeric) {
        try {
          const { data: arr } = await axios.get(
            `${CARTOLA_API}/ligas?q=${encodeURIComponent(leagueIdOrSlug)}`,
            { headers: baseHeaders }
          );
          const match =
            Array.isArray(arr) &&
            arr.find(x => (x.slug === leagueIdOrSlug) || (String(x.liga_id) === String(leagueIdOrSlug)));
          if (match?.liga_id) {
            // tenta novamente com o ID
            try {
              return await axios
                .get(`${CARTOLA_API}/ligas/${match.liga_id}`, { headers: baseHeaders })
                .then(r => r.data);
            } catch {
              return await axios
                .get(`${CARTOLA_API}/liga/${match.liga_id}`, { headers: baseHeaders })
                .then(r => r.data);
            }
          }
        } catch {
          /* ignore */
        }
      }
      // propaga o erro original
      throw err2;
    }
  }
}

// Normaliza lista de participantes de diferentes formatos
function extrairParticipantesLiga(ligaJson) {
  const raiz = ligaJson || {};
  const cand =
    raiz.times ||
    raiz.times_participantes ||
    raiz.participantes ||
    (raiz.liga && (raiz.liga.times || raiz.liga.times_participantes)) ||
    [];

  const normalizados = [];
  for (const t of cand) {
    // formatos comuns:
    // t.time.time_id / t.time.nome
    // t.time_id / t.nome_time
    // t.id / t.nome
    const timeObj = t?.time || t;
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

    if (time_id) normalizados.push({ time_id, nome, raw: t });
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

/* ==================== ROTAS ==================== */
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    hasBearer: Boolean(CARTOLA_BEARER),
    hasGlbToken: Boolean(GLB_TOKEN),
    defaultLeague: DEFAULT_LEAGUE_ID_OR_SLUG,
  });
});

app.get('/debug/auth', (_req, res) => {
  res.json({
    ok: true,
    hasBearer: Boolean(CARTOLA_BEARER),
    bearerPrefix: CARTOLA_BEARER ? CARTOLA_BEARER.slice(0, 20) + '…' : null,
    hasGlbToken: Boolean(GLB_TOKEN),
  });
});

app.get('/status', async (_req, res) => {
  try {
    const s = await getStatus();
    res.json(s);
  } catch (e) {
    const status = e?.response?.status || 500;
    const data = e?.response?.data || { message: e.message };
    console.error('STATUS FAIL', status, data);
    res.status(500).json({ error: 'Falha ao obter status do jogo.', status, data });
  }
});

// Inspecionar a liga padrão (bruto)
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

// /live -> usa LIGA_SLUG/ID do ambiente
app.get('/live', async (_req, res) => {
  await liveForLeague(DEFAULT_LEAGUE_ID_OR_SLUG, res);
});

// /live/:leagueId -> aceita ID ou slug
app.get('/live/:leagueId', async (req, res) => {
  await liveForLeague(req.params.leagueId, res);
});

async function liveForLeague(leagueIdOrSlug, res) {
  try {
    // 1) Liga e participantes
    const liga = await getLeagueRaw(leagueIdOrSlug);
    const participantes = extrairParticipantesLiga(liga);

    if (!participantes.length) {
      return res.status(404).json({
        error: 'Liga encontrada, mas sem participantes visíveis.',
        dica: 'Se for liga privada, é preciso Bearer válido com acesso à liga.',
      });
    }

    // 2) Pontuados
    const pontuados = await getPontuados();

    // 3) Busca escalações e soma parciais em paralelo
    const resultados = await Promise.all(
      participantes.map(async (p) => {
        const atletas = await getTimeLineup(p.time_id);
        const total = atletas.reduce((acc, id) => {
          const reg = pontuados[String(id)];
          return acc + (reg && typeof reg.pontuacao === 'number' ? reg.pontuacao : 0);
        }, 0);
        return {
          time_id: p.time_id,
          nome: p.nome,
          parcial: Number(total.toFixed(2)),
        };
      })
    );

    resultados.sort((a, b) => b.parcial - a.parcial);

    res.json({
      liga: {
        id: liga?.liga_id || liga?.liga?.liga_id || leagueIdOrSlug,
        nome: liga?.nome || liga?.liga?.nome || liga?.slug || String(leagueIdOrSlug),
        slug: liga?.slug || liga?.liga?.slug || null,
      },
      atualizacao: new Date().toISOString(),
      resultados,
    });
  } catch (e) {
    const status = e?.response?.status || 500;
    const data = e?.response?.data || { message: e.message };
    console.error('LIVE FAIL', status, data);
    res.status(500).json({
      error: 'Falha ao calcular parciais da liga.',
      status,
      data,
      dica: !CARTOLA_BEARER
        ? 'Defina CARTOLA_BEARER no Railway. Sem ele, endpoints de liga costumam negar acesso.'
        : undefined,
    });
  }
}

/* ==================== START ==================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Cartola Proxy online na porta ${PORT}`);
  if (!CARTOLA_BEARER) {
    console.log('Aviso: Sem CARTOLA_BEARER. Endpoints de liga podem exigir autenticação.');
  }
});
