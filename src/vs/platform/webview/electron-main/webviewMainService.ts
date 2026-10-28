/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WebContents, webContents, WebFrameMain } from 'electron';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { hasKey } from '../../../base/common/types.js';
import { FindInFrameOptions, FoundInFrameResult, IWebviewManagerService, WebviewWebContentsId, WebviewWindowId } from '../common/webviewManagerService.js';
import { WebviewProtocolProvider } from './webviewProtocolProvider.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';
import { IFileService } from '../../files/common/files.js';

export class WebviewMainService extends Disposable implements IWebviewManagerService {

	declare readonly _serviceBrand: undefined;

	private readonly _onFoundInFrame = this._register(new Emitter<FoundInFrameResult>());
	public readonly onFoundInFrame = this._onFoundInFrame.event;

	constructor(
		@IFileService fileService: IFileService,
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
	) {
		super();
		this._register(new WebviewProtocolProvider(fileService));
	}

	public async setIgnoreMenuShortcuts(id: WebviewWebContentsId | WebviewWindowId, enabled: boolean): Promise<void> {
		const contents = this.getWebContents(id);
		if (!contents.isDestroyed()) {
			contents.setIgnoreMenuShortcuts(enabled);
		}
	}

	private getWebContents(id: WebviewWebContentsId | WebviewWindowId): WebContents {
		let contents: WebContents | undefined;

		if (hasKey(id, { windowId: true })) {
			const { windowId } = id;
			const window = this.windowsMainService.getWindowById(windowId);
			if (!window?.win) {
				throw new Error(`Invalid windowId: ${windowId}`);
			}
			contents = window.win.webContents;
		} else {
			const { webContentsId } = id;
			contents = webContents.fromId(webContentsId);
			if (!contents) {
				throw new Error(`Invalid webContentsId: ${webContentsId}`);
			}
		}

		return contents;
	}

	public async findInFrame(id: WebviewWebContentsId | WebviewWindowId, frameName: string, text: string, options: { findNext?: boolean; forward?: boolean }): Promise<void> {
		const initialFrame = this.getFrameByName(id, frameName);

		type WebFrameMainWithFindSupport = WebFrameMain & {
			findInFrame?(text: string, findOptions: FindInFrameOptions): void;
			on(event: 'found-in-frame', listener: Function): WebFrameMain;
			removeListener(event: 'found-in-frame', listener: Function): WebFrameMain;
		};
		const frame = initialFrame as unknown as WebFrameMainWithFindSupport;
		if (typeof frame.findInFrame === 'function') {
			frame.findInFrame(text, {
				findNext: options.findNext,
				forward: options.forward,
			});
			const foundInFrameHandler = (_: unknown, result: FoundInFrameResult) => {
				if (result.finalUpdate) {
					this._onFoundInFrame.fire(result);
					frame.removeListener('found-in-frame', foundInFrameHandler);
				}
			};
			frame.on('found-in-frame', foundInFrameHandler);
		} else {
			// AgenteCode: stock Electron has no `findInFrame`, so search the webview content with the browser's own find
			await this.findWithScript(initialFrame, text, options);
		}
	}

	/**
	 * Fallback for Electron builds without `WebFrameMain.findInFrame`: runs `window.find` inside the webview content
	 * frames (a webview host frame contains the extension's content frame). It selects and reveals the match but cannot
	 * count matches, so a hit is reported as one match.
	 */
	private async findWithScript(hostFrame: WebFrameMain, text: string, options: { findNext?: boolean; forward?: boolean }): Promise<void> {
		const forward = options.forward !== false;
		const script = `(function () {
			const selection = window.getSelection();
			if (${options.findNext ? 'true' : 'false'} && selection) {
				selection.removeAllRanges();
			}
			const found = window.find(${JSON.stringify(text)}, false, ${forward ? 'false' : 'true'}, true, false, false, false);
			if (found && selection && selection.rangeCount) {
				// window.find selects the match but does not scroll to it inside a webview, so reveal it here
				const container = selection.getRangeAt(0).startContainer;
				const element = container.nodeType === 1 ? container : container.parentElement;
				if (element) {
					element.scrollIntoView({ block: 'center', inline: 'nearest' });
				}
			}
			return found;
		})()`;

		let found = false;
		for (const frame of hostFrame.framesInSubtree) {
			if (frame === hostFrame) {
				continue;
			}
			try {
				if (await frame.executeJavaScript(script) === true) {
					found = true;
					break;
				}
			} catch {
				// the frame can go away while searching
			}
		}

		this._onFoundInFrame.fire({ requestId: 0, activeMatchOrdinal: found ? 1 : 0, matches: found ? 1 : 0, finalUpdate: true });
	}

	public async stopFindInFrame(id: WebviewWebContentsId | WebviewWindowId, frameName: string, options: { keepSelection?: boolean }): Promise<void> {
		const initialFrame = this.getFrameByName(id, frameName);

		type WebFrameMainWithFindSupport = WebFrameMain & {
			stopFindInFrame?(stopOption: 'keepSelection' | 'clearSelection'): void;
		};

		const frame = initialFrame as unknown as WebFrameMainWithFindSupport;
		if (typeof frame.stopFindInFrame === 'function') {
			frame.stopFindInFrame(options.keepSelection ? 'keepSelection' : 'clearSelection');
		} else if (!options.keepSelection) {
			// AgenteCode: fallback search only selects text, so clear the selection when the find box closes
			for (const child of initialFrame.framesInSubtree) {
				if (child !== initialFrame) {
					child.executeJavaScript('window.getSelection()?.removeAllRanges()').catch(() => { });
				}
			}
		}
	}

	private getFrameByName(id: WebviewWebContentsId | WebviewWindowId, frameName: string): WebFrameMain {
		const frame = this.getWebContents(id).mainFrame.framesInSubtree.find(frame => {
			return frame.name === frameName;
		});
		if (!frame) {
			throw new Error(`Unknown frame: ${frameName}`);
		}
		return frame;
	}
}
