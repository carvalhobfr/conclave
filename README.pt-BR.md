# Conclave

### Simplifique e proteja cada PR.

**Conclave é um companheiro de PR: fornece contexto, evidências e um caminho mais seguro entre a mudança de código e o merge.**

[English](README.md) · [Português (Brasil)](README.pt-BR.md)

Conclave ajuda agentes e pessoas a entenderem o que mudou, o que foi afetado e qual é o próximo passo antes do merge.

## Como funciona

O produto tem duas partes conectadas:

1. **Entender e trabalhar:** indexa o repositório, encontra funções, classes, métodos e dependências e fornece contexto para `ask`, `investigate` e `task`.
2. **Verificar antes do merge:** compara a mudança no Git com o objetivo, rastreia impacto e produz um relatório independente para o agente, CI e reviewer humano.

```text
Entender → Trabalhar → Verificar → Decidir
```

O comando `review` (ou seu alias mais explícito, `validate`) é apenas a etapa de verificação. Ele não substitui testes, execução da aplicação, análise de segurança ou aprovação humana.

## Instalação rápida

Requisitos: Node.js 20+ e Git.

```bash
npm install --save-dev conclave-ai
npx --no-install conclave review . --working \
  --objective "Restaurar a sessão após atualizar a página"
```

Ou execute sem instalar no projeto:

```bash
npx --yes --package=conclave-ai conclave review . --working \
  --objective "Restaurar a sessão após atualizar a página"
```

## Atualizar o Conclave

Se o Conclave está instalado no projeto atual:

```bash
conclave update
```

Para atualizar uma instalação global:

```bash
conclave update --global
```

Para apenas consultar a versão mais recente publicada:

```bash
conclave update --check
```

Se você já estiver na versão mais recente, `conclave update` encerra com uma mensagem clara e não tenta fazer uma instalação desnecessária.

Também é possível usar diretamente `npm install --save-dev conclave-ai@latest` no projeto ou `npm install --global conclave-ai@latest` globalmente. Depois da atualização, reinstale a skill se ela estiver copiada no projeto: `npx conclave skill install --force`.

## Comparar uma branch

```bash
git fetch origin
git switch feature/login
git status --short       # review de branch/commit exige árvore limpa
conclave review . --branch origin/main \
  --objective "Adicionar login sem senha"
```

`--branch` é a **referência-base**, não a branch que será analisada. O Conclave sempre compara o `HEAD` atualmente em checkout com essa base. Para conferir o que o Git está comparando:

```bash
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
git merge-base origin/main HEAD
```

Se esses comandos não mostrarem as mudanças esperadas, atualize as referências remotas ou escolha a base correta. Não compare uma `main` já mesclada com `origin/main`: depois do merge, as duas apontam para o mesmo commit.

O resultado mostra arquivos alterados, unidades de código afetadas, evidências e próximos passos. Use `--json` para CI e ferramentas:

```bash
conclave validate . --branch origin/main \
  --objective "Adicionar login sem senha" --json
```

## O que a validação faz

Ela coleta a mudança Git, cria um mapa local seguro do projeto, relaciona as partes alteradas com seus consumidores e verifica claims ou contratos declarados.

`PASS` significa que as verificações estruturais disponíveis não encontraram um bloqueio. Não significa que o código está garantidamente correto: testes, comportamento em runtime e revisão humana continuam necessários.

A validação é local e independente: não exige chave de API, não chama um modelo, não envia o código para fora da máquina e não executa scripts do repositório.

## Skill para agentes

Instale a skill para Codex e Claude Code:

```bash
npm install --save-dev conclave-ai
npx conclave skill install
```

Depois use `$conclave-validate` no Codex ou `/conclave-validate` no Claude Code. A skill roda a validação e apresenta as evidências ao agente.

## Recursos com IA (opcionais)

`ask`, `investigate` e `task` podem usar OpenAI/Codex, OpenRouter ou Anthropic. Configure pelo CLI:

```bash
conclave models
conclave init
conclave provider-check
```

Esses recursos são opcionais. A etapa de validação continua funcionando sem provider.

## GitHub Actions

```yaml
- run: >-
    npx --no-install conclave review .
    --branch origin/${{ github.base_ref }}
    --contract .conclave/review-contract.json
    --json
```

## Suporte de linguagens

A análise estrutural profunda suporta TypeScript, JavaScript, Python e Java. Outras linguagens ainda recebem comparação Git, busca textual e verificações de arquivos e contratos.

## Documentação

- [Documentação em inglês](README.md)
- [Arquitetura do SuperValidator](docs/super-validator.md)
- [Segurança e limites](docs/security.md)
- [Schema do relatório](schemas/validation-report.v1.schema.json)
- [Skill portátil](skills/conclave-validate/SKILL.md)
