# Novidades do AgenteCode

Uma seção por versão, da mais nova para a mais antiga. O título de cada seção precisa ter o formato `## vX.Y.Z - data`.

## v1.0.10 - 27/10/2026

A revisão do agente agora enxerga o que foi alterado por comandos de terminal.

- **Mudanças feitas por terminal aparecem na revisão:** quando o agente altera arquivos com `perl`, `sed`, scripts ou `cat >`, o Claude Code não registra o antes e o depois, e esses arquivos ficavam fora da tela. Agora o AgenteCode usa o git para enxergá-los. A cada novo pedido ao agente ele tira uma foto do projeto (sem mexer no seu índice, nos seus arquivos nem nos seus commits) e compara no fim. Esses arquivos ganham a etiqueta **TERMINAL**, com o diff, os botões **Manter** e **Desfazer** por trecho e o **Descartar tudo** funcionando como nos demais.
- **Conversas que já aconteceram:** sem foto, a comparação é aproximada (etiqueta **TERMINAL ~**): usa o último commit anterior à conversa e só os arquivos mexidos no horário dela, então o que foi commitado no meio não some. Em conversas muito longas a lista pode ficar grande.
- Só vale em pastas com git. Para desligar, use `agentecode.review.terminalChanges: false`.

## v1.0.9 - 26/10/2026

Revisão do que o agente mudou, direto no editor: botões Manter e Desfazer em cada trecho.

- **Use esta versão no lugar da v1.0.8:** a v1.0.8 foi publicada por engano com o conteúdo incompleto (sem a tela nova de revisão). Instale esta, que já traz tudo, direto da sua versão atual.
- **Botões dentro do código:** acima de cada trecho que o agente alterou aparecem **Manter** (verde) e **Desfazer** (vermelho), com as linhas acrescentadas e removidas ao lado. **Desfazer** volta só aquele pedaço e salva o arquivo (o Ctrl+Z também funciona). Com o cursor no trecho, **Alt+Y** mantém e **Alt+N** desfaz. Os números abrem o diff "antes ↔ agora".
- **Tela "Alterações do agente" renovada:** na barra lateral das Sessões do agente, com o resumo `N arquivos +X −Y`, os botões **Aceitar tudo** e **Descartar tudo**, selo de linguagem, ícone de arquivo novo, modificado ou excluído (os mesmos do VS Code), etiquetas NOVO e EXCLUÍDO e números coloridos. A seta de cada arquivo mostra os trechos, e um clique leva até a linha. Quem preferir a lista simples de antes usa `agentecode.review.panel: tree`.
- **Margem do editor e Explorer:** os arquivos que o agente mudou ganham barras coloridas na margem (comparadas com o estado de antes da conversa) e a marca "IA" no Explorer. As alterações também aparecem como "Alterações do agente" no painel de código-fonte (Ctrl+Shift+G), onde basta marcar o repositório uma vez na lista de repositórios.
- **Comparar por turno:** é possível escolher com o que comparar: o início da conversa, antes da última resposta ou antes de um pedido específico.
- **Cores de destaque:** os quatro temas do AgenteCode passaram a ter uma cor de destaque para essas linhas do editor.
- O que foi feito por comandos de terminal continua não aparecendo, e se você mesmo editar o arquivo depois do agente, o **Voltar** também desfaz a sua edição (a tela avisa antes de confirmar).

## v1.0.7 - 26/10/2026

Revisão do que o agente mudou, histórico de uso e custo e sincronização da configuração do Claude.

