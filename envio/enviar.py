"""Envio de e-mails de prospecção em ritmo lento (roda no GitHub Actions).

    python envio/enviar.py --limite 15            # envia de verdade
    python envio/enviar.py --limite 3 --simular   # só monta e mostra (local)

Pega da planilha os próximos leads com Status "Novo" e e-mail, manda UM
e-mail por provedor, espera alguns minutos entre um e outro (ritmo humano,
pra não ser tratado como disparo em massa) e marca "Enviado" na planilha na
hora. Descadastro = link no rodapé → Status "Descadastrado" pra sempre.

Configuração (GitHub Secrets / variáveis de ambiente):
    PLANILHA_URL, PLANILHA_TOKEN            (mesmos do scraper)
    Zoho Mail pela API (funciona no plano GRATUITO) — ver envio/zoho.py:
        ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_REMETENTE
    ou SMTP (planos pagos): SMTP_HOST, SMTP_PORT, SMTP_USUARIO, SMTP_SENHA
    REMETENTE_NOME (ex.: "Kmeas · SepiaStream")

Repositório público: o log só mostra contagens, nunca e-mail/nome de provedor.
"""

import argparse
import json
import os
import random
import re
import smtplib
import ssl
import sys
import time
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scraper"))
from planilha import Planilha  # noqa: E402
from zoho import EnvioRecusado, ZohoMail  # noqa: E402

FLYER = "https://flyer.sepiastream.com"
ANEXO_PADRAO = Path(__file__).resolve().parent / "anexos" / "SepiaStream_SVA_Provedores.pdf"

# prioridade de e-mail: institucional do site (comercial/contato...) > Receita
PREFERENCIA = ("comercial", "vendas", "contato", "atendimento", "sac", "diretoria", "adm", "financeiro")


# e-mail de escritório de contabilidade/jurídico/fiscal: ninguém ali lê proposta comercial
RE_NAO_COMERCIAL = re.compile(r"fiscal|contab|contador|societ|juridic|nfe|nf-e|notas?fisc|escrit|dp|rh|tribut|cobranca|boleto", re.I)


def escolher_email(lead):
    """E-mail comercial do provedor, ou None se só houver endereço de contabilidade/fiscal."""
    candidatos = [e.strip() for e in (lead.get("emailsSite") or "").split(",") if "@" in e]
    candidatos.sort(key=lambda e: next((i for i, p in enumerate(PREFERENCIA) if e.startswith(p)), 99))
    receita = (lead.get("emailReceita") or "").strip()
    if "@" in receita:
        candidatos.append(receita)
    bons = [e for e in candidatos if not RE_NAO_COMERCIAL.search(e.split("@")[0])]
    return bons[0] if bons else None


def nome_do_provedor(lead):
    nome = (lead.get("fantasia") or lead.get("empresa") or "").strip()
    nome = re.sub(r"\s+(LTDA|EIRELI|ME|EPP|S/?A)\.?(\s*-\s*ME)?$", "", nome, flags=re.I)
    return nome.title() if nome.isupper() else nome


def cidade(lead):
    primeiro = (lead.get("municipios") or "").split(",")[0].split("(")[0].strip()
    return primeiro or lead.get("uf", "")


