"""Envia os leads pro Apps Script publicado na planilha (ver planilha/apps-script.gs).
URL e token vêm do ambiente (GitHub Secrets): PLANILHA_URL, PLANILHA_TOKEN."""

import os
import random
import time

import requests


class Planilha:
    def __init__(self, url=None, token=None):
        self.url = url or os.environ["PLANILHA_URL"]
        self.token = token or os.environ["PLANILHA_TOKEN"]

    def _post(self, corpo):
        """Várias UFs gravam em paralelo: o Apps Script tem uma trava e recusa com
        'Lock timeout' quem chega enquanto outra grava — aí espera e tenta de novo."""
        for tentativa in range(30):
            try:
                resp = requests.post(self.url, json={"token": self.token, **corpo}, timeout=360)
                dados = resp.json()
            except (requests.RequestException, ValueError):
                if tentativa == 29:
                    raise
                time.sleep(20 + random.uniform(0, 20))
                continue
            if dados.get("ok"):
                return dados
            erro = str(dados.get("erro", ""))
            if "token inválido" in erro or "ação desconhecida" in erro:
                raise RuntimeError(f"planilha recusou: {erro}")
            # trava ocupada, cota de chamadas simultâneas do Google etc.: espera e tenta de novo
            time.sleep(20 + random.uniform(0, 40))
        raise RuntimeError("planilha ocupada por tempo demais")

    def cnpjs(self):
        return set(self._post({"acao": "cnpjs"})["cnpjs"])

    def upsert(self, linhas, lote=300):
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