- **Alterações do agente:** nova seção na barra lateral das Sessões do agente que lista os arquivos que o agente mudou na conversa, com as linhas acrescentadas e removidas. Clique num arquivo para ver a diferença "antes da conversa ↔ agora". Cada arquivo tem **Marcar como revisado** e **Voltar este arquivo** (o estado atual fica guardado e dá para desfazer). O que foi feito por comandos de terminal não aparece.
- **Histórico de uso e custo:** botão no painel "Uso do Claude" (e o comando **AgenteCode: Histórico de uso e custo**) com o gasto estimado por dia, por projeto e por modelo, em 7, 30 ou 90 dias. O valor é estimado pela tabela de preços da API, não é cobrança.
- **Sincronizar também a configuração do Claude (opcional):** no menu do Sync, **Configuração do Claude** leva o `CLAUDE.md` global e os arquivos de `~/.claude/commands`, `agents` e `skills` para o seu Gist secreto. Só texto, e arquivos com chaves ou tokens são pulados. Fica desligado até você ligar.
- **Limites 5h e 7d em verde:** a cor-base dos dois limites passa a ser o verde do contexto, com o degradê para âmbar e vermelho. O tooltip e o painel mostram o horário em que cada limite reinicia.
- **Correção:** **Desfazer a última sincronização** não restaurava os arquivos e agora restaura. O **Voltar arquivos para antes desta resposta** também passa a funcionar em conversas em que o Claude Code grava os caminhos relativos à pasta.

## v1.0.6 - 23/10/2026

Horário de reinício dos limites de uso.

- **Quando o limite reinicia:** na barra de status e no painel, o limite de sessão (5h) mostra o horário do reinício (ex.: "reseta em 2h18 (às 19:08)") e o semanal mostra o dia e a hora (ex.: "ter. às 21:00"), como no Claude Code Desktop.

## v1.0.5 - 22/10/2026

Correção do aviso falso da sincronização.

- **Acabou o aviso "Há configurações mais novas no GitHub" quando não havia nada novo.** Ao abrir a IDE, o AgenteCode comparava só a data do Gist, que muda mesmo com o conteúdo igual (por exemplo, depois de um envio feito por este computador). Agora ele compara o **conteúdo** e só avisa quando as configurações no GitHub são realmente diferentes.
- Quando a data muda mas o conteúdo é o mesmo, a IDE atualiza o registro local em silêncio, e a próxima verificação ao abrir não gasta nem a consulta completa.

## v1.0.4 - 22/10/2026

Sincronização nativa de configurações, atalhos, snippets e extensões via GitHub Gist secreto.

- **Login simples por código no navegador:** Conexão direta com a sua conta do GitHub via OAuth Device Flow, sem a necessidade de gerar ou digitar tokens manualmente.
- **Armazenamento em Gist secreto:** Todas as suas configurações (`settings.json`, `keybindings.json`, snippets e extensões instaladas) são sincronizadas em um Gist da sua própria conta do GitHub.
- **Segurança e privacidade garantidas:** Chaves de API, senhas, tokens e caminhos locais específicos de máquina são filtrados e removidos automaticamente antes do envio.
- **Sincronização automática e resolução de conflitos:** Detecção de alterações com envio automático após alguns segundos de inatividade, verificação silenciosa ao iniciar e detecção inteligente de conflitos com opção de pré-visualização.
- **Cópia de segurança com 1 clique para desfazer:** Cada aplicação de configurações cria um backup local automático dos últimos 10 estados, permitindo desfazer a qualquer momento pelo menu.
- **Guia passo a passo explicativo:** Guia integrado acessível no primeiro uso ou pelo menu **Sync Settings with GitHub...** e pelo comando **AgenteCode: Sincronização - Ver guia**.

## v1.0.3 - 21/10/2026

Barra de uso do Claude com cores que acompanham o consumo.

- **A cor sobe junto com o uso.** Os limites de 5h e 7d e o contexto saem da cor-base e vão aos poucos para o âmbar e o vermelho: base até 50%, âmbar em 75% e vermelho a partir de 90%. Vale na barra de status e no painel. Antes a cor era fixa e trocava de uma vez em 80% ou 90%.
- O limite de 7d agora usa o mesmo azul do 5h por padrão (antes era amarelo). Para voltar, ajuste `claudeUsageBar.colorWeekly7d`.
- As faixas e o degradê podem ser ajustados em `claudeUsageBar.colorGradient`, `colorGradientStart`, `colorGradientAmber` e `colorGradientRed`.
- A extensão **Claude Usage** agora faz parte do AgenteCode, sem baixar nada do Open VSX. As configurações `claudeUsageBar.*` continuam valendo, e se você instalar a extensão avulsa a da IDE se desativa sozinha.

