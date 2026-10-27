/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Traducoes para portugues (pt-BR): texto em ingles -> texto em portugues, uma pasta por area.

module.exports = {
	...require('./pt-br/sync'),
	...require('./pt-br/usage'),
	...require('./pt-br/review'),
	...require('./pt-br/misc')
};
