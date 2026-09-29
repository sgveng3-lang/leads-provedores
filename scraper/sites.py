"""Acha o site do provedor e extrai contatos comerciais dele.

1. Site: domínio do e-mail oficial (Receita), se não for e-mail gratuito;
   senão, busca no Bing (o Google bloqueia robô).
2. Raspagem educada: respeita robots.txt, no máximo 5 páginas por site
   (início + páginas de contato/atendimento), 1 s entre requisições.
3. Só guarda e-mails INSTITUCIONAIS do próprio domínio (contato@,
   comercial@...) — nada de e-mail pessoal/nominal (LGPD).
"""

import base64
import re
import time
import unicodedata
from urllib import robotparser
from urllib.parse import parse_qs, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

UA = "Mozilla/5.0 (compatible; leads-provedores/1.0; +https://github.com/sgveng3-lang/leads-provedores)"
UA_BUSCA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
TIMEOUT = 12
MAX_PAGINAS = 5
MAX_BYTES = 2 << 20

EMAIL_GRATUITO = {
    "gmail.com", "hotmail.com", "hotmail.com.br", "outlook.com", "outlook.com.br", "live.com", "msn.com",
    "yahoo.com", "yahoo.com.br", "bol.com.br", "uol.com.br", "terra.com.br", "ig.com.br", "globo.com",
    "globomail.com", "r7.com", "zipmail.com.br", "oi.com.br", "icloud.com", "me.com", "protonmail.com",
    "gmail.com.br", "aol.com", "yandex.com",
}
SITES_IGNORADOS = (
    "facebook.", "instagram.", "linkedin.", "youtube.", "twitter.", "x.com", "tiktok.", "wikipedia.",
    "google.", "bing.", "microsoft.", "apple.com", "reclameaqui.", "gov.br", "cnpj", "econodata", "casadosdados",
    "empresas", "telelistas", "guiamais", "apontador", "solutudo", "consultas", "speedtest", "minhaconexao",
    "melhorplano", "tecmundo", "olx.", "mercadolivre", "yelp.", "tripadvisor", "waze.", "maps.",
)
LOCAIS_INSTITUCIONAIS = {
    "contato", "contatos", "comercial", "vendas", "venda", "atendimento", "sac", "suporte", "financeiro",
    "cobranca", "faturamento", "adm", "administrativo", "administracao", "diretoria", "ouvidoria", "noc",
    "info", "informacoes", "faleconosco", "fale", "marketing", "parcerias", "parceria", "negocios", "corporativo",
    "empresas", "provedor", "internet", "central", "relacionamento", "comunicacao", "rh", "juridico", "compras",
    "suporte.tecnico", "atendimento.cliente", "contato.comercial", "ti", "noc.suporte", "helpdesk", "abuse",
}
PALAVRAS_CONTATO = ("contato", "fale", "atendimento", "comercial", "sobre", "empresa", "quem-somos",
                    "quemsomos", "suporte", "central", "ouvidoria", "sac")

RE_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
RE_WHATS = re.compile(r"(?:wa\.me/|whatsapp\.com/send/?\?phone=|api\.whatsapp\.com/send/?\?phone=)\+?(\d{10,13})", re.I)
RE_TEL = re.compile(r"(?:\(?0?(\d{2})\)?[\s.-]*)(9?\d{4})[\s.-]?(\d{4})\b")
RE_0800 = re.compile(r"\b0800[\s.-]?\d{3}[\s.-]?\d{4}\b")


def _sem_acento(texto):
    return unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode().lower()


def dominio_registravel(host):
    partes = host.lower().strip(".").split(".")
    if partes and partes[0] == "www":
        partes = partes[1:]
    if len(partes) >= 3 and partes[-1] == "br" and len(partes[-2]) <= 4:
        return ".".join(partes[-3:])
    return ".".join(partes[-2:])


