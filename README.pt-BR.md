<div align="center">

# Conclave

### Simplifique e proteja cada PR.

**Conclave é um companheiro de PR: fornece contexto, evidências e um caminho mais seguro entre a mudança de código e o merge.**

[English](README.md) · [Português (Brasil)](README.pt-BR.md)

[Início rápido](#início-rápido) · [Fluxo de PR](#fluxo-recomendado-de-pr) · [Skill de agentes](#usar-no-codex-ou-claude-code) · [Configuração](#configuração-opcional-de-ia)

</div>

---

## Um companheiro de PR, não uma caixa-preta

O Conclave fica entre **código alterado** e **pronto para merge**. Ele compara a mudança com o objetivo, acompanha o código afetado, mostra evidências e próximos passos e deixa a decisão com uma pessoa.

<p align="center"><img src="https://raw.githubusercontent.com/carvalhobfr/conclave-ai/master/docs/assets/conclave-pr-flow.svg" alt="Uma mudança é verificada pelo Conclave, gera contexto e evidências e segue para aprovação humana antes do merge" width="900"></p>

Em uma linha:

```text
mudança → Conclave explica e verifica → agente/desenvolvedor corrige → humano aprova → merge
```

O produto tem duas camadas:

| Camada | O que faz | Precisa de chave? |
| --- | --- | ---: |
| Fluxo de PR (`pr`, `review`, `validate`) | Compara mudanças Git, cria um mapa local do código, rastreia impacto, verifica alegações e mostra evidências | Não |
| Raciocínio opcional (`ask`, `task`, UI web local) | Usa um provedor configurado para investigar perguntas ou planejar/executar uma tarefa limitada | Só com provedor hospedado |

O fluxo de PR é independente do agente que escreveu o código. Ele não é executor de testes, compilador, monitor de produção nem aprovação automática. `PASS` significa que as verificações estruturais disponíveis não encontraram bloqueio; testes, runtime, segurança e revisão humana continuam necessários.

## Início rápido

Requisitos: Node.js 20+ e Git. O repositório analisado pode ser TypeScript, JavaScript, Python, Java ou outra linguagem; Node.js é apenas o runtime da CLI do Conclave.

### Instalar no projeto (recomendado)

```bash
npm install --save-dev conclave-ai
npx --no-install conclave start
```

O pacote expõe um único binário: `conclave`. Não existe o comando de shell `conclave-ai`.

Yarn e pnpm também funcionam:

```bash
yarn add --dev conclave-ai
yarn conclave start

pnpm add --save-dev conclave-ai
pnpm exec conclave start
```

### Testar sem alterar o `package.json`

```bash
npx --yes --package=conclave-ai conclave start
```

### Instalar globalmente (opcional)

```bash
npm install --global conclave-ai
conclave start
```

A instalação global é prática para uso pessoal. A instalação no projeto costuma ser melhor para equipes e CI, pois todos usam a versão registrada no repositório.

## CLI guiada

Execute `conclave` sem argumentos em um terminal interativo ou use:

```bash
conclave start [caminho]
```

O menu foi feito para o fluxo normal. Ele permite:

1. executar um fluxo completo de PR;
2. escolher a origem: branch, área de trabalho, arquivos preparados ou um commit;
3. informar o objetivo da mudança;
4. acompanhar o progresso de coleta, indexação e validação;
5. ler resumo, evidências, riscos, verdict e próximos passos; e
6. consultar histórico, configurar modelos opcionais, atualizar o Conclave ou abrir a ajuda completa.

A primeira opção, **Executar fluxo completo de PR**, é o ponto de partida recomendado. **Revisar evidências (avançado)** é o relatório de baixo nível para CI, contratos e scripts.

### Comparar branches sem decorar referências

Para um fluxo guiado por branches, execute:

```bash
conclave compare .
```

O Conclave lista branches locais e remotas, marca a branch atual, permite escolher a base e o alvo e depois pede o objetivo da mudança. Ele nunca troca de branch. Você pode digitar manualmente uma referência quando ela não aparecer na lista. O mesmo seletor está disponível em `conclave start` → **Comparar branches**.

Para scripts e CI, continue usando a forma explícita:

```bash
conclave compare . --base origin/main --head feature/login \
  --objective "Adicionar login sem senha" --json
```

Você não precisa executar `conclave index` antes do fluxo de PR. A opção guiada **Entender este repositório** e o comando `conclave index` criam intencionalmente um `.conclave/code-index-v2.json` reutilizável para busca, grafo e Ask. Já `conclave pr` e `conclave review` criam o snapshot exato que precisam em memória (ou em uma pasta temporária quando você informa `--head`) e não usam esse índice persistido como fonte da mudança.

## Fluxo recomendado de PR

Na branch de funcionalidade que você quer analisar:

```bash
git fetch origin
git switch feature/login
git status --short

conclave pr . --base origin/main --head feature/login \
  --objective "Adicionar login sem senha"
```

`--base` é a **referência de comparação** e `--head` é a **branch/commit analisado**. O Conclave nunca troca seu checkout. Se `--head` for omitido, ele usa o `HEAD` atual:

- coleta a comparação do Git;
- cria um mapa local seguro de arquivos e unidades de código;
- acompanha o impacto local do código alterado;
- verifica o objetivo e as alegações de um contrato opcional;
- mostra resumo humano do PR, progresso, arquivos, riscos, verdict e próximos passos; e
- salva um registro com permissão do dono em `.conclave/review-history.json`.

Isso também funciona se o checkout estiver em outra branch ou tiver arquivos untracked: o Conclave lê a referência alvo em um snapshot temporário. O ciclo de correção é explícito e repetível:

```text
mudança → conclave pr → ler evidências → corrigir → conclave pr novamente → aprovação humana → merge
```

Depois de `BLOCK` ou `WARN`, abra os arquivos e linhas citados, corrija com seu editor ou agente e execute o mesmo comando outra vez. Nesta versão o Conclave não publica comentários no GitHub, aplica patches, faz merge ou aprova PRs.

### Comparar branches e entender o que mudou

O modo branch também funciona como um resumo local de PR:

```bash
conclave pr . --base origin/main --head feature/login \
  --objective "Descrever o comportamento que esta branch deve entregar"
```

Para CI e integrações, use `--json`. O modo JSON contém somente JSON, sem mensagens de progresso:

```bash
conclave pr . --base origin/main --head feature/login \
  --objective "Adicionar login sem senha" --json > /tmp/conclave-pr.json
```

Para acompanhar as tentativas anteriores:

```bash
conclave history .
conclave history . --json
```

Se aparecer **No code change was collected**, confira primeiro o que o Git realmente está comparando:

```bash
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
git merge-base origin/main HEAD
```

Atualize a referência remota ou escolha a base correta quando esses comandos não mostrarem o trabalho esperado. Uma `main` já mesclada comparada com `origin/main` normalmente não tem diff porque as duas referências apontam para o mesmo commit.

## `review` e `validate`: o relatório de evidências

`pr` é o fluxo completo e amigável. `review` é o comando de baixo nível; `validate` é seu alias explícito. Os dois usam o mesmo motor determinístico e aceitam `--json`.

```bash
# Alterações rastreadas não preparadas (arquivos novos devem ser preparados ou ignorados)
conclave review . --working --objective "..."

# Somente o que está preparado no Git
conclave review . --staged --objective "..."

# Branch/commit contra uma base explícita
conclave review . --base origin/main --head feature/login --objective "..."

# Um commit existente
conclave validate . --commit HEAD --objective "..." --json
```

As origens são mutuamente exclusivas. O objetivo é obrigatório porque uma mudança só pode ser verificada contra um resultado pretendido.

<p align="center"><img src="https://raw.githubusercontent.com/carvalhobfr/conclave-ai/master/docs/assets/conclave-review-pipeline.svg" alt="Snapshot Git, índice local, grafo de impacto, verificações e verdict com evidências" width="900"></p>

O pipeline coleta o snapshot Git, ignora arquivos inseguros ou irrelevantes, analisa o código compatível, relaciona linhas alteradas a unidades nomeadas, rastreia chamadores, imports e referências e avalia contratos opcionais. **Símbolo** é apenas uma unidade de código nomeada, como função, classe, método, interface ou componente.

| Verdict | Exit code | Significado |
| --- | ---: | --- |
| `PASS` | `0` | Nenhum bloqueio determinístico foi encontrado nas evidências disponíveis |
| `WARN` | `0` | O resultado ainda precisa de atenção humana |
| `BLOCK` | `1` | Um problema determinístico contradiz o objetivo ou uma alegação |
| `INCONCLUSIVE` | `2` | Não há evidência estrutural suficiente |

O review é local e independente: não envia o repositório para fora da máquina, não usa credenciais, não chama modelo, não executa scripts do projeto e não exige rede.

## Tornar alegações do PR verificáveis

O objetivo descreve a meta. Um contrato adiciona alegações explícitas e legíveis por máquina:

```json
{
  "objective": "Restaurar autenticação após refresh",
  "claims": [
    {
      "id": "restore-exists",
      "statement": "bootstrapSession existe",
      "check": {
        "kind": "symbol-exists",
        "symbol": "bootstrapSession",
        "expectation": "present"
      }
    }
  ]
}
```

```bash
conclave pr . --base origin/main --head feature/login \
  --contract .conclave/review-contract.json \
  --objective "Restaurar autenticação após refresh"
```

Há verificações de símbolo, caller, referência, texto e arquivo alterado. Consulte o [schema do relatório](schemas/validation-report.v1.schema.json).

## Usar no Codex ou Claude Code

O Conclave inclui a skill portátil `conclave-validate`. A skill não é o pacote inteiro: o pacote contém a CLI e o instalador; a skill é o adaptador que pede ao agente para executar o mesmo relatório independente.

Instale a skill no repositório atual:

```bash
npm install --save-dev conclave-ai
npx --no-install conclave skill install
```

Isso cria:

```text
.agents/skills/conclave-validate/  # Codex
.claude/skills/conclave-validate/  # Claude Code
```

Depois use `$conclave-validate` no Codex ou `/conclave-validate` no Claude Code. A skill pede um objetivo, escolhe área de trabalho/arquivos preparados/branch/commit, executa o validator e apresenta verdict, alegações, impacto, evidências, limitações e próxima ação.

Para instalar somente os arquivos da skill, sem adicionar dependência ao `package.json`:

```bash
npx --yes --package=conclave-ai conclave skill install
```

Esse comando instala os adaptadores, mas o validator ainda precisa encontrar uma CLI no projeto, globalmente ou em `CONCLAVE_CLI_PATH`. Use `--dry-run` para visualizar e `--force` somente depois de revisar uma substituição.

Para instalar para seu usuário:

```bash
conclave skill install --scope user
```

## Configuração opcional de IA

Você **não** precisa de chave para `pr`, `review`, `validate`, CI ou para a skill. Esses caminhos são determinísticos e locais.

Configure um provedor somente para `ask`, `task` ou para a UI web local:

```bash
conclave models
conclave init
conclave provider-check
```

`conclave init` é uma configuração interativa em quatro passos: provedor, perfil de modelo, estilo de raciocínio e chave oculta. Ele grava somente o bloco gerenciado `CONCLAVE_*` em um `.env` ignorado pelo Git, com permissão exclusiva do dono. Use `conclave config` para consultar metadados sem exibir a chave.

| Provedor | O que usar |
| --- | --- |
| OpenAI Platform / Codex API | Chave da OpenAI Platform. Ela pode chamar modelos Codex disponíveis no projeto. Login de assinatura ChatGPT/Codex não é uma chave de API. |
| OpenRouter | Chave de inferência do OpenRouter. As chamadas usam créditos, limites e cota de modelos gratuitos da conta. |
| Anthropic | Chave da Anthropic Console. A assinatura do app Claude é separada da API. |

Escolha um dos quatro perfis mantidos ou passe um model ID exato:

```bash
conclave init --provider openai --profile coding
conclave init --provider openrouter --profile claude-sonnet-latest
conclave init --provider anthropic --profile deep
conclave init --provider openrouter --model "provider/custom-model"
```

O provedor configurado nunca é usado pelo fluxo determinístico de PR.

## Atualizar o Conclave

Instalação no projeto:

```bash
conclave update
```

Instalação global:

```bash
conclave update --global
```

Consultar a versão mais recente no registro do npm sem instalar:

```bash
conclave update --check
```

Se a versão instalada já for a mais recente, o comando informa isso claramente e não tenta instalar de novo. Também é possível usar `npm install --save-dev conclave-ai@latest` ou `npm install --global conclave-ai@latest`. Depois de atualizar a skill, atualize uma cópia do projeto com `npx --no-install conclave skill install --force`.

## CI e GitHub Actions

Execute a mesma verificação contra a base real do pull request:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: actions/setup-node@v4
  with:
    node-version: 20
    cache: npm
- run: npm ci
- run: >-
    npx --no-install conclave review .
    --base origin/${{ github.base_ref }}
    --head ${{ github.event.pull_request.head.sha }}
    --contract .conclave/review-contract.json
    --objective "Validar o objetivo do pull request"
    --json
```

Em pull requests, passe base e head explicitamente quando possível. Em workflows de push, use o SHA anterior do evento como base e o SHA enviado como `--head`.

## Interfaces e linguagens

- **CLI:** fluxo guiado completo e comandos para scripts.
- **Skill:** adaptadores para Codex e Claude Code.
- **MCP:** `conclave mcp /caminho/absoluto/do/repositorio` inicia um servidor stdio somente leitura.
- **UI web:** a partir do checkout, rode `npm run build && npm run start:web` e abra `http://127.0.0.1:4317`.

A análise estrutural profunda suporta TypeScript, JavaScript, Python e Java. Outras linguagens ainda recebem comparação Git, verificações de arquivo/texto e contratos no nível do repositório. O review não executa testes nem scripts do projeto.

## Documentação

- [Guia em inglês](README.md)
- [Arquitetura do SuperValidator](docs/super-validator.md)
- [Segurança e limites](docs/security.md)
- [Schema do relatório](schemas/validation-report.v1.schema.json)
- [Skill portátil](skills/conclave-validate/SKILL.md)
- [Como contribuir](CONTRIBUTING.md)

Conclave é distribuído sob a [licença MIT](LICENSE).
