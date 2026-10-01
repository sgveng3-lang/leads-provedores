// Bot controlador da raspagem de leads. Só escuta o grupo configurado,
// dispara o workflow no GitHub e avisa o resultado. Todo o trabalho pesado
// roda no GitHub Actions — aqui não se processa dado nenhum.
//
// Também controla os posts de vídeo (TikTok/Instagram) do repo sepiastream-posts.
//
// Timers: com raspagem em andamento, consulta o GitHub a cada 3 min; sem
// raspagem, a cada 15 min (pra notar a raspagem semanal e os posts agendados).
import { carregarEnv, lerEstado, log, salvarEstado } from './base.js';
import * as gh from './github.js';
import { acharGrupo, conectar, enviar, idsEnviadosPeloBot, textoDa } from './whatsapp.js';

carregarEnv();
for (const v of ['WHATSAPP_NUMERO', 'WHATSAPP_GRUPO', 'GITHUB_TOKEN']) {
  if (!process.env[v]) throw new Error(`${v} não definido no .env`);
}

const COM_EXECUCAO_MS = 3 * 60_000;
const SEM_EXECUCAO_MS = 15 * 60_000;
const estado = lerEstado();
let timer = null;

const AJUDA =
  '🤖 *Leads Provedores*\n\n' +
  '*raspar* — raspa o Brasil inteiro agora\n' +
  '*raspar MG,SP* — só as UFs indicadas\n' +
  '*status* — andamento da raspagem\n' +
  '*cancelar* — cancela a raspagem em andamento\n' +
  '*planilha* — link da planilha\n\n' +
  '📧 *E-mails de prospecção*\n' +
  '*envio* — situação do envio\n' +
  '*envio ligar* / *envio desligar* — envio automático (dias úteis 09:00)\n' +
  '*envio limite 20* — e-mails por dia (máx. 40)\n' +
  '*envio agora 5* — envia já N e-mails reais (máx. 15)\n' +
  '*envio teste fulano@email.com* — 2 e-mails de teste só pra esse endereço\n\n' +
  '🎬 *Posts de vídeo* (TikTok e Instagram independentes)\n' +
  '*posts* — situação de cada rede e da fila no Drive\n' +
  '*posts tiktok ligar* / *desligar* — só o TikTok\n' +
  '*posts instagram ligar* / *desligar* — só o Instagram\n' +
  '*posts ligar* / *posts desligar* — as duas\n' +
  '*posts tiktok agora* / *posts instagram agora* / *posts agora* — posta já\n' +
  '*posts tiktok por dia 3* / *posts instagram por dia 2* — posts por dia (1 a 6)\n' +
  '*posts instagram normal|teste|ambos* — tipo de Reel\n' +
  '*posts horario 10-22* — janela de horário (as duas)\n' +
  '*posts intervalo 10h* — tempo mínimo entre posts da mesma rede\n' +
  '*posts ordem intercalada|numerica|alfabetica*\n' +
  '*posts tiktok retomar* — tira a pausa (depois de renovar os cookies)\n\n' +
  '*ajuda* — esta mensagem\n' +
  'Raspagem automática: toda segunda às 06:00.';

const agora = () => Math.floor(Date.now() / 1000);
const minutos = (desde) => Math.round((agora() - desde) / 60);

function formatarResumo(r) {
  return (
    `✅ *Raspagem concluída* (${r.pedido || '—'})\n\n` +
    `📍 ${r.filtros || ''}\n` +
    `🔎 Processados: *${r.processados ?? 0}*\n` +
    `📧 Gravados (com e-mail): *${r.provedores ?? 0}*\n` +
    `🆕 Novos: *${r.novos ?? 0}* · 🔁 Atualizados: *${r.atualizados ?? 0}*\n` +
    `💬 Com WhatsApp: *${r.comWhatsapp ?? 0}*\n` +
    `🗑️ Sem e-mail (descartados): ${r.semEmailDescartados ?? 0}\n` +
    `⏱️ ${r.duracaoMin ?? '?'} min\n\n` +
    `📊 ${process.env.PLANILHA_LINK || r.planilha || ''}`
  );
}

