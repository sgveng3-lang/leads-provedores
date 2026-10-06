/**
 * Recebe os leads do scraper (GitHub Actions) e grava na planilha.
 *
 * Instalação: na planilha "Leads Provedores" → Extensões → Apps Script →
 * cole este arquivo inteiro em Código.gs → Configurações do projeto (⚙) →
 * Propriedades do script → adicione TOKEN = <conteúdo de segredos/token-planilha.txt>
 * → Implantar → Nova implantação → App da Web (Executar como: Eu; Quem pode
 * acessar: Qualquer pessoa) → copie a URL /exec.
 *
 * Sem o TOKEN certo nada é gravado. A URL sozinha não dá acesso a nada.
 *
 * Aba "Provedores": uma linha por CNPJ. O scraper atualiza as colunas de
 * dados; as colunas STATUS e OBSERVAÇÕES são suas e nunca são sobrescritas.
 * Aba "Execuções": uma linha por raspagem (log).
 */

const ABA_PROVEDORES = 'Provedores';
const ABA_EXECUCOES = 'Execuções';
const ABA_ALVO = 'alvo';

const COLUNAS = [
  'CNPJ', 'Empresa (Anatel)', 'Nome fantasia', 'Grupo econômico', 'Porte',
  'UF principal', 'UFs', 'Municípios', 'Acessos', 'Mês ref. Anatel',
  'E-mail (Receita)', 'Telefone (Receita)', 'Situação (Receita)',
  'Site', 'E-mails do site', 'WhatsApp', 'Telefones do site',
  'Status', 'Observações', 'Primeira captura', 'Atualizado em',
  'Enviado em', 'Enviado para', 'Já enviado',
  'WhatsApp comercial',
];
// colunas que o scraper nunca sobrescreve (suas + as do envio de e-mail)
const COLUNAS_DO_USUARIO = ['Status', 'Observações', 'Enviado em', 'Enviado para', 'Já enviado'];
const COLUNAS_EXECUCOES = ['Data', 'Pedido', 'Filtros', 'Provedores', 'Novos', 'Atualizados', 'Com e-mail', 'Com WhatsApp', 'Duração (min)'];

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.sair) return descadastrar_(String(p.sair), String(p.t || ''));
  return json_({ ok: true, servico: 'leads-provedores' });
}

// assinatura do link de descadastro: HMAC-SHA256(cnpj, TOKEN), 16 primeiros caracteres
function assinatura_(cnpj) {
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  const bytes = Utilities.computeHmacSha256Signature(cnpj, token);
  return Utilities.base64EncodeWebSafe(bytes).slice(0, 16);
}

function descadastrar_(cnpj, t) {
  const html = (msg) => HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;max-width:520px;margin:60px auto;text-align:center"><h2>' + msg + '</h2></div>');
  if (t !== assinatura_(cnpj)) return html('Link inválido.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const alvo = lerAba_(ABA_ALVO);
    const ia = alvo.linhas.findIndex((l) => l[0] === cnpj);
    if (ia >= 0) {
      alvo.aba.getRange(ia + 2, alvo.cab.indexOf('Status') + 1).setValue('Descadastrado');
    } else { // e-mails antigos, enviados pela aba Provedores
      const aba = aba_(ABA_PROVEDORES, COLUNAS);
      const n = aba.getLastRow() - 1;
      const cnpjs = n > 0 ? aba.getRange(2, 1, n, 1).getDisplayValues() : [];
      const i = cnpjs.findIndex((l) => l[0] === cnpj);
      if (i >= 0) aba.getRange(i + 2, COLUNAS.indexOf('Status') + 1).setValue('Descadastrado');
    }
  } finally {
    lock.releaseLock();
  }
  return html('Pronto! Você não vai receber mais e-mails nossos.');
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // duas raspagens ao mesmo tempo não se atropelam
  try {
    const corpo = JSON.parse(e.postData.contents);
    const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token || corpo.token !== token) return json_({ ok: false, erro: 'token inválido' });

    if (corpo.acao === 'upsert') return json_(upsert_(corpo.linhas || []));
    if (corpo.acao === 'execucao') return json_(registrarExecucao_(corpo.execucao || {}));
    if (corpo.acao === 'cnpjs') return json_({ ok: true, cnpjs: cnpjsExistentes_() });
    if (corpo.acao === 'pendentes') return json_(corpo.aba === ABA_ALVO ? pendentesAlvo_(corpo.quantidade || 20) : pendentes_(corpo.quantidade || 20));
    if (corpo.acao === 'coluna_alvo') return json_(colunaAlvo_(corpo.nome, corpo.valores || {}));
    if (corpo.acao === 'aba_alvo') return json_(gravarAlvo_(corpo.cabecalho || [], corpo.linhas || [], corpo.formatos || {}));
    if (corpo.acao === 'contatos_alvo') return json_(contatosAlvo_());
    if (corpo.acao === 'whats_pendentes') return json_(whatsPendentes_(corpo.quantidade || 15, corpo.diasUteis || 2));
    if (corpo.acao === 'marcar_whats') return json_(marcarWhats_(corpo.cnpj, corpo.para, corpo.status, corpo.soStatus));
    if (corpo.acao === 'marcar_enviado') return json_(corpo.aba === ABA_ALVO ? marcarEnviadoAlvo_(corpo.cnpj, corpo.para, corpo.status) : marcarEnviado_(corpo.cnpj, corpo.para, corpo.status));
    return json_({ ok: false, erro: 'ação desconhecida' });
  } catch (erro) {
    return json_({ ok: false, erro: String(erro) });
  } finally {
    lock.releaseLock();
  }
}

