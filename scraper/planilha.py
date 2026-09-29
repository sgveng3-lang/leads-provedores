"""Envia os leads pro Apps Script publicado na planilha (ver planilha/apps-script.gs).
URL e token vêm do ambiente (GitHub Secrets): PLANILHA_URL, PLANILHA_TOKEN."""

import os

import requests


class Planilha:
    def __init__(self, url=None, token=None):
        self.url = url or os.environ["PLANILHA_URL"]
        self.token = token or os.environ["PLANILHA_TOKEN"]

    def _post(self, corpo):
        for tentativa in range(4):
            try:
                resp = requests.post(self.url, json={"token": self.token, **corpo}, timeout=300)
                dados = resp.json()
                if not dados.get("ok"):
                    raise RuntimeError(f"planilha recusou: {dados.get('erro')}")
                return dados
            except (requests.RequestException, ValueError):
                if tentativa == 3:
                    raise

    def cnpjs(self):
        return set(self._post({"acao": "cnpjs"})["cnpjs"])

    def upsert(self, linhas, lote=100):
        novos = atualizados = 0
        for i in range(0, len(linhas), lote):
            r = self._post({"acao": "upsert", "linhas": linhas[i:i + lote]})
            # a resposta às vezes volta sem as contagens (redirecionamento do
            # Google); a gravação em si já aconteceu, então não derruba a execução
            novos += r.get("novos", 0)
            atualizados += r.get("atualizados", 0)
        return novos, atualizados

    def registrar_execucao(self, execucao):
        return self._post({"acao": "execucao", "execucao": execucao}).get("url", "")