async function avisar(texto) {
  if (estado.grupoJid) await enviar(estado.grupoJid, texto);
}

// ---------------- acompanhamento ----------------
function agendar(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => ciclo().catch((e) => log.erro('ciclo', e.message)).finally(() => agendar(estado.execucao || estado.envioAvisar || estado.postsAvisar ? COM_EXECUCAO_MS : SEM_EXECUCAO_MS)), ms);
}

async function ciclo() {
  await acompanharEnvio().catch((e) => log.erro('envio', e.message));
  await acompanharPosts().catch((e) => log.erro('posts', e.message));
  if (estado.execucao) {
    const run = await gh.execucao(estado.execucao.runId);
    if (run.status !== 'completed') return;
    const exec = estado.execucao;
    estado.execucao = null;
    estado.ultimoRunVisto = Math.max(estado.ultimoRunVisto, run.id);
    salvarEstado(estado);
    if (run.conclusion === 'cancelled') return avisar(`⛔ Raspagem ${exec.pedido} cancelada.`);
    const r = await gh.resumo(run.id).catch(() => null);
    const { falhas } = await gh.progresso(run.id).catch(() => ({ falhas: [] }));
    let texto = r ? formatarResumo(r) : `⚠️ Raspagem ${exec.pedido} terminou (${run.conclusion}), mas sem resumo.`;
    if (falhas.length) texto += `\n\n⚠️ UFs com falha: ${falhas.join(', ')} — mande *raspar ${falhas.join(',')}* pra refazer.`;
    return avisar(texto);
  }

  // sem execução do bot: procura execução nova (ex.: a semanal automática)
  const [ultima] = await gh.ultimasExecucoes(1);
  if (ultima && ultima.id > estado.ultimoRunVisto && ultima.status !== 'completed') {
    estado.execucao = { runId: ultima.id, pedido: ultima.event === 'schedule' ? 'semanal' : 'manual', inicio: agora() };
    estado.ultimoRunVisto = ultima.id;
    salvarEstado(estado);
    await avisar(`🚀 Raspagem ${estado.execucao.pedido} começou no GitHub. Aviso aqui quando terminar.`);
  }

  // 1x por semana: religa o agendamento se o GitHub desligou por inatividade
  if (agora() - (estado.ultimaChecagemAgenda || 0) > 7 * 86400) {
    if (await gh.garantirAgendamentoAtivo()) await avisar('🔁 O GitHub tinha desligado a raspagem semanal por inatividade; religuei.');
    estado.ultimaChecagemAgenda = agora();
    salvarEstado(estado);
  }
}

