"""E-mail/telefone oficiais do CNPJ por APIs públicas, um CNPJ por vez.

Os arquivos em massa da Receita bloqueiam IP de fora do Brasil (a máquina do
GitHub fica nos EUA); estas APIs respondem de lá e trazem o e-mail cadastrado.
Ordem: OpenCNPJ (rápida, sem limite visível) → CNPJá aberta (~5/min) →
CNPJ.ws (~3/min) → ReceitaWS (~3/min). Todas vêm da mesma base da Receita,
então só passamos pra próxima quando a anterior FALHA (erro/limite) — se a
primeira responde "sem e-mail", as outras também responderiam igual.
Os resultados ficam em cache (_dados/cnpj_cache.json.gz) entre execuções.
"""

import re
import time
from collections import Counter

import requests

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"


def _tel(texto):
    digitos = re.sub(r"\D", "", texto or "")
    if len(digitos) < 10:
        return ""
    ddd, numero = digitos[:2], digitos[2:]
    return f"({ddd}) {numero[:-4]}-{numero[-4:]}"


def _get(url):
    r = requests.get(url, headers={"User-Agent": UA, "Accept": "application/json"}, timeout=30)
    if r.status_code in (429, 403, 500, 502, 503, 504):
        return None
    if r.status_code == 404:
        return {}
    r.raise_for_status()
    return r.json()


def _opencnpj(cnpj):
    d = _get(f"https://api.opencnpj.org/{cnpj}")
    if not d:
        return d
    telefones = [_tel(t.get("ddd", "") + t.get("numero", "")) for t in d.get("telefones") or [] if not t.get("is_fax")]
    return {"fantasia": (d.get("nome_fantasia") or "").title(), "situacao": (d.get("situacao_cadastral") or "").title(),
            "email": (d.get("email") or "").lower(), "telefones": [t for t in dict.fromkeys(telefones) if t]}


def _cnpja(cnpj):
    d = _get(f"https://open.cnpja.com/office/{cnpj}")
    if not d:
        return d
    emails = [e.get("address", "").lower() for e in d.get("emails") or [] if e.get("address")]
    telefones = [_tel(p.get("area", "") + p.get("number", "")) for p in d.get("phones") or []]
    return {"fantasia": (d.get("alias") or "").title(), "situacao": ((d.get("status") or {}).get("text") or "").title(),
            "email": emails[0] if emails else "", "telefones": [t for t in dict.fromkeys(telefones) if t]}


def _cnpjws(cnpj):
    d = _get(f"https://publica.cnpj.ws/cnpj/{cnpj}")
    if not d:
        return d
    e = d.get("estabelecimento") or {}
    telefones = [_tel((e.get("ddd1") or "") + (e.get("telefone1") or "")), _tel((e.get("ddd2") or "") + (e.get("telefone2") or ""))]
    return {"fantasia": (e.get("nome_fantasia") or "").title(), "situacao": (e.get("situacao_cadastral") or "").title(),
            "email": (e.get("email") or "").lower(), "telefones": [t for t in dict.fromkeys(telefones) if t]}


def _receitaws(cnpj):
    d = _get(f"https://receitaws.com.br/v1/cnpj/{cnpj}")
    if d is None:
        return None
    if d.get("status") == "ERROR":
        return {} if "inválido" in (d.get("message") or "").lower() else None
    telefones = [_tel(t) for t in (d.get("telefone") or "").split("/")]
    return {"fantasia": (d.get("fantasia") or "").title(), "situacao": (d.get("situacao") or "").title(),
            "email": (d.get("email") or "").lower(), "telefones": [t for t in dict.fromkeys(telefones) if t]}


# (nome, função, segundos mínimos entre consultas na mesma API)
APIS = [("opencnpj", _opencnpj, 0.5), ("cnpja", _cnpja, 12), ("cnpjws", _cnpjws, 21), ("receitaws", _receitaws, 21)]


class ConsultaCnpj:
    def __init__(self):
        self.ultima = {nome: 0.0 for nome, _, _ in APIS}
        self.uso = Counter()  # contagens por API (só números — vão pro log público)

    def consultar(self, cnpj):
        """Primeira API que responder. None = todas falharam."""
        for nome, funcao, intervalo in APIS:
            espera = intervalo - (time.time() - self.ultima[nome])
            if espera > 0:
                time.sleep(espera)
            self.ultima[nome] = time.time()
            try:
                resultado = funcao(cnpj)
            except (requests.RequestException, ValueError, AttributeError, TypeError):
                resultado = None
            if resultado is None:
                self.uso[f"{nome}-falha"] += 1
                continue
            self.uso[nome] += 1
            return resultado
        return None
