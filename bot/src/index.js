// Bot controlador da raspagem de leads. Só escuta o grupo configurado,
// dispara o workflow no GitHub e avisa o resultado. Todo o trabalho pesado
// roda no GitHub Actions — aqui não se processa dado nenhum.
//
// Timers: com raspagem em andamento, consulta o GitHub a cada 3 min; sem
// raspagem, a cada 30 min (pra notar a execução semanal automática).
import { carregarEnv, lerEstado, log, salvarEstado } from './base.js';
import * as gh from './github.js';
import { acharGrupo, conectar, enviar, idsEnviadosPeloBot, textoDa } from './whatsapp.js';

carregarEnv();
for (const v of ['WHATSAPP_NUMERO', 'WHATSAPP_GRUPO', 'GITHUB_TOKEN']) {
  if (!process.env[v]) throw new Error(`${v} não definido no .env`);
}

const COM_EXECUCAO_MS = 3 * 60_000;
const SEM_EXECUCAO_MS = 30 * 60_000;
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
  timer = setTimeout(() => ciclo().catch((e) => log.erro('ciclo', e.message)).finally(() => agendar(estado.execucao || estado.envioAvisar ? COM_EXECUCAO_MS : SEM_EXECUCAO_MS)), ms);
}

async function ciclo() {
  await acompanharEnvio().catch((e) => log.erro('envio', e.message));
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
  const [ultima] = await gh.ultimasExecucoes(1, gh.ENVIO);
  if (!ultima || ultima.status !== 'completed' || ultima.id <= (estado.ultimoEnvioVisto || 0)) return;
  const primeiraVez = !estado.ultimoEnvioVisto;
  estado.ultimoEnvioVisto = ultima.id;
  salvarEstado(estado);
  if (primeiraVez && !estado.envioAvisar) return; // não repete envio antigo ao ligar o bot
  estado.envioAvisar = false;
  salvarEstado(estado);
  const r = await gh.resumo(ultima.id, 'resumo-envio').catch(() => null);
  if (!r) return avisar(`⚠️ Um envio de e-mails terminou (${ultima.conclusion}), sem resumo.`);
  return avisar(`📧 Envio ${r.teste ? 'de TESTE ' : ''}concluído: *${r.enviados}* enviados, ${r.falhas} falha(s)` +
    (r.repetidos ? `, ${r.repetidos} endereço(s) repetido(s) pulado(s)` : '') + '.');
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
log.info('bot no ar');