// ---------------- comandos ----------------
async function comando(texto, quem) {
  const [cmd, ...args] = texto.trim().replace(/^[/!.]/, '').split(/\s+/);
  switch (cmd.toLowerCase()) {
    case 'ajuda':
    case 'menu':
      return avisar(AJUDA);

    case 'planilha':
      return avisar(`📊 ${process.env.PLANILHA_LINK || '(PLANILHA_LINK não configurado)'}`);

    case 'raspar': {
      if (estado.execucao) {
        return avisar(`⏳ Já tem uma raspagem rodando (${estado.execucao.pedido}, há ${minutos(estado.execucao.inicio)} min). Mande *status* ou *cancelar*.`);
      }
      const ufs = (args[0] || 'TODAS').toUpperCase();
      if (!/^(TODAS|[A-Z]{2}(,[A-Z]{2})*)$/.test(ufs)) return avisar('UFs inválidas. Exemplo: *raspar* ou *raspar MG,SP*');
      const pedido = `wa-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
      await gh.disparar({ ufs, pedido });
      await avisar(`🚀 Raspagem disparada (${ufs === 'TODAS' ? 'Brasil inteiro' : ufs}). Leva até ~2 h no Brasil inteiro; aviso aqui quando terminar.`);
      const run = await gh.acharExecucaoDoPedido(pedido);
      if (!run) return avisar('⚠️ Disparei, mas não achei a execução no GitHub. Confira em Actions.');
      estado.execucao = { runId: run.id, pedido, inicio: agora(), porQuem: quem };
      estado.ultimoRunVisto = Math.max(estado.ultimoRunVisto, run.id);
      salvarEstado(estado);
      return agendar(COM_EXECUCAO_MS);
    }

    case 'status': {
      if (!estado.execucao) {
        const [ultima] = await gh.ultimasExecucoes(1);
        const quando = ultima ? new Date(ultima.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—';
        return avisar(`💤 Nenhuma raspagem rodando.\nÚltima: ${quando} (${ultima?.conclusion || '—'}).\nPróxima automática: segunda às 06:00.`);
      }
      const p = await gh.progresso(estado.execucao.runId);
      return avisar(
        `⏳ Raspagem ${estado.execucao.pedido} rodando há ${minutos(estado.execucao.inicio)} min\n` +
          `UFs concluídas: ${p.concluidas}/${p.total || '?'}` + (p.falhas.length ? `\nFalhas: ${p.falhas.join(', ')}` : ''),
      );
    }

    case 'envio':
      return comandoEnvio(args, quem);

    case 'posts':
    case 'post':
      return comandoPosts(args);

    case 'cancelar': {
      if (!estado.execucao) return avisar('Não há raspagem rodando.');
      await gh.cancelar(estado.execucao.runId);
      return avisar('⛔ Pedido de cancelamento enviado ao GitHub.');
    }

    default:
      return null; // mensagem comum do grupo: ignora
  }
}

// ---------------- e-mails ----------------
const LIMITE_MAXIMO = 40; // teto seguro por dia pra uma caixa Zoho (ver conversa: bounces ~10/dia)

async function comandoEnvio(args, quem) {
  const sub = (args[0] || 'status').toLowerCase();
  if (sub === 'status' || sub === 'situacao' || sub === 'situação') {
    const [ligado, limite] = await Promise.all([gh.lerVariavel('ENVIO_LIGADO'), gh.lerVariavel('ENVIO_LIMITE')]);
    const [ultima] = await gh.ultimasExecucoes(1, gh.ENVIO);
    let texto = `📧 *Envio de e-mails*\nAutomático: ${ligado === 'sim' ? '🟢 LIGADO (dias úteis 09:00)' : '🔴 DESLIGADO'}\nLimite por dia: ${limite || 15}`;
    if (ultima) {
      const quando = new Date(ultima.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      const r = ultima.status === 'completed' ? await gh.resumo(ultima.id, 'resumo-envio').catch(() => null) : null;
      texto += `\nÚltimo envio: ${quando} — ${ultima.status === 'completed' ? (r ? `${r.enviados} enviados${r.teste ? ' (teste)' : ''}` : ultima.conclusion) : 'em andamento'}`;
    }
    return avisar(texto);
  }
  if (sub === 'ligar' || sub === 'desligar') {
    await gh.gravarVariavel('ENVIO_LIGADO', sub === 'ligar' ? 'sim' : 'nao');
    return avisar(sub === 'ligar'
      ? '🟢 Envio automático LIGADO: dias úteis às 09:00, no limite configurado. Mande *envio desligar* pra pausar.'
      : '🔴 Envio automático DESLIGADO. Nada sai até alguém mandar *envio ligar*.');
  }
  if (sub === 'limite') {
    const n = Number(args[1]);
    if (!Number.isInteger(n) || n < 1 || n > LIMITE_MAXIMO) return avisar(`Use um número de 1 a ${LIMITE_MAXIMO}. Ex.: *envio limite 20*`);
    await gh.gravarVariavel('ENVIO_LIMITE', n);
    return avisar(`✅ Limite ajustado: ${n} e-mails por dia.`);
  }
  if (sub === 'agora') {
    const n = Number(args[1] || 5);
    if (!Number.isInteger(n) || n < 1 || n > 15) return avisar('Use de 1 a 15. Ex.: *envio agora 5*');
    await gh.dispararEnvio({ limite: n });
    estado.envioAvisar = true;
    salvarEstado(estado);
    agendar(COM_EXECUCAO_MS);
    return avisar(`📨 Enviando ${n} e-mail(s) reais agora, um a cada 8–15 min. Aviso quando terminar.`);
  }
  if (sub === 'teste') {
    const email = (args[1] || '').toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) return avisar('Ex.: *envio teste fulano@gmail.com*');
    await gh.dispararEnvio({ limite: 2, testePara: email });
    estado.envioAvisar = true;
    salvarEstado(estado);
    agendar(COM_EXECUCAO_MS);
    return avisar(`🧪 Mandando 2 e-mails de TESTE pra ${email} (nada é marcado na planilha).`);
  }
  return avisar('Opções: *envio*, *envio ligar*, *envio desligar*, *envio limite N*, *envio agora N*, *envio teste email*');
}

// avisa no grupo o resultado de cada envio que terminar (automático ou pedido)
async function acompanharEnvio() {
  const novas = (await gh.ultimasExecucoes(5, gh.ENVIO))
    .filter((r) => r.id > (estado.ultimoEnvioVisto || 0))
    .sort((a, b) => a.id - b.id);
  // para na primeira ainda rodando: o aviso dela não pode se perder atrás de uma mais nova
  const prontas = [];
  for (const r of novas) {
    if (r.status !== 'completed') break;
    prontas.push(r);
  }
  if (!prontas.length) return;
  const primeiraVez = !estado.ultimoEnvioVisto;
  estado.ultimoEnvioVisto = prontas[prontas.length - 1].id;
  salvarEstado(estado);
  if (primeiraVez && !estado.envioAvisar) return; // não repete envio antigo ao ligar o bot
  estado.envioAvisar = false;
  salvarEstado(estado);
  for (const run of prontas) {
    const r = await gh.resumo(run.id, 'resumo-envio').catch(() => null);
    if (!r) {
      // sem resumo e sem falha = agendamento de reserva que não precisou enviar
      if (run.conclusion === 'failure') await avisar(`⚠️ Um envio de e-mails falhou antes de terminar. Veja em GitHub > leads-provedores > Actions.`);
      continue;
    }
    await avisar(`📧 Envio ${r.teste ? 'de TESTE ' : ''}concluído: *${r.enviados}* enviados, ${r.falhas} falha(s)` +
      (r.repetidos ? `, ${r.repetidos} endereço(s) repetido(s) pulado(s)` : '') + '.');
  }
}

// ---------------- agendamentos feitos pelo bot ----------------
// O agendamento (cron) do GitHub atrasa horas e às vezes nem roda (30/09: das 12
// rodadas de hora em hora dos posts, só 3 aconteceram). Por isso quem dá a partida
// é o bot, conferindo a cada minuto. Os crons do GitHub ficam só de reserva.
const ENVIO_DESDE = 9; // e-mails: dias úteis 09:00; se o bot estava fora, até 16:00
const ENVIO_ATE = 16;
const POSTS_DESDE = 10; // posts: uma rodada de sorteio por hora, 10:07 a 21:07
const POSTS_ATE = 22;
const POSTS_MINUTO = 7;
const RASPAR_DESDE = 6; // raspagem: segunda 06:00; se o bot estava fora, até 18:00
const RASPAR_ATE = 18;
let rodandoAgenda = false;

function agoraBR(data = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    }).formatToParts(data).map((x) => [x.type, x.value]),
  );
  return {
    dia: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour), minuto: Number(p.minute),
    semana: p.weekday, util: !['Sat', 'Sun'].includes(p.weekday),
  };
}
const diaBR = (iso) => agoraBR(new Date(iso)).dia;

async function agendamentos() {
  if (rodandoAgenda) return;
  rodandoAgenda = true;
  try {
    await envioDiario().catch((e) => log.erro('envio diário', e.message));
    await postsDaHora().catch((e) => log.erro('posts da hora', e.message));
    await raspagemSemanal().catch((e) => log.erro('raspagem semanal', e.message));
  } finally {
    rodandoAgenda = false;
  }
}

// Posts: o bot faz a "rodada da hora" (agora=false); o postar.py decide sozinho se
// posta (sorteio, janela, intervalo, posts por dia). Se o cron do GitHub já rodou
// nesta hora, o bot não repete.
async function postsDaHora() {
  const { dia, hora, minuto } = agoraBR();
  const chave = `${dia} ${hora}`;
  if (hora < POSTS_DESDE || hora >= POSTS_ATE || minuto < POSTS_MINUTO || estado.postsHora === chave) return;
  const [tt, ig] = await Promise.all([gh.lerVariavel('TIKTOK_LIGADO', PR()), gh.lerVariavel('INSTAGRAM_LIGADO', PR())]);
  if (tt === 'sim' || ig === 'sim') {
    const nestaHora = (await gh.ultimasExecucoes(5, gh.POSTAR, PR())).some((r) => {
      const t = agoraBR(new Date(r.created_at));
      return t.dia === dia && t.hora === hora;
    });
    if (!nestaHora) {
      await gh.dispararPost('', false);
      log.info(`posts: rodada das ${hora}h disparada`);
    }
  }
  estado.postsHora = chave;
  salvarEstado(estado);
}

// Raspagem: segunda-feira; o cron do GitHub (segunda 12:00) é reserva e pula se
// a "semanal-bot" já rodou no dia.
async function raspagemSemanal() {
  const { dia, hora, semana } = agoraBR();
  if (semana !== 'Mon' || hora < RASPAR_DESDE || hora >= RASPAR_ATE || estado.raspagemDia === dia || estado.execucao) return;
  const jaHoje = (await gh.ultimasExecucoes(10)).some((r) => diaBR(r.created_at) === dia && r.event !== 'schedule');
  estado.raspagemDia = dia;
  salvarEstado(estado);
  if (jaHoje) return; // alguém já raspou hoje pelo grupo/site
  const pedido = 'semanal-bot';
  await gh.disparar({ ufs: 'TODAS', pedido });
  await avisar('🚀 Raspagem semanal começou (Brasil inteiro, até ~2 h). Aviso aqui quando terminar.');
  const run = await gh.acharExecucaoDoPedido(pedido);
  if (!run) return avisar('⚠️ Disparei a raspagem semanal, mas não achei a execução no GitHub. Confira em Actions.');
  estado.execucao = { runId: run.id, pedido: 'semanal', inicio: agora() };
  estado.ultimoRunVisto = Math.max(estado.ultimoRunVisto, run.id);
  salvarEstado(estado);
  agendar(COM_EXECUCAO_MS);
}

async function envioDiario() {
  const { dia, hora, util } = agoraBR();
  if (!util || hora < ENVIO_DESDE || hora >= ENVIO_ATE || estado.envioDiarioDia === dia) return;
  if ((await gh.lerVariavel('ENVIO_LIGADO')) !== 'sim') return; // desligado: confere de novo no próximo minuto
  const hoje = (await gh.ultimasExecucoes(10, gh.ENVIO)).filter((r) => diaBR(r.created_at) === dia);
  if (hoje.some((r) => r.event === 'schedule' && r.status !== 'completed')) return; // reserva decidindo agora: confere no próximo minuto
  let jaEnviou = hoje.some((r) => (r.display_title || '').endsWith('diario'));
  for (const r of hoje.filter((x) => x.event === 'schedule')) {
    if (!jaEnviou && (await gh.resumo(r.id, 'resumo-envio').catch(() => null))) jaEnviou = true; // a reserva já enviou
  }
  let limite = null;
  if (!jaEnviou) {
    limite = (await gh.lerVariavel('ENVIO_LIMITE')) || 15;
    await gh.dispararEnvio({ limite, origem: 'diario' });
    estado.envioAvisar = true;
  }
  estado.envioDiarioDia = dia;
  salvarEstado(estado);
  if (limite) {
    agendar(COM_EXECUCAO_MS);
    await avisar(`📨 Envio do dia começou: ${limite} e-mail(s), um a cada 8–15 min. Aviso quando terminar.`);
  }
}

// ---------------- posts de vídeo ----------------
// TikTok e Instagram são independentes: cada um liga/desliga, tem seus posts por
// dia e anda pela fila do Drive no seu ritmo (o vídeo sai da Fila quando foi pras duas).
const PR = () => gh.POSTS_REPO();
const REDES_POST = ['tiktok', 'instagram'];
const NOME_REDE = { tiktok: 'TikTok', instagram: 'Instagram' };
const NOME_IG = { normal: 'Reel normal', teste: 'Reel de teste', ambos: 'teste + normal' };
const PADRAO_POSTS = {
  TIKTOK_LIGADO: 'nao', INSTAGRAM_LIGADO: 'nao', TIKTOK_POR_DIA: '2', INSTAGRAM_POR_DIA: '2',
  POSTS_JANELA: '10-22', POSTS_INTERVALO_MIN: '90', POSTS_ORDEM: 'intercalada', IG_MODO: 'normal',
};
const horaBR = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const semAcento = (t) => (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function formatarIntervalo(min) {
  const h = Math.floor(+min / 60), m = +min % 60;
  return h && m ? `${h}h${m}` : h ? `${h}h` : `${m} min`;
}

async function lerConfigPosts() {
  const v = {};
  await Promise.all(Object.keys(PADRAO_POSTS).map(async (k) => { v[k] = (await gh.lerVariavel(k, PR())) || PADRAO_POSTS[k]; }));
  return v;
}

async function statusPosts() {
  const [v, f] = await Promise.all([lerConfigPosts(), gh.filaStatus().catch(() => null)]);
  let texto = '🎬 *Posts de vídeo*';
  for (const rede of REDES_POST) {
    const R = rede.toUpperCase();
    const ligado = v[`${R}_LIGADO`] === 'sim';
    const pausa = f && f.ok && f.pausas && f.pausas[rede];
    texto += `\n\n*${NOME_REDE[rede]}*: ${pausa ? '⏸️ PAUSADO' : ligado ? '🟢 LIGADO' : '🔴 DESLIGADO'} · ${v[`${R}_POR_DIA`]} por dia`;
    if (rede === 'instagram') texto += ` · ${NOME_IG[v.IG_MODO] || v.IG_MODO}`;
    if (f && f.ok && f.redes && f.redes[rede]) {
      const r = f.redes[rede];
      texto += `\nPendentes: *${r.pendentes}* · postados hoje: ${r.hoje}`;
      if (r.proximos.length) texto += `\nPróximo: ${r.proximos[0]}`;
    }
    if (pausa) texto += `\n(${pausa.motivo}) — renove e mande *posts ${rede} retomar*`;
  }
  texto += `\n\n🕐 Entre ${v.POSTS_JANELA.replace('-', 'h e ')}h (horário sorteado) · mínimo de ${formatarIntervalo(v.POSTS_INTERVALO_MIN)} entre posts da mesma rede · ordem ${v.POSTS_ORDEM}`;
  texto += f && f.ok ? `\n📂 Fila no Drive: ${f.fila} vídeo(s)` : '\n📂 Fila: não consegui consultar o Drive (variável FILA_STATUS_URL configurada?)';
  return avisar(texto);
}

async function postarAgora(rede) {
  await gh.dispararPost(rede);
  estado.postsAvisar = true;
  salvarEstado(estado);
  agendar(COM_EXECUCAO_MS);
  return avisar(`🚀 Postando o próximo vídeo ${rede ? `no ${NOME_REDE[rede]}` : 'nas redes ligadas (ou nas duas, se nenhuma estiver ligada)'}. Aviso quando terminar (~5 min).`);
}

// posts tiktok ... / posts instagram ...
async function comandoRede(rede, args) {
  const R = rede.toUpperCase();
  const sub = semAcento(args[0]);
  const gravar = (nome, valor) => gh.gravarVariavel(nome, valor, PR());
  if (!sub) return statusPosts();
  if (sub === 'ligar' || sub === 'desligar') {
    await gravar(`${R}_LIGADO`, sub === 'ligar' ? 'sim' : 'nao');
    return avisar(sub === 'ligar'
      ? `🟢 ${NOME_REDE[rede]} LIGADO: posta sozinho no horário sorteado. *posts ${rede} desligar* pra parar.`
      : `🔴 ${NOME_REDE[rede]} DESLIGADO. Os vídeos ficam esperando na fila; ao religar, ele alcança o que a outra rede já postou.`);
  }
  if (sub === 'agora') return postarAgora(rede);
  if (sub === 'por' || sub === 'limite') {
    const n = Number(sub === 'por' ? args[2] : args[1]);
    if (!Number.isInteger(n) || n < 1 || n > 6) return avisar(`Use de 1 a 6. Ex.: *posts ${rede} por dia 3*`);
    await gravar(`${R}_POR_DIA`, n);
    return avisar(`✅ ${NOME_REDE[rede]}: ${n} post(s) por dia.`);
  }
  if (sub === 'retomar') {
    await gh.dispararRetomar(rede);
    return avisar(`▶️ Retomando ${NOME_REDE[rede]}. Volta a postar na próxima execução.`);
  }
  if (rede === 'instagram' && NOME_IG[sub]) {
    await gravar('IG_MODO', sub);
    return avisar(`✅ Instagram: ${NOME_IG[sub]}.`);
  }
  return avisar(`Opções: *posts ${rede} ligar*, *desligar*, *agora*, *por dia N*, *retomar*` +
    (rede === 'instagram' ? ', *normal*, *teste*, *ambos*' : ''));
}

async function comandoPosts(args) {
  const sub = semAcento(args[0] || 'status');
  const gravar = (nome, valor) => gh.gravarVariavel(nome, valor, PR());

  if (sub === 'tiktok' || sub === 'instagram' || sub === 'ig') return comandoRede(sub === 'ig' ? 'instagram' : sub, args.slice(1));
  if (sub === 'status' || sub === 'situacao') return statusPosts();
  if (sub === 'ligar' || sub === 'desligar') {
    await Promise.all(REDES_POST.map((r) => gravar(`${r.toUpperCase()}_LIGADO`, sub === 'ligar' ? 'sim' : 'nao')));
    return avisar(sub === 'ligar' ? '🟢 TikTok e Instagram LIGADOS.' : '🔴 TikTok e Instagram DESLIGADOS. Nada sai sozinho.');
  }
  if (sub === 'agora') {
    const rede = semAcento(args[1]);
    if (rede && !REDES_POST.includes(rede)) return avisar('Ex.: *posts agora*, *posts tiktok agora*, *posts instagram agora*');
    return postarAgora(rede);
  }
  if (sub === 'retomar') return comandoRede(semAcento(args[1]) || 'tiktok', ['retomar']);
  if (sub === 'horario') {
    const m = (args[1] || '').match(/^(\d{1,2})-(\d{1,2})$/);
    if (!m || +m[1] >= +m[2] || +m[1] < 10 || +m[2] > 22) return avisar('Ex.: *posts horario 10-22* (o agendamento roda entre 10h e 22h)');
    await gravar('POSTS_JANELA', `${+m[1]}-${+m[2]}`);
    return avisar(`✅ Posts entre ${+m[1]}h e ${+m[2]}h (vale pras duas redes).`);
  }
  if (sub === 'intervalo') {
    // aceita "10h", "10", "1h30", "90min"
    const t = semAcento(args[1]).replace(/\s/g, '');
    let minutos = null;
    let m = t.match(/^(\d{1,3})min$/);
    if (m) minutos = +m[1];
    else if ((m = t.match(/^(\d{1,2})(?:h(\d{1,2})?)?$/))) minutos = +m[1] * 60 + (m[2] ? +m[2] : 0);
    if (minutos === null || minutos < 30 || minutos > 24 * 60) return avisar('Ex.: *posts intervalo 10h*, *posts intervalo 1h30* ou *posts intervalo 90min* (de 30 min a 24h)');
    await gravar('POSTS_INTERVALO_MIN', minutos);
    return avisar(`✅ Mínimo de ${formatarIntervalo(minutos)} entre posts da mesma rede.`);
  }
  if (sub === 'ordem') {
    const ordem = semAcento(args[1]);
    if (!['intercalada', 'numerica', 'alfabetica'].includes(ordem)) return avisar('Ex.: *posts ordem intercalada*, *numerica* ou *alfabetica*');
    await gravar('POSTS_ORDEM', ordem);
    return avisar(`✅ Ordem: ${ordem}.`);
  }
  return avisar('Opções: *posts*, *posts tiktok ligar/desligar*, *posts instagram ligar/desligar*, *posts ligar/desligar* (as duas), ' +
    '*posts agora*, *posts tiktok por dia N*, *posts instagram normal|teste|ambos*, *posts horario 10-22*, *posts intervalo 10h*, *posts ordem ...*, *posts tiktok retomar*');
}

// avisa no grupo cada execução que postou (ou falhou); as que só "não sortearam" ficam quietas
async function acompanharPosts() {
  const runs = (await gh.ultimasExecucoes(10, gh.POSTAR, PR()))
    .filter((r) => r.status === 'completed' && r.id > (estado.ultimoPostVisto || 0))
    .sort((a, b) => a.id - b.id);
  if (!runs.length) return;
  const primeiraVez = !estado.ultimoPostVisto;
  estado.ultimoPostVisto = runs[runs.length - 1].id;
  estado.postsAvisar = false;
  salvarEstado(estado);
  if (primeiraVez) return; // não repete posts antigos ao ligar o bot
  for (const run of runs) {
    const r = await gh.resumo(run.id, 'resultado-post', PR()).catch(() => null);
    if (!r) {
      if (run.conclusion === 'failure') await avisar(`⚠️ A postagem das ${horaBR(run.created_at)} falhou antes de postar. Veja em GitHub > sepiastream-posts > Actions.`);
      continue;
    }
    if (r.erro) { await avisar(`⚠️ Postagem das ${horaBR(run.created_at)} falhou: ${r.erro}`); continue; }
    const linhas = [];
    for (const p of r.posts || []) {
      let l = `${p.ok ? '✅' : '❌'} *${NOME_REDE[p.rede] || p.rede}*: ${p.video}`;
      if (!p.ok) l += `\n   ${p.erro}`;
      for (const link of p.links || []) l += `\n   ${link}`;
      if (p.concluido) l += '\n   📂 saiu nas duas redes → Postados';
      if (p.pausou) l += `\n   ⏸️ *${NOME_REDE[p.rede]} PAUSADO* (pediu login/captcha). Exporte cookies novos, atualize o secret TIKTOK_COOKIES e mande *posts ${p.rede} retomar*.`;
      linhas.push(l);
    }
    if (r.pulados && r.pulados.length) linhas.push(`⏭️ Pulado(s) por ter menos de 15 s: ${r.pulados.join(', ')}`);
    if (!linhas.length) continue;
    const pend = r.pendentes || {};
    let texto = `🎬 ${linhas.join('\n')}\n\nPendentes — TikTok: ${pend.tiktok ?? '?'} · Instagram: ${pend.instagram ?? '?'}`;
    if (REDES_POST.some((x) => pend[x] !== undefined && pend[x] <= 2)) texto += '\n📢 Fila acabando — coloque mais vídeos na pasta Fila do Drive.';
    await avisar(texto);
  }
}

// ---------------- início ----------------
const cliente = await conectar();

cliente.on('message', async (evento) => {
  try {
    const { key, message } = evento;
    if (!key || !estado.grupoJid || key.remoteJid !== estado.grupoJid) return; // só o grupo
    if (idsEnviadosPeloBot.has(key.id)) return; // eco do próprio bot
    const texto = textoDa(message).trim();
    if (!texto || texto.length > 80) return;
    await comando(texto, key.participant || 'dono');
  } catch (e) {
    log.erro('comando', e.message);
    avisar('❌ Deu erro ao executar o comando. Tente de novo em instantes.').catch(() => {});
  }
});

// acha o grupo pelo nome (e guarda o id) assim que a conexão abrir
async function prepararGrupo() {
  for (let i = 0; i < 20 && !estado.grupoJid; i++) {
    try {
      estado.grupoJid = await acharGrupo(process.env.WHATSAPP_GRUPO);
      if (estado.grupoJid) {
        salvarEstado(estado);
        log.info('grupo encontrado');
        return;
      }
      log.info(`grupo "${process.env.WHATSAPP_GRUPO}" ainda não encontrado (o número do bot está nele?)`);
    } catch (e) {
      log.info(`aguardando conexão pra listar grupos (${e.message})`);
    }
    await new Promise((ok) => setTimeout(ok, 30_000));
  }
}

await prepararGrupo();
agendar(10_000);
setInterval(agendamentos, 60_000);
log.info('bot no ar');
