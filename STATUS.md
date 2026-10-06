# leads-provedores: status (02/10/2026)

Sistema de captação e prospecção de provedores de internet para o SVA SepiaStream.
Tudo roda online. O PC só guarda cópias do código e das chaves (`segredos/`, fora do git).

## Arquitetura

```
WhatsApp (grupo "sepiastream")  ←→  Bot no Discloud (Node, ~50 MB, 24/7)
                                         │ API do GitHub
                                         ▼
GitHub Actions (repo público sgveng3-lang/leads-provedores)
  raspar.yml  → 1x por mês, ÚLTIMO DIA do mês 06:00 BRT (disparado pelo bot; cron dias 28–31 12:00 é reserva): Anatel → OpenCNPJ → site do provedor → planilha
  filtrar.yml → 1x por mês, DIA 1º 06:00 BRT (disparado pelo bot; cron dia 1º 12:00 é reserva): PGFN (Dívida Ativa) x provedores pequenos → aba "alvo"
  enviar.yml  → disparado pelo BOT às 09:00 BRT em dias úteis (origem "diario", só com ENVIO_LIGADO=sim); cron 11:00 é só reserva e pula se o bot já enviou (o agendamento do GitHub atrasava ~5h40). E-mails pela API do Zoho
                                         │ Apps Script (App da Web)
                                         ▼
Google Sheets "Leads Provedores" (conta sgveng3@gmail.com)
```

## Estado atual

| Parte | Situação |
|---|---|
| Raspagem | ✅ Funcionando. 1ª rodada completa: 26/27 UFs, ~6.900 leads com e-mail. PB/MT/RS falharam (corrigido o retry); entram na próxima raspagem (último dia do mês). |
| Aba alvo | ✅ Desde 02/10/2026. Provedores pequenos (Anatel "Pequeno Porte", 200–20 mil acessos) cruzados com a Dívida Ativa da União (dados abertos da PGFN, trimestral; trimestre atual x 2 anos antes). Perfis: Pagando, Já quitou, Pagando em parte, Devendo, Devendo na Justiça, Em discussão. Porte/Simples/e-mail/CNAE pelas APIs de CNPJ (cache de 90 dias). Refeita todo dia 1º; colunas Status/Observações/Enviado em/Enviado para/Já enviado preservadas. 1ª execução: 936 provedores. |
| Planilha | ✅ Abas Provedores e Execuções. Controle de envio: **Já enviado (SIM/NÃO)**, Enviado em, Enviado para, Status. Colunas Status/Observações/Já enviado nunca são sobrescritas pela raspagem. |
| Envio de e-mails | ✅ **LIGADO desde 30/09/2026** (`ENVIO_LIGADO=sim`). **Desde 02/10/2026 a fila sai da aba alvo** (dívida ÷ acessos, maior primeiro; porte "Demais" só com até 5 mil acessos e CNAE 61) e o envio é marcado lá — as abas Provedores/Execuções não são mais alteradas pelo envio. Texto destaca redução de impostos e aumento de receita (nunca menciona a dívida). Bot dispara às 09:00 (se estava fora, até 16:00). Para: e-mail da Receita; Cc: e-mails do site (até 3). PDF anexado. Foco em 200–20 mil assinantes; ignora fiscal/contábil. 1 e-mail a cada 8–15 min, limite 15/dia. Trava contra repetição por CNPJ e por endereço. Descadastro em 1 clique. |
| Bot WhatsApp | ✅ Online no Discloud. Comandos: `raspar [UFs]`, `filtrar`, `status`, `cancelar`, `planilha`, `envio`, `envio ligar/desligar`, `envio limite N`, `envio agora N`, `envio teste email`, `ajuda`. |
| WhatsApp de prospecção | ✅ Desde 04/10/2026 (dias úteis 14:00–17:30, quem recebeu o e-mail há 2+ dias úteis). **Desde 06/10/2026 evita o número do suporte** (que responde com robô): só usa o "WhatsApp comercial" do site (número rotulado comercial/vendas, coluna nova da aba Provedores) e celulares da Receita que não aparecem no site; o bot ainda confere o tipo de conta — plataforma de atendimento (API) nunca, WhatsApp Business só se for o comercial do site, celular da Receita só se for WhatsApp comum. Sem número bom → "Só suporte". Provedor com mais de um número bom recebe em TODOS (um por rodada, contando no limite; para se uma pessoa do provedor responder; menu automático não para, segue pro próximo número). Resposta com menu automático → "Robô respondeu", sem PDF. `whats analisar 30` mostra a divisão da fila sem mandar nada. `filtro/contatos_alvo.py` revisita os sites da aba alvo fora da raspagem. |

## Próximos passos

1. Testar no grupo: `envio` e `envio teste kmeasnovi@gmail.com`.
2. Quando aprovar o texto: `envio ligar`. Subir o limite aos poucos: 15 → 20/25 → até 40/dia no máximo.
3. Acima de ~28 e-mails/dia: dividir o envio em 2 execuções (manhã/tarde), porque uma execução não comporta mais.
4. Opcional: "vigia" que avisa por e-mail se o bot do Discloud cair.

## Riscos combinados

- O envio usa `contato@sepiastream.com`, a mesma organização Zoho que recebe os leads do flyer. Envio em excesso pode bloquear a organização inteira. Por isso o ritmo é baixo.
- O GitHub desliga o agendamento de repositório público após 60 dias sem commit. O bot religa sozinho uma vez por semana.
- Se o celular do número do bot (11 91487-4852) ficar ~14 dias offline, o WhatsApp desconecta o bot, e é preciso parear de novo.

## Operação (sem precisar do PC)

- **Atualizar o bot:** zip só com `src/`, `package*.json` e `discloud.config` → API Discloud `PUT /v2/app/<id>/commit` + `/restart`. Não enviar `.auth`/`.env`: os do servidor são mantidos.
- **Nunca rodar o bot localmente** com o do Discloud online: os dois usariam a mesma sessão do WhatsApp.
