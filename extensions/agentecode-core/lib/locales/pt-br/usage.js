/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Textos de usage: ingles -> portugues.

module.exports = {
	// lib/usage/core.js (barra de uso e painel)
	'Claude Code credential has no token': 'credencial do Claude Code sem token',
	'Claude Code credential is unreadable': 'credencial do Claude Code ilegível',
	'Claude Code credential not found (log in to Claude Code)': 'credencial do Claude Code não encontrada (faça login no Claude Code)',
	'at {0}': 'às {0}',
	'{0} at {1}': '{0} às {1}',
	'{0} ago': 'há {0}',
	'current session': 'sessão atual',
	'turn {0}': 'turno {0}',
	'Model': 'Modelo',
	'Context': 'Contexto',
	'{0} / {1} tokens': '{0} / {1} tokens',
	'Estimated cost': 'Custo estimado',
	'a model has no known price': 'há modelo sem preço conhecido',
	'Tokens (total)': 'Tokens (soma)',
	'in {0} · out {1} · cache read {2} · cache written {3}': 'in {0} · out {1} · cache lido {2} · cache escrito {3}',
	'resets in {0} ({1})': 'reseta em {0} ({1})',
	'5h limit': 'Limite 5h',
	'7d limit': 'Limite 7d',
	'Cost calculated from the transcript using the API price table (includes subagents); it is not the billed amount.': 'Custo calculado pela tabela de preços da API a partir do transcript (inclui subagentes); não é o valor de cobrança.',
	'Limits read {0} at {1}{2}.': 'Limites lidos {0} às {1}{2}.',
	'directly from the API': 'direto da API',
	'from claude-usage-meter': 'da claude-usage-meter',
	'outdated, not shown': 'desatualizados, não exibidos',
	'no data': 'sem dados',
	'Resets in {0} ({1})': 'Reseta em {0} ({1})',
	'reading {0}': 'leitura {0}',
	'Subscription usage': 'Uso da assinatura',
	'Window restarted; waiting for the new reading.': 'Janela reiniciada; aguardando a nova leitura.',
	'Session (5h)': 'Sessão (5h)',
	'Weekly (7 days)': 'Semanal (7 dias)',
	'enable the 5h/7d limits': 'ativar os limites 5h/7d',
	'Waiting for the usage API query.': 'Aguardando a consulta à API de uso.',
	'Last error: {0}.': 'Último erro: {0}.',
	'Click to {0} (reads the Claude Code token and queries Anthropic\'s usage API).': 'Clique para {0} (lê o token do Claude Code e consulta a API de uso da Anthropic).',
	'Limits reading is outdated (last at {0}).': 'Leitura dos limites desatualizada (última às {0}).',
	'5h/7d limits unavailable.': 'Limites 5h/7d indisponíveis.',
	'Current session': 'Sessão atual',
	'Time': 'Tempo',
	'Last turn': 'Último turno',
	'No Claude Code transcript found for this folder.': 'Nenhum transcript do Claude Code encontrado para esta pasta.',

	// lib/usage/direct.js
	'credential not found in the Keychain': 'credencial não encontrada no Keychain',
	'token expired, waiting for Claude Code to renew it': 'token vencido, aguardando o Claude Code renovar',
	'API response without the limits': 'resposta da API sem os limites',
	'API rate-limiting the requests (HTTP 429)': 'API limitando as consultas (HTTP 429)',
	'token rejected (HTTP {0})': 'token recusado (HTTP {0})',
	'network failure': 'falha de rede',

	// lib/usage/usage.js
	'Claude Usage cost': 'Claude Usage custo',
	'Claude Usage: show your subscription\'s 5h and 7d limits? To do so, the extension reads the Claude Code token on this computer and queries Anthropic\'s usage API (every minute while you use Claude). Nothing is sent anywhere else.': 'Claude Usage: mostrar os limites de 5h e 7d da sua assinatura? Para isso a extensão lê o token do Claude Code neste computador e consulta a API de uso da Anthropic (a cada minuto enquanto você usa o Claude). Nada é enviado a outro lugar.',
	'Enable': 'Ativar',
	'Not now': 'Agora não',

	// lib/usageHistoryView.js
	'{0} tokens': '{0} tokens',
	'Spending per day': 'Gasto por dia',
	'Nothing in this period.': 'Nada neste período.',
	'{0} days': '{0} dias',
	'Usage and cost history': 'Histórico de uso e custo',
	'Calculated from the conversations stored on this computer (includes subagents).': 'Calculado a partir das conversas guardadas neste computador (inclui subagentes).',
	'Today': 'Hoje',
	'Last 7 days': 'Últimos 7 dias',
	'Last 30 days': 'Últimos 30 dias',
	'Period ({0} days)': 'Período ({0} dias)',
	'Sessions in the period': 'Sessões no período',
	'By project': 'Por projeto',
	'By model': 'Por modelo',
	'{0} session(s) · {1} tokens': '{0} sessão(ões) · {1} tokens',
	'Values estimated from the API price table using the transcripts; {0}.': 'Valores estimados pela tabela de preços da API a partir dos transcripts; {0}.',
	'they are not the billed amount': 'não são o valor de cobrança',
	'On a subscription, usage is limited by the 5h and 7d windows (see the usage bar).': 'Na assinatura, o que limita o uso são as janelas de 5h e 7d (veja a barra de uso).',
	'Some responses from models with no known price were left out of the total.': 'Há respostas de modelos sem preço conhecido, que ficaram fora da soma.',
	'Only conversations still present on this computer are shown.': 'Só aparecem conversas ainda presentes neste computador.',
	'Calculating the history (the first time may take a few seconds)...': 'Calculando o histórico (a primeira vez pode levar alguns segundos)...',
	'Could not read the history: {0}': 'Não foi possível ler o histórico: {0}',
	'Usage history': 'Histórico de uso'
};
