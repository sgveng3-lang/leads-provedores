# leads-provedores

Coleta dados públicos de provedores de internet do Brasil para prospecção B2B:

1. **Anatel**: dados abertos de acessos de banda larga fixa (provedores de pequeno porte, nº de assinantes, UFs e municípios).
2. **Receita Federal**: dados abertos do CNPJ (e-mail, telefone e situação cadastral oficiais).
3. **Site do provedor**: e-mails institucionais do próprio domínio (contato@, comercial@...), WhatsApp e telefones. A coleta respeita o robots.txt, visita no máximo 5 páginas por site e espera 1 s entre requisições.

Os resultados vão para uma planilha privada, e nenhum dado de provedor aparece nos logs deste repositório.
A execução é disparada manualmente pelo workflow `raspar` (Actions → raspar → Run workflow).

Segredos necessários: `PLANILHA_URL` e `PLANILHA_TOKEN` (Apps Script em `planilha/apps-script.gs`).