function aba_(nome, cabecalho) {
  const planilha = SpreadsheetApp.getActiveSpreadsheet();
  let aba = planilha.getSheetByName(nome);
  if (!aba) {
    aba = planilha.insertSheet(nome);
    aba.getRange(1, 1, 1, cabecalho.length).setValues([cabecalho]).setFontWeight('bold');
    aba.setFrozenRows(1);
  }
  return aba;
}

function cnpjsExistentes_() {
  const aba = aba_(ABA_PROVEDORES, COLUNAS);
  const n = aba.getLastRow() - 1;
  if (n < 1) return [];
  return aba.getRange(2, 1, n, 1).getDisplayValues().map((l) => l[0]);
}

function upsert_(linhas) {
  const aba = aba_(ABA_PROVEDORES, COLUNAS);
  aba.getRange(1, 1, 1, COLUNAS.length).setValues([COLUNAS]).setFontWeight('bold');
  const agora = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd HH:mm');
  const total = aba.getLastRow() - 1;
  const atuais = total > 0 ? aba.getRange(2, 1, total, COLUNAS.length).getValues() : [];
  const indicePorCnpj = {};
  atuais.forEach((l, i) => { indicePorCnpj[String(l[0])] = i; });

  let novos = 0, atualizados = 0;
  linhas.forEach((dados) => {
    const cnpj = String(dados['CNPJ'] || '');
    if (!cnpj) return;
    const i = indicePorCnpj[cnpj];
    if (i === undefined) {
      const linha = COLUNAS.map((c) => (c === 'Primeira captura' || c === 'Atualizado em') ? agora
        : (c === 'Status' ? 'Novo' : (c === 'Já enviado' ? 'NÃO' : (dados[c] ?? ''))));
      atuais.push(linha);
      indicePorCnpj[cnpj] = atuais.length - 1;
      novos++;
    } else {
      COLUNAS.forEach((c, j) => {
        if (COLUNAS_DO_USUARIO.includes(c) || c === 'Primeira captura') return;
        if (c === 'Atualizado em') { atuais[i][j] = agora; return; }
        // não apaga um dado bom com um vazio (ex.: site fora do ar nesta rodada)
        if (dados[c] !== undefined && dados[c] !== '') atuais[i][j] = dados[c];
      });
      atualizados++;
    }
  });

  if (atuais.length) {
    const intervalo = aba.getRange(2, 1, atuais.length, COLUNAS.length);
    intervalo.setNumberFormat('@'); // CNPJ e telefones como texto (sem perder zeros)
    intervalo.setValues(atuais);
  }
  return { ok: true, novos: novos, atualizados: atualizados, total: atuais.length };
}

