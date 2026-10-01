// Chamadas à API do GitHub (fetch nativo). Token fine-grained com acesso só ao
// repositório leads-provedores: Actions = leitura e escrita.
import { inflateRawSync } from 'node:zlib';

const API = 'https://api.github.com';
const WORKFLOW = 'raspar.yml';

function repo() {
  return process.env.GITHUB_REPO || 'sgveng3-lang/leads-provedores';
}

async function gh(caminho, opcoes = {}, repositorio = repo()) {
  const resp = await fetch(`${API}/repos/${repositorio}${caminho}`, {
    ...opcoes,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'leads-bot',
      ...(opcoes.headers || {}),
    },
  });
  if (!resp.ok && resp.status !== 204) {
    throw new Error(`GitHub ${opcoes.method || 'GET'} ${caminho}: HTTP ${resp.status}`);
  }
  return resp;
}

export async function disparar({ ufs = 'TODAS', pedido }) {
  await gh(`/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'main', inputs: { ufs, pedido } }),
  });
}

export async function ultimasExecucoes(quantidade = 5, workflow = WORKFLOW, repositorio = repo()) {
  const r = await gh(`/actions/workflows/${workflow}/runs?per_page=${quantidade}`, {}, repositorio);
  return (await r.json()).workflow_runs || [];
}

// ---------- envio de e-mails (workflow enviar.yml) ----------
export const ENVIO = 'enviar.yml';

export async function dispararEnvio({ limite, testePara = '', origem = 'manual' }) {
  await gh(`/actions/workflows/${ENVIO}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'main', inputs: { limite: String(limite), teste_para: testePara, origem } }),
  });
}

// Variáveis do repositório (ENVIO_LIGADO, ENVIO_LIMITE) — token precisa de
// "Variables: Read and write".
export async function lerVariavel(nome, repositorio = repo()) {
  const r = await fetch(`${API}/repos/${repositorio}/actions/variables/${nome}`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'leads-bot' },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub variável ${nome}: HTTP ${r.status}`);
  return (await r.json()).value;
}

export async function gravarVariavel(nome, valor, repositorio = repo()) {
  const atual = await lerVariavel(nome, repositorio);
  if (atual === null) {
    await gh('/actions/variables', { method: 'POST', body: JSON.stringify({ name: nome, value: String(valor) }) }, repositorio);
  } else {
    await gh(`/actions/variables/${nome}`, { method: 'PATCH', body: JSON.stringify({ name: nome, value: String(valor) }) }, repositorio);
  }
}

// O dispatch não devolve o id da execução: procura pelo pedido no título.
export async function acharExecucaoDoPedido(pedido, tentativas = 12) {
  for (let i = 0; i < tentativas; i++) {
    await new Promise((ok) => setTimeout(ok, 5000));
    const run = (await ultimasExecucoes(10)).find((r) => (r.display_title || '').includes(pedido));
    if (run) return run;
  }
  return null;
}

export async function execucao(runId) {
  return (await gh(`/actions/runs/${runId}`)).json();
}

export async function progresso(runId) {
  const jobs = (await (await gh(`/actions/runs/${runId}/jobs?per_page=100`)).json()).jobs || [];
  const ufs = jobs.filter((j) => j.name.startsWith('raspar'));
  return {
    total: ufs.length,
    concluidas: ufs.filter((j) => j.status === 'completed').length,
    falhas: ufs.filter((j) => j.conclusion === 'failure').map((j) => j.name.replace(/^raspar \((\w+)\)$/, '$1')),
  };
}

export async function cancelar(runId) {
  await gh(`/actions/runs/${runId}/cancel`, { method: 'POST' });
}

// Resumo (só contagens) que o job "consolidar" publica como artefato "resumo".
export async function resumo(runId, nome = 'resumo', repositorio = repo()) {
  const arts = (await (await gh(`/actions/runs/${runId}/artifacts?per_page=100`, {}, repositorio)).json()).artifacts || [];
  const art = arts.find((a) => a.name === nome);
  if (!art) return null;
  const zip = Buffer.from(await (await gh(`/actions/artifacts/${art.id}/zip`, {}, repositorio)).arrayBuffer());
  return JSON.parse(primeiroArquivoDoZip(zip).toString('utf8'));
}

// Lê o 1º arquivo de um ZIP pelo diretório central (sem biblioteca de zip).
function primeiroArquivoDoZip(zip) {
  let fim = zip.length - 22;
  while (fim >= 0 && zip.readUInt32LE(fim) !== 0x06054b50) fim--;
  const central = zip.readUInt32LE(fim + 16);
  const metodo = zip.readUInt16LE(central + 10);
  const tamanhoComprimido = zip.readUInt32LE(central + 20);
  const local = zip.readUInt32LE(central + 42);
  const inicio = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const dados = zip.subarray(inicio, inicio + tamanhoComprimido);
  return metodo === 8 ? inflateRawSync(dados) : dados;
}

// Repositório público sem commit por 60 dias: o GitHub desliga o agendamento.
export async function garantirAgendamentoAtivo() {
  const wf = await (await gh(`/actions/workflows/${WORKFLOW}`)).json();
  if (wf.state !== 'active') {
    await gh(`/actions/workflows/${WORKFLOW}/enable`, { method: 'PUT' });
    return true;
  }
  return false;
}

// ---------- posts de vídeo (repo privado sepiastream-posts) ----------
export const POSTS_REPO = () => process.env.POSTS_REPO || 'sgveng3-lang/sepiastream-posts';
export const POSTAR = 'postar.yml';

// agora=false: execução "da hora" — o postar.py sorteia se posta, como no agendamento
export async function dispararPost(redes = '', agora = true) {
  await gh(`/actions/workflows/${POSTAR}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'main', inputs: { agora, redes } }),
  }, POSTS_REPO());
}

export async function dispararRetomar(rede) {
  await gh('/actions/workflows/retomar.yml/dispatches', {
    method: 'POST',
    body: JSON.stringify({ ref: 'main', inputs: { rede } }),
  }, POSTS_REPO());
}

// Situação da fila no Drive: GET público do Apps Script (só nomes e contagens).
// A URL fica na variável FILA_STATUS_URL do repo de posts.
export async function filaStatus() {
  const url = await lerVariavel('FILA_STATUS_URL', POSTS_REPO());
  if (!url) return null;
  const r = await fetch(`${url}?acao=status`, { redirect: 'follow' });
  return r.json();
}
