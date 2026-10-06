// Prospecção pelo WhatsApp do bot: dias úteis, das 14:00 às 17:30, manda uma mensagem
// curta (sem link/PDF) pra quem já recebeu o e-mail há 2+ dias úteis (fila: ação
// whats_pendentes da planilha). Quem responde ganha o PDF e o grupo é avisado; quem
// pede pra parar é marcado e não recebe mais nada.
//
// Cuidados contra bloqueio: começa com 5/dia (10 depois de 5 dias com envio, 15 depois
// de 10), intervalo de 8–15 min, 4 versões do texto, só números confirmados no WhatsApp,
// e freio automático (qualquer falha de envio ou sinal de restrição desliga tudo).
//
// Evita o suporte (que responde com robô): a planilha só manda o WhatsApp comercial do site
// e celulares da Receita que não aparecem no site; aqui ainda conferimos o tipo de conta:
// plataforma de atendimento (API) nunca; WhatsApp Business só se o site rotulou como comercial;
// celular da Receita só se for WhatsApp comum (pessoal). Se nenhum servir: "Só suporte".
// Provedor com mais de um número bom recebe em TODOS (pedido do usuário, 06/10/2026): um por vez,
// com o mesmo intervalo, contando no limite do dia; se uma pessoa daquele provedor responder ou pedir
// pra parar, os números restantes dele não recebem (menu automático não para: segue pro próximo número).
// Se mesmo assim responder um menu automático, não manda o PDF e espera uma pessoa.
import { log } from './base.js';
import * as gh from './github.js';
import { comWhatsapp, enviar, enviarDocumento, tiposDeConta, usuario } from './whatsapp.js';

const DESDE = 14 * 60; // minutos do dia (horário de Brasília)
const ATE = 17 * 60 + 30;
const INTERVALO_MIN = 8;
const INTERVALO_MAX = 15;
const LIMITE_MAXIMO = 15;
const DIAS_UTEIS_DEPOIS_DO_EMAIL = 2;
const GUARDAR_CONTATO_DIAS = 30; // por quanto tempo uma resposta ainda dispara o PDF
const PDF = 'anexos/SepiaStream_SVA_Provedores.pdf';
const PDF_NOME = 'SepiaStream - SVA para provedores.pdf';
const PDF_LEGENDA = 'Segue nossa apresentação (2 páginas). A versão online tem os pacotes e um simulador: flyer.sepiastream.com\n\nQualquer dúvida é só me chamar por aqui.';
const RESPOSTA_SAIR = 'Tudo bem, não vamos mais mandar mensagem por aqui. Obrigado pelo retorno!';

const TEXTOS = [
  (n) => `Oi, tudo bem? Aqui é da SepiaStream. Mandei um e-mail pra ${n} esses dias sobre um SVA de streaming pra incluir no plano dos assinantes. Conseguiram dar uma olhada?`,
  (n) => `Olá! Sou da SepiaStream. Enviei um e-mail pra equipe da ${n} falando de um SVA de streaming que o provedor coloca no plano. Vocês chegaram a ver?`,
  (n) => `Oi! Aqui é da SepiaStream, tudo certo? Há alguns dias mandei um e-mail pra ${n} sobre um SVA de streaming pros assinantes. Conseguiram ver?`,
  (n) => `Olá, tudo bem? Falo da SepiaStream. Mandei um e-mail pra vocês da ${n} sobre incluir um SVA de streaming no plano. Deu pra dar uma olhada?`,
];

// "não quero", "pare", "sair", "sem interesse", ou um "não" curto ("não, obrigado")
const QUER_SAIR = /\b(pare|parar|sair|remove|remover|descadastr\w*|stop|bloque\w*)\b|n[aã]o (tenho|temos) interesse|sem interesse|n[aã]o quero|n[aã]o queremos|n[aã]o (me )?(mande|manda|chame|chama)|^\s*n[aã]o\b[\s,.!]*(obrigad[oa])?[\s.!]*$/i;