// Próximos leads pra receber e-mail: Status "Novo" (ou vazio), sem envio anterior,
// com algum e-mail. Maiores provedores primeiro.
function pendentes_(quantidade) {
  const aba = aba_(ABA_PROVEDORES, COLUNAS);
  aba.getRange(1, 1, 1, COLUNAS.length).setValues([COLUNAS]).setFontWeight('bold');
  const n = aba.getLastRow() - 1;
  if (n < 1) return { ok: true, leads: [], enviados: [] };
  const col = {};
  COLUNAS.forEach((c, i) => { col[c] = i; });
  const linhas = aba.getRange(2, 1, n, COLUNAS.length).getDisplayValues();

  // "Já enviado" = SIM é o controle; linhas antigas sem a coluna preenchida contam
  // como SIM se já têm data de envio (e a planilha é corrigida aqui mesmo)
  const jaEnviado = linhas.map((l) => l[col['Já enviado']] === 'SIM' || (!!l[col['Enviado em']]));
  const corrigir = linhas.map((l, i) => [jaEnviado[i] ? 'SIM' : (l[col['Já enviado']] || 'NÃO')]);
  aba.getRange(2, col['Já enviado'] + 1, n, 1).setValues(corrigir);

  // endereços que já receberam e-mail (por qualquer CNPJ): o envio não repete
  const enviados = linhas.map((l) => String(l[col['Enviado para']] || '').replace(/^RECUSADO\s+|^REPETIDO\s+/, '').toLowerCase())
    .filter((e) => e.includes('@'));

  const leads = linhas
    .filter((l, i) => !jaEnviado[i] && ['', 'Novo'].includes(l[col['Status']])
      && (l[col['E-mails do site']] || l[col['E-mail (Receita)']]))
    .map((l) => ({
      cnpj: l[col['CNPJ']], empresa: l[col['Empresa (Anatel)']], fantasia: l[col['Nome fantasia']],
      uf: l[col['UF principal']], municipios: l[col['Municípios']], acessos: Number(String(l[col['Acessos']]).replace(/\D/g, '')) || 0,
      emailReceita: l[col['E-mail (Receita)']], emailsSite: l[col['E-mails do site']],
    }))
    .sort((a, b) => b.acessos - a.acessos)
    .slice(0, quantidade);
  // assinatura do descadastro só pros escolhidos (calcular pra milhares estoura o tempo do Google)
  leads.forEach((lead) => { lead.sair = assinatura_(lead.cnpj); });
  return { ok: true, leads: leads, enviados: Array.from(new Set(enviados)) };
}

// Aba "alvo": provedores pequenos cruzados com a Dívida Ativa da União (PGFN).
// É recriada a cada gravação, mas as colunas de controle (CONTROLE_ALVO) são
// preservadas por CNPJ. É dela que sai a fila do envio de e-mails.
// As abas Provedores e Execuções só são LIDAS aqui, nunca alteradas.
// formatos = { "<índice da coluna>": "<formato de número>" }
// WhatsApp em / para / status: prospecção pelo WhatsApp do bot (só quem já recebeu o e-mail).
const CONTROLE_ALVO = ['Status', 'Observações', 'Enviado em', 'Enviado para', 'Já enviado',
  'WhatsApp em', 'WhatsApp para', 'WhatsApp status'];

function lerAba_(nome) {
  const aba = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nome);
  if (!aba || aba.getLastRow() < 2) return { aba: aba, cab: [], linhas: [] };
  const valores = aba.getRange(1, 1, aba.getLastRow(), aba.getLastColumn()).getDisplayValues();
  return { aba: aba, cab: valores[0], linhas: valores.slice(1) };
}