## v1.0.2 - 20/10/2026

Correção da atualização automática.

- **Quem está na v1.0.0 ou v1.0.1 precisa instalar esta versão manualmente, uma única vez:** baixe o instalador desta Release e execute. Nessas duas versões o botão **Restart to Update** fechava a IDE e não instalava nada. A partir da v1.0.2 a atualização automática funciona.
- **Restart to Update** agora fecha a IDE, instala e abre a nova versão sozinho. A janela de progresso da instalação fica visível, e o log fica em `%TEMP%\AgenteCode-update\install.log`.
- Se o instalador não iniciar por algum motivo, a IDE atual é reaberta em vez de você ficar sem ela.
- A barra de progresso do **Download Update** passa a atualizar de forma contínua. Antes ela parecia travada, embora o download estivesse em andamento.

## v1.0.1 - 20/10/2026

Correção na conta do GitHub.

- O item **Sign in with GitHub...** do menu da conta agora **some quando você já está conectado**. Antes ele aparecia sempre e cada clique abria um novo login por código.
- Se ele for acionado por outro caminho com a conta já conectada, a IDE só avisa "Você já está conectado ao GitHub como ..." e não inicia outro login.
- O texto "About ... (v1.0.1)" do menu da engrenagem passa a ler a versão do próprio produto.

## v1.0.0 - 20/10/2026

A primeira versão estável do AgenteCode: uma IDE pensada para trabalhar com agentes, com o Claude Code embutido.

### Atualização dentro da IDE
- A IDE avisa quando há uma versão nova: aparece uma bolinha na engrenagem, no mesmo estilo do VS Code.
- **Check for Updates...** na engrenagem verifica na hora. A verificação automática acontece ao abrir e uma vez por dia, e pode ser desligada em `update.mode`.
- **Download Update** baixa o instalador dentro da IDE, com progresso, e confere o SHA-256 contra o arquivo publicado na Release.
- **Restart to Update** fecha a IDE normalmente, instala e abre a nova versão sozinha. Se algo falhar, a página da versão abre no navegador.
- Depois de atualizar, esta tela de novidades abre uma vez. Para vê-la de novo: **AgenteCode: Mostrar notas da versão**.

### Sessões do agente
- Novo painel **Sessões do agente** na barra lateral direita, ao lado do Claude Code.
- Lista as conversas do projeto, com **busca por texto** dentro delas.
- **Retomar** abre a conversa no Claude Code do painel lateral.
- **Exportar** gera um arquivo Markdown com a conversa, as ferramentas usadas e o resultado de cada uma.
- **Excluir** move a sessão para a Lixeira do Windows, junto com os arquivos auxiliares (tecla `Delete`, seleção múltipla). Sessões em uso ficam protegidas.

### Voltar arquivos (checkpoint)
- Dentro de cada sessão, o botão **Voltar arquivos para antes desta resposta** desfaz o que o agente fez nos arquivos.
- Mostra o que vai mudar, com a diferença de cada arquivo, e pede confirmação.
- Guarda o estado atual antes de voltar: **AgenteCode: Desfazer a última volta de arquivos** desfaz a volta.
- Limites: não desfaz o que foi feito por comandos de terminal, nem volta a conversa.

### Base da IDE
- Quatro temas próprios (Deep Teal, Eficaz, Everforest e One Dark Pro), cada um com a versão Clean, sem divisórias.
- Claude Code embutido, abrindo na barra lateral direita (`Ctrl+L`).
- Extensões pelo Open VSX, sem o Copilot e sem telemetria no núcleo da IDE.
- Menu da engrenagem com a versão e o diálogo Sobre.
