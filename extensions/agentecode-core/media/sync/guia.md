# Sincronização de Configurações com o GitHub

O AgenteCode permite que você sincronize facilmente suas configurações, atalhos de teclado, snippets e lista de extensões entre diferentes computadores utilizando um **Gist secreto** na sua própria conta do GitHub.

Nenhum token manual precisa ser digitado: o login é feito de forma segura e rápida através do navegador (**Device Flow** do GitHub).

---

## Como Funciona

- Suas configurações são agrupadas e salvas em um Gist na sua conta do GitHub.
- **Aviso de Privacidade:** O Gist gerado é **secreto** (não aparece em buscas públicas do GitHub nem no seu perfil público), porém qualquer pessoa que possua o link direto poderá ler o conteúdo.
- **Segurança Automática:** O AgenteCode remove automaticamente senhas, tokens de autenticação (como chaves de API, credenciais e variáveis sensíveis) e caminhos específicos da sua máquina local antes de enviar qualquer dado.

---

## 1. Primeiro Uso (Enviar Configurações)

1. No canto inferior esquerdo da tela, clique no **ícone de engrenagem** (Configurações) ou no **ícone de conta** e selecione **Sync Settings with GitHub...**
2. Se for sua primeira vez, escolha a opção **Conectar ao GitHub e enviar minhas configurações**.
3. Leia o aviso de privacidade e clique em **Continuar**.
4. Uma notificação será exibida com um código de uso único (ex.: `ABCD-1234`). Clique no botão **Copiar código e abrir o GitHub**.
5. O navegador será aberto na página de ativação do GitHub (`github.com/login/device`). Cole o código copiado e clique em **Continue**.
6. Autorize o aplicativo **AgenteCode** a criar e gerenciar seus Gists.
7. Pronto! O AgenteCode detectará a autorização automaticamente e fará o primeiro envio. Ao final, você pode clicar em **Copiar URL** ou **Abrir** para ver o Gist criado.

---

## 2. Em Outro Computador (Baixar Configurações)

1. No novo computador, abra o menu **Sync Settings with GitHub...**
2. Selecione a opção **Baixar configurações de outro computador**.
3. Se ainda não estiver conectado neste computador, realize a autorização rápida por código no navegador.
4. O AgenteCode localizará seu Gist sincronizado e apresentará uma **Pré-visualização** das diferenças.
5. Você poderá inspecionar as diferenças arquivo por arquivo e confirmar a aplicação.
6. Uma cópia de segurança dos seus arquivos locais atuais é criada automaticamente antes de aplicar as mudanças.
7. Ao término, um resumo detalhado mostra todos os arquivos atualizados e as extensões instaladas.

---

## 3. Sincronização Automática

- Enquanto estiver conectado, o AgenteCode monitora alterações em suas configurações locais.
- Quando você alterar um arquivo (`settings.json`, `keybindings.json` ou snippets), ele aguardará 30 segundos (tempo configurável) e enviará as alterações de forma silenciosa para o seu Gist caso o conteúdo tenha mudado.
- Ao abrir o editor, se houver configurações mais novas no GitHub salvas por outro computador, o AgenteCode emitirá uma notificação perguntando se você deseja baixá-las. **O editor nunca sobrescreve seus arquivos locais sem sua autorização.**
- Você pode ligar ou desligar o envio automático a qualquer momento pelo menu através da opção **Sincronização automática: ligada/desligada**.

---

## 4. Como Desfazer uma Sincronização

Caso tenha baixado configurações e queira voltar ao estado anterior:
1. Abra o menu **Sync Settings with GitHub...**
2. Clique em **Desfazer a última sincronização**.
3. O AgenteCode restaurará o backup local mais recente (os últimos 10 backups locais são mantidos no seu computador).

---

## 5. Como Desconectar

1. Abra o menu **Sync Settings with GitHub...**
2. Clique em **Desconectar**.
3. O token de acesso será removido com segurança do armazenamento criptografado da IDE.
4. Seu Gist no GitHub **não** é excluído ao desconectar, garantindo que você não perca seu histórico. Caso deseje apagá-lo, você pode usar a opção **Abrir Gist no navegador** antes de desconectar.

## 6. Levar também a configuração do Claude (opcional)

Por padrão, só as configurações da IDE são sincronizadas. Se você quiser que o "jeito" do seu agente acompanhe você em outro computador:

1. Abra o menu **Sync Settings with GitHub...**
2. Clique em **Configuração do Claude: Desligada** e confirme em **Ligar**.
3. Passam a ser enviados o seu `CLAUDE.md` global e os arquivos de `~/.claude/commands`, `agents` e `skills` (somente texto, até 200 KB cada).

O que **nunca** é enviado: seu login do Claude, o histórico das conversas e o `settings.json` do Claude. Arquivos que contenham chaves ou tokens são pulados automaticamente.

> **Atenção:** o Gist é secreto, mas quem tiver o link consegue ler o conteúdo. Não deixe informações confidenciais nesses arquivos.

Ao baixar em outro computador, os arquivos do Claude também passam pela pré-visualização, e uma cópia dos que seriam substituídos é guardada para o **Desfazer**.
