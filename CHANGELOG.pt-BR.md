# Changelog

Todas as mudanças relevantes do Conclave são documentadas aqui. O projeto segue [Versionamento Semântico](https://semver.org/lang/pt-BR/) e a estrutura do [Keep a Changelog](https://keepachangelog.com/pt-BR/).

[English](CHANGELOG.md) · [Português (Brasil)](CHANGELOG.pt-BR.md)

## [Não publicado] — planejado para 0.7.0

Esta é a próxima versão atualmente presente no repositório. A versão mais recente publicada no npm ainda é a `0.2.8`.

### Adicionado

- Linhagem de review no schema v2 com digests de objetivo, contrato, diff, artefato, relatório anterior e relatório atual.
- Gates contra mudança silenciosa do contrato, séries explícitas de rebaseline, fingerprints estáveis e acompanhamento de progresso/estagnação no ciclo de correção.
- Recibos de evidência externa vinculados ao artefato revisado e planos determinísticos de desafios selecionados pelo risco.
- Suporte a `--previous-report`, `--receipt` repetível, `--series` e `--new-series` na CLI e na skill portável.
- `conclave check`, a passagem recomendada para PRs. Detecta a provável base e inclui commits da branch, arquivos staged, unstaged e untracked.
- `conclave compare`, com seletor interativo de branches locais e remotas sem trocar o checkout.
- Catálogo completo em `conclave help`, organizado por objetivo, além de guias como `conclave help check` e `conclave help symbol`.
- Preferência global de idioma da CLI com inglês como padrão, português do Brasil (`pt-BR`) e espanhol europeu (`es-ES`).
- `conclave config --language <idioma>` e seletor de idioma no menu guiado.
- Cockpit local de review com resumo, achados, código alterado, diff exato, histórico e handoff copiável para o coding agent.
- Histórico local de reviews e `conclave handoff` para o ciclo corrigir e conferir novamente.
- `conclave setup` guiado e skills portáveis para Codex, Claude Code, GitHub Actions e outros agents.
- Workflow de pull request no GitHub Actions com resumo do job, annotations, um comentário atualizado no PR e artefato JSON.
- Parsing estrutural e evidências de grafo para Python e Java, além de TypeScript e JavaScript.
- `conclave doctor` para diagnosticar a integração do repositório.

### Alterado

- Conclave foi reposicionado como companheiro de PR read-only: fornece contexto, evidências e próximos passos, enquanto a autoridade do merge continua humana.
- Task Mode autônomo e toda mutação pública do repositório foram removidos. Conclave aponta o problema; o desenvolvedor ou seu coding agent realiza a correção.
- O review agora cria um snapshot novo e não depende de `.conclave/code-index-v2.json`; o índice persistente é apenas um cache opcional para search, graph, Ask e Investigate.
- Comparações sem mudança retornam “Nothing to review” informativo em vez de um blocker falso.
- O README ficou mais curto, bilíngue, orientado a tarefas e explícito sobre review determinístico versus reasoning opcional por provider.
- As chaves do JSON continuam estáveis em inglês independentemente do idioma da interface humana.

### Segurança

- Claims de confiança dos recibos são tratados conservadoramente como autorrelatados; o Conclave nunca diz que executou um comando reportado externamente.
- Recibos de worktree mutável precisam do digest do artefato ou do diff e não podem depender apenas do `HEAD`.
- A preferência de idioma fica fora do repositório e usa permissão de arquivo somente para o dono.
- O `.env` do repositório não pode redirecionar nem substituir silenciosamente as preferências globais da CLI.
- O review de PR continua local e determinístico: não usa chave de API, não chama modelo e não executa scripts do repositório.

## [0.2.8] — 2026-08-12

### Adicionado

- Resumos legíveis de PR com comparação, riscos, arquivos alterados, veredito e próximos passos.
- Fluxo guiado de PR baseado em comparações Git explícitas.
- Navegação guiada na CLI para o fluxo principal de PR.

### Corrigido

- Documentação e comportamento de comparação de branches foram esclarecidos para evitar o review do diff errado.

## [0.2.6] — 2026-08-12

### Adicionado

- `conclave update --check`, `--local` e `--global`.

### Corrigido

- Uma instalação já atualizada agora recebe uma explicação clara em vez de erro `ENOENT`.

## [0.2.5] — 2026-08-12

### Adicionado

- Navegação guiada na CLI para os fluxos comuns do Conclave.
- Suporte estrutural e documentação de review para Python e Java.

### Alterado

- Validação determinística passou a ser apresentada como uma etapa de evidências no fluxo do PR, não como julgamento automático do código.

## [0.2.4] — 2026-08-12

### Adicionado

- READMEs separados em inglês e português do Brasil.
- Diagramas hospedados no repositório para o fluxo do PR e pipeline determinístico.

### Alterado

- A explicação do produto foi simplificada em torno do caminho entre a mudança de código e o merge aprovado por uma pessoa.

## [0.2.3] — 2026-08-12

### Alterado

- Foram esclarecidos o fluxo de review entre branches, os limites determinísticos e o significado das unidades de código antes chamadas de símbolos.

## [0.2.2] — 2026-08-11

### Adicionado

- Setup guiado e moderno de providers para Ask e Investigate opcionais.
- Gates de validação da skill portável e do fluxo web.

### Corrigido

- A autovalidação do CI passou a comparar com a base do evento em vez de bloquear em um diff vazio.
- Os nomes do pacote e do repositório foram alinhados em `conclave-ai`.

## [0.2.1] — 2026-08-11

### Alterado

- Melhorias no onboarding de provider e nos metadados iniciais do pacote npm.

## [0.2.0] — 2026-08-11

### Adicionado

- Primeira versão pública no npm como `conclave-ai`.
- Contratos de validação determinística, coleta de mudanças, análise estrutural de impacto e vereditos com evidências.
- Configuração opcional de API e uma skill de validação portável.

[Não publicado]: https://github.com/carvalhobfr/conclave-ai/compare/b6c5418...HEAD
[0.2.8]: https://www.npmjs.com/package/conclave-ai/v/0.2.8
[0.2.6]: https://www.npmjs.com/package/conclave-ai/v/0.2.6
[0.2.5]: https://www.npmjs.com/package/conclave-ai/v/0.2.5
[0.2.4]: https://www.npmjs.com/package/conclave-ai/v/0.2.4
[0.2.3]: https://www.npmjs.com/package/conclave-ai/v/0.2.3
[0.2.2]: https://www.npmjs.com/package/conclave-ai/v/0.2.2
[0.2.1]: https://www.npmjs.com/package/conclave-ai/v/0.2.1
[0.2.0]: https://www.npmjs.com/package/conclave-ai/v/0.2.0