export function rampa(diasComEnvio) {
  return diasComEnvio < 5 ? 5 : diasComEnvio < 10 ? 10 : 15;
}

export function nomeDoProvedor(lead) {
  let nome = String(lead.fantasia || lead.empresa || '').trim();
  let anterior = null;
  while (anterior !== nome) { // tira terminações jurídicas, inclusive compostas ("LTDA - EPP")
    anterior = nome;
    nome = nome.replace(/[\s,.-]+(LTDA|EIRELI|ME|EPP|S\/?A)\.?$/i, '').replace(/[\s.,-]+$/, '');
  }
  if (nome === nome.toUpperCase()) nome = nome.toLowerCase().replace(/(^|\s)\S/g, (l) => l.toUpperCase());
  return nome || 'vocês';
}

export function textoDaMensagem(lead, sorteio = Math.random()) {
  return TEXTOS[Math.floor(sorteio * TEXTOS.length)](nomeDoProvedor(lead));
}

export const querSair = (texto) => QUER_SAIR.test(String(texto || '').trim());

// menu/aviso automático: "Digite 1 para...", "1️⃣ Suporte", "Protocolo: ...", "assistente virtual"...
const ROBO = /\b(digite|op[cç](ao|ão|oes|ões)|escolha uma|menu|protocolo|atendimento autom|assistente virtual|atendente virtual|mensagem autom|resposta autom|hor[aá]rio de atendimento|retornaremos|aguarde)/i;
export function pareceRobo(texto) {
  const t = String(texto || '');
  const itens = (t.match(/(^|\n)\s*\*?\s*([1-9]️?⃣|[1-9]\s*[-–).:])/g) || []).length;
  return ROBO.test(t) || itens >= 2;
}

// Números que podem receber (na ordem). numeros = saída de comWhatsapp; origemDe(numero) = 'comercial'|'receita'
export function escolherNumeros(numeros, tipos, origemDe) {
  const bons = [];
  for (let i = 0; i < numeros.length; i++) {
    const origem = origemDe(numeros[i].numero);
    if (tipos[i] === 'api') continue;
    if (origem === 'comercial' || tipos[i] === 'pessoal') bons.push({ ...numeros[i], origem, tipo: tipos[i] });
  }
  return bons;
}

// números da fila com WhatsApp + tipo de conta + os escolhidos (não manda nada)
async function analisarLead(lead) {
  const numeros = await comWhatsapp(lead.celulares);
  const tipos = numeros.length ? await tiposDeConta(numeros.map((n) => n.pn)) : [];
  const origemDe = (n) => lead.origens[lead.celulares.indexOf(n)] || 'receita';
  return { numeros, tipos, escolhidos: escolherNumeros(numeros, tipos, origemDe) };
}

