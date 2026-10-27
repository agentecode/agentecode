/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Textos de misc: ingles -> portugues.

module.exports = {
	// lib/sessionsView.js
	'Session: {0}': 'Sessão: {0}',
	'Project: {0}': 'Projeto: {0}',
	'File: {0}': 'Arquivo: {0}',
	'Click the button to restore the files to before this response.': 'Clique no botão para voltar os arquivos para antes desta resposta.',
	'Searching for "{0}" in the sessions…': 'Buscando "{0}" nas sessões…',
	'Search: "{0}" — {1} session(s)': 'Busca: "{0}" — {1} sessão(ões)',
	'No session contains "{0}".': 'Nenhuma sessão contém "{0}".',
	'Search the agent sessions': 'Buscar nas sessões do agente',
	'Searches the text of the conversations (case-insensitive)': 'Procura no texto das conversas (sem diferenciar maiúsculas)',
	'Could not open the session in Claude Code: {0}': 'Não foi possível abrir a sessão no Claude Code: {0}',
	'{0} session(s) were modified less than 2 minutes ago and seem to be in use. They will not be deleted.': '{0} sessão(ões) foram alteradas há menos de 2 minutos e parecem estar em uso. Elas não serão excluídas.',
	'… and {0} more': '… e mais {0}',
	'Move to Trash': 'Mover para a Lixeira',
	'Move this session to the Trash?': 'Mover esta sessão para a Lixeira?',
	'Move {0} sessions to the Trash?': 'Mover {0} sessões para a Lixeira?',
	'The file copies (checkpoints) of these sessions go along with them. You can recover them from the Windows Recycle Bin.': 'As cópias de arquivos (checkpoints) dessas sessões vão junto. Dá para recuperar pela Lixeira do Windows.',
	'{0} item(s) could not be moved (see the developer console).': '{0} item(ns) não puderam ser movidos (veja o console do desenvolvedor).',
	'Refresh Claude Code': 'Atualizar Claude Code',
	'Session moved to the Trash.': 'Sessão movida para a Lixeira.',
	'{0} sessions moved to the Trash.': '{0} sessões movidas para a Lixeira.',
	'{0} The Claude Code list only updates when its screens reload.': '{0} A lista do Claude Code só atualiza quando as telas dele recarregam.',

	// lib/releaseNotesView.js
	'# What\'s new in AgenteCode {0}': '# Novidades do AgenteCode {0}',
	'There are no written notes for version {0}.': 'Não há notas escritas para a versão {0}.',

	// lib/export.js
	'No agent session was found for this folder.': 'Nenhuma sessão do agente foi encontrada para esta pasta.',
	'No agent session was found.': 'Nenhuma sessão do agente foi encontrada.',
	'Reading agent sessions…': 'Lendo sessões do agente…',
	'Export Session to Markdown': 'Exportar sessão para Markdown',
	'Choose the session to export': 'Escolha a sessão que será exportada',
	'Could not read the session: {0}': 'Não foi possível ler a sessão: {0}',
	'Export': 'Exportar',
	'Save Session as Markdown': 'Salvar sessão como Markdown',
	'Open': 'Abrir',
	'Session exported to {0}.': 'Sessão exportada para {0}.',

	// lib/sessionMarkdown.js
	'Untitled session': 'Sessão sem título',
	'… ({0} characters omitted)': '… ({0} caracteres omitidos)',
	'content': 'conteúdo',
	'Agent session': 'Sessão do agente',
	'Session': 'Sessão',
	'Project': 'Projeto',
	'Period': 'Período',
	'User messages': 'Mensagens do usuário',
	'_Exported from AgenteCode on {0}._': '_Exportado do AgenteCode em {0}._',
	'User': 'Usuário',
	'_[attached image]_': '_[imagem anexada]_',
	'error': 'erro',
	'result': 'resultado',
	'{0} ({1} characters)': '{0} ({1} caracteres)',

	// lib/sessionStore.js
	'Unreadable session': 'Sessao ilegivel',

	// lib/rewind.js
	'goes back to the previous version': 'volta à versão anterior',
	'is recreated (it was deleted later)': 'é recriado (foi apagado depois)',
	'is deleted (it did not exist yet)': 'é excluído (não existia ainda)',
	'Uncheck what you do NOT want to touch. The conversation does not go back, and what was done by commands (Bash) is not undone.': 'Desmarque o que NÃO quer mexer. A conversa não volta, e o que foi feito por comandos (Bash) não é desfeito.',
	'View Difference': 'Ver diferença',
	'{0} (current ↔ after rewind)': '{0} (atual ↔ após voltar)',
	'This point has no tracked files to rewind.': 'Este ponto não tem arquivos rastreados para voltar.',
	'The files are already as they were before this response. Nothing to rewind.': 'Os arquivos já estão como eram antes desta resposta. Nada para voltar.',
	'Rewind files to before: {0}': 'Voltar arquivos para antes de: {0}',
	'Save or discard the changes open in the editor before rewinding: {0}.': 'Salve ou descarte as alterações abertas no editor antes de voltar: {0}.',
	'{0} file(s) outside this folder were ignored.': '{0} arquivo(s) fora desta pasta foram ignorados.',
	'{0} file(s) without a stored copy were ignored.': '{0} arquivo(s) sem cópia guardada foram ignorados.',
	'Rewind Files': 'Voltar arquivos',
	'Rewind {0} file(s) to before this response?': 'Voltar {0} arquivo(s) para antes desta resposta?',
	'The current state is kept and you can undo it with "AgenteCode: Undo Last File Rewind".': 'O estado atual fica guardado e dá para desfazer em "AgenteCode: Desfazer a última volta de arquivos".',
	'Undo': 'Desfazer',
	'{0} file(s) rewound; {1} failed (see the developer console).': '{0} arquivo(s) voltaram; {1} falharam (veja o console do desenvolvedor).',
	'{0} file(s) rewound to before this response.': '{0} arquivo(s) voltaram para antes desta resposta.',
	'There is no file rewind to undo.': 'Não há nenhuma volta de arquivos para desfazer.',
	'Undone with {0} failure(s) (see the developer console).': 'Desfeito com {0} falha(s) (veja o console do desenvolvedor).',
	'Rewind undone: {0} file(s) are back as before.': 'Volta desfeita: {0} arquivo(s) estão como antes.'
};