function gravarAlvo_(cabecalho, linhas, formatos) {
  // "E-mails do site" vem da aba Provedores (pelo CNPJ), logo após "E-mail (Receita)";
  // de lá também vem quem já recebeu e-mail ou se descadastrou (só leitura)
  const prov = lerAba_(ABA_PROVEDORES);
  const pc = {};
  prov.cab.forEach((c, i) => { pc[c] = i; });
  const provPorCnpj = {};
  prov.linhas.forEach((l) => { provPorCnpj[l[0]] = l; });
  if (!cabecalho.includes('E-mails do site')) {
    let pos = cabecalho.indexOf('E-mail (Receita)') + 1;
    if (pos === 0) pos = cabecalho.length;
    cabecalho = cabecalho.slice(0, pos).concat(['E-mails do site'], cabecalho.slice(pos));
    linhas = linhas.map((l) => {
      const p = provPorCnpj[String(l[0])];
      return l.slice(0, pos).concat([p ? p[pc['E-mails do site']] : ''], l.slice(pos));
    });
  }

  // controle já existente na aba alvo (preservado)
  const atual = lerAba_(ABA_ALVO);
  const controlePorCnpj = {};
  const ac = CONTROLE_ALVO.map((c) => atual.cab.indexOf(c));
  // basta o controle do e-mail existir; colunas de controle mais novas (WhatsApp) que faltem vêm vazias
  if (ac.slice(0, 5).every((i) => i >= 0)) atual.linhas.forEach((l) => { controlePorCnpj[l[0]] = ac.map((i) => (i >= 0 ? l[i] : '')); });

  linhas = linhas.map((l) => {
    const cnpj = String(l[0]);
    let ctrl = controlePorCnpj[cnpj];
    if (!ctrl) {
      const p = provPorCnpj[cnpj];
      const jaRecebeu = !!p && (p[pc['Já enviado']] === 'SIM' || !!p[pc['Enviado em']]);
      const descad = !!p && p[pc['Status']] === 'Descadastrado';
      ctrl = [descad ? 'Descadastrado' : (jaRecebeu ? 'Enviado (aba Provedores)' : 'Novo'), '',
        jaRecebeu ? p[pc['Enviado em']] : '', jaRecebeu ? p[pc['Enviado para']] : '', jaRecebeu ? 'SIM' : 'NÃO', '', '', ''];
    }
    return l.concat(ctrl);
  });
  cabecalho = cabecalho.concat(CONTROLE_ALVO);

  const aba = atual.aba || SpreadsheetApp.getActiveSpreadsheet().insertSheet(ABA_ALVO);
  if (aba.getFilter()) aba.getFilter().remove();
  aba.clear();
  aba.getRange(1, 1, 1, cabecalho.length).setValues([cabecalho]).setFontWeight('bold');
  aba.setFrozenRows(1);
  if (linhas.length) {
    aba.getRange(2, 1, linhas.length, 1).setNumberFormat('@'); // CNPJ como texto
    aba.getRange(2, 1, linhas.length, cabecalho.length).setValues(linhas);
    Object.keys(formatos).forEach((k) => aba.getRange(2, Number(k) + 1, linhas.length, 1).setNumberFormat(formatos[k]));
    const iPrio = cabecalho.indexOf('Prioridade');
    if (iPrio >= 0) {
      const cores = { 'Alta': '#c6efce', 'Média': '#ffeb9c', 'Baixa': '#f2dcdb' };
      aba.getRange(2, iPrio + 1, linhas.length, 1).setBackgrounds(linhas.map((l) => [cores[l[iPrio]] || null]));
    }
  }
  aba.getRange(1, 1, linhas.length + 1, cabecalho.length).createFilter();
  aba.autoResizeColumns(1, cabecalho.length);
  return { ok: true, linhas: linhas.length, colunas: cabecalho.length };
}

