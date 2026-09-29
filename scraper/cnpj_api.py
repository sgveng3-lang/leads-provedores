"""E-mail/telefone oficiais do CNPJ por API pública, um CNPJ por vez.

Os arquivos em massa da Receita bloqueiam IP de fora do Brasil (a máquina do
GitHub fica nos EUA), mas estas duas APIs respondem de lá e trazem o e-mail
cadastrado. Cada uma aceita ~3 consultas/min; alternando as duas, ~6/min.
Os resultados ficam em cache (_dados/cnpj_cache.json.gz) entre execuções.
"""

import re
import time

import requests

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
INTERVALO_POR_API = 21  # segundos entre consultas na mesma API (limite ~3/min)


def _tel(texto):
    digitos = re.sub(r"\D", "", texto or "")
    if len(digitos) < 10:
        return ""
    ddd, numero = digitos[:2], digitos[2:]
    return f"({ddd}) {numero[:-4]}-{numero[-4:]}"


def _cnpjws(cnpj):
    r = requests.get(f"https://publica.cnpj.ws/cnpj/{cnpj}", headers={"User-Agent": UA}, timeout=30)
    if r.status_code == 429:
        return None
    if r.status_code == 404:
        return {}
    r.raise_for_status()
    e = r.json().get("estabelecimento") or {}
    telefones = [_tel((e.get("ddd1") or "") + (e.get("telefone1") or "")), _tel((e.get("ddd2") or "") + (e.get("telefone2") or ""))]
    return {
        "fantasia": (e.get("nome_fantasia") or "").title(),
        "situacao": (e.get("situacao_cadastral") or "").title(),
        "email": (e.get("email") or "").lower(),
        "telefones": [t for t in dict.fromkeys(telefones) if t],
    }


def _receitaws(cnpj):
    r = requests.get(f"https://receitaws.com.br/v1/cnpj/{cnpj}", headers={"User-Agent": UA}, timeout=30)
    if r.status_code == 429:
        return None
    r.raise_for_status()
    d = r.json()
    if d.get("status") == "ERROR":
        return {} if "inválido" in (d.get("message") or "").lower() else None
    telefones = [_tel(t) for t in (d.get("telefone") or "").split("/")]
    return {
        "fantasia": (d.get("fantasia") or "").title(),
        "situacao": (d.get("situacao") or "").title(),
        "email": (d.get("email") or "").lower(),
        "telefones": [t for t in dict.fromkeys(telefones) if t],
    }


class ConsultaCnpj:
    def __init__(self):
        self.apis = [("cnpjws", _cnpjws), ("receitaws", _receitaws)]
        self.ultima = {nome: 0.0 for nome, _ in self.apis}
        self.vez = 0

    def consultar(self, cnpj):
        """Tenta as APIs alternando e respeitando o limite de cada uma. None = não conseguiu."""
        for _ in range(len(self.apis) * 3):
            nome, funcao = self.apis[self.vez % len(self.apis)]
            self.vez += 1
            espera = INTERVALO_POR_API - (time.time() - self.ultima[nome])
            if espera > 0:
                time.sleep(espera)
            self.ultima[nome] = time.time()
            try:
                resultado = funcao(cnpj)
            except (requests.RequestException, ValueError):
                resultado = None
            if resultado is not None:
                return resultado
        return None
