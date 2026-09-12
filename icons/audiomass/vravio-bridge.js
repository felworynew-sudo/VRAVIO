/* VRAVIO boundary adapter for the bundled, unmodified AudioMass application.
 * The parent and this document share one origin, but an explicit origin check
 * remains important: this page accepts a File and hands it to Web Audio. */
(function (window) {
	'use strict';
	var pending = null;
	function norm(value) {
		return String(value || '').replace(/\s+/g, ' ').replace(/[✓✔]/g, '').trim().toLowerCase();
	}
	function clickAudioMassCommand(menuName, itemName) {
		var headers = Array.prototype.slice.call(document.querySelectorAll('.pk_hdr > .pk_btn'));
		var header = headers.find(function (node) { return norm(node.textContent).indexOf(norm(menuName)) === 0; });
		if (!header) return;
		var menuButton = header.querySelector(':scope > button');
		if (menuButton) menuButton.click();
		window.requestAnimationFrame(function () {
			var items = Array.prototype.slice.call(header.querySelectorAll('.pk_menu button'));
			var wanted = norm(itemName);
			var item = items.find(function (node) { return norm(node.textContent).indexOf(wanted) === 0; });
			if (item && !item.disabled) item.click();
		});
	}
	function applyChrome(message) {
		var palette = message.palette || {};
		var root = document.documentElement;
		root.classList.add('vravio-embedded');
		root.lang = message.language === 'ru' ? 'ru' : 'en';
		root.style.colorScheme = message.theme === 'light' ? 'light' : 'dark';
		var tokens = {
			'--bg-0': palette.background, '--bg-1': palette.surface,
			'--bg-2': palette.raisedSurface, '--bg-3': palette.hoverSurface,
			'--bg-4': palette.hoverSurface, '--bd': palette.border,
			'--fg-0': palette.text, '--fg-1': palette.muted,
			'--fg-2': palette.muted, '--ac': palette.accent,
			'--ac-2': palette.accent, '--ac-soft': 'color-mix(in srgb, ' + palette.accent + ' 16%, transparent)',
			'--ac-glow': 'color-mix(in srgb, ' + palette.accent + ' 42%, transparent)'
		};
		Object.keys(tokens).forEach(function (key) { if (tokens[key]) root.style.setProperty(key, tokens[key]); });
		var translations = message.language === 'ru' ? {
			'CHANNELS': 'КАНАЛЫ', 'Selection:': 'Выделение:', 'Start:': 'Начало:', 'End:': 'Конец:', 'Duration:': 'Длительность:',
			'clear selection': 'снять выделение', 'Drag and Drop Audio Files in this window, or click': 'Перетащите аудиофайл в это окно или нажмите',
			'here to use a sample': 'здесь, чтобы открыть пример', 'BPM': 'УД/МИН'
		} : { 'КАНАЛЫ': 'CHANNELS', 'Выделение:': 'Selection:', 'Начало:': 'Start:', 'Конец:': 'End:', 'Длительность:': 'Duration:', 'снять выделение': 'clear selection', 'УД/МИН': 'BPM', 'Перетащите аудиофайл в это окно или нажмите': 'Drag and Drop Audio Files in this window, or click', 'здесь, чтобы открыть пример': 'here to use a sample' };
		Array.prototype.slice.call(document.querySelectorAll('.pk_mt_head, .pk_selection, .pk_tmpMsg, .pk_mtbeat b, .icon-clearsel')).forEach(function (node) {
			// Do not assign innerHTML here: the channel header and selection bar
			// contain AudioMass buttons with listeners attached during startup.
			// Replacing only their text nodes translates labels without recreating
			// (and silently disconnecting) those controls.
			var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
			var textNodes = [], current;
			while ((current = walker.nextNode())) textNodes.push(current);
			textNodes.forEach(function (textNode) {
				Object.keys(translations).forEach(function (from) {
					if (textNode.nodeValue.indexOf(from) !== -1) textNode.nodeValue = textNode.nodeValue.split(from).join(translations[from]);
				});
			});
		});
	}
	function openInAudioMass(message) {
		if (!message || message.type !== 'vravio:audiomass:open-file' || !message.file) return;
		var editor = window.PKAudioEditor;
		if (!editor || !editor.engine || !editor.engine.LoadArrayBuffer) {
			pending = message;
			return;
		}
		editor.engine.LoadArrayBuffer(message.file);
		if (message.file.name) document.title = message.file.name + ' — VRAVIO Audio';
	}
	window.addEventListener('message', function (event) {
		if (event.origin !== window.location.origin) return;
		if (event.data && event.data.type === 'vravio:audiomass:chrome') { applyChrome(event.data); return; }
		if (event.data && event.data.type === 'vravio:audiomass:command') { clickAudioMassCommand(event.data.menu, event.data.item); return; }
		openInAudioMass(event.data);
	});
	window.addEventListener('load', function () {
		if (pending) { var message = pending; pending = null; openInAudioMass(message); }
	});
})(window);