class Raspador:
    def __init__(self):
        self.sessao = requests.Session()
        self.sessao.headers.update({"User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9"})
        self.robots = {}

    # ---------- HTTP ----------
    def _get(self, url, **kw):
        try:
            resp = self.sessao.get(url, timeout=TIMEOUT, stream=True, allow_redirects=True, **kw)
            tipo = resp.headers.get("Content-Type", "")
            if resp.status_code >= 400 or "html" not in tipo:
                return None
            conteudo = resp.raw.read(MAX_BYTES, decode_content=True)
            resp.encoding = resp.encoding or "utf-8"
            return resp.url, conteudo.decode(resp.encoding, errors="replace")
        except (requests.RequestException, UnicodeError, LookupError, OSError):
            return None

    def _pode(self, url):
        base = "{0.scheme}://{0.netloc}".format(urlparse(url))
        if base not in self.robots:
            rp = robotparser.RobotFileParser()
            try:
                resp = self.sessao.get(base + "/robots.txt", timeout=TIMEOUT)
                rp.parse(resp.text.splitlines() if resp.status_code == 200 else [])
            except requests.RequestException:
                rp.parse([])
            self.robots[base] = rp
        return self.robots[base].can_fetch(UA, url)

    # ---------- achar o site ----------
    def site_pelo_email(self, email):
        dominio = email.split("@")[-1].lower() if "@" in email else ""
        if not dominio or dominio in EMAIL_GRATUITO:
            return None
        for url in (f"https://{dominio}", f"https://www.{dominio}", f"http://{dominio}"):
            pagina = self._get(url)
            if pagina:
                return pagina
        return None

    def site_pela_busca(self, nome, municipio, uf):
        consulta = f"{nome} provedor internet {municipio} {uf}"
        try:
            resp = requests.get("https://www.bing.com/search", params={"q": consulta, "setlang": "pt-br", "cc": "BR"},
                                headers={"User-Agent": UA_BUSCA, "Accept-Language": "pt-BR"}, timeout=TIMEOUT)
        except requests.RequestException:
            return None
        sopa = BeautifulSoup(resp.text, "html.parser")
        fichas = [t for t in re.findall(r"[a-z0-9]{4,}", _sem_acento(nome)) if t not in ("provedor", "internet", "telecom", "ltda", "comunicacoes", "telecomunicacoes", "servicos", "informatica", "fibra", "net")]
        for link in sopa.select("li.b_algo h2 a[href]")[:6]:
            url = self._desembrulhar_bing(link["href"])
            host = urlparse(url).netloc.lower()
            if not host or any(s in host for s in SITES_IGNORADOS):
                continue
            pagina = self._get(url)
            if not pagina:
                continue
            texto = _sem_acento(BeautifulSoup(pagina[1], "html.parser").get_text(" ")[:20000])
            dominio = _sem_acento(host)
            if any(f in dominio or f in texto for f in fichas) and ("internet" in texto or "fibra" in texto or "provedor" in texto):
                return f"https://{urlparse(pagina[0]).netloc}", pagina[1]
        return None

    @staticmethod
    def _desembrulhar_bing(href):
        if "bing.com/ck/" not in href:
            return href
        u = parse_qs(urlparse(href).query).get("u", [""])[0]
        if u.startswith("a1"):
            try:
                return base64.urlsafe_b64decode(u[2:] + "=" * (-len(u[2:]) % 4)).decode()
            except ValueError:
                return ""
        return ""

    # ---------- raspar contatos ----------
    def contatos(self, url_inicial, html_inicial=None):
        dominio = dominio_registravel(urlparse(url_inicial).netloc)
        visitadas, fila = set(), [url_inicial]
        emails, whats, telefones = {}, {}, {}
        primeira = True
        while fila and len(visitadas) < MAX_PAGINAS:
            url = fila.pop(0)
            if url in visitadas or not self._pode(url):
                continue
            visitadas.add(url)
            if primeira and html_inicial:
                final, html = url, html_inicial
            else:
                time.sleep(1)
                pagina = self._get(url)
                if not pagina:
                    continue
                final, html = pagina
            primeira = False
            sopa = BeautifulSoup(html, "html.parser")
            texto = sopa.get_text(" ")
            hrefs = [a.get("href", "") for a in sopa.find_all("a")]

            candidatos = RE_EMAIL.findall(texto) + [h[7:].split("?")[0] for h in hrefs if h.lower().startswith("mailto:")]
            for e in candidatos:
                e = e.strip().lower()
                local, _, dom = e.partition("@")
                if dom.endswith((".png", ".jpg", ".gif", ".webp", ".svg")) or "sentry" in dom or "wix" in dom:
                    continue
                if dominio_registravel(dom) == dominio and _sem_acento(local) in LOCAIS_INSTITUCIONAIS:
                    emails[e] = True
            for h in hrefs + [texto]:
                for numero in RE_WHATS.findall(h):
                    numero = numero if numero.startswith("55") else "55" + numero
                    whats[numero] = True
            for m in RE_0800.findall(texto):
                telefones[re.sub(r"[\s.-]", "", m)] = True
            for ddd, a, b in RE_TEL.findall(texto):
                if 11 <= int(ddd) <= 99:
                    telefones[f"({ddd}) {a}-{b}"] = True

            for a in sopa.find_all("a", href=True):
                destino = urljoin(final, a["href"]).split("#")[0]
                alvo = _sem_acento(destino + " " + a.get_text(" "))
                if urlparse(destino).netloc.endswith(dominio) and any(p in alvo for p in PALAVRAS_CONTATO):
                    if destino not in visitadas and destino not in fila:
                        fila.append(destino)
        return {
            "emails": list(emails)[:5],
            "whatsapp": [f"+{w}" for w in list(whats)[:3]],
            "telefones": list(telefones)[:4],
        }

    def processar(self, prov):
        """prov: dados da base (anatel + receita). Retorna {site, emails, whatsapp, telefones}."""
        rec = prov.get("receita") or {}
        pagina = self.site_pelo_email(rec.get("email", ""))
        if not pagina:
            nome = rec.get("fantasia") or prov["empresa"]
            municipio = (prov.get("municipios_top") or [""])[0].split("/")[0]
            pagina = self.site_pela_busca(nome, municipio, prov.get("uf_principal", ""))
        if not pagina:
            return {"site": "", "emails": [], "whatsapp": [], "telefones": []}
        url = f"https://{urlparse(pagina[0]).netloc}" if pagina[0].startswith("http") else pagina[0]
        return {"site": url, **self.contatos(pagina[0], pagina[1])}
