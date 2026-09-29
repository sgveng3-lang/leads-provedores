"""Envio pela API REST do Zoho Mail — funciona no plano GRATUITO (o SMTP não).

Autenticação OAuth "Self Client" (api-console.zoho.com), feita uma vez:
    python envio/zoho.py trocar-codigo   # troca o código gerado no console por um refresh token
Depois, cada execução pede um access token novo com o refresh token.

Variáveis: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_REMETENTE
(e-mail da caixa que envia). Conta nos EUA → domínios .com (accounts.zoho.com / mail.zoho.com).
"""

import os
import sys
from pathlib import Path

import requests

CONTAS = os.environ.get("ZOHO_ACCOUNTS", "https://accounts.zoho.com")
MAIL = os.environ.get("ZOHO_MAIL", "https://mail.zoho.com")
ESCOPOS = "ZohoMail.messages.CREATE,ZohoMail.accounts.READ"


class ZohoMail:
    def __init__(self):
        self.client_id = os.environ["ZOHO_CLIENT_ID"]
        self.client_secret = os.environ["ZOHO_CLIENT_SECRET"]
        self.refresh_token = os.environ["ZOHO_REFRESH_TOKEN"]
        self.remetente = os.environ["ZOHO_REMETENTE"].lower()
        self._token = None
        self._conta = None

    def _renovar(self):
        r = requests.post(f"{CONTAS}/oauth/v2/token", params={
            "refresh_token": self.refresh_token, "grant_type": "refresh_token",
            "client_id": self.client_id, "client_secret": self.client_secret,
        }, timeout=30)
        dados = r.json()
        if "access_token" not in dados:
            raise RuntimeError(f"Zoho recusou o refresh token: {dados.get('error', r.status_code)}")
        self._token = dados["access_token"]

    def _cabecalhos(self):
        if not self._token:
            self._renovar()
        return {"Authorization": f"Zoho-oauthtoken {self._token}", "Accept": "application/json"}

    def conta(self):
        if not self._conta:
            r = requests.get(f"{MAIL}/api/accounts", headers=self._cabecalhos(), timeout=30)
            r.raise_for_status()
            for c in r.json().get("data", []):
                enderecos = {c.get("primaryEmailAddress", "").lower()} | {
                    e.get("mailId", "").lower() for e in c.get("emailAddress", [])}
                if self.remetente in enderecos:
                    self._conta = c["accountId"]
                    break
            if not self._conta:
                raise RuntimeError("a caixa ZOHO_REMETENTE não pertence a este login do Zoho")
        return self._conta

    def enviar(self, para, assunto, html, nome_remetente=""):
        corpo = {
            "fromAddress": f'"{nome_remetente}" <{self.remetente}>' if nome_remetente else self.remetente,
            "toAddress": para, "subject": assunto, "content": html, "mailFormat": "html",
        }
        for tentativa in range(2):
            r = requests.post(f"{MAIL}/api/accounts/{self.conta()}/messages", json=corpo,
                              headers=self._cabecalhos(), timeout=60)
            if r.status_code == 401 and tentativa == 0:  # token expirou (1 h): renova e tenta de novo
                self._renovar()
                continue
            dados = r.json() if r.content else {}
            if r.status_code >= 400 or (dados.get("status") or {}).get("code", 200) >= 400:
                descricao = (dados.get("data") or {}).get("errorCode") or (dados.get("status") or {}).get("description")
                raise EnvioRecusado(f"HTTP {r.status_code}: {descricao}")
            return dados
        raise EnvioRecusado("token recusado duas vezes")


class EnvioRecusado(Exception):
    pass


def trocar_codigo():
    """Uso local, uma vez: lê client id/secret/código de segredos/ e grava o refresh token lá."""
    pasta = Path(__file__).resolve().parent.parent / "segredos"
    ler = lambda n: (pasta / n).read_text(encoding="utf-8").strip()
    r = requests.post(f"{CONTAS}/oauth/v2/token", params={
        "grant_type": "authorization_code", "client_id": ler("zoho-client-id.txt"),
        "client_secret": ler("zoho-client-secret.txt"), "code": ler("zoho-codigo.txt"),
    }, timeout=30)
    dados = r.json()
    if "refresh_token" not in dados:
        sys.exit(f"Zoho recusou o código: {dados.get('error', r.status_code)} (o código vale só alguns minutos)")
    (pasta / "zoho-refresh-token.txt").write_text(dados["refresh_token"], encoding="utf-8")
    print("refresh token salvo em segredos/zoho-refresh-token.txt")


if __name__ == "__main__" and sys.argv[1:] == ["trocar-codigo"]:
    trocar_codigo()