def montar(lead, remetente, url_planilha):
    nome = nome_do_provedor(lead)
    acessos = int(lead.get("acessos") or 0)
    base = f"cerca de {acessos:,}".replace(",", ".") + " assinantes" if acessos >= 100 else "seus assinantes"
    sair = f"{url_planilha}?{urlencode({'sair': lead['cnpj'], 't': lead['sair']})}"
    assunto = f"SVA de streaming pra {nome} — R$ 2,00 por assinante"
    texto = f"""Olá, equipe da {nome}!

Vi que vocês atendem {base} em {cidade(lead)} e queria apresentar o SepiaStream: um SVA de streaming (clássicos do cinema e animação) que o provedor inclui no plano por R$ 2,00 por licença.

• Zero infraestrutura do lado de vocês — o assinante assiste pelo navegador, no celular, TV ou computador.
• Ajuda na composição do plano entre internet e SVA.
• Ativação simples, por lista de assinantes.

Segue em anexo nossa apresentação (PDF, 2 páginas). A versão online tem os pacotes e um simulador com os números do provedor:
{FLYER}

Se fizer sentido, é só responder este e-mail que eu explico em 15 minutos.

{remetente}
SepiaStream — {FLYER}

--
Você recebeu este e-mail porque este endereço aparece como contato público da {nome} (cadastro do CNPJ ou site). Não quer receber mais? {sair}
"""
    html = texto.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    html = html.replace(FLYER, f'<a href="{FLYER}">{FLYER.replace("https://", "")}</a>')
    html = html.replace(sair.replace("&", "&amp;"), f'<a href="{sair}">descadastrar</a>')
    html = "<div style='font-family:Arial,sans-serif;font-size:14px;line-height:1.5'>" + html.replace("\n", "<br>") + "</div>"
    return assunto, texto, html


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limite", type=int, default=15, help="e-mails por execução")
    ap.add_argument("--intervalo-min", type=float, default=8, help="minutos mínimos entre e-mails")
    ap.add_argument("--intervalo-max", type=float, default=15, help="minutos máximos entre e-mails")
    ap.add_argument("--min-acessos", type=int, default=200, help="foco: provedores pequenos/médios")
    ap.add_argument("--max-acessos", type=int, default=20000)
    ap.add_argument("--simular", action="store_true", help="não envia nem marca; mostra os e-mails (uso local)")
    ap.add_argument("--anexo", default=str(ANEXO_PADRAO), help="PDF anexado em cada e-mail ('' = sem anexo)")
    ap.add_argument("--teste-para", default="", help="modo teste: manda TUDO pra este endereço e não marca na planilha")
    args = ap.parse_args()

    planilha = Planilha()
    # a planilha devolve os maiores primeiro; filtramos a faixa-alvo e os sem e-mail comercial aqui
    resposta = planilha._post({"acao": "pendentes", "quantidade": 800})
    ja_usados = {e.lower() for e in resposta.get("enviados", [])}
    leads, repetidos = [], []
    for lead in resposta["leads"]:
        email = escolher_email(lead)
        if not email or not args.min_acessos <= int(lead.get("acessos") or 0) <= args.max_acessos:
            continue
        if email.lower() in ja_usados:  # mesmo endereço de outro CNPJ já recebeu: não repete
            repetidos.append((lead, email))
            continue
        ja_usados.add(email.lower())
        leads.append(lead)
        if len(leads) >= args.limite:
            break
    if not args.simular and not args.teste_para:
        for lead, email in repetidos:
            planilha._post({"acao": "marcar_enviado", "cnpj": lead["cnpj"], "para": f"REPETIDO {email}", "status": "Endereço repetido"})
    if repetidos:
        print(f"endereços repetidos (marcados sem enviar): {len(repetidos)}")
    remetente = os.environ.get("REMETENTE_NOME", "Equipe SepiaStream")
    print(f"pendentes nesta execução: {len(leads)}")

    if args.simular:
        for lead in leads:
            assunto, texto, _ = montar(lead, remetente, planilha.url)
            print("=" * 70, f"\nPara: {escolher_email(lead)}\nAssunto: {assunto}\n\n{texto}")
        return

    usar_api = bool(os.environ.get("ZOHO_REFRESH_TOKEN"))
    zoho = ZohoMail() if usar_api else None
    usuario = zoho.remetente if zoho else os.environ["SMTP_USUARIO"]
    enviados = falhas = 0
    contexto = ssl.create_default_context()
    for i, lead in enumerate(leads):
        para = args.teste_para or escolher_email(lead)
        assunto, texto, html = montar(lead, remetente, planilha.url)
        if args.teste_para:
            assunto = "[TESTE] " + assunto
        try:
            if zoho:
                zoho.enviar(para, assunto, html, remetente, anexo=args.anexo or None)
            else:
                msg = EmailMessage()
                msg["From"] = formataddr((remetente, usuario))
                msg["To"] = para
                msg["Subject"] = assunto
                msg["Message-ID"] = make_msgid(domain=usuario.split("@")[-1])
                msg["List-Unsubscribe"] = f"<{planilha.url}?{urlencode({'sair': lead['cnpj'], 't': lead['sair']})}>"
                msg.set_content(texto)
                msg.add_alternative(html, subtype="html")
                if args.anexo:
                    msg.add_attachment(Path(args.anexo).read_bytes(), maintype="application", subtype="pdf",
                                       filename=Path(args.anexo).name)
                # uma conexão por e-mail: com minutos de intervalo, a sessão SMTP expiraria
                with smtplib.SMTP_SSL(os.environ.get("SMTP_HOST", "smtp.zoho.com"), int(os.environ.get("SMTP_PORT", "465")),
                                      context=contexto, timeout=60) as smtp:
                    smtp.login(usuario, os.environ["SMTP_SENHA"])
                    smtp.send_message(msg)
            if not args.teste_para:
                planilha._post({"acao": "marcar_enviado", "cnpj": lead["cnpj"], "para": para})
            enviados += 1
        except smtplib.SMTPRecipientsRefused:
            planilha._post({"acao": "marcar_enviado", "cnpj": lead["cnpj"], "para": f"RECUSADO {para}"})
            falhas += 1
        except (smtplib.SMTPException, OSError, EnvioRecusado, RuntimeError) as erro:
            # limite do provedor/autenticação/conexão: para o dia aqui (tenta de novo amanhã)
            print(f"parando: erro de envio ({type(erro).__name__}: {str(erro)[:80]})")
            falhas += 1
            break
        print(f"enviados: {enviados} | falhas: {falhas}")
        if i < len(leads) - 1 and not args.teste_para:
            time.sleep(random.uniform(args.intervalo_min, args.intervalo_max) * 60)

    resumo = f"envio: {enviados} enviados, {falhas} falhas, {len(leads)} pendentes selecionados"
    print(resumo)
    saida = Path(__file__).resolve().parent.parent / "_dados" / "resumo-envio.json"
    saida.parent.mkdir(exist_ok=True)
    saida.write_text(json.dumps({"enviados": enviados, "falhas": falhas, "selecionados": len(leads),
                                 "repetidos": len(repetidos), "teste": bool(args.teste_para)}), encoding="utf-8")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a", encoding="utf-8").write(f"### {resumo}\n")


if __name__ == "__main__":
    main()