// número de "R$ 1.234,56" / "2.885" / "1,234.56" / "1234.56" (a planilha exibe no formato do Brasil)
function numero_(texto) {
  let s = String(texto || '').replace(/[^\d,.-]/g, '');
  const v = s.lastIndexOf(','), p = s.lastIndexOf('.');
  if (v >= 0 && p >= 0) s = v > p ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (p >= 0 && /^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  else if (v >= 0) s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  return Number(s) || 0;
}

// Porte "Demais" na Receita (fora de ME/EPP) só entra no envio se for provedor de verdade:
// até DEMAIS_MAX_ACESSOS acessos e atividade principal de telecomunicação (CNAE divisão 61).
const DEMAIS_MAX_ACESSOS = 5000;
function entraNoEnvio_(porte, acessos, cnae) {
  if (porte !== 'Demais') return true;
  return acessos <= DEMAIS_MAX_ACESSOS && /^61/.test(String(cnae || '').trim());
}

// Fila do envio a partir da aba alvo: provedor MENOR com dívida MAIOR primeiro
// (dívida por assinante = dívida atual ÷ acessos; quem já quitou usa a dívida de 2024).
function pendentesAlvo_(quantidade) {
  const alvo = lerAba_(ABA_ALVO);
  if (!alvo.linhas.length) return { ok: true, aba: ABA_ALVO, leads: [], enviados: [] };
  const c = {};
  alvo.cab.forEach((n, i) => { c[n] = i; });
  // endereços que já receberam e-mail (aba alvo + aba Provedores, só leitura)
  const prov = lerAba_(ABA_PROVEDORES);
  const ep = prov.cab.indexOf('Enviado para');
  const enviados = alvo.linhas.map((l) => l[c['Enviado para']])
    .concat(ep >= 0 ? prov.linhas.map((l) => l[ep]) : [])
    .map((e) => String(e || '').replace(/^RECUSADO\s+|^REPETIDO\s+/, '').toLowerCase())
    .filter((e) => e.includes('@'));

  const leads = alvo.linhas
    .filter((l) => l[c['Já enviado']] !== 'SIM' && !l[c['Enviado em']] && ['', 'Novo'].includes(l[c['Status']])
      && (l[c['E-mails do site']] || l[c['E-mail (Receita)']])
      && entraNoEnvio_(l[c['Porte (Receita)']], numero_(l[c['Acessos']]), l[c['Atividade principal (CNAE)']]))
    .map((l) => {
      const acessos = numero_(l[c['Acessos']]);
      const atual = ['Pagando (R$)', 'Em cobrança (R$)', 'Em cobrança na Justiça (R$)', 'Em discussão (R$)']
        .reduce((s, n) => s + numero_(l[c[n]]), 0);
      const divida = atual || numero_(l[c['Dívida em 2024 (R$)']]);
      return {
        cnpj: l[c['CNPJ']], empresa: l[c['Empresa (Anatel)']], fantasia: '', uf: l[c['UF']],
        municipios: l[c['Municípios']], acessos: acessos,
        emailReceita: l[c['E-mail (Receita)']], emailsSite: l[c['E-mails do site']],
        _pontos: divida / Math.max(acessos, 1),
      };
    })
    .sort((a, b) => b._pontos - a._pontos)
    .slice(0, quantidade);
  leads.forEach((lead) => { lead.sair = assinatura_(lead.cnpj); delete lead._pontos; });
  return { ok: true, aba: ABA_ALVO, leads: leads, enviados: Array.from(new Set(enviados)) };
}

// Só leitura: situação do e-mail de cada linha da aba alvo + telefones da aba Provedores
// (Receita, WhatsApp do site e telefones do site), pelo CNPJ
function contatosAlvo_() {
  const alvo = lerAba_(ABA_ALVO);
  const c = {};
  alvo.cab.forEach((n, i) => { c[n] = i; });
  const prov = lerAba_(ABA_PROVEDORES);
  const pc = {};
  prov.cab.forEach((n, i) => { pc[n] = i; });
  const provPorCnpj = {};
  prov.linhas.forEach((l) => { provPorCnpj[l[0]] = l; });
  const campo = (l, mapa, nome) => (l && mapa[nome] !== undefined ? l[mapa[nome]] : '');
  const linhas = alvo.linhas.map((l) => {
    const p = provPorCnpj[l[c['CNPJ']]];
    return {
      cnpj: l[c['CNPJ']], status: campo(l, c, 'Status'), enviadoEm: campo(l, c, 'Enviado em'),
      jaEnviado: campo(l, c, 'Já enviado'), telReceita: campo(p, pc, 'Telefone (Receita)'),
      whatsSite: campo(p, pc, 'WhatsApp'), telSite: campo(p, pc, 'Telefones do site'),
      whatsComercial: campo(p, pc, 'WhatsApp comercial'), site: campo(p, pc, 'Site'),
    };
  });
  return { ok: true, aba: ABA_ALVO, linhas: linhas };
}

// Atualiza (ou cria, antes das colunas de controle) uma coluna de dados da aba alvo
// pelo CNPJ, sem regravar o resto. valores = { "<CNPJ>": "<valor>" }
function colunaAlvo_(nome, valores) {
  if (!nome || CONTROLE_ALVO.includes(nome)) return { ok: false, erro: 'coluna inválida' };
  const alvo = lerAba_(ABA_ALVO);
  if (!alvo.aba || !alvo.linhas.length) return { ok: false, erro: 'aba alvo vazia' };
  let j = alvo.cab.indexOf(nome);
  if (j < 0) {
    const antes = alvo.cab.indexOf(CONTROLE_ALVO[0]);
    if (antes >= 0) { alvo.aba.insertColumnBefore(antes + 1); j = antes; } else j = alvo.cab.length;
    alvo.aba.getRange(1, j + 1).setValue(nome).setFontWeight('bold');
    if (alvo.aba.getFilter()) alvo.aba.getFilter().remove();
    alvo.aba.getRange(1, 1, alvo.linhas.length + 1, alvo.cab.length + 1).createFilter();
  }
  const atuais = alvo.aba.getRange(2, j + 1, alvo.linhas.length, 1).getDisplayValues();
  let n = 0;
  const novos = alvo.linhas.map((l, i) => {
    if (Object.prototype.hasOwnProperty.call(valores, l[0])) { n++; return [valores[l[0]]]; }
    return [(atuais[i] || [''])[0]];
  });
  alvo.aba.getRange(2, j + 1, novos.length, 1).setValues(novos);
  return { ok: true, atualizados: n };
}

// ---------------- WhatsApp (bot) ----------------
// Celulares de um texto livre: "(37) 9999-8888 / +55 37 99999-8888" → ["37999998888", ...].
// A Receita ainda guarda celular no formato antigo (8 dígitos, sem o 9 na frente): acrescenta o 9.
function celulares_(texto) {
  return (String(texto || '').match(/\+?[\d()\s.-]{10,20}/g) || [])
    .map((t) => t.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, ''))
    .map((n) => (n.length === 10 && /[6-9]/.test(n[2]) ? n.slice(0, 2) + '9' + n.slice(2) : n))
    .filter((n) => n.length === 11 && n[2] === '9');
}

