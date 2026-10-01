# leads-provedores: status (29/09/2026)

Sistema de captação e prospecção de provedores de internet para o SVA SepiaStream.
Tudo roda online. O PC só guarda cópias do código e das chaves (`segredos/`, fora do git).

## Arquitetura

```
WhatsApp (grupo "sepiastream")  ←→  Bot no Discloud (Node, ~50 MB, 24/7)
                                         │ API do GitHub
                                         ▼
GitHub Actions (repo público sgveng3-lang/leads-provedores)
  raspar.yml  → toda segunda 06:00 BRT: Anatel → OpenCNPJ → site do provedor → planilha
  enviar.yml  → disparado pelo BOT às 09:00 BRT em dias úteis (origem "diario", só com ENVIO_LIGADO=sim); cron 11:00 é só reserva e pula se o bot já enviou (o agendamento do GitHub atrasava ~5h40). E-mails pela API do Zoho
                                         │ Apps Script (App da Web)
                                         ▼
Google Sheets "Leads Provedores" (conta sgveng3@gmail.com)
```

## Estado atual

| Parte | Situação |
|---|---|
| Raspagem | ✅ Funcionando. 1ª rodada completa: 26/27 UFs, ~6.900 leads com e-mail. PB/MT/RS falharam (corrigido o retry); entram na próxima segunda. |
| Planilha | ✅ Abas Provedores e Execuções. Controle de envio: **Já enviado (SIM/NÃO)**, Enviado em, Enviado para, Status. Colunas Status/Observações/Já enviado nunca são sobrescritas pela raspagem. |
| Envio de e-mails | ✅ **LIGADO desde 30/09/2026** (`ENVIO_LIGADO=sim`). Bot dispara às 09:00 (se estava fora, até 16:00). Para: e-mail da Receita; Cc: e-mails do site (até 3). PDF anexado. Foco em 200–20 mil assinantes; ignora fiscal/contábil. 1 e-mail a cada 8–15 min, limite 15/dia. Trava contra repetição por CNPJ e por endereço. Descadastro em 1 clique. |
| Bot WhatsApp | ✅ Online no Discloud. Comandos: `raspar [UFs]`, `status`, `cancelar`, `planilha`, `envio`, `envio ligar/desligar`, `envio limite N`, `envio agora N`, `envio teste email`, `ajuda`. |

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