async function planilha(acao, dados = {}) {
  const r = await fetch(process.env.PLANILHA_URL, {
    method: 'POST', redirect: 'follow',
    body: JSON.stringify({ token: process.env.PLANILHA_TOKEN, acao, ...dados }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`planilha ${acao}: ${j.erro || 'erro'}`);
  return j;
}

export function criarProspeccao({ estado, salvarEstado, avisar, agoraBR }) {
  const w = () => {
    estado.whats ||= { contatos: {}, diasComEnvio: 0 };
    return estado.whats;
  };
  const minutoDoDia = ({ hora, minuto }) => hora * 60 + minuto;
  let ocupado = false;

  async function frear(motivo) {
    await gh.gravarVariavel('WHATS_LIGADO', 'nao').catch((e) => log.erro('whats freio', e.message));
    const s = w();
    s.fila = null; // ao religar, a fila do dia é buscada de novo
    salvarEstado(estado);
    log.erro('whats: FREIO', motivo);
    await avisar(`⛔ *WhatsApp de prospecção DESLIGADO automaticamente*\nMotivo: ${motivo}\nNada mais sai até alguém mandar *whats ligar*.`).catch(() => {});
  }

  async function limiteDoDia() {
    const configurado = Math.min(Number(await gh.lerVariavel('WHATS_LIMITE')) || LIMITE_MAXIMO, LIMITE_MAXIMO);
    return Math.min(configurado, rampa(w().diasComEnvio || 0));
  }

  // marcações que falharam (planilha fora do ar) são refeitas depois
  async function marcar(dados) {
    try {
      await planilha('marcar_whats', dados);
    } catch (e) {
      log.erro('whats marcar', e.message);
      (w().marcasPendentes ||= []).push(dados);
      salvarEstado(estado);
    }
  }

  async function refazerMarcas() {
    const s = w();
    if (!s.marcasPendentes?.length) return;
    const pendentes = s.marcasPendentes;
    s.marcasPendentes = [];
    salvarEstado(estado);
    for (const d of pendentes) await marcar(d);
  }

  // chamado a cada minuto pelo bot
  async function tique(agora = agoraBR(), relogio = Date.now()) {
    if (ocupado) return;
    ocupado = true;
    try {
      const s = w();
      await refazerMarcas();
      if (s.dia !== agora.dia) {
        Object.assign(s, { dia: agora.dia, fila: null, enviadosHoje: 0, semWhatsHoje: 0, soSuporteHoje: 0, extras: [], proximoEm: 0, resumoDado: false });
        limparContatosAntigos(relogio);
        salvarEstado(estado);
      }
      const m = minutoDoDia(agora);
      if (!agora.util || m < DESDE || m >= ATE || relogio < (s.proximoEm || 0)) return;
      if (s.fila && !s.fila.length && !s.extras?.length) return fecharDia();
      if ((await gh.lerVariavel('WHATS_LIGADO')) !== 'sim') return;

      if (!s.fila) {
        const restante = (await limiteDoDia()) - (s.enviadosHoje || 0); // religado no mesmo dia: só o que falta
        if (restante <= 0) { s.fila = []; salvarEstado(estado); return fecharDia(); }
        const { leads } = await planilha('whats_pendentes', { quantidade: restante, diasUteis: DIAS_UTEIS_DEPOIS_DO_EMAIL });
        s.fila = leads.filter((l) => !Object.values(s.contatos).some((c) => c.cnpj === l.cnpj));
        salvarEstado(estado);
        if (!s.fila.length) return log.info('whats: ninguém na fila hoje');
        await avisar(`💬 WhatsApp do dia começou: até ${s.fila.length} mensagem(ns), uma a cada ${INTERVALO_MIN}–${INTERVALO_MAX} min, até 17:30. Aviso quando terminar.`);
      }
      await enviarProximo(relogio);
    } catch (e) {
      log.erro('whats tique', e.message);
      w().proximoEm = relogio + 5 * 60_000; // planilha/GitHub instável: tenta de novo em 5 min
      salvarEstado(estado);
    } finally {
      ocupado = false;
    }
  }

  // manda pra um número e registra; false = WhatsApp recusou (já freou)
  async function mandarPara(lead, numero, relogio) {
    const s = w();
    const { pn, lid } = numero;
    try {
      await enviar(`${pn}@s.whatsapp.net`, textoDaMensagem(lead));
    } catch (e) {
      salvarEstado(estado);
      await frear(`o WhatsApp recusou uma mensagem (${e.message})`);
      return false;
    }
    s.contatos[pn] = { cnpj: lead.cnpj, nome: nomeDoProvedor(lead), lid, em: Math.floor(relogio / 1000), origem: numero.origem, tipo: numero.tipo };
    s.enviadosHoje = (s.enviadosHoje || 0) + 1;
    if (s.ultimoDiaComEnvio !== s.dia) {
      s.ultimoDiaComEnvio = s.dia;
      s.diasComEnvio = (s.diasComEnvio || 0) + 1;
    }
    s.proximoEm = relogio + (INTERVALO_MIN + Math.random() * (INTERVALO_MAX - INTERVALO_MIN)) * 60_000;
    salvarEstado(estado);
    log.info(`whats: mensagem ${s.enviadosHoje} do dia enviada`);
    const todos = Object.keys(s.contatos).filter((k) => s.contatos[k].cnpj === lead.cnpj && !s.contatos[k].teste);
    await marcar({ cnpj: lead.cnpj, para: todos.join(', '), status: 'Enviado' });
    return true;
  }

  async function enviarProximo(relogio) {
    const s = w();
    // números restantes de um provedor que tem mais de um
    while (s.extras?.length) {
      const { lead, numero } = s.extras.shift();
      salvarEstado(estado);
      const doProvedor = Object.values(s.contatos).filter((c) => c.cnpj === lead.cnpj);
      if (doProvedor.some((c) => c.respondeu)) continue; // uma pessoa já respondeu por outro número (menu automático não conta)
      if ((s.enviadosHoje || 0) >= (await limiteDoDia())) { s.extras = []; salvarEstado(estado); break; }
      if (!(await mandarPara(lead, numero, relogio))) { s.extras.unshift({ lead, numero }); salvarEstado(estado); }
      return;
    }
    while (s.fila.length) {
      const lead = s.fila.shift();
      salvarEstado(estado);
      if (!lead.origens) continue; // fila montada antes da regra do suporte: volta amanhã pela regra nova
      let numeros, tipos, escolhidos;
      try {
        ({ numeros, tipos, escolhidos } = await analisarLead(lead));
      } catch (e) {
        s.fila.unshift(lead);
        s.errosConsulta = (s.errosConsulta || 0) + 1;
        salvarEstado(estado);
        if (s.errosConsulta >= 2) return frear(`a consulta de números falhou 2 vezes seguidas (${e.message})`);
        throw e;
      }
      s.errosConsulta = 0;
      if (!numeros.length) {
        s.semWhatsHoje = (s.semWhatsHoje || 0) + 1;
        await marcar({ cnpj: lead.cnpj, para: lead.celulares.join(', '), status: 'Sem WhatsApp' });
        continue; // não conta no limite nem espera o intervalo
      }
      if (!escolhidos.length) {
        s.soSuporteHoje = (s.soSuporteHoje || 0) + 1;
        await marcar({ cnpj: lead.cnpj, para: numeros.map((n, i) => `${n.numero} (${tipos[i]})`).join(', '), status: 'Só suporte' });
        continue;
      }
      // não foi: o freio já desligou; o provedor não foi marcado e volta na fila quando religarem
      if (!(await mandarPara(lead, escolhidos[0], relogio))) return;
      (s.extras ||= []).push(...escolhidos.slice(1).map((numero) => ({ lead, numero })));
      salvarEstado(estado);
      return;
    }
    return fecharDia();
  }

  async function fecharDia() {
    const s = w();
    if (s.resumoDado) return;
    s.resumoDado = true;
    salvarEstado(estado);
    if (!s.enviadosHoje && !s.semWhatsHoje && !s.soSuporteHoje) return;
    await avisar(`💬 WhatsApp do dia concluído: *${s.enviadosHoje || 0}* enviada(s)` +
      (s.semWhatsHoje ? `, ${s.semWhatsHoje} provedor(es) sem WhatsApp nos números que temos` : '') +
      (s.soSuporteHoje ? `, ${s.soSuporteHoje} pulado(s) por só ter número de suporte/empresa` : '') +
      ((s.semWhatsHoje || s.soSuporteHoje) ? ' (marcados na aba alvo)' : '') + '.');
  }

  // mensagem 1:1 recebida (não do grupo): se for de alguém que prospectamos, trata a 1ª resposta
  async function mensagemRecebida(key, texto) {
    const s = w();
    const ids = [key.remoteJid, key.remoteJidAlt].filter(Boolean).map(usuario);
    const pn = Object.keys(s.contatos).find((k) => ids.includes(k) || (s.contatos[k].lid && ids.includes(s.contatos[k].lid)));
    if (!pn) return false;
    const c = s.contatos[pn];
    if (c.respondeu) return true; // da 2ª mensagem em diante, quem conversa é a pessoa no celular
    const trecho = texto ? `"${texto.slice(0, 200)}${texto.length > 200 ? '…' : ''}"` : '(mídia/áudio)';
    if (texto && pareceRobo(texto) && !querSair(texto)) { // menu automático: sem PDF, espera uma pessoa
      if (!c.robo) {
        c.robo = true;
        salvarEstado(estado);
        if (!c.teste) await marcar({ cnpj: c.cnpj, status: 'Robô respondeu', soStatus: true });
        await avisar(`🤖 *${c.nome}* respondeu com mensagem automática: ${trecho}\nNão mandei o PDF; se uma pessoa responder depois, aviso aqui.`);
      }
      return true;
    }
    c.respondeu = true;
    salvarEstado(estado);
    if (texto && querSair(texto)) {
      await enviar(`${pn}@s.whatsapp.net`, RESPOSTA_SAIR).catch((e) => log.erro('whats sair', e.message));
      s.extras = (s.extras || []).filter((x) => x.lead.cnpj !== c.cnpj);
      salvarEstado(estado);
      if (!c.teste) await marcar({ cnpj: c.cnpj, status: 'Não quer WhatsApp', soStatus: true });
      await avisar(`🙅 *${c.nome}* pediu pra não receber mais WhatsApp: ${trecho}\nMarcado na aba alvo; não mandamos mais nada.`);
      return true;
    }
    let pdf = '📎 PDF enviado.';
    try {
      await enviarDocumento(`${pn}@s.whatsapp.net`, PDF, PDF_NOME, PDF_LEGENDA);
    } catch (e) {
      log.erro('whats pdf', e.message);
      pdf = '⚠️ Não consegui mandar o PDF; mande pelo celular.';
    }
    if (!c.teste) await marcar({ cnpj: c.cnpj, status: 'Respondeu', soStatus: true });
    await avisar(`💬 *${c.nome}* respondeu no WhatsApp${c.teste ? ' (TESTE)' : ''}: ${trecho}\n${pdf}\nContinue a conversa pelo celular do bot (+${pn}).`);
    return true;
  }

  function limparContatosAntigos(relogio = Date.now()) {
    const s = w();
    const limite = Math.floor(relogio / 1000) - GUARDAR_CONTATO_DIAS * 86400;
    for (const [k, c] of Object.entries(s.contatos)) if (c.em < limite) delete s.contatos[k];
  }

  async function comando(args) {
    const sub = String(args[0] || 'status').toLowerCase();
    const s = w();
    if (sub === 'status' || sub === 'situacao' || sub === 'situação') {
      const [ligado, limite] = await Promise.all([gh.lerVariavel('WHATS_LIGADO'), limiteDoDia()]);
      limparContatosAntigos();
      const contatos = Object.values(s.contatos).filter((c) => !c.teste);
      return avisar(
        `💬 *WhatsApp de prospecção*\nAutomático: ${ligado === 'sim' ? '🟢 LIGADO (dias úteis 14:00–17:30)' : '🔴 DESLIGADO'}\n` +
          `Limite hoje: ${limite} (começa com 5; 10 após 5 dias com envio; 15 após 10)\n` +
          `Hoje: ${s.dia === agoraBR().dia ? s.enviadosHoje || 0 : 0} enviada(s)` + (s.fila?.length ? `, ${s.fila.length} na fila` : '') + '\n' +
          `Últimos ${GUARDAR_CONTATO_DIAS} dias: ${contatos.length} enviada(s), ${contatos.filter((c) => c.respondeu).length} resposta(s)`,
      );
    }
    if (sub === 'ligar' || sub === 'desligar') {
      await gh.gravarVariavel('WHATS_LIGADO', sub === 'ligar' ? 'sim' : 'nao');
      s.fila = null; // desligar: esvazia; ligar: busca a fila de novo (respeitando o que já saiu hoje)
      s.resumoDado = false;
      salvarEstado(estado);
      return avisar(sub === 'ligar'
        ? '🟢 WhatsApp de prospecção LIGADO: dias úteis das 14:00 às 17:30, só pra quem recebeu o e-mail há 2+ dias úteis. *whats desligar* pra parar.'
        : '🔴 WhatsApp de prospecção DESLIGADO. Nada sai até alguém mandar *whats ligar*.');
    }
    if (sub === 'limite') {
      const n = Number(args[1]);
      if (!Number.isInteger(n) || n < 1 || n > LIMITE_MAXIMO) return avisar(`Use um número de 1 a ${LIMITE_MAXIMO}. Ex.: *whats limite 10*`);
      await gh.gravarVariavel('WHATS_LIMITE', n);
      return avisar(`✅ Limite: ${n} por dia (a subida gradual continua valendo: hoje sai no máximo ${Math.min(n, rampa(s.diasComEnvio || 0))}).`);
    }
    if (sub === 'teste') {
      const numero = String(args[1] || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
      if (!/^\d{10,11}$/.test(numero)) return avisar('Ex.: *whats teste 11999998888* (com DDD)');
      const [achado] = await comWhatsapp([numero]);
      if (!achado) return avisar(`Esse número não tem WhatsApp (${numero}).`);
      const lead = { cnpj: 'TESTE', empresa: 'PROVEDOR TESTE LTDA' };
      await enviar(`${achado.pn}@s.whatsapp.net`, textoDaMensagem(lead));
      s.contatos[achado.pn] = { cnpj: 'TESTE', nome: 'Provedor Teste', lid: achado.lid, em: Math.floor(Date.now() / 1000), teste: true };
      salvarEstado(estado);
      return avisar(`🧪 Mensagem de TESTE enviada pra +${achado.pn}. Responda de lá pra ver o PDF chegando e o aviso aqui (nada é marcado na planilha).`);
    }
    if (sub === 'analisar') {
      const n = Math.min(Math.max(Number(args[1]) || 30, 1), 60);
      // diasUteis -1: todos que já receberam o e-mail, mesmo os que ainda não estão na vez (0 vira 2 na planilha)
      const { leads } = await planilha('whats_pendentes', { quantidade: n, diasUteis: -1 });
      const cont = { comercial: 0, receitaPessoal: 0, soSuporte: 0, semWhats: 0, api: 0, empresa: 0 };
      for (const lead of leads) {
        const { numeros, tipos, escolhidos } = await analisarLead(lead);
        const escolhido = escolhidos[0];
        tipos.forEach((t) => { if (t === 'api') cont.api++; else if (t === 'empresa') cont.empresa++; });
        if (!numeros.length) cont.semWhats++;
        else if (!escolhido) cont.soSuporte++;
        else if (escolhido.origem === 'comercial') cont.comercial++;
        else cont.receitaPessoal++;
      }
      return avisar(`🔎 *Análise de ${leads.length} provedor(es) que já receberam o e-mail* (inclui os que ainda não estão na vez; nada foi enviado)\n` +
        `✅ WhatsApp comercial do site: ${cont.comercial}\n✅ Celular pessoal (Receita, fora do site): ${cont.receitaPessoal}\n` +
        `⛔ Só suporte/empresa (pulados): ${cont.soSuporte}\n📵 Sem WhatsApp: ${cont.semWhats}\n` +
        `Números vistos: ${cont.empresa} WhatsApp Business, ${cont.api} plataforma de atendimento (robô).`);
    }
    return avisar('Opções: *whats*, *whats ligar*, *whats desligar*, *whats limite N*, *whats teste 11999998888*, *whats analisar 30*');
  }

  return { tique, mensagemRecebida, comando, frear, limparContatosAntigos };
}