// dias úteis (seg–sex) entre "yyyy-MM-dd HH:mm" e hoje (hoje não conta)
function diasUteisDesde_(texto) {
  const m = String(texto || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return -1;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const hoje = new Date(Utilities.formatDate(new Date(), 'America/Sao_Paulo', "yyyy-MM-dd'T'00:00:00"));
  let n = 0;
  for (d.setDate(d.getDate() + 1); d < hoje; d.setDate(d.getDate() + 1)) if (d.getDay() % 6) n++;
  return n;
}

// Finais (8 últimos dígitos) de todos os telefones de um texto, fixos ou celulares
function finais_(texto) {
  return (String(texto || '').match(/(\+?55[\s.-]?)?\(?0?\d{2}\)?[\s.-]?9?[\s.]?\d{4}[\s.-]?\d{4}\b/g) || [])
    .map((t) => t.replace(/\D/g, '').slice(-8));
}

// Fila do WhatsApp: quem recebeu o e-mail há pelo menos N dias úteis (endereço aceito),
// segue com Status "Enviado" (você não mexeu), ainda não teve WhatsApp e tem celular.
// Evita o SUPORTE (que cai em robô): só entram o WhatsApp que o site rotula como comercial/vendas
// e celulares da Receita que NÃO aparecem no site (no site ficam os números do atendimento;
// o da Receita, quando é outro, costuma ser de quem abriu a empresa). WhatsApp genérico do site
// e telefones do site sem rótulo ficam de fora. origens[i] diz de onde veio celulares[i].
// E-mail mais antigo primeiro.
function whatsPendentes_(quantidade, diasUteis) {
  const alvo = lerAba_(ABA_ALVO);
  if (!alvo.linhas.length) return { ok: true, aba: ABA_ALVO, leads: [] };
  const c = {};
  alvo.cab.forEach((n, i) => { c[n] = i; });
  const prov = lerAba_(ABA_PROVEDORES);
  const pc = {};
  prov.cab.forEach((n, i) => { pc[n] = i; });
  const provPorCnpj = {};
  prov.linhas.forEach((l) => { provPorCnpj[l[0]] = l; });
  const campo = (l, mapa, nome) => (l && mapa[nome] !== undefined ? l[mapa[nome]] : '');
  const leads = [];
  alvo.linhas.forEach((l) => {
    if (!['Enviado', 'Enviado (aba Provedores)'].includes(l[c['Status']])) return;
    if (/^(RECUSADO|REPETIDO)\b/.test(String(l[c['Enviado para']] || ''))) return;
    if (campo(l, c, 'WhatsApp status')) return;
    if (diasUteisDesde_(l[c['Enviado em']]) < diasUteis) return;
    const p = provPorCnpj[l[c['CNPJ']]];
    const comerciais = celulares_(campo(p, pc, 'WhatsApp comercial'));
    const doSite = {};
    finais_(campo(p, pc, 'WhatsApp') + ' ' + campo(p, pc, 'Telefones do site')).forEach((f) => { doSite[f] = true; });
    comerciais.forEach((n) => { delete doSite[n.slice(-8)]; });
    const daReceita = celulares_(campo(p, pc, 'Telefone (Receita)')).filter((n) => !doSite[n.slice(-8)]);
    const numeros = [], origens = [];
    comerciais.concat(daReceita).forEach((n, i) => {
      if (numeros.includes(n)) return;
      numeros.push(n);
      origens.push(i < comerciais.length ? 'comercial' : 'receita');
    });
    if (!numeros.length) return;
    leads.push({ cnpj: l[c['CNPJ']], empresa: l[c['Empresa (Anatel)']], fantasia: campo(p, pc, 'Nome fantasia'),
      celulares: numeros, origens: origens, enviadoEm: l[c['Enviado em']] });
  });
  // quem recebeu o e-mail há mais tempo vai primeiro
  leads.sort((a, b) => String(a.enviadoEm).localeCompare(String(b.enviadoEm)));
  return { ok: true, aba: ABA_ALVO, leads: leads.slice(0, quantidade) };
}

// Marca o WhatsApp de uma linha da aba alvo (cria as colunas no fim, se ainda não existirem).
// soStatus = true: só troca o "WhatsApp status" (ex.: "Respondeu"), sem mexer na data/número.
function marcarWhats_(cnpj, para, status, soStatus) {
  const alvo = lerAba_(ABA_ALVO);
  const i = alvo.linhas.findIndex((l) => l[0] === cnpj);
  if (i < 0) return { ok: false, erro: 'cnpj não encontrado na aba alvo' };
  const col = (nome) => {
    let j = alvo.cab.indexOf(nome);
    if (j < 0) {
      j = alvo.cab.length;
      alvo.aba.getRange(1, j + 1).setValue(nome).setFontWeight('bold');
      alvo.cab.push(nome);
    }
    return j + 1;
  };
  const linha = i + 2;
  if (!soStatus) {
    alvo.aba.getRange(linha, col('WhatsApp em')).setValue(Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd HH:mm'));
    alvo.aba.getRange(linha, col('WhatsApp para')).setNumberFormat('@').setValue(para || '');
  }
  alvo.aba.getRange(linha, col('WhatsApp status')).setValue(status || 'Enviado');
  return { ok: true };
}

function marcarEnviadoAlvo_(cnpj, para, status) {
  const alvo = lerAba_(ABA_ALVO);
  const i = alvo.linhas.findIndex((l) => l[0] === cnpj);
  if (i < 0) return { ok: false, erro: 'cnpj não encontrado na aba alvo' };
  const col = (n) => alvo.cab.indexOf(n) + 1;
  const agora = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd HH:mm');
  const linha = i + 2;
  alvo.aba.getRange(linha, col('Status')).setValue(status || 'Enviado');
  alvo.aba.getRange(linha, col('Já enviado')).setValue('SIM');
  alvo.aba.getRange(linha, col('Enviado em')).setValue(agora);
  alvo.aba.getRange(linha, col('Enviado para')).setValue(para || '');
  return { ok: true };
}

function marcarEnviado_(cnpj, para, status) {
  const aba = aba_(ABA_PROVEDORES, COLUNAS);
  const n = aba.getLastRow() - 1;
  const cnpjs = n > 0 ? aba.getRange(2, 1, n, 1).getDisplayValues() : [];
  const i = cnpjs.findIndex((l) => l[0] === cnpj);
  if (i < 0) return { ok: false, erro: 'cnpj não encontrado' };
  const linha = i + 2;
  const agora = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd HH:mm');
  aba.getRange(linha, COLUNAS.indexOf('Status') + 1).setValue(status || 'Enviado');
  aba.getRange(linha, COLUNAS.indexOf('Já enviado') + 1).setValue('SIM');
  aba.getRange(linha, COLUNAS.indexOf('Enviado em') + 1).setValue(agora);
  aba.getRange(linha, COLUNAS.indexOf('Enviado para') + 1).setValue(para || '');
  return { ok: true };
}

function registrarExecucao_(ex) {
  const aba = aba_(ABA_EXECUCOES, COLUNAS_EXECUCOES);
  const agora = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd HH:mm');
  aba.appendRow([agora, ex.pedido || '', ex.filtros || '', ex.provedores || 0, ex.novos || 0,
    ex.atualizados || 0, ex.comEmail || 0, ex.comWhatsapp || 0, ex.duracaoMin || 0]);
  return { ok: true, url: SpreadsheetApp.getActiveSpreadsheet().getUrl() };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
