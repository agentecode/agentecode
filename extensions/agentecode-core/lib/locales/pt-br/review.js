/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Textos de review: ingles -> portugues.

module.exports = {
	// Estados e rotulos
	'new': 'novo',
	'deleted': 'excluído',
	'modified': 'modificado',
	'AI': 'IA',
	'Agent changes': 'Alterações do agente',
	'View diff': 'Ver diferença',
	'the start of the conversation': 'o início da conversa',
	'before "{0}"': 'antes de "{0}"',
	'Changed by the agent and not yet reviewed': 'Alterado pelo agente e ainda não revisado',

	// CodeLens e dicas no editor
	'Changed by the agent in this conversation.': 'Alterado pelo agente nesta conversa.',
	'Alt+Y: keep this hunk': 'Alt+Y: manter este trecho',
	'Alt+N: undo this hunk': 'Alt+N: desfazer este trecho',
	'Click +N −M to see the difference (before ↔ now).': 'Clique em +N −M para ver a diferença (antes ↔ agora).',
	'Keep': 'Manter',
	'Delete': 'Excluir',
	'Undo': 'Desfazer',
	'Keep the new file': 'Manter o arquivo novo',
	'Delete the new file': 'Excluir o arquivo novo',
	'View the file': 'Ver o arquivo',
	'agent · new file': 'agente · arquivo novo',
	'Keep this hunk (Alt+Y)': 'Manter este trecho (Alt+Y)',
	'Undo this hunk (Alt+N)': 'Desfazer este trecho (Alt+N)',
	'View the difference (before ↔ now)': 'Ver a diferença (antes ↔ agora)',
	'agent · Alt+Y keep · Alt+N undo': 'agente · Alt+Y manter · Alt+N desfazer',
	'Changed by the agent': 'Alterado pelo agente',
	'Shortcuts: **Alt+Y** keep · **Alt+N** undo': 'Atalhos: **Alt+Y** manter · **Alt+N** desfazer',

	// Lista e painel
	'No agent conversation found for this folder.': 'Nenhuma conversa do agente encontrada para esta pasta.',
	'This conversation has not changed any files yet.': 'Esta conversa ainda não alterou arquivos.',
	'All reviewed ({0}).': 'Tudo revisado ({0}).',
	'No difference: the files are as they were before.': 'Nenhuma diferença: os arquivos estão como antes.',
	'Conversation: {0}': 'Conversa: {0}',
	'Comparing with: {0}': 'Comparando com: {0}',
	'No difference.': 'Nenhuma diferença.',
	'{0} already reviewed hidden.': '{0} já revisado(s) oculto(s).',
	'Includes what was changed by terminal commands (compared with the project snapshot at the start of the request).': 'Inclui o que foi alterado por comandos de terminal (comparado com a foto do projeto no começo do pedido).',
	'Terminal changes are approximate: compared with the last commit before the conversation, only for files touched during it.': 'As mudanças por terminal são aproximadas: comparadas com o último commit anterior à conversa, só dos arquivos mexidos no horário dela.',
	'No git repository: what was done by terminal commands does not appear here.': 'Sem repositório git: o que foi feito por comandos de terminal não aparece aqui.',
	'{0} file(s) +{1} −{2}': '{0} arquivo(s) +{1} −{2}',
	'{0} file(s) to review': '{0} arquivo(s) a revisar',
	'Could not read the changes: {0}': 'Não foi possível ler as alterações: {0}',

	// Voltar arquivos
	'Save or discard the changes open in the editor before reverting: {0}.': 'Salve ou descarte as alterações abertas no editor antes de voltar: {0}.',
	'… and {0} more': '… e mais {0}',
	'Revert': 'Voltar',
	'Revert this file to its previous state?': 'Voltar este arquivo para o estado de antes?',
	'Revert {0} files to their previous state?': 'Voltar {0} arquivos para o estado de antes?',
	'If you edited the file yourself after the agent, those edits are reverted too. The current state is saved and can be undone with "AgenteCode: Undo the Last File Revert".': 'Se você mesmo editou o arquivo depois do agente, essas edições também voltam. O estado atual fica guardado e dá para desfazer em "AgenteCode: Desfazer a última volta de arquivos".',
	'{0} file(s) reverted; {1} failed (see the developer console).': '{0} arquivo(s) voltaram; {1} falharam (veja o console do desenvolvedor).',
	'{0} file(s) reverted.': '{0} arquivo(s) voltaram.',
	'review: {0} file(s)': 'revisão: {0} arquivo(s)',

	// Comandos
	'before ↔ now': 'antes ↔ agora',
	'Place the cursor inside a hunk changed by the agent.': 'Coloque o cursor dentro de um trecho alterado pelo agente.',
	'This hunk changed since the list was calculated. Refresh and try again.': 'Este trecho mudou desde que a lista foi calculada. Atualize e tente de novo.',
	'Also showing the already reviewed files in the side list.': 'Mostrando também os arquivos já revisados na lista lateral.',
	'Hiding the already reviewed files.': 'Ocultando os arquivos já revisados.',
	'Review the changes of which conversation?': 'Revisar alterações de qual conversa?',
	'Choose the agent conversation': 'Escolha a conversa do agente',
	'Start of the conversation': 'Início da conversa',
	'current': 'atual',
	'Before the last response': 'Antes da última resposta',
	'Before: {0}': 'Antes de: {0}',
	'Compare the changes with...': 'Comparar as alterações com...',
	'What has the agent changed since when?': 'O que o agente mudou desde quando?',

	// Tela (webview)
	'New file': 'Arquivo novo',
	'Modified file': 'Arquivo modificado',
	'Deleted file': 'Arquivo excluído',
	'{0} file': '{0} arquivo',
	'{0} files': '{0} arquivos',
	'Accept all': 'Aceitar tudo',
	'Marks all files as reviewed': 'Marca todos os arquivos como revisados',
	'Discard all': 'Descartar tudo',
	'Reverts all files to their previous state (asks for confirmation)': 'Volta todos os arquivos para o estado de antes (pede confirmação)',
	'Compare with: {0}': 'Comparar com: {0}',
	'Choose the comparison point': 'Escolher o ponto de comparação',
	'Switch conversation': 'Trocar conversa',
	'Choose another agent conversation': 'Escolher outra conversa do agente',
	'Refresh': 'Atualizar',
	'Recalculate now': 'Recalcular agora',
	'{0} already reviewed (visible)': '{0} já revisado(s) visível(is)',
	'{0} already reviewed (hidden)': '{0} já revisado(s) oculto(s)',
	'hide': 'ocultar',
	'show': 'mostrar',
	'Show the hunks': 'Mostrar os trechos',
	'NEW': 'NOVO',
	'DELETED': 'EXCLUÍDO',
	'Changed outside the agent log (terminal or another tool). Approximate comparison, against the last commit before the conversation.': 'Alterado fora do registro do agente (terminal ou outra ferramenta). Comparação aproximada, com o último commit anterior à conversa.',
	'Changed by a terminal command or another tool (outside the agent log).': 'Alterado por comando de terminal ou outra ferramenta (fora do registro do agente).',
	'Keep (mark as reviewed)': 'Manter (marcar como revisado)',
	'Revert this file': 'Voltar este arquivo',
	'No pending hunks': 'Nenhum trecho pendente',
	'@line {0}': '@linha {0}',
	'Keep this hunk': 'Manter este trecho',
	'Undo this hunk': 'Desfazer este trecho'
};
